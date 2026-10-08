// Batched writer calls (README, deviation 20): nodes ready together share one
// call, up to `writer.batch`, packed only from the queues' ready nodes; each job
// is judged alone (heads, the CJK guard, the 1.25× tolerance, three tries, the
// trim), the first try aims at 0.75 of the limit, a job that fits is stored at
// once, and a bad or missing one is asked again alone in the same conversation,
// or fails alone and comes back in a later call. With `writer.batch = 1` every call is the one-line call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchTask, replyLines } from '../lib/batch-prompts.js';
import { resolveConfig } from '../lib/config.js';
import { KEEP, compressTask } from '../lib/prompts.js';
import { PLACEHOLDER, View } from '../lib/view.js';
import { Writer } from '../lib/writer.js';
import { MemoryTree, jobsOf, settleTicks } from './fixtures.js';

const TAGS = { user: 'you', talk: 'Assistant' };

/** @param {string[]} texts */
function entriesOf(texts) {
  return texts.map((text, i) => ({ i, kind: /** @type {any} */ (i % 2 === 0 ? 'user' : 'talk'), text, size: Buffer.byteLength(text), time: 0 }));
}

/**
 * A writer over `entries` with an in-memory tree and a compaction view of every message.
 * @param {ReturnType<typeof entriesOf>} entries @param {import('../lib/writer.js').Summarize} summarize
 * @param {{ batch?: number, lineBytes?: number }} [options]
 */
function writerFor(entries, summarize, { batch, lineBytes = 512 } = {}) {
  const tree = new MemoryTree();
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const infos = [];
  const store = Object.assign(tree, { save: (/** @type {number} */ l, /** @type {number} */ i, /** @type {string} */ text) => tree.set(l, i, text) });
  const compactionView = new View(store, 1_000_000, 500_000);
  for (const entry of entries) compactionView.add(entry.i);
  const writer = new Writer({
    entries,
    tree: /** @type {any} */ (store),
    compactionView,
    tagged: (entry) => `${TAGS[/** @type {'user' | 'talk'} */ (entry.kind)]}: ${entry.text}`,
    lineBytes,
    ...(batch === undefined ? {} : { batch }),
    summarize,
    canCall: () => true,
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    saved: () => {},
  });
  return { writer, tree, warnings, infos };
}

/** A summarize whose calls wait until the test answers them; each call keeps its conversation. */
function heldCalls() {
  /** @type {{ turns: any[], context: string, task: string, last: string, answer: (text: string) => void }[]} */
  const calls = [];
  /** @type {import('../lib/writer.js').Summarize} */
  const summarize = (turns) => new Promise((resolve) => {
    const first = /** @type {{ texts: string[] }} */ (turns[0]);
    const last = /** @type {{ texts: string[] }} */ (turns.at(-1));
    calls.push({ turns: [...turns], context: first.texts[0], task: first.texts[1], last: last.texts[0], answer: (text) => resolve({ text, message: { n: calls.length } }) });
  });
  return { calls, summarize };
}

/** The messages a call's jobs compress, or the merges it does, as names. @param {string} task */
const namesOf = (task) => jobsOf(task).map((job) => /^Compaction: (compress message \d+|merge lines \S+ and [^\s,]+)/.exec(job)?.[1]);

const long = (/** @type {number} */ i) => `message-${i} ${'x'.repeat(600)}`;

test('a batch holds only ready nodes, at most `writer.batch` of them, and a node ready alone gets the one-line call', async () => {
  const { calls, summarize } = heldCalls();
  const { writer, tree } = writerFor(entriesOf(Array.from({ length: 12 }, (_, i) => long(i))), summarize, { batch: 3 });
  writer.pump();
  await settleTicks();
  // Eight message lines may be unbuilt at once (UNBUILT_AHEAD): 0..7, in calls of three.
  assert.deepEqual(calls.map((call) => namesOf(call.task)), [
    ['compress message 0', 'compress message 1', 'compress message 2'],
    ['compress message 3', 'compress message 4', 'compress message 5'],
    ['compress message 6', 'compress message 7'],
  ]);
  calls[0].answer(['a', 'b', 'c'].map((tag, k) => `<line id="${k + 1}">${tag.repeat(300)}</line>`).join('\n'));
  await settleTicks();
  assert.deepEqual([0, 1, 2].map((i) => tree.text(0, i)?.length), [300, 300, 300]);
  // Three lines built: messages 8..10 may start; only merge 0+1 has both halves built (3 is not).
  assert.deepEqual(calls.slice(3).map((call) => namesOf(call.task)), [
    ['compress message 8', 'compress message 9', 'compress message 10'],
    ['merge lines 0+1 and 1+1'],
  ]);
  assert.doesNotMatch(calls[4].task, /<job id=/, 'a node ready alone did not get the one-line task');
  for (const call of calls) assert.ok(!call.context.includes(PLACEHOLDER), 'a batch saw an unsummarized line');
  writer.close();
});

test('the batch task numbers each job\'s own spec task, ruler, language and KEEP sentences and input whole, under one "Compaction:" head, and each reply tag names its limit', () => {
  const one = compressTask(5, 'you: hi', 384);
  const two = compressTask(6, 'Assistant: hello', 384);
  const task = batchTask([one, two], 384);
  assert.ok(task.startsWith('Compaction: compress message 5; compress message 6.\nThese are 2 jobs.'), task.split('\n')[0]);
  assert.match(task, /<line id="1">job 1's line, at most 384 bytes<\/line>\n<line id="2">job 2's line, at most 384 bytes<\/line>/);
  assert.ok(task.includes(`<job id="1">\n${one.slice('Compaction: '.length)}\n</job>`));
  assert.ok(task.includes(`<job id="2">\n${two.slice('Compaction: '.length)}\n</job>`));
  assert.ok(task.includes(KEEP) && task.includes('Write the line in the language of the messages it summarizes.'));
  assert.deepEqual([...replyLines('<line id="2">b</line>\n<line id=\'1\'>a\nmore</line><line id="2">again</line>')], [[2, 'b'], [1, 'a\nmore']]);
});

// The first live run (2026-10-08) asked batched first tries for the full 512 bytes: 81% came back past 640.
test('a batched first try aims at 0.75 of the limit: each job\'s ruler, its "at most" and its reply tag say 384 bytes, while 640 still fits', async () => {
  const { calls, summarize } = heldCalls();
  const { writer, tree } = writerFor(entriesOf([long(0), long(1)]), summarize, { batch: 6 });
  writer.pump();
  await settleTicks();
  const jobs = [...calls[0].task.matchAll(/<job id="\d">\n([\s\S]*?)\n<\/job>/g)].map((match) => match[1]);
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.match(job, /^compress message \d into one line of at most 384 bytes\n\(about 53 words\), the length of this ruler:\n-{384}\n/);
    assert.doesNotMatch(job, /-{385}/);
  }
  assert.match(calls[0].task, /<line id="2">job 2's line, at most 384 bytes<\/line>/);
  calls[0].answer(`<line id="1">${'a'.repeat(640)}</line><line id="2">${'b'.repeat(500)}</line>`);
  await settleTicks();
  assert.equal(calls.filter((call) => call.turns.length > 1).length, 0, 'a line within 1.25× of the true limit was asked again');
  assert.deepEqual([tree.text(0, 0)?.length, tree.text(0, 1)?.length], [640, 500]);
  writer.close();
});

test('a reply with one bad job stores the good ones at once and asks the bad one again alone, in the same conversation, with the one-line "Too long"', async () => {
  const { calls, summarize } = heldCalls();
  const { writer, tree } = writerFor(entriesOf([long(0), long(1), long(2), long(3)]), summarize, { batch: 6 });
  writer.pump();
  await settleTicks();
  assert.equal(calls.length, 1);
  calls[0].answer(`<line id="1">0+1|${'a'.repeat(300)}</line>\n<line id="2">${'y'.repeat(700)}</line>\n<line id="3">${'c'.repeat(300)}</line>\n<line id="4">${'d'.repeat(300)}</line>`);
  await settleTicks();
  assert.equal(tree.text(0, 0), 'a'.repeat(300), 'a good job waited for the bad one, or kept its head');
  assert.equal(tree.text(0, 2), 'c'.repeat(300));
  assert.equal(tree.text(0, 3), 'd'.repeat(300));
  assert.equal(tree.built(0, 1), false);
  const retry = calls.find((call) => call.turns.length > 1);
  assert.ok(retry, 'the bad job was not asked again in the same conversation');
  assert.equal(retry.task, calls[0].task, 'the retry is not a follow-up of the batched call');
  assert.deepEqual(retry.turns[1], { role: 'assistant', message: { n: 1 } });
  assert.equal(retry.last, `Job 2 only. Too long: your line is 700 bytes, over the 384-byte limit. Write
the whole line again for the same <input>, cutting just enough of the
least valuable items to fit before this cut:
${'y'.repeat(384)}| ← LIMIT
Answer with that one line inside its tag, and nothing else:
<line id="2">job 2's line</line>`);
  // The stored jobs' parent did not wait for the retry: it started in a call of its own.
  assert.ok(calls.some((call) => namesOf(call.task).includes('merge lines 2+1 and 3+1')), 'the merge the stored jobs made ready did not start');
  retry.answer('second');
  await settleTicks();
  assert.equal(tree.text(0, 1), 'second', 'an untagged reply to a one-job retry is its line');
  writer.close();
});

test('a missing job is asked for again alone; one that never comes back fails alone and returns in a later call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, summarize } = heldCalls();
  const { writer, tree, warnings } = writerFor(entriesOf([long(0), long(1)]), summarize, { batch: 6 });
  writer.pump();
  await settleTicks();
  calls[0].answer('<line id="1">first</line>');
  await settleTicks();
  assert.equal(tree.text(0, 0), 'first');
  assert.equal(calls.length, 2);
  assert.match(calls[1].last, /^Job 2 only\. Missing: your reply held no <line id="2">\.\nAnswer with that one line/);
  calls[1].answer('<line id="2"></line>');
  await settleTicks();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].turns.length, 5, 'the third try did not continue the same conversation');
  calls[2].answer('<line id="2"> </line>');
  await settleTicks();
  assert.equal(calls.length, 3, 'more than three tries for one job');
  assert.equal(tree.built(0, 1), false);
  assert.match(warnings.join('\n'), /line 0:1 failed, retrying every 10 s: no try came back/);
  t.mock.timers.tick(10_000);
  await settleTicks();
  assert.equal(calls.length, 4);
  assert.doesNotMatch(calls[3].task, /<job id=/, 'the failed job, alone now, did not get the one-line call');
  assert.match(calls[3].task, /^Compaction: compress message 1 into one line of at most 512 bytes/);
  calls[3].answer('second');
  await settleTicks();
  assert.equal(tree.text(0, 1), 'second');
  writer.close();
});

test('the CJK guard and the length rules apply to each job alone, three tries each, the shortest trimmed when none fits', async () => {
  const { calls, summarize } = heldCalls();
  const texts = [long(0), `${long(1)} 发布说明`, long(2), long(3), long(4)];
  const { writer, tree, warnings, infos } = writerFor(entriesOf(texts), summarize, { batch: 6 });
  writer.pump();
  await settleTicks();
  const words = (/** @type {number} */ n) => Array.from({ length: n }, (_, k) => `w${k}`).join(' ').padEnd(n * 4, ' ');
  calls[0].answer([
    '<line id="1">用户要求发布说明</line>', // invents CJK: Wrong language
    '<line id="2">发布说明</line>', // its source holds CJK: kept
    `<line id="3">${'z'.repeat(641)}</line>`, // one byte past 1.25×: Too long
    `<line id="4">${'q'.repeat(640)}</line>`, // at 1.25×: kept as is
    `<line id="5">${words(200)}</line>`, // too long every time: trimmed
  ].join('\n'));
  await settleTicks();
  assert.equal(tree.text(0, 1), '发布说明');
  assert.equal(tree.text(0, 3), 'q'.repeat(640));
  assert.deepEqual(JSON.parse(infos[0].replace('[ENDLESS_WRITER_BATCH] ', '')), { jobs: 5, tagged: 5, missing: 0, foreign: 1, over: 2 }, 'the batched call was not logged with its counts');
  const retryOf = (/** @type {number} */ id) => calls.filter((call) => call.turns.length > 1 && call.last.startsWith(`Job ${id} only.`));
  assert.match(retryOf(1)[0]?.last ?? '', /^Job 1 only\. Wrong language: <input> holds no Chinese, Japanese or Korean text\./);
  assert.match(retryOf(3)[0]?.last ?? '', /^Job 3 only\. Too long: your line is 641 bytes, over the 384-byte limit\./);
  assert.match(retryOf(5)[0]?.last ?? '', /^Job 5 only\. Too long: your line is \d+ bytes, over the 384-byte limit\./);
  retryOf(1)[0].answer('<line id="1">you: release notes list only what ships</line>');
  retryOf(3)[0].answer(`<line id="3">${'z'.repeat(400)}</line>`);
  retryOf(5)[0].answer(`<line id="5">${words(190)}</line>`);
  await settleTicks();
  assert.equal(tree.text(0, 0), 'you: release notes list only what ships');
  assert.equal(tree.text(0, 2), 'z'.repeat(400));
  assert.equal(retryOf(5).length, 2, 'job 5 was not asked a third time');
  assert.match(retryOf(5)[1].last, /^Job 5 only\. Too long/);
  retryOf(5)[1].answer(`<line id="5">${words(180)}</line>`);
  await settleTicks();
  assert.equal(retryOf(5).length, 2, 'more than three tries for job 5');
  const line = /** @type {string} */ (tree.text(0, 4));
  assert.ok(Buffer.byteLength(line) <= 640 && line.endsWith('…'), `job 5 kept ${Buffer.byteLength(line)} bytes`);
  assert.equal(writer.trimmed, 1);
  assert.match(warnings.join('\n'), /line 0:4 fit in no try and was trimmed/);
  writer.close();
});

test('a call that fails fails each of its jobs alone, and they come back together in a later call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  /** @type {string[]} */
  const tasks = [];
  const { writer, tree, warnings } = writerFor(entriesOf([long(0), long(1)]), async (turns) => {
    tasks.push(/** @type {{ texts: string[] }} */ (turns[0]).texts[1]);
    if (++n === 1) throw new Error('provider busy');
    return { text: '<line id="1">a</line><line id="2">b</line>', message: null };
  }, { batch: 6 });
  writer.pump();
  await settleTicks();
  assert.equal(warnings.length, 2);
  t.mock.timers.tick(10_000);
  await settleTicks();
  assert.deepEqual(namesOf(tasks[1]), ['compress message 0', 'compress message 1']);
  assert.deepEqual([tree.text(0, 0), tree.text(0, 1)], ['a', 'b']);
  writer.close();
});

test('with `writer.batch = 1` every call is the one-line call, as before; the default is 6 and 0 is refused', async () => {
  const { calls, summarize } = heldCalls();
  const { writer } = writerFor(entriesOf(Array.from({ length: 12 }, (_, i) => long(i))), summarize, { batch: 1 });
  writer.pump();
  await settleTicks();
  assert.equal(calls.length, 8);
  for (const [k, call] of calls.entries()) {
    assert.ok(call.task.startsWith(`Compaction: compress message ${k} into one line`), call.task.split('\n')[0]);
    assert.doesNotMatch(call.task, /<job id=/);
  }
  writer.close();
  assert.equal(resolveConfig({}).writer.batch, 6);
  assert.equal(resolveConfig({ writer: { batch: 1 } }).writer.batch, 1);
  assert.throws(() => resolveConfig({ writer: { batch: 0 } }), /writer\.batch/);
  assert.throws(() => resolveConfig({ writer: { batch: 2.5 } }), /writer\.batch/);
});
