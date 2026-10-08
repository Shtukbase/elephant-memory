// A turn the person stops with Esc is saved: the message, what the agent
// already said, its tool uses so far, and a closing note. The event sequences
// are the harness's own (0.2.0-rc.2): `dsh-api-session-controller` cancels with
// `{ kind: 'user' }` and keeps the inbox; `dsh-agent-loop` claims the turn's
// messages before step 1 (`inbox.claim`, a splice with no outcome), appends
// them only in `step()` after the request is prepared, commits a cut reply as
// an `interrupted` assistant message, and always ends with `turn/end` reason
// `{ kind: 'aborted', reason: { kind: 'user' } }`. The middle sequences are
// copied from two real stopped sessions, their long texts shortened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERRUPTED_NOTE, STOPPED_NOTE } from '../lib/history.js';
import { stepOne } from '../lib/step-one.js';
import { TurnCollector } from '../lib/turns.js';
import { FakeSession } from './harness-fake.js';

const STOPPED = { kind: 'aborted', reason: { kind: 'user' } };

/** The person's message as the web UI queues it (real log, seq 4). @param {string} id @param {string} text */
const queued = (id, text) => ({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-${id}`, clientTimeZone: 'Asia/Bangkok' }, role: 'user', id });

/** Every record the chat's events give, as [turn, kind, text]. @param {readonly any[]} events */
function records(events) {
  const collector = new TurnCollector('session-1', 'turn');
  const out = [];
  for (const event of events) {
    const record = collector.push(event);
    if (record !== null) for (const entry of record.entries) out.push([record.turn, entry.kind, entry.text]);
  }
  return out;
}

/**
 * Step 1 of a turn as the loop runs it up to the plugin's hold: open the turn,
 * claim the queued message, run the step-one seam over a memory whose summary
 * lines are not written yet. Resolves when the seam settles or throws.
 * @param {FakeSession} session @param {number} turn @param {AbortSignal} signal
 */
async function heldStepOne(session, turn, signal) {
  session.append('turn/start', { turn });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  const memory = {
    size: 3,
    // memory.js settle: resolves false when the turn's signal aborts.
    settle: (/** @type {AbortSignal} */ s) => new Promise((resolve) => s.addEventListener('abort', () => resolve(false), { once: true })),
    render: () => '<chat></chat>',
    waiting: () => 3,
    view: { parts: [] },
    writer: { lastError: '' },
  };
  const io = { makeMessage: () => assert.fail('nothing is laid out'), viewMessage: () => assert.fail('no view'), checkpoint: () => assert.fail('no checkpoint'), bracketOpen: () => false };
  return stepOne({ memory, session, signal, next: () => assert.fail('the chain is not reached'), kinds: [], timeoutMs: 600_000, io });
}

test('a turn stopped while it waits for the memory keeps the person\'s message once, and the next turn does not repeat it', async () => {
  const session = new FakeSession();
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued('m-held', 'Rule: release notes list only what ships.')] });
  const abort = new AbortController();
  const held = heldStepOne(session, 2, abort.signal);
  abort.abort({ kind: 'user' });
  await assert.rejects(held, (error) => /** @type {any} */ (error).kind === 'user', 'the hold must end with the cancel itself, not a refusal');
  // The loop's finally: no user/message was appended, nothing went back to the inbox.
  assert.ok(!session.events.some((e) => e.type === 'user/message'));
  session.append('turn/end', { turn: 2, reason: STOPPED });
  // The person writes again; an ordinary turn follows.
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued('m-next', 'Go on.')] });
  session.append('turn/start', { turn: 3 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  session.append('user/message', queued('m-next', 'Go on.'), { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], source: { kind: 'model' } } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
  assert.deepEqual(records(session.events), [
    [2, 'user', 'Rule: release notes list only what ships.'],
    [2, 'note', STOPPED_NOTE],
    [3, 'user', 'Go on.'],
    [3, 'talk', 'Done.'],
  ]);
});

test('a turn refused and then stopped keeps nothing: its message went back to the inbox and comes with the next turn, once', () => {
  const session = new FakeSession();
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued('m1', 'Check the board.')] });
  session.append('turn/start', { turn: 1 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  // engine.refuse: the claimed message goes back (without its rpcId), then the cancel lands.
  const back = { ...queued('m1', 'Check the board.'), source: { kind: 'user', clientTimeZone: 'Asia/Bangkok' } };
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [back] });
  session.append('turn/end', { turn: 1, reason: STOPPED });
  session.append('turn/start', { turn: 2 });
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] });
  session.append('user/message', back, { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }], source: { kind: 'model' } } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.deepEqual(records(session.events), [
    [2, 'user', 'Check the board.'],
    [2, 'talk', 'Checked.'],
  ]);
});

test('a turn stopped before any model output keeps the message and the note, once', () => {
  const session = new FakeSession();
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued('m1', 'What is the rule now?')] });
  session.append('turn/start', { turn: 1 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('user/message', queued('m1', 'What is the rule now?'), { surfaceOp: 'append' });
  // Stopped with nothing visible streamed: the loop settles an attempt, never a message.
  session.append('assistant/attempt', { turn: 1, step: 1, stream: [] });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: STOPPED });
  assert.deepEqual(records(session.events), [
    [1, 'user', 'What is the rule now?'],
    [1, 'note', STOPPED_NOTE],
  ]);
});

test('a turn stopped mid-reply keeps the tool uses, the reply as far as it went, and the note (real session)', () => {
  const session = new FakeSession();
  const ask = queued('03f21eb4-e46d-42c7-848e-89091a7746b4', 'What rule did I give you about release notes, and in which chat?');
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [ask] });
  session.append('turn/start', { turn: 1 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('user/message', ask, { surfaceOp: 'append' });
  const call = { type: 'tool-call', id: 'call_00_4wici9akd150okb0prh2kaqx', name: 'run_code', arguments: '{"code":"pwd"}' };
  session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'I\'ll search your workspace for release notes rules and planning notes.' }, call], source: { provider: 'opencode-go', model: 'deepseek-flash' } } }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments });
  session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, content: [{ type: 'text', text: '/work' }] } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 8 });
  // The cut reply (real seq 90): `interrupted`, its unfinished tool call dropped by the harness.
  session.append('assistant/message', { turn: 1, step: 8, message: { role: 'assistant', content: [{ type: 'text', text: 'I have both answers, verbatim from the stored turns. Let me confirm the session title maps to the chat name.' }], source: { provider: 'opencode-go', model: 'deepseek-flash' } }, interrupted: true, stream: [] }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 8 });
  session.append('turn/end', { turn: 1, reason: STOPPED });
  assert.deepEqual(records(session.events), [
    [1, 'user', 'What rule did I give you about release notes, and in which chat?'],
    [1, 'tool', 'said: I\'ll search your workspace for release notes rules and planning notes.\n\ndid: run_code {"code":"pwd"}\nresult: /work'],
    [1, 'talk', 'I have both answers, verbatim from the stored turns. Let me confirm the session title maps to the chat name.'],
    [1, 'note', STOPPED_NOTE],
  ]);
});

test('a turn stopped during a tool call keeps the call with its aborted result and the note (real session)', () => {
  const session = new FakeSession();
  const rule = queued('256396c1-ef9f-48ea-a484-04809c06a70b', 'Rule: release notes list only what ships.');
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [rule] });
  session.append('turn/start', { turn: 2 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  session.append('step/start', { turn: 2, step: 9 });
  session.append('user/message', rule, { surfaceOp: 'append' });
  const call = { type: 'tool-call', id: 'call_00_3yocj6s4orgc311o41rzw0nf', name: 'ask_user_question', arguments: '{"questions":[]}' };
  session.append('assistant/message', { turn: 2, step: 9, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Ask how to file it.' }, call], source: { provider: 'opencode-go', model: 'deepseek-flash' } } }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 2, step: 9, callId: call.id, name: call.name, arguments: call.arguments });
  session.append('tool/result', { turn: 2, step: 9, message: { role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, content: [{ type: 'text', text: 'Error: ask_user_question was aborted before the user answered' }], isError: true }, error: { name: 'UserQuestionError', code: 'ASK_ABORTED' } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 2, step: 9 });
  session.append('turn/end', { turn: 2, reason: STOPPED });
  assert.deepEqual(records(session.events), [
    [2, 'user', 'Rule: release notes list only what ships.'],
    [2, 'tool', 'did: ask_user_question {"questions":[]}\nresult: error: Error: ask_user_question was aborted before the user answered'],
    [2, 'note', STOPPED_NOTE],
  ]);
});

test('a turn closed after a crash keeps its claimed message and ends with an interrupted note, never the stopped one', () => {
  const session = new FakeSession();
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued('m1', 'Rule: release notes list only what ships.')] });
  session.append('turn/start', { turn: 1 });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  // The process died in the hold; on the next start dsh-session's interruptedTurnClosers
  // (openTurnClosers, lib/index.js:747-795) writes the closer with a bare reason.
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  assert.deepEqual(records(session.events), [
    [1, 'user', 'Rule: release notes list only what ships.'],
    [1, 'note', INTERRUPTED_NOTE],
  ]);
});

test('a finished turn has no note, and a turn that failed for another reason is not marked stopped', () => {
  const session = new FakeSession();
  session.append('turn/start', { turn: 1 });
  session.append('user/message', queued('m1', 'Hello.'), { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: 2 });
  session.append('user/message', queued('m2', 'Again.'), { surfaceOp: 'append' });
  session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } });
  assert.deepEqual(records(session.events), [[1, 'user', 'Hello.'], [2, 'user', 'Again.']]);
});
