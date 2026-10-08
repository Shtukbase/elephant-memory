// The turn layout keeps the harness's context messages before the view, so
// step 1 of every turn reads them from the provider's prefix cache (SEAMS.md,
// "Context nodes and the cache"). Measured before this layout: each turn start
// re-sent the skill catalog and the runtime context AFTER the new message, and
// missed the cache on ~3.4k tokens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextFirst, layOutTurn, planTurn } from '../lib/context.js';
import {
  FakeSession,
  RuntimeContext,
  commonPrefix,
  instructionsOwner,
  skillCatalogOwner,
  stepOne,
  textOf,
  userMessage,
  wire,
} from './harness-fake.js';

/** The view at a turn: two lines per earlier turn, and each view extends the previous one. @param {number} turn */
function view(turn) {
  const lines = [];
  for (let t = 1; t < turn; t++) lines.push(`${2 * t - 2}+1|you: message ${t}`, `${2 * t - 1}+1|Assistant: reply ${t}`);
  return `<chat>\n${lines.join('\n')}\n</chat>`;
}

/** The Endless listener on step 1, as `engine.preStep` runs it once the view is settled. @param {FakeSession} session */
function endless(session) {
  return async (/** @type {any} */ { turn }, /** @type {() => Promise<any>} */ next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || decision.messages.length === 0) return decision;
    if (turn === 1) return contextFirst(decision);
    return layOutTurn(session, decision, {
      makeMessage: (item) => ({ ...userMessage('', item.source), content: item.content }),
      checkpoint: (span) => session.append('user/message', userMessage(view(turn), { kind: 'compact-checkpoint', compactionId: `c${turn}` }), {
        surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end },
        sourceEventSeqs: span.seqs,
      }),
    });
  };
}

/** @param {any[]} messages */
const kinds = (messages) => messages.map((m) => (m.role === 'system' ? 'system' : m.source.kind));

/** Where `text` ends inside a wire request. @param {string} wired @param {string} text */
function endOf(wired, text) {
  const escaped = JSON.stringify(text).slice(1, -1);
  const at = wired.indexOf(escaped);
  assert.ok(at >= 0, 'text not found in the request');
  return at + escaped.length;
}

/** The old view's lines, without the closing tag that the next view moves. @param {number} turn */
const oldLines = (turn) => view(turn).replace(/\n<\/chat>$/, '');

/** @param {any[]} events @param {string} kind */
const count = (events, kind) => events.filter((e) => e.type === 'user/message' && e.data.source.kind === kind).length;

/** @param {any[]} messages @param {string} kind */
const find = (messages, kind) => messages.find((m) => m.source?.kind === kind);

/** Run turns 1..n; `between(turn)` runs after each reply, before `turn/end`. */
async function converse(/** @type {number} */ n, /** @type {() => ((io: any) => Function)[]} */ chain, between = (/** @type {any} */ _ctx) => {}) {
  const session = new FakeSession();
  const runtime = new RuntimeContext(session);
  const skills = { entries: ['alpha', 'beta'] };
  const state = { policy: 'Approval policy: ask.' };
  const listeners = chain().map((make) => make({ session, skills }));
  const requests = [];
  for (let turn = 1; turn <= n; turn++) {
    requests.push(await stepOne(session, runtime, { turn, text: `message ${turn}`, context: state.policy, listeners }));
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `reply ${turn}` }], source: { kind: 'model' } } }, { surfaceOp: 'append' });
    between({ turn, session, runtime, skills, state });
    session.append('turn/end', { turn });
  }
  return { session, runtime, requests };
}

const outermost = () => [
  ({ session }) => endless(session),
  ({ session, skills }) => skillCatalogOwner(session, skills),
  ({ session }) => instructionsOwner(session, 'Root instructions.'),
];

test('step 1 of every turn reads [system][catalog][runtime context][instructions][view][new message], and nothing is sent twice', async () => {
  const { session, runtime, requests } = await converse(4, outermost);
  assert.deepEqual(kinds(requests[0]), ['system', 'skill-catalog', 'runtime-context', 'agent-instructions', 'user']);
  for (const request of requests.slice(1)) {
    assert.deepEqual(kinds(request), ['system', 'skill-catalog', 'runtime-context', 'agent-instructions', 'compact-checkpoint', 'user']);
  }
  // The owners found their messages visible every turn: no copy, no republication.
  assert.equal(count(session.events, 'skill-catalog'), 1);
  assert.equal(count(session.events, 'runtime-context'), 1);
  assert.equal(count(session.events, 'agent-instructions'), 1);
  assert.ok(textOf(find(requests[3], 'skill-catalog')).startsWith('The following skills'), 'the catalog was republished as changed');
  assert.equal(runtime.retained?.seq, session.visible('runtime-context')[0].seq, 'the loop would send a fresh runtime context');
});

test('each step-1 request shares with the previous one everything up to the end of the old view', async () => {
  const { requests } = await converse(4, outermost);
  // Turn 2: the whole context block was already the first request's prefix.
  const [first, second] = [wire(requests[0]), wire(requests[1])];
  assert.ok(commonPrefix(first, second) >= endOf(second, textOf(find(requests[1], 'agent-instructions'))));
  // Turns 3 and 4: the context block and the old view lines are cached; only new lines and the message are not.
  for (const turn of [3, 4]) {
    const before = wire(requests[turn - 2]);
    const after = wire(requests[turn - 1]);
    assert.ok(commonPrefix(before, after) >= endOf(after, oldLines(turn - 1)), `turn ${turn} misses inside the old view`);
  }
});

test('whatever the listener order, the owners re-send nothing and the layout is in place from turn 2', async () => {
  const ownersOutside = () => [
    ({ session, skills }) => skillCatalogOwner(session, skills),
    ({ session }) => instructionsOwner(session, 'Root instructions.'),
    ({ session }) => endless(session),
  ];
  const { session, runtime, requests } = await converse(4, ownersOutside);
  for (const request of requests.slice(1)) {
    assert.deepEqual(kinds(request), ['system', 'skill-catalog', 'runtime-context', 'agent-instructions', 'compact-checkpoint', 'user']);
  }
  for (const turn of [3, 4]) {
    const after = wire(requests[turn - 1]);
    assert.ok(commonPrefix(wire(requests[turn - 2]), after) >= endOf(after, oldLines(turn - 1)));
  }
  assert.ok(requests.every((r) => r.filter((m) => m.source?.kind === 'skill-catalog').length <= 1));
  assert.ok(!session.events.some((e) => e.data?.source?.update === true), 'the catalog was republished as changed');
  assert.equal(runtime.retained?.seq, session.visible('runtime-context')[0].seq);
});

test('a context message that changes during a turn moves into the block: the next turn misses from it, the one after hits again', async () => {
  const { session, runtime, requests } = await converse(4, outermost, ({ turn, session: s, runtime: r, state }) => {
    if (turn !== 2) return;
    // Later steps of turn 2, as the harness appends them: nested instructions after a read, then a new policy.
    s.append('user/message', userMessage('Instructions for collections/.', { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set', scope: 'collections', path: 'collections/AGENTS.md' }] }), { surfaceOp: 'append' });
    state.policy = 'Approval policy: never.';
    s.append('user/message', r.project(state.policy), { surfaceOp: 'append' });
  });
  const third = requests[2];
  assert.deepEqual(kinds(third), ['system', 'skill-catalog', 'runtime-context', 'agent-instructions', 'agent-instructions', 'compact-checkpoint', 'user']);
  assert.equal(textOf(find(third, 'runtime-context')), 'Approval policy: never.');
  const [second, thirdWire] = [wire(requests[1]), wire(third)];
  const shared = commonPrefix(second, thirdWire);
  assert.ok(shared >= endOf(thirdWire, textOf(find(third, 'skill-catalog'))), 'the unchanged catalog missed');
  assert.ok(shared < endOf(thirdWire, 'Approval policy: never.'), 'the changed snapshot cannot have been cached');
  const fourth = wire(requests[3]);
  assert.ok(commonPrefix(thirdWire, fourth) >= endOf(fourth, oldLines(3)), 'turn 4 missed again');
  assert.equal(session.visible('runtime-context').length, 1);
  assert.equal(runtime.retained?.seq, session.visible('runtime-context')[0].seq, 'the loop would send the snapshot again');
});

test('a skill catalog that changed is moved into the block in the turn it changes, and the next turn hits again', async () => {
  const { session, requests } = await converse(4, outermost, ({ turn, skills }) => {
    if (turn === 2) skills.entries = ['alpha', 'beta', 'gamma'];
  });
  const third = requests[2];
  assert.deepEqual(kinds(third), ['system', 'skill-catalog', 'runtime-context', 'agent-instructions', 'compact-checkpoint', 'user']);
  assert.ok(textOf(find(third, 'skill-catalog')).includes('gamma'));
  assert.equal(session.visible('skill-catalog').length, 1);
  assert.equal(count(session.events, 'skill-catalog'), 2, 'the catalog was sent more than once for one change');
  const fourth = wire(requests[3]);
  assert.ok(commonPrefix(wire(third), fourth) >= endOf(fourth, oldLines(3)));
});

test('the first turn puts the step\'s context messages first and keeps every other message in its order', () => {
  const user = userMessage('hello', { kind: 'user' });
  const time = userMessage('It is noon.', { kind: 'time-context' });
  const rc = userMessage('Policy.', { kind: 'runtime-context' });
  const catalog = userMessage('Skills.', { kind: 'skill-catalog', entries: [] });
  const decision = contextFirst({ kind: 'enter', messages: [user, rc, time, catalog] });
  assert.deepEqual(decision.messages, [catalog, rc, user, time]);
  assert.deepEqual(contextFirst({ kind: 'reject' }), { kind: 'reject' });
});

test('with too few surface slots, what does not fit stays after the new message', () => {
  const session = new FakeSession();
  session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'S' }] } }, { surfaceOp: 'append' });
  const rcOld = session.append('user/message', userMessage('Policy.', { kind: 'runtime-context' }), { surfaceOp: 'append' });
  const ai = session.append('user/message', userMessage('Rules.', { kind: 'agent-instructions', changes: [] }), { surfaceOp: 'append' });
  const user = userMessage('next', { kind: 'user' });
  const catalog = userMessage('Skills.', { kind: 'skill-catalog', entries: [] });
  const plan = planTurn(session, [user, catalog]);
  // Three context entries and two slots, one of them the checkpoint's: the block keeps one entry.
  assert.deepEqual(plan?.writes.map((w) => [w.slot, w.item.source.kind]), [[rcOld.seq, 'skill-catalog']]);
  assert.deepEqual(plan?.span.seqs, [ai.seq]);
  const decision = layOutTurn(session, { kind: 'enter', messages: [user, catalog] }, {
    makeMessage: (item) => ({ ...userMessage('', item.source), content: item.content }),
    checkpoint: (span) => session.append('user/message', userMessage('<chat>\n</chat>', { kind: 'compact-checkpoint' }), { surfaceOp: { op: 'replace', startSeq: span.start, endSeq: span.end }, sourceEventSeqs: span.seqs }),
  });
  assert.deepEqual(kinds(session.deriveMessages()), ['system', 'skill-catalog', 'compact-checkpoint']);
  assert.deepEqual(kinds(decision.messages), ['user', 'runtime-context', 'agent-instructions']);
  assert.equal(textOf(decision.messages[1]), 'Policy.');
  assert.equal(planTurn(new FakeSession(), [user]), null);
});
