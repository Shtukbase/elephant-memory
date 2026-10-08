// Looking back: zoom addressing (id+n names messages, not tree coordinates),
// date, and the raw search.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateOf, recallSearch, zoom } from '../lib/recall.js';
import { longDate } from '../lib/text.js';
import { PLACEHOLDER } from '../lib/view.js';
import { MemoryTree } from './fixtures.js';

const CONFIG = { agentName: 'Assistant', you: 'you', granularity: /** @type {const} */ ('turn'), lineBytes: 512 };

/** Eight messages and a complete tree whose node (l, i) reads "L<l>.<i>". */
function memoryOf(texts = Array.from({ length: 8 }, (_, i) => `message ${i}`)) {
  const tree = new MemoryTree();
  for (let l = 0; 2 ** l <= texts.length; l++) {
    for (let i = 0; (i + 1) * 2 ** l <= texts.length; i++) tree.set(l, i, `L${l}.${i}`);
  }
  const entries = texts.map((text, i) => ({
    i,
    kind: /** @type {any} */ (i % 2 === 0 ? 'user' : 'talk'),
    text,
    size: Buffer.byteLength(text),
    time: 1_760_000_000_000 + i * 60_000,
  }));
  return { size: entries.length, entry: (/** @type {number} */ i) => entries[i], tree, config: CONFIG };
}

test('zoom opens id+n into its two halves, named by message ids', () => {
  const memory = memoryOf();
  assert.equal(zoom(memory, 0, 8), '0+4|L2.0\n4+4|L2.1');
  assert.equal(zoom(memory, 4, 4), '4+2|L1.2\n6+2|L1.3');
  assert.equal(zoom(memory, 6, 2), '6+1|L0.6\n7+1|L0.7');
});

test('zoom(id, 1) gives the message whole, with its source tag', () => {
  const memory = memoryOf();
  assert.equal(zoom(memory, 5, 1), '5+0|Assistant: message 5');
  assert.equal(zoom(memory, 2, 1), '2+0|you: message 2');
});

test('zoom refuses a line that does not exist', () => {
  const memory = memoryOf();
  for (const [id, n] of [[3, 3], [2, 4], [8, 1], [4, 8], [-1, 1], ['x', 1], [0, 0]]) {
    assert.equal(zoom(memory, id, n), `No line ${id}+${n}.`, `zoom(${id}, ${n})`);
  }
});

test('a half not summarized yet shows the placeholder', () => {
  const memory = memoryOf();
  memory.tree.nodes.delete('1:3');
  assert.equal(zoom(memory, 4, 4), `4+2|L1.2\n6+2|${PLACEHOLDER}`);
});

test('date names when a message was written', () => {
  const memory = memoryOf();
  assert.equal(dateOf(memory, 2), longDate(1_760_000_000_000 + 2 * 60_000));
  assert.equal(dateOf(memory, 99), 'No message 99.');
});

test('recall_search finds raw words, newest first, as id|kind|date|snippet', () => {
  const memory = memoryOf(['the release notes', 'ok', 'Release on Friday', 'nothing here']);
  const hits = recallSearch(memory, 'release').split('\n');
  assert.deepEqual(hits.map((hit) => hit.split('|').slice(0, 2)), [['2', 'you'], ['0', 'you']]);
  assert.equal(hits[0].split('|')[3], 'Release on Friday');
  assert.equal(recallSearch(memory, '/fri(day)?$/i').split('|')[0], '2');
  assert.equal(recallSearch(memory, 'absent'), 'No message contains "absent".');
  assert.equal(recallSearch(memory, '  '), 'The search needs words to look for.');
  assert.match(recallSearch(memory, '/(/'), /^That pattern is not a valid regular expression/);
});

test('a pattern that backtracks without end is stopped at the time limit and said plainly, never left to hold the thread', () => {
  const memory = memoryOf(['a'.repeat(40) + '!', 'plain words']);
  const started = Date.now();
  const answer = recallSearch(memory, '/(a+)+$/', 100);
  assert.ok(Date.now() - started < 5_000, 'the search returned');
  assert.equal(answer, 'That pattern is not one this search can finish within 0.1 s. Search for plain words, or a simpler pattern.');
  // A pattern that finishes still finds, through the same stopped-in-time scan.
  assert.equal(recallSearch(memory, '/^plain/', 100).split('|')[0], '1');
});
