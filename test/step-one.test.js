// Step 1 of a turn over a shared memory: a new chat's first turn carries the
// view of the earlier chats; each turn sees the view as of its start; the
// next turn's input extends the previous one; the host's own context kinds
// stay before the view; and below the model guard nothing is replaced.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { CONTEXT_KINDS, VIEW_SOURCE, contextKinds, planTurn } from '../lib/context.js';
import { ModelGuard } from '../lib/guard.js';
import { TASK_MARKER } from '../lib/prompts.js';
import { Memories } from '../lib/registry.js';
import { TurnRefusal, seamStepOne, stepOne } from '../lib/step-one.js';
import { keptLog, rootsForThisFile, wholeTurn } from './fixtures.js';
import { FakeSession, commonPrefix, textOf, userMessage, wire } from './harness-fake.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

const SCOUT = '/agents/scout';
const BOARD = '/work/board';

function registry() {
  return new Memories({
    config: resolveConfig({}),
    root: roots.fresh(),
    log: keptLog(),
    summarizer: () => async () => ({ text: 'S', message: null }),
  });
}

/** @param {Memories} memories @param {string} id */
function chat(memories, id) {
  memories.bind(id, SCOUT, BOARD);
  const session = new FakeSession(id);
  session.listeners.push((event) => memories.observe(session, event));
  return session;
}

/** The writes the engine makes (checkpoint.js), on the fake session. @param {FakeSession} session */
const ioFor = (session) => ({
  makeMessage: (/** @type {any} */ item) => ({ ...userMessage('', item.source), content: item.content }),
  viewMessage: (/** @type {string} */ view) => userMessage(view, { kind: VIEW_SOURCE }),
  checkpoint: (/** @type {any} */ span, /** @type {string} */ view) => session.append('user/message', userMessage(view, { kind: 'compact-checkpoint', compactionId: `c${session.seq}` }), {
    surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end },
    sourceEventSeqs: span.seqs,
  }),
  bracketOpen: () => false,
});

/**
 * One turn of `session` as the loop runs it: turn/start, step 1 through
 * `stepOne`, the system prompt at node 0, the step's messages, a reply,
 * turn/end. `during` runs while the chain decides. Returns the request.
 */
async function turnOf(/** @type {FakeSession} */ session, /** @type {any} */ memory, /** @type {number} */ n, /** @type {string} */ text, during = async () => {}, /** @type {any[]} */ context = [], kindsOf = CONTEXT_KINDS) {
  session.append('turn/start', { turn: n });
  const decision = await stepOne({
    memory,
    session,
    signal: new AbortController().signal,
    kinds: kindsOf,
    timeoutMs: 5000,
    next: async () => {
      await during();
      return { kind: 'enter', messages: [userMessage(text, { kind: 'user' }), ...context] };
    },
    io: ioFor(session),
  });
  if (session.surface.nodes.length === 0) session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] } }, { surfaceOp: 'append' });
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' });
  const request = session.deriveMessages();
  session.append('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${text}` }] } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: n });
  return request;
}

/** @param {any[]} messages */
const kinds = (messages) => messages.map((m) => (m.role === 'system' ? 'system' : m.source.kind));

test('a new chat starts with the earlier chat\'s view; its turn sees the view as of its start; the next turn extends it', async () => {
  const memories = registry();
  const a = chat(memories, 'chat-a');
  const memory = memories.attach(a);
  wholeTurn(a, 1, 'Rule: release notes list only what ships.', 'Noted.');
  const b = chat(memories, 'chat-b');
  assert.equal(memories.attach(b), memory);
  // While chat B's first turn waits on the chain, chat A finishes another turn.
  const first = await turnOf(b, memory, 1, 'What rule did I give you?', async () => {
    wholeTurn(a, 2, 'Also: no previews of upcoming work.', 'Understood.');
  });
  // Only the summary lines and the new message: no earlier message travels whole.
  assert.deepEqual(kinds(first), ['system', VIEW_SOURCE, 'user']);
  const view1 = textOf(first[1]);
  assert.equal(view1, '<chat>\n0+1|you: Rule: release notes list only what ships.\n1+1|Scout: Noted.\n</chat>',
    'the new chat must start with the earlier chat, as the view stood when its turn started');
  const second = await turnOf(b, memory, 2, 'And the other rule?');
  assert.deepEqual(kinds(second), ['system', 'compact-checkpoint', 'user']);
  const view2 = textOf(second[1]);
  assert.match(view2, /\|you: Also: no previews of upcoming work\./);
  assert.match(view2, /\|you: What rule did I give you\?/);
  // The model input before the new message extends the previous turn's, up to the end of its old lines.
  const old = JSON.stringify(view1.replace(/\n<\/chat>$/, '')).slice(1, -1);
  const wired = wire(second);
  assert.ok(wired.includes(old));
  assert.ok(commonPrefix(wire(first), wired) >= wired.indexOf(old) + old.length, 'turn 2 missed the cache inside the old view');
  memories.closeAll();
});

test('a new chat\'s first turn reads [system][context kinds][view][new message]: the view never goes before the context', async () => {
  const memories = registry();
  const a = chat(memories, 'chat-a');
  const memory = memories.attach(a);
  wholeTurn(a, 1, 'Rule: release notes list only what ships.', 'Noted.');
  const b = chat(memories, 'chat-b');
  assert.equal(memories.attach(b), memory);
  // The chain adds its context messages after the person's, in no particular order, host kind last.
  const context = [
    userMessage('Instructions.', { kind: 'agent-instructions' }),
    userMessage('Brief.', { kind: 'host-standing-context' }),
    userMessage('Policy.', { kind: 'runtime-context' }),
    userMessage('Skills.', { kind: 'skill-catalog' }),
  ];
  const first = await turnOf(b, memory, 1, 'What rule did I give you?', async () => {}, context, contextKinds(['host-standing-context']));
  assert.deepEqual(kinds(first), ['system', 'skill-catalog', 'runtime-context', 'agent-instructions', 'host-standing-context', VIEW_SOURCE, 'user']);
  assert.match(textOf(first[5]), /^<chat>\n0\+1\|you: Rule: release notes list only what ships\./, 'the view is the one that stood at the turn\'s start');
  memories.closeAll();
});

test('a memory that cannot settle refuses the turn instead of sending the history', async () => {
  const session = new FakeSession('chat-x');
  const memory = { size: 1, settle: async () => false, render: () => '', waiting: () => 3, view: { parts: [1, 2, 3] }, writer: { lastError: 'provider busy' } };
  await assert.rejects(
    stepOne({ memory, session, signal: new AbortController().signal, kinds: CONTEXT_KINDS, timeoutMs: 1000, next: async () => ({ kind: 'enter', messages: [] }), io: ioFor(session) }),
    (error) => error instanceof TurnRefusal && /3 summary lines were not written within 1 s; last error: provider busy/.test(error.message),
  );
});

test('the host\'s own context kinds stay before the view, newest only; without them they are replaced with the history', () => {
  const session = new FakeSession();
  session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'S' }] } }, { surfaceOp: 'append' });
  const older = session.append('user/message', userMessage('Brief, first version.', { kind: 'host-standing-context' }), { surfaceOp: 'append' });
  const asked = session.append('user/message', userMessage('hello', { kind: 'user' }), { surfaceOp: 'append' });
  const newer = session.append('user/message', userMessage('Brief, second version.', { kind: 'host-standing-context' }), { surfaceOp: 'append' });
  const next = [userMessage('next', { kind: 'user' })];
  const withHost = planTurn(session, next, contextKinds(['host-standing-context']));
  assert.deepEqual(withHost?.writes.map((w) => [w.slot, w.item.seq]), [[older.seq, newer.seq]], 'the newest brief must take the first slot');
  assert.deepEqual(withHost?.span.seqs, [asked.seq, newer.seq]);
  const without = planTurn(session, next, CONTEXT_KINDS);
  assert.deepEqual(without?.writes, []);
  assert.deepEqual(without?.span.seqs, [older.seq, asked.seq, newer.seq]);
  assert.deepEqual(contextKinds(['host-standing-context']), [...CONTEXT_KINDS, 'host-standing-context']);
  assert.deepEqual(resolveConfig({ contextKinds: ['host-standing-context'] }).contextKinds, ['host-standing-context']);
  assert.throws(() => resolveConfig({ contextKinds: ['a', 'a'] }), /contextKinds/);
  assert.throws(() => resolveConfig({ contextKinds: ['two words'] }), /contextKinds/);
});

test('below a 65,536-token context window the turn is an ordinary chat: no memory, no replace, one log line', async () => {
  const log = keptLog();
  const windows = new Map([['deepseek-flash', 1_000_000], ['local-small', 8192], ['edge', 65_535], ['floor', 65_536]]);
  const guard = new ModelGuard({ resolve: async (_provider, model) => (windows.has(model) ? { context: { contextWindow: windows.get(model) } } : {}), log });
  const session = new FakeSession('chat-small');
  let attached = 0;
  const decision = { kind: 'enter', messages: [userMessage('hi', { kind: 'user' })] };
  const run = (/** @type {string} */ model) => seamStepOne({
    sessionId: 'chat-small',
    route: { provider: 'local', model },
    guard,
    attach: () => {
      attached++;
      throw new Error('stop here');
    },
    noteRoute: () => {},
    session,
    signal: new AbortController().signal,
    next: async () => decision,
    kinds: CONTEXT_KINDS,
    timeoutMs: 1000,
    io: () => ioFor(session),
  });
  assert.equal(await run('local-small'), decision);
  assert.equal(await run('local-small'), decision);
  assert.equal(await run('edge'), decision);
  assert.equal(await run('unknown-window'), decision);
  assert.equal(attached, 0, 'a guarded turn opened the memory');
  assert.equal(session.events.length, 0, 'a guarded turn changed the surface');
  assert.deepEqual(log.warnings.map((w) => w.replace(/^\[ENDLESS_GUARD\] chat-small: /, '')), [
    'local/local-small has a 8192-token context window, below 65536; this chat runs without endless memory',
    'local/edge has a 65535-token context window, below 65536; this chat runs without endless memory',
    'local/unknown-window does not state its context window; this chat runs without endless memory',
  ]);
  await assert.rejects(run('floor'), /the memory could not be opened: stop here/);
  assert.equal(attached, 1, 'a model at the floor must run endless memory');
});

// A 201-turn trial run on 2026-10-08: a person's turn was answered as a compaction. The marker
// the writer's tasks open with never reaches a turn request outside the system prompt.
test('no turn request carries the writer\'s task marker outside the system prompt', async () => {
  const memories = registry();
  const a = chat(memories, 'chat-a');
  const memory = memories.attach(a);
  /** @type {any[][]} */
  const requests = [];
  for (let n = 1; n <= 4; n++) requests.push(await turnOf(a, memory, n, `Turn ${n}: please draft the compaction notes.`));
  for (const request of requests) {
    for (const message of request.filter((m) => m.role !== 'system')) {
      assert.ok(!textOf(message).includes(TASK_MARKER), `a ${message.source.kind} message carries "${TASK_MARKER}"`);
    }
  }
  memories.closeAll();
});
