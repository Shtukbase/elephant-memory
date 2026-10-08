// The stored views: the chat's view is written after every change and loaded at
// open, never rebuilt from the history while its file is usable (a rebuilt
// view differs from the live one and kills every cached prefix); a missing or
// unusable file is rebuilt and logged. The compaction view is the chat's view
// merged to a quarter, takes the same new lines, and is derived again when the
// chat's view merges.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { Memory } from '../lib/memory.js';
import { View, countOf, startOf } from '../lib/view.js';
import { keptLog, rootsForThisFile, settleTicks } from './fixtures.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

const KEY = { agent: '/agents/scout', project: '/work/board' };

/** @param {string} dir @param {Record<string, unknown>} [config] @param {import('../lib/writer.js').Summarize} [summarize] */
function open(dir, config = {}, summarize = async () => {
  throw new Error('no model call was expected');
}) {
  const log = keptLog();
  const memory = new Memory({ memoryId: 'abcdef0123456789', key: KEY, dir, config: resolveConfig(config), summarize, log });
  return { memory, log };
}

/** @param {Memory} memory @param {number} turn @param {string} text */
function turn(memory, turn, text) {
  memory.appendTurn({ sessionId: 's1', sessionTitle: '', turn, at: turn, entries: [{ kind: 'user', text, time: turn }, { kind: 'talk', text: `ok ${turn}`, time: turn }] });
  memory.writer.pump();
}

/** @param {{ parts: { l: number, i: number }[] }} view */
const names = (view) => view.parts.map((p) => `${startOf(p)}+${countOf(p)}`).join(',');
const viewPath = (/** @type {string} */ dir) => path.join(dir, 'view-turn-v1.json');

test('the view is written after every change, and a reopened memory loads it as it was, never folding it again', () => {
  const dir = roots.fresh();
  const first = open(dir).memory;
  turn(first, 1, 'hello');
  assert.deepEqual(JSON.parse(fs.readFileSync(viewPath(dir), 'utf8')), { parts: [[0, 0], [0, 1]], shrinking: false });
  turn(first, 2, 'bye');
  assert.deepEqual(JSON.parse(fs.readFileSync(viewPath(dir), 'utf8')).parts, [[0, 0], [0, 1], [0, 2], [0, 3]]);
  first.close();
  // A layout no fold of this history makes: only loading the file gives it back.
  fs.writeFileSync(viewPath(dir), JSON.stringify({ parts: [[1, 0], [0, 2], [0, 3]], shrinking: false }));
  const again = open(dir);
  assert.equal(names(again.memory.view), '0+2,2+1,3+1', 'the view was folded again from the history instead of loaded');
  assert.equal(again.memory.render(), '<chat>\n0+2|you: hello Scout: ok 1\n2+1|you: bye\n3+1|Scout: ok 2\n</chat>');
  assert.deepEqual(again.log.warnings, []);
  again.memory.close();
});

test('messages the stored view does not cover yet are added as live, without a rebuild', () => {
  const dir = roots.fresh();
  const first = open(dir).memory;
  turn(first, 1, 'hello');
  const stored = fs.readFileSync(viewPath(dir), 'utf8');
  turn(first, 2, 'bye');
  first.close();
  // A crash between the order append and the view write.
  fs.writeFileSync(viewPath(dir), JSON.stringify({ ...JSON.parse(stored), parts: [[1, 0]] }));
  const again = open(dir);
  assert.equal(names(again.memory.view), '0+2,2+1,3+1');
  assert.deepEqual(again.log.warnings, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(viewPath(dir), 'utf8')).parts, [[1, 0], [0, 2], [0, 3]], 'the caught-up view was not written');
  again.memory.close();
});

test('a missing or unusable view file is rebuilt from the history, and the rebuild is logged', () => {
  for (const [damage, reason] of [[() => {}, /its file is missing/], [(/** @type {string} */ file) => fs.writeFileSync(file, '{not json'), /could not be read/], [(/** @type {string} */ file) => fs.writeFileSync(file, JSON.stringify({ parts: [[0, 0], [0, 5]], shrinking: false })), /does not start at message 1/]]) {
    const dir = roots.fresh();
    const first = open(dir).memory;
    turn(first, 1, 'hello');
    first.close();
    fs.rmSync(viewPath(dir));
    /** @type {(file: string) => void} */ (damage)(viewPath(dir));
    const again = open(dir);
    assert.equal(names(again.memory.view), '0+1,1+1');
    assert.equal(again.log.warnings.length, 1);
    assert.match(again.log.warnings[0], /view-turn-v1\.json was rebuilt from the history/);
    assert.match(again.log.warnings[0], /** @type {RegExp} */ (reason));
    again.memory.close();
  }
});

test('the compaction view is the chat\'s view merged to a quarter, takes the same new lines, and is derived again when the chat\'s view merges', async () => {
  const dir = roots.fresh();
  // Chat view 512 → 330 bytes; compaction view 128 → 82 bytes: their cycles
  // never line up, so a chat batch finds the compaction view above its floor.
  const config = { lineBytes: 64, viewBytes: 512, viewFloorBytes: 330 };
  // Messages fit as their own lines; every merge is a short model line.
  let n = 0;
  const { memory } = open(dir, config, async () => ({ text: `S${n++}`, message: null }));
  const cv = memory.compactionView;
  assert.deepEqual([cv.high, cv.low], [128, 82]);
  let chatBatches = 0;
  let cvOnly = 0;
  for (let t = 1; t <= 80; t++) {
    const before = names(memory.view);
    const beforeCv = names(cv);
    // One message per turn, so each turn is one step of both views.
    memory.appendTurn({ sessionId: 's1', sessionTitle: '', turn: t, at: t, entries: [{ kind: 'user', text: `m${t}`.padEnd(30, '.'), time: t }] });
    // Checked at once: the summaries written later must not change the picture.
    const chatMerged = !names(memory.view).startsWith(before);
    if (chatMerged) {
      chatBatches++;
      // Derived again: the chat's view, merged down to the compaction floor.
      const derived = new View(memory.tree, cv.high, cv.low);
      derived.copyFrom(memory.view);
      derived.shrink(memory.size, cv.low);
      assert.equal(names(cv), names(derived), `the compaction view was not derived again from the chat's batch at turn ${t}`);
    } else if (!names(cv).startsWith(beforeCv)) {
      // Its own batch, past its ceiling.
      cvOnly++;
    } else {
      assert.equal(names(cv), [beforeCv, `${t - 1}+1`].filter(Boolean).join(','), `turn ${t} did more than append to the compaction view`);
    }
    // Always coarser than the chat's view, over the same messages.
    assert.equal(cv.covered(), memory.size);
    for (const part of memory.view.parts) {
      assert.ok(cv.parts.some((c) => startOf(c) <= startOf(part) && startOf(part) + countOf(part) <= startOf(c) + countOf(c)), `chat line ${startOf(part)}+${countOf(part)} is not inside a compaction line`);
    }
    await settleTicks();
  }
  assert.ok(chatBatches >= 1 && cvOnly >= 1, `chat batches ${chatBatches}, compaction-only batches ${cvOnly}`);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'compaction-view-turn-v1.json'), 'utf8'));
  assert.deepEqual(stored, JSON.parse(JSON.stringify(cv)));
  memory.close();
  const again = open(dir, config);
  assert.equal(names(again.memory.compactionView), names(cv));
  again.memory.close();
});
