// Memory per (agent, project): the default key outside a host, a binding made
// before a chat's first turn, a second chat that starts with the first one's
// memory, and two chats that interleave whole turns, each named by its title.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { EndlessRefusal } from '../lib/api.js';
import { resolveConfig } from '../lib/config.js';
import { Memories } from '../lib/registry.js';
import { keptLog, rootsForThisFile, settleTicks, wholeTurn } from './fixtures.js';
import { FakeSession } from './harness-fake.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

const SCOUT = '/agents/scout';
const BOARD = '/work/board';

/** The contract's id rule, computed here on its own. @param {string} agent @param {string} project */
const idOf = (agent, project) => createHash('sha256').update(`${agent}\n${project}`).digest('hex').slice(0, 16);

/** A registry whose writer records every model call, and the route it was given, and answers with a short line. */
function registry() {
  /** @type {{ memoryId: string, step: string, route: any }[]} */
  const calls = [];
  const memories = new Memories({
    config: resolveConfig({}),
    root: roots.fresh(),
    log: keptLog(),
    summarizer: (memoryId, route) => async (turns) => {
      const first = /** @type {{ texts: string[] }} */ (turns[0]);
      calls.push({ memoryId, step: first.texts[1], route: route() });
      return { text: `S${calls.length}`, message: null };
    },
  });
  return { memories, calls };
}

/** A chat whose every event reaches the registry, as `session/event` does. @param {Memories} memories @param {string} id @param {any} [header] */
function chat(memories, id, header) {
  const session = new FakeSession(id, header);
  session.listeners.push((event) => memories.observe(session, event));
  return session;
}

test('an unbound chat uses the default key (its preset, its workspace), with the contract\'s memory id', () => {
  const { memories } = registry();
  const session = chat(memories, 'chat-1', { agentPreset: 'endless', cwd: BOARD });
  const memory = memories.attach(session);
  assert.equal(memory.memoryId, idOf('endless', BOARD));
  assert.deepEqual(memory.key, { agent: 'endless', project: BOARD });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(memories.root, 'memories', memory.memoryId, 'key.json'), 'utf8')), { agent: 'endless', project: BOARD });
  memories.closeAll();
});

// A live trial on 2026-10-08 in a clean harness: the web UI made the session in
// its default mode (header `standard`) and logged the Endless pick as an
// `agent-preset/selected` event, so the memory was keyed `standard`.
test('an unbound chat is keyed by the mode it runs, picked after it was made, so it shares a memory with a chat made in that mode', () => {
  const { memories } = registry();
  const picked = chat(memories, 'chat-picked', { agentPreset: 'standard', cwd: BOARD });
  picked.append('permission/preset', { preset: 'workspace-write' });
  picked.append('agent-preset/selected', { agentPreset: 'standard' });
  picked.append('agent-preset/selected', { agentPreset: 'endless' });
  const memory = memories.attach(picked);
  assert.deepEqual(memory.key, { agent: 'endless', project: BOARD });
  assert.equal(memories.attach(chat(memories, 'chat-default', { agentPreset: 'endless', cwd: BOARD })), memory);
  memories.closeAll();
});

test('a chat bound before its first turn writes into its key\'s memory, and a new chat bound there starts with all of it', async () => {
  const { memories } = registry();
  assert.deepEqual(memories.bind('chat-a', SCOUT, BOARD), { memoryId: idOf(SCOUT, BOARD) });
  const a = chat(memories, 'chat-a', { agentPreset: 'endless', cwd: '/somewhere/else' });
  assert.equal(memories.attach(a).memoryId, idOf(SCOUT, BOARD), 'the binding did not win over the default key');
  wholeTurn(a, 1, 'Rule: release notes list only what ships.', 'Noted.');
  wholeTurn(a, 2, 'Thanks.', 'Any time.');
  // A new chat, the next day, with the same agent in the same project.
  memories.bind('chat-b', SCOUT, BOARD);
  const b = chat(memories, 'chat-b');
  const memory = memories.attach(b);
  assert.equal(memory, memories.get('chat-a'), 'two chats of one key must share one memory');
  assert.equal(memory.size, 4);
  await settleTicks();
  assert.match(memory.render(), /release notes list only what ships/);
  // An unbound chat elsewhere has a memory of its own.
  const c = chat(memories, 'chat-c', { agentPreset: 'endless', cwd: '/other/project' });
  assert.notEqual(memories.attach(c), memory);
  assert.equal(memories.get('chat-c')?.size, 0);
  memories.closeAll();
});

test('a chat whose turns are already in a memory keeps it; a chat with none may be bound again', () => {
  const { memories } = registry();
  memories.bind('chat-a', SCOUT, BOARD);
  const a = chat(memories, 'chat-a');
  memories.attach(a);
  wholeTurn(a, 1, 'hello', 'hi');
  assert.throws(() => memories.bind('chat-a', '/agents/wren', BOARD), (error) => error instanceof EndlessRefusal && error.code === 'endless/already-bound');
  memories.bind('chat-b', SCOUT, BOARD);
  const b = chat(memories, 'chat-b');
  memories.attach(b);
  assert.deepEqual(memories.bind('chat-b', '/agents/wren', BOARD), { memoryId: idOf('/agents/wren', BOARD) });
  assert.equal(memories.attach(b).memoryId, idOf('/agents/wren', BOARD));
  assert.throws(() => memories.bind('chat-d', '', BOARD), EndlessRefusal);
  memories.closeAll();
});

test('two chats of one memory interleave whole turns only, in the order they finish, and the writer reads each turn\'s chat title', async () => {
  const { memories, calls } = registry();
  memories.bind('chat-a', SCOUT, BOARD);
  memories.bind('chat-b', SCOUT, BOARD);
  const a = chat(memories, 'chat-a');
  const b = chat(memories, 'chat-b');
  const memory = memories.attach(a);
  memories.attach(b);
  // The writer runs once a turn that passed the model guard named the route.
  memories.noteRoute(memory.memoryId, { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'chat-a' });
  a.append('session/title', { title: 'Pricing page' });
  b.append('session/title', { title: 'Release notes' });
  const long = (/** @type {string} */ word) => `${word} ${'detail '.repeat(100)}`;
  // A's turn starts first, B's starts and finishes inside it, then A finishes.
  a.append('turn/start', { turn: 1 });
  a.append('user/message', { id: 'a1', role: 'user', content: [{ type: 'text', text: long('alpha-question') }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  wholeTurn(b, 1, long('beta-question'), long('beta-reply'));
  a.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: long('alpha-reply') }] } }, { surfaceOp: 'append' });
  a.append('turn/end', { turn: 1 });
  assert.deepEqual(memory.records.map((r) => [r.sessionId, r.turn]), [['chat-b', 1], ['chat-a', 1]]);
  assert.deepEqual(memory.entries.map((e) => [e.record, e.text.split(' ')[0]]), [
    [0, 'beta-question'], [0, 'beta-reply'], [1, 'alpha-question'], [1, 'alpha-reply'],
  ]);
  await settleTicks(200);
  assert.equal(memory.view.allBuilt(), true);
  const compressed = calls.filter((call) => call.step.startsWith('Compaction: compress message'));
  assert.match(compressed[0].step, /\nin «Release notes», you: beta-question/);
  assert.match(compressed[2].step, /\nin «Pricing page», you: alpha-question/);
  assert.match(compressed[1].step, /\nScout: beta-reply/, 'only the first message of a turn names its chat');
  memories.closeAll();
});

test('the writer calls only the route a chat of the memory ran on, and calls nothing while none is known', async () => {
  const { memories, calls } = registry();
  memories.bind('chat-a', SCOUT, BOARD);
  const a = chat(memories, 'chat-a');
  const memory = memories.attach(a);
  wholeTurn(a, 1, `long ${'words '.repeat(200)}`, 'ok');
  await settleTicks(100);
  assert.equal(calls.length, 0, 'a summary was sent with no route of this memory\'s chats');
  assert.equal(memory.view.allBuilt(), false);
  const route = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'chat-a' };
  memories.noteRoute(memory.memoryId, route);
  await settleTicks(100);
  assert.equal(memory.view.allBuilt(), true);
  assert.deepEqual(calls.map((call) => call.route), [route]);
  memories.closeAll();
});

// A browser trial on 2026-10-08: an agent's own replies read "Assistant:".
test('an agent\'s replies are tagged with its own name: the display name a bind gives, else its page\'s name; an unbound chat keeps the configured one', async () => {
  const { memories } = registry();
  memories.bind('chat-o', '/agents/orchestrator-two', BOARD, 'Orchestrator');
  const o = chat(memories, 'chat-o');
  memories.attach(o);
  wholeTurn(o, 1, 'hello', 'Hi, I coordinate.');
  memories.bind('chat-c', '/agents/release-captain', BOARD);
  const c = chat(memories, 'chat-c');
  memories.attach(c);
  wholeTurn(c, 1, 'hello', 'Ready.');
  const u = chat(memories, 'chat-u', { agentPreset: 'endless', cwd: BOARD });
  memories.attach(u);
  wholeTurn(u, 1, 'hello', 'Hello.');
  await settleTicks();
  assert.match(memories.attach(o).render(), /\n1\+1\|Orchestrator: Hi, I coordinate\.\n/);
  assert.match(memories.attach(c).render(), /\n1\+1\|Release Captain: Ready\.\n/);
  assert.match(memories.attach(u).render(), /\n1\+1\|Assistant: Hello\.\n/);
  const keyFile = path.join(memories.root, 'memories', idOf('/agents/orchestrator-two', BOARD), 'key.json');
  assert.equal(JSON.parse(fs.readFileSync(keyFile, 'utf8')).name, 'Orchestrator');
  assert.throws(() => memories.bind('chat-x', SCOUT, BOARD, 'Two: words'), /not readable/);
  memories.closeAll();
});

// Round 4 live walk, F6: a chat's first turn notes the route before the harness
// has written that chat's system prompt, and its summary calls went out with
// the plugin's own section and no tools while the other chat's carried 57.
test('until a chat has its own system prompt, the writer reads the newest other chat\'s, then its own', () => {
  const { memories } = registry();
  memories.bind('chat-a', SCOUT, BOARD);
  memories.bind('chat-b', SCOUT, BOARD);
  const a = chat(memories, 'chat-a');
  const memory = memories.attach(a);
  memories.attach(chat(memories, 'chat-b'));
  const ofA = { system: { role: 'system', content: [] }, tools: [{ name: 'zoom' }] };
  /** @type {any} */
  let ofB = {};
  memories.noteRoute(memory.memoryId, { provider: 'p', model: 'm', sessionId: 'chat-a', prefix: () => ofA });
  memories.noteRoute(memory.memoryId, { provider: 'p', model: 'm2', sessionId: 'chat-b', prefix: () => ofB });
  const route = /** @type {any} */ (memories.routeOf(memory.memoryId));
  assert.deepEqual({ provider: route.provider, model: route.model, sessionId: route.sessionId }, { provider: 'p', model: 'm2', sessionId: 'chat-b' });
  assert.equal(route.prefix(), ofA, 'a chat with no system prompt yet sent none, while another chat of the memory has one');
  ofB = { system: { role: 'system', content: [{ type: 'text', text: 'B' }] }, tools: [] };
  assert.equal(route.prefix(), ofB, 'a chat with its own system prompt did not send it');
  // A chat that went away gives nothing.
  ofB = {};
  memories.detach('chat-a');
  assert.deepEqual(route.prefix(), {});
  memories.closeAll();
});
