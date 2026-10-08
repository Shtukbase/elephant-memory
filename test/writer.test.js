// The writer: free nodes need no model call; a message's line starts once
// fewer than eight lines before it are unbuilt; a merge starts once both halves
// are built; each call's context is the compaction view up to the node,
// stopping at the first unbuilt line; the tasks and the "Too long" retry are
// the spec's, three tries at most, the shortest valid one kept and trimmed
// when none fits; a try in a script its sources do not use is invalid.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEP } from '../lib/prompts.js';
import { stripHeads } from '../lib/text.js';
import { PLACEHOLDER, View } from '../lib/view.js';
import { Writer } from '../lib/writer.js';
import { MemoryTree, settleTicks } from './fixtures.js';

const TAGS = { user: 'you', talk: 'Assistant', tool: 'did', echo: 'result', work: 'colleague', note: 'note' };

/** @param {string[]} texts @param {string[]} [kinds] */
function entriesOf(texts, kinds = []) {
  return texts.map((text, i) => ({ i, kind: /** @type {any} */ (kinds[i] ?? (i % 2 === 0 ? 'user' : 'talk')), text, size: Buffer.byteLength(text), time: 0 }));
}

/**
 * A writer over `entries` with an in-memory tree that records saves; its
 * compaction view holds every message.
 * @param {ReturnType<typeof entriesOf>} entries
 * @param {import('../lib/writer.js').Summarize} summarize
 * @param {{ lineBytes?: number, tree?: MemoryTree }} [options]
 */
function writerFor(entries, summarize, { lineBytes = 512, tree = new MemoryTree() } = {}) {
  /** @type {string[]} */
  const saves = [];
  /** @type {string[]} */
  const warnings = [];
  const store = Object.assign(tree, {
    save: (/** @type {number} */ l, /** @type {number} */ i, /** @type {string} */ text) => {
      saves.push(`${l}:${i}`);
      tree.set(l, i, text);
    },
  });
  const compactionView = new View(store, 1_000_000, 500_000);
  for (const entry of entries) compactionView.add(entry.i);
  const writer = new Writer({
    entries,
    tree: /** @type {any} */ (store),
    compactionView,
    tagged: (entry) => `${TAGS[entry.kind]}: ${entry.text}`,
    lineBytes,
    summarize,
    canCall: () => true,
    warn: (message) => warnings.push(message),
    saved: () => {},
  });
  return { writer, tree, compactionView, saves, warnings };
}

/** A summarize whose calls wait until the test answers them. */
function heldCalls() {
  /** @type {{ context: string, task: string, answer: (text: string) => void }[]} */
  const calls = [];
  /** @type {import('../lib/writer.js').Summarize} */
  const summarize = (turns) => new Promise((resolve) => {
    const first = /** @type {{ role: 'user', texts: string[] }} */ (turns[0]);
    calls.push({ context: first.texts[0], task: first.texts[1], answer: (text) => resolve({ text, message: null }) });
  });
  return { calls, summarize };
}

test('a free line that cannot be stored (a full disk) never throws into the event loop, skips nothing, and is stored on the next try', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entries = entriesOf(['hello there', 'hi, what is up?', 'move the task to next week', 'done']);
  const { writer, tree, warnings } = writerFor(entries, async () => ({ text: 'never', message: null }));
  const store = /** @type {any} */ (writer.host.tree);
  const save = store.save;
  let full = true;
  store.save = (/** @type {number} */ l, /** @type {number} */ i, /** @type {string} */ text) => {
    if (full && l === 0 && i === 1) throw new Error('ENOSPC: no space left on device');
    save(l, i, text);
  };
  assert.doesNotThrow(() => writer.pump());
  assert.equal(tree.built(0, 0), true);
  assert.equal(tree.built(0, 1), false, 'the line that failed is not built');
  assert.equal(tree.built(0, 2), false, 'and no later line was taken past it');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be stored, trying again every 10 s: ENOSPC/);
  assert.doesNotThrow(() => t.mock.timers.tick(10_000));
  assert.equal(warnings.length, 1, 'the same failure is said once');
  full = false;
  t.mock.timers.tick(10_000);
  assert.deepEqual([0, 1, 2, 3].map((i) => tree.built(0, i)), [true, true, true, true]);
  assert.equal(tree.built(2, 0), true, 'the merges above it were queued and built too');
  writer.close();
});

test('a short message is its own line, word for word, and two lines that fit are joined, with no model call', () => {
  let calls = 0;
  const entries = entriesOf(['hello there', 'hi, what is up?', 'move the task to next week', 'done']);
  const { writer, tree } = writerFor(entries, async () => {
    calls++;
    return { text: 'never', message: null };
  });
  writer.pump();
  assert.equal(calls, 0);
  assert.equal(tree.text(0, 0), 'you: hello there');
  assert.equal(tree.text(0, 1), 'Assistant: hi, what is up?');
  assert.equal(tree.text(1, 0), 'you: hello there\nAssistant: hi, what is up?');
  assert.equal(tree.text(2, 0), 'you: hello there\nAssistant: hi, what is up?\nyou: move the task to next week\nAssistant: done');
});

test('a message\'s line starts once fewer than eight lines before it are unbuilt, and its context stops at the first unbuilt line', async () => {
  const texts = Array.from({ length: 12 }, (_, i) => `message-${i} ${'x'.repeat(600)}`);
  const { calls, summarize } = heldCalls();
  const { writer } = writerFor(entriesOf(texts), summarize);
  writer.pump();
  await settleTicks();
  assert.deepEqual(calls.map((call) => Number(/message-(\d+)/.exec(call.task)?.[1])), [0, 1, 2, 3, 4, 5, 6, 7]);
  // Message 0 had nothing before it; the others stop at unbuilt message 0.
  for (const call of calls) assert.equal(call.context, '<chat>\n\n</chat>');
  assert.equal(calls.length, 8, 'message 8 started while eight lines before it were unbuilt');
  // Seven unbuilt lines before message 8 (0, 1, 2, 4, 5, 6, 7): it starts.
  calls[3].answer('S3');
  await settleTicks();
  assert.equal(calls.length, 9, 'message 8 did not start once fewer than eight lines before it were unbuilt');
  assert.equal(calls[8].context, '<chat>\n\n</chat>', 'message 8\'s context did not stop at unbuilt message 0');
  calls[0].answer('S0');
  await settleTicks();
  assert.equal(calls.length, 10);
  // Message 9's context: line 0 is built, line 1 is not, so it stops there.
  assert.equal(calls[9].context, '<chat>\n0+1|S0\n</chat>');
  for (const call of calls) assert.ok(!call.context.includes(PLACEHOLDER), 'a writer call saw an unsummarized line');
});

test('the compress task is the spec\'s, with a ruler of the limit in dashes and the message whole', async () => {
  const { calls, summarize } = heldCalls();
  const { writer } = writerFor(entriesOf(['short', 'y'.repeat(700)]), summarize);
  writer.pump();
  await settleTicks();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context, '<chat>\n0+1|you: short\n</chat>');
  assert.equal(calls[0].task, `Compaction: compress message 1 into one line of at most 512 bytes
(about 70 words), the length of this ruler:
${'-'.repeat(512)}
Write the line in the language of the messages it summarizes.
${KEEP}
<input>
Assistant: ${'y'.repeat(700)}
</input>`);
});

test('a merge starts once both halves are built; its task names the lines and its messages, and its context runs to its last message', async () => {
  const { calls, summarize } = heldCalls();
  const texts = Array.from({ length: 4 }, (_, i) => `m${i} ${'z'.repeat(300)}`);
  const { writer, tree } = writerFor(entriesOf(texts), summarize, { lineBytes: 512 });
  writer.pump();
  await settleTicks();
  // Every message fits as its own line, but no two lines fit together.
  assert.equal(tree.built(0, 3), true);
  assert.deepEqual(calls.map((call) => call.task.split('\n')[0]), [
    'Compaction: merge lines 0+1 and 1+1, adjacent, into one line of at most',
    'Compaction: merge lines 2+1 and 3+1, adjacent, into one line of at most',
  ]);
  assert.equal(calls[1].task, `Compaction: merge lines 2+1 and 3+1, adjacent, into one line of at most
512 bytes (about 70 words), the length of this ruler:
${'-'.repeat(512)}
Write the line in the language of the messages it summarizes.
${KEEP}
<chat> may hold their messages, 2 to 3, in more detail: take details
of them from there too.
Use only facts present in the lines being merged and in those messages.
<input>
2+1|you: ${texts[2]}
3+1|Assistant: ${texts[3]}
</input>`);
  assert.equal(calls[1].context, `<chat>\n0+1|you: ${texts[0]}\n1+1|Assistant: ${texts[1]}\n2+1|you: ${texts[2]}\n3+1|Assistant: ${texts[3]}\n</chat>`);
  calls[0].answer('A');
  await settleTicks();
  assert.equal(calls.length, 2, 'the top merge started before both halves were built');
  calls[1].answer('B');
  await settleTicks();
  // A + "\n" + B fits: the top merge is a free node.
  assert.equal(tree.text(2, 0), 'A\nB');
});

test('a stored tree\'s ready merges are queued when the writer opens', async () => {
  const tree = new MemoryTree().set(0, 0, 'x'.repeat(300)).set(0, 1, 'y'.repeat(300));
  const { calls, summarize } = heldCalls();
  const { writer } = writerFor(entriesOf(['a', 'b']), summarize, { tree });
  writer.pump();
  await settleTicks();
  assert.equal(calls.length, 1);
  assert.match(calls[0].task, /^Compaction: merge lines 0\+1 and 1\+1/);
});

// A 201-turn trial run on 2026-10-08: 3,133 writer calls over 201 turns, mostly "Too long" retries.
test('a line over the limit gets the spec\'s "Too long" retry at 0.75 of the limit, three tries at most; when none fits even 1.25× the limit the shortest is trimmed at a word boundary and counted', async () => {
  const words = (/** @type {number} */ n) => Array.from({ length: n }, (_, k) => `w${k}`).join(' ');
  const answers = [words(30), words(28), words(26)];
  /** @type {any[][]} */
  const seen = [];
  const { writer, tree, warnings } = writerFor(entriesOf(['y'.repeat(200)]), async (turns) => {
    seen.push(turns.map((turn) => ({ ...turn })));
    return { text: answers[seen.length - 1] ?? answers[2], message: { attempt: seen.length } };
  }, { lineBytes: 64 });
  writer.pump();
  await settleTicks();
  assert.equal(seen.length, 3, 'more than three tries for one line');
  const second = seen[1];
  assert.equal(second.length, 3);
  assert.deepEqual(second[1], { role: 'assistant', message: { attempt: 1 } });
  assert.equal(second[2].texts[0], `Too long: your line is ${Buffer.byteLength(answers[0])} bytes, over the 48-byte limit. Write
the whole line again for the same <input>, cutting just enough of the
least valuable items to fit before this cut:
${answers[0].slice(0, 48)}| ← LIMIT`);
  const line = /** @type {string} */ (tree.text(0, 0));
  assert.ok(Buffer.byteLength(line) <= 80, `the kept line is ${Buffer.byteLength(line)} bytes, over the 1.25× tolerance of 64`);
  assert.ok(line.endsWith('…') && answers[2].startsWith(line.slice(0, -1)), 'not the shortest try, trimmed');
  assert.match(line, /w\d+…$/, 'trimmed inside a word');
  assert.equal(writer.trimmed, 1);
  assert.match(warnings.join('\n'), /line 0:0 fit in no try and was trimmed to \d+ bytes; 1 lines trimmed since the memory opened/);
});

// A hard cut at 512 would have trimmed 27.5% of the 201-turn run's lines.
test('a try up to 1.25 times the limit fits with no retry and no cut; one byte more is retried with the cut mark at 0.75 of the limit', async () => {
  for (const [first, calls] of [[640, 1], [641, 2]]) {
    /** @type {any[][]} */
    const seen = [];
    const { writer, tree } = writerFor(entriesOf(['y'.repeat(900)]), async (turns) => {
      seen.push(turns.map((turn) => ({ ...turn })));
      return { text: seen.length === 1 ? 'x'.repeat(first) : 'z'.repeat(400), message: null };
    });
    writer.pump();
    await settleTicks();
    assert.equal(seen.length, calls, `a ${first}-byte try made ${seen.length} calls`);
    assert.equal(writer.trimmed, 0);
    if (calls === 1) assert.equal(tree.text(0, 0), 'x'.repeat(640), 'a 640-byte try was changed');
    else {
      assert.match(seen[1][2].texts[0], /^Too long: your line is 641 bytes, over the 384-byte limit\./);
      assert.equal(tree.text(0, 0), 'z'.repeat(400));
    }
  }
});

// A 201-turn trial run on 2026-10-08: 74 of 1,182 lines were Chinese, from no Chinese source.
test('a try in a CJK script its sources do not use is invalid: "Wrong language" feedback, and the next valid try is kept', async () => {
  const answers = ['用户要求发布说明只列出发布的内容', 'you: release notes list only what ships'];
  /** @type {any[][]} */
  const seen = [];
  const { writer, tree } = writerFor(entriesOf(['y'.repeat(600)]), async (turns) => {
    seen.push(turns.map((turn) => ({ ...turn })));
    return { text: answers[seen.length - 1], message: null };
  });
  writer.pump();
  await settleTicks();
  assert.equal(seen.length, 2);
  assert.match(seen[1][2].texts[0], /^Wrong language: <input> holds no Chinese, Japanese or Korean text\./);
  assert.equal(tree.text(0, 0), 'you: release notes list only what ships');
});

test('a line whose every try invents a CJK script fails and waits; a source that holds CJK text may be summarized in it', async () => {
  const bad = writerFor(entriesOf(['y'.repeat(600)]), async () => ({ text: '发布说明', message: null }));
  bad.writer.pump();
  await settleTicks();
  assert.equal(bad.tree.built(0, 0), false);
  assert.match(bad.writer.lastError, /script its messages do not use/);
  bad.writer.close();
  const good = writerFor(entriesOf([`${'y'.repeat(600)} 发布说明`]), async () => ({ text: '发布说明', message: null }));
  good.writer.pump();
  await settleTicks();
  assert.equal(good.tree.text(0, 0), '发布说明');
});

test('a line that fits on the second try stops there, and a copied id+n| head is dropped', async () => {
  let calls = 0;
  const { writer, tree } = writerFor(entriesOf(['y'.repeat(200)]), async () => {
    calls++;
    return { text: calls === 1 ? 'w'.repeat(100) : '0+1|short enough', message: null };
  }, { lineBytes: 64 });
  writer.pump();
  await settleTicks();
  assert.equal(calls, 2);
  assert.equal(tree.text(0, 0), 'short enough');
});

// D14, a 235-turn run on deepseek-flash: 66% of new lines were over 512 bytes, 29% fit in no try even at 640.
test('the retry after a try past the tolerance draws its cut mark at 0.75 of the limit, and a model that follows the mark lands under the tolerance', async () => {
  /** @type {any[][]} */
  const seen = [];
  const { writer, tree } = writerFor(entriesOf(['y'.repeat(900)]), async (turns) => {
    seen.push(turns.map((turn) => ({ ...turn })));
    if (seen.length === 1) return { text: 'x'.repeat(700), message: null };
    // A model that follows the ruler: it writes exactly what lies before the mark.
    const feedback = /** @type {{ texts: string[] }} */ (turns.at(-1)).texts[0];
    const cut = /before this cut:\n([\s\S]*)\| ← LIMIT$/.exec(feedback)?.[1] ?? '';
    return { text: cut, message: null };
  });
  writer.pump();
  await settleTicks();
  assert.equal(seen.length, 2, 'the second try fit, so no third call');
  const feedback = seen[1][2].texts[0];
  assert.match(feedback, /^Too long: your line is 700 bytes, over the 384-byte limit\. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n/);
  assert.equal(feedback.endsWith(`${'x'.repeat(384)}| ← LIMIT`), true, 'the cut mark is not at 384 bytes');
  assert.equal(tree.text(0, 0), 'x'.repeat(384));
  assert.equal(writer.trimmed, 0);
});

test('a model whose retry overshoots the cut mark by half still lands under the tolerance, where the mark at the true limit would have missed it', async () => {
  /** @type {any[][]} */
  const seen = [];
  const { writer, tree } = writerFor(entriesOf(['y'.repeat(900)]), async (turns) => {
    seen.push(turns.map((turn) => ({ ...turn })));
    if (seen.length === 1) return { text: 'x'.repeat(700), message: null };
    const feedback = /** @type {{ texts: string[] }} */ (turns.at(-1)).texts[0];
    const cut = /before this cut:\n([\s\S]*)\| ← LIMIT$/.exec(feedback)?.[1] ?? '';
    return { text: cut + 'z'.repeat(cut.length / 2), message: null };
  });
  writer.pump();
  await settleTicks();
  assert.equal(seen.length, 2, `${seen.length} tries: the overshoot of the second try was still past 640 bytes`);
  assert.equal(Buffer.byteLength(/** @type {string} */ (tree.text(0, 0))), 576);
  assert.equal(writer.trimmed, 0);
});

// D14: a merge reply that copies both of its input lines carried a second head (`625+1|` stored on a second line).
test('a head on any line of a try is dropped before the try is measured and stored', async () => {
  let calls = 0;
  const { writer, tree } = writerFor(entriesOf(['y'.repeat(200)]), async () => {
    calls++;
    // 30 + 1 + 6 + 45 = 82 bytes with the head, 76 without: over 1.25 x 64 = 80 only while the head counts.
    return { text: `0+1|${'a'.repeat(30)}\n625+1|${'b'.repeat(45)}`, message: null };
  }, { lineBytes: 64 });
  writer.pump();
  await settleTicks();
  assert.equal(calls, 1, 'the head was measured: the try looked too long and was asked again');
  assert.equal(tree.text(0, 0), `${'a'.repeat(30)}\n${'b'.repeat(45)}`);
});

test('stripHeads takes every id+n| head at the start of a line, repeated or indented, and nothing inside a line', () => {
  assert.equal(stripHeads('625+1|did: read'), 'did: read');
  assert.equal(stripHeads('  0+1| 1+1|  one'), 'one');
  assert.equal(stripHeads('one\n  625+1|two\n3+4|three'), 'one\ntwo\nthree');
  assert.equal(stripHeads('x = 3+4|5 and result: 16+0|y'), 'x = 3+4|5 and result: 16+0|y', 'a middle of a line is the line\'s own words');
  assert.equal(stripHeads('625+1|'), '');
});
