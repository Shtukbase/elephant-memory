// The engine's own turn refusal: when the memory cannot settle, `preStep`
// ends the turn as a failure with one plain sentence (the chat's refusal line)
// and puts the messages it claimed back into the agent's inbox, so the next
// turn delivers them and the person's words are never lost.
// This file imports the engine, and so the harness's packages; it stands apart
// from the pure step tests so a missing optional peer reddens only this file.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { CONTEXT_KINDS } from '../lib/context.js';
import { EndlessCompactionEngine } from '../lib/engine.js';
import { Memories } from '../lib/registry.js';
import { REFUSAL_WORDS } from '../lib/step-one.js';
import { keptLog, rootsForThisFile, settleTicks, wholeTurn } from './fixtures.js';
import { FakeSession, userMessage } from './harness-fake.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

/**
 * An engine whose constructor is not run (it needs the harness's context):
 * only what `preStep` and `refuse` read is set.
 * @param {any} memory @param {ReturnType<typeof keptLog>} log
 */
function engineOver(memory, log) {
  const engine = Object.create(EndlessCompactionEngine.prototype);
  engine.log = log;
  engine.kinds = CONTEXT_KINDS;
  engine.guard = { allows: async () => true };
  engine.memories = { attach: () => memory, noteRoute: () => {} };
  return engine;
}

/** @param {number} size */
const memoryOf = (size, settles = false) => ({
  memoryId: 'm1',
  size,
  settle: async () => settles,
  render: () => '<chat>\n</chat>',
  waiting: () => 3,
  view: { parts: [1, 2, 3] },
  writer: { lastError: 'provider busy' },
});

/** The agent the loop hands the seam: its session, its model, and the inbox `inject` fills. */
function agentOf(/** @type {string} */ id) {
  /** @type {any[]} */
  const inbox = [];
  const session = new FakeSession(id);
  return { agent: { session, options: { provider: 'local', model: 'deepseek-flash' }, inject: (/** @type {any} */ message) => inbox.push(message) }, inbox, session };
}

test('a refused turn ends as a failure in one plain sentence and puts exactly the claimed messages back for the next turn', async () => {
  const log = keptLog();
  const { agent, inbox, session } = agentOf('chat-r');
  // The first carries the browser's submission id, as a message the web UI sent does.
  const claimed = [userMessage('Remember the release rule.', { kind: 'user', rpcId: 'rpc-1' }), userMessage('And the preview rule.', { kind: 'user' })];
  const payload = { agent, messages: claimed, turn: 4, step: 1, signal: new AbortController().signal };
  // A turn the memory lets through is the control: nothing goes back to the inbox.
  const whole = { kind: 'enter', messages: claimed };
  assert.equal(await engineOver(memoryOf(0), log).preStep(payload, async () => whole), whole);
  assert.deepEqual(inbox, [], 'a turn that was not refused changed the inbox');
  // A memory that cannot settle refuses the turn: a thrown error is the loop's
  // turn failure, which the web UI draws as the chat's refusal line; a `reject`
  // ended the turn `blocked`, drawn as a finished turn with nothing said.
  await assert.rejects(
    engineOver(memoryOf(1), log).preStep(payload, async () => assert.fail('the chain ran on a refused turn')),
    (/** @type {any} */ error) => error.message === REFUSAL_WORDS,
  );
  assert.equal(inbox.length, 2, 'the claimed messages were lost, or put back more than once');
  assert.deepEqual(inbox[0], { ...claimed[0], source: { kind: 'user' } }, 'the message came back changed, or kept its submission id');
  assert.ok(inbox[1] === claimed[1], 'a message without a submission id came back changed or out of order');
  assert.equal(session.events.length, 0, 'a refused turn wrote to the surface');
  assert.deepEqual(log.warnings, [
    '[ENDLESS_TURN] chat-r: turn refused, its messages wait for the next turn: 3 summary lines were not written within 180 s; last error: provider busy',
  ]);
  assert.doesNotMatch(REFUSAL_WORDS, /summary|line|\d|endless|writer|error/i, 'the sentence names machinery');
});

// Round 4 live walk, F5: the writer failed at once on every try and the held
// turn showed "Still starting" for seven minutes.
test('a held turn whose writer fails at once on every try is refused at the hold limit, its message kept for the next turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let tries = 0;
  const memories = new Memories({
    config: resolveConfig({}),
    root: roots.fresh(),
    log: keptLog(),
    summarizer: () => async () => {
      tries++;
      throw new Error('provider "hub-mock" model "deepseek-v4-flash" does not support reasoning effort "off"');
    },
  });
  const { agent, inbox, session } = agentOf('chat-f');
  session.listeners.push((event) => memories.observe(session, event));
  memories.attach(session);
  wholeTurn(session, 1, `a long checklist ${'item '.repeat(300)}`, 'Noted.');
  const engine = engineOver(null, keptLog());
  engine.memories = memories;
  const claimed = [userMessage('Also note the harbour master is on leave.', { kind: 'user', rpcId: 'rpc-2' })];
  /** @type {unknown} */
  let outcome;
  const turn = engine.preStep({ agent, messages: claimed, turn: 2, step: 1, signal: new AbortController().signal }, async () => assert.fail('a turn with an unsummarised line went on'))
    .then(() => 'entered', (/** @type {any} */ error) => error);
  void turn.then((value) => { outcome = value; });
  // 17 retries, 10 s apart: still waiting, failing every time.
  for (let k = 0; k < 17; k++) {
    await settleTicks(10);
    t.mock.timers.tick(10_000);
  }
  await settleTicks(10);
  assert.equal(outcome, undefined, 'the turn was refused before the hold limit');
  assert.ok(tries >= 15, `the writer was not retried while the turn waited (${tries} tries)`);
  t.mock.timers.tick(10_000);
  const error = await turn;
  assert.ok(error instanceof Error && error.message === REFUSAL_WORDS, `the held turn did not refuse at 180 s: ${String(error)}`);
  assert.equal(inbox.length, 1, 'the claimed message was lost');
  memories.closeAll();
});

// Not a refusal: the same seam notes the route the memory's writer follows.
test('the route a turn notes lets the writer read that chat\'s own system prompt and tools', async () => {
  const log = keptLog();
  const { agent, session } = agentOf('chat-p');
  const system = { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] };
  session.append('system/message', { message: system }, { surfaceOp: 'append' });
  const tools = [{ name: 'zoom' }];
  Object.assign(session, {
    deriveEventMessage: (/** @type {any} */ event) => event.data.message,
    requestHeader: () => ({ tools }),
    toolHistory: () => ({ tools: [], updates: [] }),
  });
  /** @type {any[]} */
  const noted = [];
  const engine = engineOver(memoryOf(0), log);
  engine.memories.noteRoute = (/** @type {string} */ _memoryId, /** @type {any} */ route) => noted.push(route);
  const payload = { agent, messages: [userMessage('hi', { kind: 'user' })], turn: 1, step: 1, signal: new AbortController().signal };
  await engine.preStep(payload, async () => ({ kind: 'enter', messages: payload.messages }));
  assert.equal(noted.length, 1);
  assert.equal(noted[0].sessionId, 'chat-p');
  assert.deepEqual(noted[0].prefix(), { system, tools, toolHistory: { tools: [], updates: [] } });
});

// Round 4 live walk, F2: after a switch in the composer, the writer kept
// calling the route the chat was created on.
test('the turn guard and the writer follow the route this turn runs on, not the one the chat was created on', async () => {
  const log = keptLog();
  const created = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const cases = [
    // A pick not yet used by any request: the turn's request will use it.
    { state: { pending: { provider: 'opencode-go', model: 'deepseek-flash', reasoningEffort: 'high' }, lastUsed: created }, header: created, want: { provider: 'opencode-go', model: 'deepseek-flash' } },
    // No pick pending: the route the last request used.
    { state: { pending: null, lastUsed: { provider: 'mockgo', model: 'm1' } }, header: created, want: { provider: 'mockgo', model: 'm1' } },
    // No projection registered (another host): the logged request header.
    { state: undefined, header: { provider: 'mockgo', model: 'm2' }, want: { provider: 'mockgo', model: 'm2' } },
    // A chat with no request yet and no pick: its creation options.
    { state: undefined, header: undefined, want: created },
  ];
  for (const { state, header, want } of cases) {
    const { agent, session } = agentOf('chat-s');
    agent.options = created;
    Object.assign(session, { requestHeader: () => (header === undefined ? undefined : { config: header }) });
    /** @type {any[]} */
    const asked = [];
    /** @type {any[]} */
    const noted = [];
    const engine = engineOver(memoryOf(0), log);
    engine.projections = { stateOf: (/** @type {any} */ s, /** @type {string} */ key) => (s === session && key === 'modelSelection' ? state : undefined) };
    engine.guard = { allows: async (/** @type {string} */ _id, /** @type {any} */ route) => (asked.push(route), true) };
    engine.memories.noteRoute = (/** @type {string} */ _memoryId, /** @type {any} */ route) => noted.push(route);
    const payload = { agent, messages: [userMessage('hi', { kind: 'user' })], turn: 2, step: 1, signal: new AbortController().signal };
    await engine.preStep(payload, async () => ({ kind: 'enter', messages: payload.messages }));
    assert.deepEqual(asked, [want]);
    assert.deepEqual({ provider: noted[0].provider, model: noted[0].model }, want, 'the writer was handed another route than the turn\'s');
  }
});
