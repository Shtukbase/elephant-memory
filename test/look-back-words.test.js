// A turn's look-backs reach the summary writer, and a short trace's own line in
// the view, in plain words and under the one `did:` tag: no call JSON, no line
// id, no message id (round 5 of the live walk, G3). The answers here are the
// ones lib/recall.js really gives and the trace is folded from harness-shaped
// events by the real projector, so a change of either side reddens this file.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Attachment } from '../lib/attachment.js';
import { resolveConfig } from '../lib/config.js';
import { entryForWriter, traceForWriter } from '../lib/look-back-words.js';
import { Memory } from '../lib/memory.js';
import { dateOf, recallSearch, zoom } from '../lib/recall.js';
import { TurnCollector } from '../lib/turns.js';
import { MemoryTree, eventLog, fakeSession, keptLog, rootsForThisFile, settleTicks } from './fixtures.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

const CONFIG = { agentName: 'Assistant', you: 'you', granularity: /** @type {const} */ ('turn'), lineBytes: 512 };
/** What no part of a look-back may carry into words: call JSON, a line head, a search hit's place, "id N", "message N". */
const MACHINERY = /\{"|\d+\+\d+\||(^|\s)\d+\|(you|did|Assistant|result)\||\bid \d|\bmessage \d|\bn \d/;
/** What a harness tool's own answer carries and this memory does not touch. */
const UNDO_ANSWER = '{"said":"Noted in memory: \\"the sign-off rule\\" (undo-1)"}';

/** A memory of invented messages, the shape lib/recall.js reads. */
function recallSource() {
  const texts = [
    ['user', 'Rule: release notes list only what ships.'], ['talk', 'Understood.'],
    ['user', 'The cheese-maker contact is Odalys, phone ending 0482.'], ['talk', 'Noted.'],
  ];
  const tree = new MemoryTree();
  for (let l = 0; 2 ** l <= texts.length; l++) for (let i = 0; (i + 1) * 2 ** l <= texts.length; i++) tree.set(l, i, `in «Pricing page», you: line ${l}.${i}`);
  const entries = texts.map(([kind, text], i) => ({ i, kind, text, size: text.length, time: Date.UTC(2026, 9, 8, 13, 7) + i * 60_000, title: 'Pricing page', first: kind === 'user' }));
  return { size: entries.length, entry: (/** @type {number} */ i) => entries[i], tree, config: CONFIG };
}

/**
 * One turn folded by the real projector: the person asks, the agent looks back
 * three ways, saves a note with a harness tool, and answers.
 * @param {[string, string, string][]} calls name, JSON arguments, answer
 */
function traceOf(calls) {
  const log = eventLog();
  log.turnStart(1);
  log.user('Find what I said about the cheese-maker.');
  calls.forEach(([name, args], k) => log.assistant([{ type: 'tool-call', id: `c${k}`, name, arguments: args }]));
  calls.forEach(([, , answer], k) => log.result(`c${k}`, answer));
  log.assistant([{ type: 'text', text: 'It was Odalys.' }]);
  log.turnEnd(1);
  const collector = new TurnCollector('s1', 'turn');
  const record = log.events.map((event) => collector.push(event)).find((turn) => turn !== null);
  const trace = record?.entries.find((entry) => entry.kind === 'tool');
  assert.ok(trace, 'the turn kept a trace');
  return { log, trace, record };
}

test('a look-back call reads as "did: looked back at …" with its subject, its chat and its date, and no id', () => {
  const source = recallSource();
  const { trace } = traceOf([
    ['recall_search', '{"query":"cheese-maker"}', recallSearch(source, 'cheese-maker')],
    ['zoom', '{"id":2,"n":1}', zoom(source, 2, 1)],
    ['date', '{"id":2}', dateOf(source, 2)],
  ]);
  assert.match(trace.text, /did: zoom \{"id":2,"n":1\}\nresult: 2\+0\|/, 'the stored trace is the machine form');
  const parts = traceForWriter(trace.text).split('\n\n');
  assert.deepEqual(parts, [
    'did: looked back at «cheese-maker»',
    'did: looked back at «The cheese-maker contact is Odalys, phone ending 0482.» in «Pricing page»',
    `did: looked back at when a message was written: ${dateOf(source, 2)}`,
  ]);
  for (const part of parts) assert.doesNotMatch(part, MACHINERY, part);
});

test('a look-back that found nothing, or failed, says so and keeps no id', () => {
  const source = recallSource();
  const { trace } = traceOf([
    ['recall_search', '{"query":"harbour"}', recallSearch(source, 'harbour')],
    ['zoom', '{"id":3,"n":2}', zoom(source, 3, 2)],
    ['date', '{"id":99}', dateOf(source, 99)],
  ]);
  assert.deepEqual(traceForWriter(trace.text).split('\n\n'), [
    'did: looked back at «harbour» and found nothing',
    'did: looked back and found nothing',
    'did: looked back and found nothing',
  ]);
});

test('every other tool call keeps its tag and its words byte for byte, and a harness tool\'s own ids are not this memory\'s to change', () => {
  const source = recallSource();
  const { trace } = traceOf([
    ['memory_add', '{"scope":"mine","line":"the sign-off rule"}', UNDO_ANSWER],
    ['zoom', '{"id":0,"n":1}', zoom(source, 0, 1)],
  ]);
  const parts = traceForWriter(trace.text).split('\n\n');
  assert.equal(parts[0], `did: memory_add {"scope":"mine","line":"the sign-off rule"}\nresult: ${UNDO_ANSWER}`);
  assert.equal(parts[1], 'did: looked back at «Rule: release notes list only what ships.» in «Pricing page»');
  assert.ok(parts.every((part) => part.startsWith('did: ')), 'every call is tagged "did:"');
  // Words the agent said inside the trace, and text with no look-back at all, are not touched.
  const plain = 'said: Looking.\n\ndid: grep {"pattern":"tier"}\nresult: docs/pricing.md:12: Starter';
  assert.equal(traceForWriter(plain), plain);
});

test('only a turn\'s trace is rewritten, and only at granularity turn', () => {
  const trace = { kind: /** @type {const} */ ('tool'), text: 'did: zoom {"id":0,"n":1}\nresult: 0+0|you: hi', size: 0, time: 0, i: 0 };
  assert.equal(entryForWriter(trace, 'turn').text, 'did: looked back at «hi»');
  assert.equal(entryForWriter(trace, 'step'), trace, 'a step entry is a call without its answer');
  const spoken = { ...trace, kind: /** @type {const} */ ('user') };
  assert.equal(entryForWriter(spoken, 'turn'), spoken, 'a person\'s words that quote a call are their own');
  assert.equal(entryForWriter({ ...trace, text: 'did: zoom_in {"id":0}\nresult: ok' }, 'turn').text, 'did: zoom_in {"id":0}\nresult: ok', 'another tool whose name starts the same');
});

test('the view\'s own line for a short look-back turn says it in words, with the tag the writer uses', async () => {
  const source = recallSource();
  const { log } = traceOf([
    ['recall_search', '{"query":"cheese-maker"}', recallSearch(source, 'cheese-maker')],
    ['zoom', '{"id":2,"n":1}', zoom(source, 2, 1)],
  ]);
  const dir = roots.fresh();
  const memory = new Memory({
    memoryId: 'abcdef0123456789',
    key: { agent: '/agents/scout', project: '/work/board' },
    dir,
    config: resolveConfig({ agentName: 'Scout' }),
    summarize: async () => {
      throw new Error('no model call was expected');
    },
    log: keptLog(),
  });
  new Attachment('s1', fakeSession(log.events), memory);
  await settleTicks();
  const view = memory.render();
  assert.match(view, /\n1\+1\|did: looked back at «cheese-maker»  did: looked back at «The cheese-maker contact is Odalys, phone ending 0482\.» in «Pricing page»\n/);
  // The view's own `id+n|` heads are its addresses; the words after the head are the line.
  assert.doesNotMatch(view.split('\n').filter((line) => line.startsWith('1+1|')).join('\n').replace(/^\d+\+\d+\|/, ''), MACHINERY);
  memory.close();
});

test('the summary writer reads a long turn\'s look-backs in words and its other tool work as it was', async () => {
  const source = recallSource();
  const long = 'x'.repeat(700);
  const { log } = traceOf([
    ['bash', '{"command":"ls"}', long],
    ['recall_search', '{"query":"cheese-maker"}', recallSearch(source, 'cheese-maker')],
    ['zoom', '{"id":2,"n":1}', zoom(source, 2, 1)],
  ]);
  /** @type {string[]} */
  const tasks = [];
  const dir = roots.fresh();
  const memory = new Memory({
    memoryId: 'abcdef0123456789',
    key: { agent: '/agents/scout', project: '/work/board' },
    dir,
    config: resolveConfig({ agentName: 'Scout' }),
    summarize: async (turns) => {
      tasks.push(/** @type {{ texts: string[] }} */ (turns[0]).texts[1]);
      return { text: 'did: ran a command, then looked back at the cheese-maker', message: null };
    },
    log: keptLog(),
  });
  new Attachment('s1', fakeSession(log.events), memory);
  await settleTicks();
  memory.close();
  const task = tasks.find((text) => text.includes('did: bash'));
  assert.ok(task, `the long trace went to the writer: ${JSON.stringify(tasks.map((text) => text.slice(0, 80)))}`);
  assert.ok(task.includes(`did: bash {"command":"ls"}\nresult: ${long}`), 'the other tool call is as it was');
  assert.ok(task.includes('did: looked back at «cheese-maker»\n\ndid: looked back at «The cheese-maker contact is Odalys, phone ending 0482.» in «Pricing page»'));
  assert.doesNotMatch(task.slice(task.indexOf('did: looked back')), MACHINERY);
});
