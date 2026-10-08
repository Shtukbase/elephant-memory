// The view: Taelin's merge order (due measured from a pair's LAST message), the
// sawtooth (append only, one batch past the ceiling down to the floor, catch-up
// while parents are missing), never a split, a stored view taken back only when
// it tiles the history, and `id+n|text` lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLACEHOLDER, View, countOf, lineOf, renderView, startOf } from '../lib/view.js';
import { MemoryTree } from './fixtures.js';

/** @param {{ l: number, i: number }} p */
const range = (p) => [startOf(p), startOf(p) + countOf(p)];
/** @param {View} view */
const names = (view) => view.parts.map((p) => `${startOf(p)}+${countOf(p)}`).join(',');

/**
 * Taelin's rollback `push` (rollback_state_list.js, 2022), as the spec quotes it.
 * @typedef {{ keep: number, life: number, state: number, older: States }} StateList
 * @typedef {StateList | null} States
 * @param {number} newState @param {States} states @returns {StateList}
 */
function push(newState, states) {
  if (states === null) return { keep: 0, life: 0, state: newState, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
  return { keep: 0, life, state: newState, older: push(state, older) };
}

/** push's list read as view lines: each state runs to the next newer one. @param {States} list @param {number} T */
function pushLines(list, T) {
  const states = [];
  for (let node = list; node !== null; node = node.older) states.push(node.state);
  states.reverse();
  return states.map((s, k) => `${s}+${(k + 1 < states.length ? states[k + 1] : T) - s}`).join(',');
}

/** The spec's first version: age from the pair's FIRST message. */
class FirstMessageView extends View {
  /** @param {{ l: number, i: number }} a @param {number} T */
  due(a, T) {
    return (T - startOf(a)) / 2 ** (a.l + 2);
  }
}

/** Every line one byte and every parent built: the budget counts lines. */
const lineTree = { built: () => true, bytes: () => 1 };

/** Steps 0..N-1 where a view with push's list length as budget makes push's lines. @param {typeof View} Kind @param {number} N */
function agreeingSteps(Kind, N) {
  const view = new Kind(lineTree, 1, 1);
  /** @type {States} */
  let list = null;
  let agree = 0;
  let firstMiss = -1;
  for (let t = 0; t < N; t++) {
    list = push(t, list);
    const want = pushLines(list, t + 1);
    view.high = view.low = want.split(',').length;
    view.add(t);
    if (names(view) === want) agree++;
    else if (firstMiss < 0) firstMiss = t;
  }
  return { agree, firstMiss };
}

test('with push\'s list length as the budget, the fold makes exactly push\'s merges at every step', () => {
  const { agree, firstMiss } = agreeingSteps(View, 5000);
  assert.equal(firstMiss, -1, `the fold left push's lines at step ${firstMiss}`);
  assert.equal(agree, 5000);
});

test('measuring a pair\'s age from its first message leaves push\'s lines (the spec\'s bug)', () => {
  const { agree, firstMiss } = agreeingSteps(FirstMessageView, 5000);
  // Step 9 holds T = 10 messages: the spec's example, where it merges 0-7 instead of 8-9.
  assert.equal(firstMiss, 9);
  assert.ok(agree < 500, `the first-message order agreed at ${agree} of 5000 steps`);
});

/** Fold N messages one by one; every view after each message. @param {number} N @param {number} high @param {number} low @param {number} size */
function foldAll(N, high, low, size) {
  const tree = new MemoryTree().fill(N, size);
  const view = new View(tree, high, low);
  const snapshots = [];
  for (let i = 0; i < N; i++) {
    const merges = view.add(i);
    snapshots.push({ parts: view.parts.map((p) => ({ ...p })), size: view.size(), merges });
  }
  return snapshots;
}

test('the view tiles the whole history, oldest first, and stays at or under the ceiling when parents exist', () => {
  const snapshots = foldAll(1000, 4000, 2000, 100);
  for (const [k, { parts, size }] of snapshots.entries()) {
    assert.ok(size <= 4000, `view ${k} is ${size} bytes`);
    let next = 0;
    for (const part of parts) {
      const [from, to] = range(part);
      assert.equal(from, next, `view ${k} has a gap or overlap at ${from}`);
      next = to;
    }
    assert.equal(next, k + 1, `view ${k} must cover messages 0..${k}`);
  }
});

test('a sawtooth: each new message only appends until the view passes its ceiling, then one batch takes it to its floor', () => {
  const snapshots = foldAll(1000, 4000, 2000, 100);
  let batches = 0;
  for (let k = 1; k < snapshots.length; k++) {
    const before = snapshots[k - 1];
    const now = snapshots[k];
    if (now.merges === 0) {
      // Nothing but the new line: the old view is the start of the new one.
      assert.deepEqual(now.parts.slice(0, -1), before.parts, `message ${k} changed an old line without a batch`);
      assert.ok(before.size + 100 <= 4000, `message ${k} passed the ceiling without a batch`);
    } else {
      batches++;
      assert.ok(before.size + 100 > 4000, `message ${k} merged below the ceiling`);
      assert.ok(now.size <= 2000, `the batch at message ${k} stopped at ${now.size} bytes`);
      assert.ok(now.merges > 1, 'a batch merges many pairs at once');
    }
  }
  assert.ok(batches >= 10, `only ${batches} batches over 1000 messages`);
});

test('a merged line is never split again: every old line lies inside one new line', () => {
  const snapshots = foldAll(600, 1500, 750, 100);
  for (let k = 1; k < snapshots.length; k++) {
    for (const old of snapshots[k - 1].parts) {
      const [from, to] = range(old);
      const holder = snapshots[k].parts.find((p) => range(p)[0] <= from && to <= range(p)[1]);
      assert.ok(holder, `view ${k} split line ${from}+${to - from}`);
    }
  }
});

test('a batch merges only built parents; short of the floor it merges what it can at each new message until it gets there', () => {
  const tree = new MemoryTree();
  for (let i = 0; i < 40; i++) tree.set(0, i, 'x'.repeat(100));
  const view = new View(tree, 1000, 500);
  for (let i = 0; i < 10; i++) assert.equal(view.add(i), 0);
  // Message 10 passes the ceiling, but no parent is built: nothing merges.
  assert.equal(view.add(10), 0);
  assert.equal(view.shrinking, true);
  assert.equal(view.parts.length, 11);
  // Two parents become available; building them alone changes nothing.
  tree.set(1, 0, 'a'.repeat(100)).set(1, 1, 'b'.repeat(100));
  assert.equal(view.parts.length, 11);
  // The next message merges what it can, still short of the floor.
  assert.equal(view.add(11), 2);
  assert.equal(names(view), '0+2,2+2,4+1,5+1,6+1,7+1,8+1,9+1,10+1,11+1');
  assert.equal(view.shrinking, true);
  for (let l = 1; l <= 3; l++) for (let i = 0; (i + 1) * 2 ** l <= 12; i++) tree.set(l, i, `${l}`.repeat(100));
  view.add(12);
  assert.ok(view.size() <= 500, `the catch-up stopped at ${view.size()} bytes`);
  assert.equal(view.shrinking, false);
  // Back under the floor, a new message only appends again.
  const before = names(view);
  assert.equal(view.add(13), 0);
  assert.equal(names(view), `${before},13+1`);
});

test('a stored view is taken back as it was, and refused when it does not tile the history', () => {
  const tree = new MemoryTree().fill(64, 100);
  const live = new View(tree, 2000, 1000);
  for (let i = 0; i < 50; i++) live.add(i);
  const stored = JSON.parse(JSON.stringify(live));
  const loaded = new View(tree, 2000, 1000);
  assert.equal(loaded.load(stored, 50), '');
  assert.deepEqual(loaded.parts, live.parts);
  assert.equal(loaded.covered(), 50);
  // Fewer messages than the history holds is fine: the rest are added as live.
  assert.equal(new View(tree, 2000, 1000).load(stored, 60), '');
  assert.match(new View(tree, 2000, 1000).load(stored, 40), /covers 50 messages and the history holds 40/);
  assert.match(new View(tree, 2000, 1000).load({ parts: [[0, 0], [0, 2]], shrinking: false }, 50), /does not start at message 1/);
  assert.match(new View(new MemoryTree(), 2000, 1000).load({ parts: [[1, 0]], shrinking: false }, 50), /0\+2 is not in the tree/);
  assert.match(new View(tree, 2000, 1000).load([[0, 0]], 50), /not a view/);
});

test('an unbuilt line renders as the placeholder, and a line\'s newlines as spaces', () => {
  const tree = new MemoryTree().set(0, 0, 'you: hello').set(0, 1, 'Assistant: hi');
  const view = new View(tree, 10_000, 5000);
  for (let i = 0; i < 3; i++) view.add(i);
  assert.equal(view.allBuilt(), false);
  assert.equal(renderView(view, tree), `<chat>\n0+1|you: hello\n1+1|Assistant: hi\n2+1|${PLACEHOLDER}\n</chat>`);
  tree.set(0, 2, 'did: two\nlines');
  assert.equal(view.allBuilt(), true);
  assert.equal(lineOf({ l: 0, i: 2 }, tree.text(0, 2)), '2+1|did: two lines');
});

// Lines may now be up to 1.25 times the 512-byte limit: the budget is bytes, so it still holds.
test('with 640-byte lines the view still stays under its 128,000-byte ceiling and each batch reaches its 64,000-byte floor', () => {
  const snapshots = foldAll(2000, 128_000, 64_000, 640);
  let batches = 0;
  for (const { size, merges } of snapshots) {
    assert.ok(size <= 128_000, `a ${size}-byte view`);
    if (merges > 0) {
      batches++;
      assert.ok(size <= 64_000, `a batch stopped at ${size} bytes`);
    }
  }
  assert.ok(batches >= 5, `${batches} batches`);
});
