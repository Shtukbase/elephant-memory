// One memory on disk: stored lines survive a restart and are never
// recomputed, the view is folded again identically, lines that no longer
// match the history are written again, finished turns are appended whole and
// equal what the session logs give, one writing process, and every writer
// call's spend is logged and totalled.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Attachment } from '../lib/attachment.js';
import { resolveConfig } from '../lib/config.js';
import { LockHeldError } from '../lib/lock.js';
import { Memory } from '../lib/memory.js';
import { orderFile } from '../lib/order.js';
import { TurnCollector } from '../lib/turns.js';
import { eventLog, fakeSession, keptLog, rootsForThisFile, settleTicks } from './fixtures.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

const KEY = { agent: '/agents/scout', project: '/work/board' };

/** @param {string} sessionId @param {string} title @param {number} turn @param {[any, string][]} entries */
const record = (sessionId, title, turn, entries) => ({
  sessionId,
  sessionTitle: title,
  turn,
  at: 1_760_000_000_000 + turn * 60_000,
  entries: entries.map(([kind, text], k) => ({ kind, text, time: 1_760_000_000_000 + turn * 60_000 + k })),
});

/** @param {string} dir @param {object} [extra] */
function open(dir, extra = {}) {
  const log = keptLog();
  const memory = new Memory({
    memoryId: 'abcdef0123456789',
    key: KEY,
    dir,
    config: resolveConfig({}),
    summarize: async () => {
      throw new Error('no model call was expected');
    },
    log,
    ...extra,
  });
  return { memory, log };
}

/** Two short turns of one chat: every line is a free node, so no model is needed. */
function twoTurns(/** @type {Memory} */ memory, reply = 'hi') {
  memory.appendTurn(record('s1', 'Chat A', 1, [['user', 'hello'], ['talk', reply]]));
  memory.appendTurn(record('s1', 'Chat A', 2, [['user', 'bye'], ['talk', 'see you']]));
}

test('a reopened memory reuses its stored lines and folds the same view again', () => {
  const dir = roots.fresh();
  const first = open(dir).memory;
  twoTurns(first);
  first.writer.pump();
  assert.equal(first.view.allBuilt(), true);
  const view = first.render();
  assert.equal(view, '<chat>\n0+1|in «Chat A», you: hello\n1+1|Scout: hi\n2+1|in «Chat A», you: bye\n3+1|Scout: see you\n</chat>');
  first.close();
  const again = open(dir);
  assert.equal(again.memory.view.allBuilt(), true);
  assert.equal(again.memory.render(), view);
  assert.deepEqual(again.log.warnings, []);
  again.memory.close();
});

test('stored lines that no longer match the history are forgotten and written again', () => {
  const dir = roots.fresh();
  const first = open(dir).memory;
  twoTurns(first);
  first.writer.pump();
  first.close();
  // The order derived again from changed session logs: message 1 is different now.
  const file = orderFile(dir, 'turn');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"text":"hi"', '"text":"hello again, a longer reply"'));
  const changed = open(dir);
  assert.equal(changed.memory.tree.built(0, 0), true);
  assert.equal(changed.memory.tree.built(0, 1), false);
  assert.equal(changed.memory.view.allBuilt(), false);
  assert.match(changed.log.warnings[0] ?? '', /no longer match the history from message 1 on/);
  changed.memory.writer.pump();
  assert.equal(changed.memory.tree.text(0, 1), 'Scout: hello again, a longer reply');
  changed.memory.close();
});

test('one writer: a memory open here cannot be opened again, nor one whose lock another live process holds', () => {
  const dir = roots.fresh();
  const held = open(dir).memory;
  assert.throws(() => open(dir), LockHeldError);
  held.close();
  open(dir).memory.close();
  // Another process (the test runner's parent, alive) holds the lock file.
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: process.ppid, since: new Date().toISOString() }));
  assert.throws(() => open(dir), (error) => error instanceof LockHeldError && error.message.includes(`process ${process.ppid}`));
  fs.rmSync(path.join(dir, 'lock'));
});

test('a chat attached late appends its finished turns once, and live events catch up over a gap', async () => {
  const dir = roots.fresh();
  const { memory } = open(dir);
  const log = eventLog();
  log.turnStart(1);
  log.user('hello');
  log.assistant([{ type: 'text', text: 'hi' }]);
  log.turnEnd(1);
  const attachment = new Attachment('s1', fakeSession(log.events), memory);
  assert.equal(memory.records.length, 1, 'the turn that finished before attaching was not appended');
  log.turnStart(2);
  log.user('one more');
  const answer = log.assistant([{ type: 'text', text: 'sure' }]);
  const end = log.turnEnd(2);
  attachment.observe(answer); // the turn/start and user message before it were missed: caught up from the session
  attachment.observe(end);
  attachment.observe(end); // a repeat is ignored
  assert.equal(memory.size, 4);
  assert.equal(memory.records.length, 2);
  assert.equal(memory.entry(2)?.text, 'one more');
  new Attachment('s1', fakeSession(log.events), memory); // attaching again appends nothing twice
  assert.equal(memory.records.length, 2);
  await settleTicks();
  assert.equal(memory.view.allBuilt(), true);
  assert.ok(memory.render().includes('3+1|Scout: sure'));
  memory.close();
});

test('settle waits for the lines, and gives up on timeout, abort or close', async () => {
  const dir = roots.fresh();
  const { memory } = open(dir, { summarize: () => new Promise(() => {}) });
  memory.appendTurn(record('s1', '', 1, [['user', 'x'.repeat(2000)]]));
  assert.equal(await memory.settle(undefined, 30), false);
  const controller = new AbortController();
  const waiting = memory.settle(controller.signal, 60_000);
  controller.abort();
  assert.equal(await waiting, false);
  const closing = memory.settle(undefined, 60_000);
  memory.close();
  assert.equal(await closing, false);
});

test('the order file holds whole finished turns of every chat, each exactly what its session log gives', () => {
  const dir = roots.fresh();
  const { memory } = open(dir);
  /** @type {Map<string, any[]>} */
  const logs = new Map();
  for (const [id, title] of [['chat-a', 'Pricing page'], ['chat-b', 'Release notes']]) {
    const log = eventLog();
    log.events.push({ type: 'session/title', seq: 0, time: 1, data: { title } });
    log.turnStart(1);
    log.user(`first words in ${title}`);
    log.assistant([{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }]);
    log.result('c1', 'file text');
    log.assistant([{ type: 'text', text: `reply in ${title}` }]);
    log.turnEnd(1);
    logs.set(id, log.events);
    new Attachment(id, fakeSession(log.events), memory);
  }
  const stored = fs.readFileSync(orderFile(dir, 'turn'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(stored.map((r) => [r.sessionId, r.sessionTitle, r.turn, r.entries.map((/** @type {any} */ e) => e.kind)]), [
    ['chat-a', 'Pricing page', 1, ['user', 'tool', 'talk']],
    ['chat-b', 'Release notes', 1, ['user', 'tool', 'talk']],
  ]);
  // The same fold over each whole session log gives the stored records, byte for byte.
  const folded = [...logs].flatMap(([id, events]) => {
    const collector = new TurnCollector(id, 'turn');
    return events.map((event) => collector.push(event)).filter((done) => done !== null);
  });
  assert.deepEqual(folded, stored);
  memory.close();
});

test('every writer call logs one usage line, failed calls too, and the memory keeps a running total across restarts', async () => {
  const dir = roots.fresh();
  let calls = 0;
  const usage = (/** @type {number} */ k) => ({ provider: 'deepseek-official', model: 'deepseek-flash', cacheRead: 100 * k, miss: 10 * k, output: k });
  const summarize = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('provider busy'), { usage: usage(1) });
    return { text: `S${calls}`, message: null, usage: usage(calls) };
  };
  const { memory, log } = open(dir, { summarize });
  // A call that reached the model and failed still spent tokens.
  await assert.rejects(memory.writer.call([{ role: 'user', texts: ['a'] }]), /provider busy/);
  memory.appendTurn(record('s1', '', 1, [['user', 'x'.repeat(2000)]]));
  await settleTicks();
  assert.equal(calls, 2);
  assert.equal(memory.tree.text(0, 0), 'S2');
  const lines = log.infos.filter((line) => line.startsWith('[ENDLESS_WRITER_USAGE] '));
  assert.equal(lines.length, 2, 'one usage line per call');
  assert.deepEqual(JSON.parse(lines[1].slice('[ENDLESS_WRITER_USAGE] '.length)), { memoryId: 'abcdef0123456789', ...usage(2) });
  assert.deepEqual(memory.usage.totals, { calls: 2, cacheRead: 300, miss: 30, output: 3 });
  memory.close();
  const reopened = open(dir).memory;
  assert.deepEqual(reopened.usage.totals, { calls: 2, cacheRead: 300, miss: 30, output: 3 });
  reopened.close();
});

// A browser trial on 2026-10-08: view lines read "did: did: search {...}".
test('a turn\'s trace is tagged once in the view: its own "did:" and "result:" tags, never a second one', async () => {
  const dir = roots.fresh();
  const { memory } = open(dir);
  const log = eventLog();
  log.turnStart(1);
  log.user('find the notes');
  log.assistant([{ type: 'tool-call', id: 'c1', name: 'search', arguments: '{"q":"notes"}' }]);
  log.result('c1', '2 hits');
  log.assistant([{ type: 'text', text: 'Found two.' }]);
  log.turnEnd(1);
  new Attachment('s1', fakeSession(log.events), memory);
  await settleTicks();
  assert.equal(memory.render(), '<chat>\n0+1|you: find the notes\n1+1|did: search {"q":"notes"} result: 2 hits\n2+1|Scout: Found two.\n</chat>');
  memory.close();
});

// A 201-turn trial run on 2026-10-08: the agent's own words inside a trace came back tagged "colleague:".
test('what the agent said inside a turn\'s trace is tagged with its own name, the one tag of its replies', async () => {
  const dir = roots.fresh();
  const { memory } = open(dir);
  const log = eventLog();
  log.turnStart(1);
  log.user('find the notes');
  log.assistant([{ type: 'text', text: 'Looking.' }, { type: 'tool-call', id: 'c1', name: 'search', arguments: '{}' }]);
  log.result('c1', '2 hits');
  log.assistant([{ type: 'text', text: 'Found two.' }]);
  log.turnEnd(1);
  new Attachment('s1', fakeSession(log.events), memory);
  await settleTicks();
  assert.equal(memory.render(), '<chat>\n0+1|you: find the notes\n1+1|Scout: Looking.  did: search {} result: 2 hits\n2+1|Scout: Found two.\n</chat>');
  memory.close();
});
