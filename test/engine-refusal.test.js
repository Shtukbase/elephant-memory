// The engine's own turn refusal: when the memory cannot settle, `preStep`
// rejects the step and puts the messages it claimed back into the agent's
// inbox, so the next turn delivers them and the person's words are never lost.
// This file imports the engine, and so the harness's packages; it stands apart
// from the pure step tests so a missing optional peer reddens only this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTEXT_KINDS } from '../lib/context.js';
import { EndlessCompactionEngine } from '../lib/engine.js';
import { keptLog } from './fixtures.js';
import { FakeSession, userMessage } from './harness-fake.js';

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

test('a refused turn rejects the step and puts exactly the claimed messages back for the next turn', async () => {
  const log = keptLog();
  const { agent, inbox, session } = agentOf('chat-r');
  const claimed = [userMessage('Remember the release rule.', { kind: 'user' }), userMessage('And the preview rule.', { kind: 'user' })];
  const payload = { agent, messages: claimed, turn: 4, step: 1, signal: new AbortController().signal };
  // A turn the memory lets through is the control: nothing goes back to the inbox.
  const whole = { kind: 'enter', messages: claimed };
  assert.equal(await engineOver(memoryOf(0), log).preStep(payload, async () => whole), whole);
  assert.deepEqual(inbox, [], 'a turn that was not refused changed the inbox');
  // A memory that cannot settle refuses the turn.
  const decision = await engineOver(memoryOf(1), log).preStep(payload, async () => assert.fail('the chain ran on a refused turn'));
  assert.deepEqual(decision, { kind: 'reject' });
  assert.equal(inbox.length, 2, 'the claimed messages were lost, or put back more than once');
  assert.ok(inbox[0] === claimed[0] && inbox[1] === claimed[1], 'the messages came back changed or out of order');
  assert.equal(session.events.length, 0, 'a refused turn wrote to the surface');
  assert.deepEqual(log.warnings, [
    '[ENDLESS_TURN] chat-r: turn refused, its messages wait for the next turn: 3 summary lines were not written within 180 s; last error: provider busy',
  ]);
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
