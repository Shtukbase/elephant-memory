// The six seam methods answer with exactly the contract's shapes, from a
// memory this process holds and from one it only reads on disk, and the HTTP
// route speaks the harness's Remote envelope to callers on this computer only.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { ENDLESS_METHODS, EndlessRefusal, endlessMethods } from '../lib/api.js';
import { resolveConfig } from '../lib/config.js';
import { Memories } from '../lib/registry.js';
import { handleCall, installEndlessRoutes } from '../lib/routes.js';
import { keptLog, rootsForThisFile, settleTicks, wholeTurn } from './fixtures.js';
import { FakeSession } from './harness-fake.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

const SCOUT = '/agents/scout';
const WREN = '/agents/wren';
const BOARD = '/work/board';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** @param {string} root */
const registry = (root) => new Memories({ config: resolveConfig({}), root, log: keptLog(), summarizer: () => async () => ({ text: 'S', message: null }) });

/** Two chats with Scout on the board, three turns between them, plus one Wren memory. */
async function world() {
  const root = roots.fresh();
  const memories = registry(root);
  const methods = endlessMethods(memories);
  /** @type {Record<string, FakeSession>} */
  const chats = {};
  for (const [id, agent, title] of [['chat-a', SCOUT, 'Pricing page'], ['chat-b', SCOUT, 'Release notes'], ['chat-q', WREN, 'Risks']]) {
    assert.deepEqual(Object.keys(/** @type {any} */ (methods['endless.bind']({ sessionId: id, agent, project: BOARD }))), ['memoryId']);
    const session = new FakeSession(id);
    session.listeners.push((event) => memories.observe(session, event));
    memories.attach(session);
    session.append('session/title', { title });
    chats[id] = session;
  }
  wholeTurn(chats['chat-a'], 1, 'Rule: release notes list only what ships.', 'Noted.');
  wholeTurn(chats['chat-b'], 1, 'Draft the release notes.', 'Drafted, shipped items only.');
  wholeTurn(chats['chat-a'], 2, 'Where are the notes?', 'In docs/releases.');
  wholeTurn(chats['chat-q'], 1, 'Main risk?', 'The index rebuild.');
  await settleTicks();
  const memoryId = memories.get('chat-a')?.memoryId ?? '';
  return { root, memories, methods, memoryId };
}

/** @param {unknown} value @param {string[]} keys */
const keysOf = (value, keys) => assert.deepEqual(Object.keys(/** @type {object} */ (value)).sort(), [...keys].sort());

test('the six methods answer with exactly the contract\'s shapes', async () => {
  const { memories, methods, memoryId } = await world();
  assert.deepEqual(Object.keys(methods), [...ENDLESS_METHODS]);

  const listed = /** @type {any} */ (methods['endless.memories']({ agent: SCOUT }));
  keysOf(listed, ['memories']);
  assert.equal(listed.memories.length, 1);
  keysOf(listed.memories[0], ['memoryId', 'agent', 'project', 'turns', 'firstAt', 'lastAt', 'writerUsage']);
  assert.deepEqual([listed.memories[0].memoryId, listed.memories[0].agent, listed.memories[0].project, listed.memories[0].turns], [memoryId, SCOUT, BOARD, 3]);
  assert.match(listed.memories[0].firstAt, ISO);
  assert.match(listed.memories[0].lastAt, ISO);
  assert.deepEqual(listed.memories[0].writerUsage, { calls: 0, cacheRead: 0, miss: 0, output: 0 });
  assert.equal(/** @type {any} */ (methods['endless.memories']({})).memories.length, 2);

  const view = /** @type {any} */ (methods['endless.view']({ memoryId }));
  keysOf(view, ['lines']);
  assert.equal(view.lines.length, 6);
  for (const line of view.lines) keysOf(line, ['id', 'n', 'text', 'from', 'to']);
  assert.deepEqual(view.lines[0], { id: 0, n: 1, text: 'in «Pricing page», you: Rule: release notes list only what ships.', from: view.lines[0].from, to: view.lines[0].from });
  assert.match(view.lines[0].from, ISO);

  const message = /** @type {any} */ (methods['endless.zoom']({ memoryId, id: 3, n: 1 }));
  keysOf(message, ['message']);
  keysOf(message.message, ['id', 'kind', 'text', 'at', 'sessionId', 'sessionTitle']);
  assert.deepEqual({ ...message.message, at: '' }, { id: 3, kind: 'reply', text: 'Drafted, shipped items only.', at: '', sessionId: 'chat-b', sessionTitle: 'Release notes' });
  const halves = /** @type {any} */ (methods['endless.zoom']({ memoryId, id: 0, n: 4 }));
  keysOf(halves, ['lines']);
  assert.deepEqual(halves.lines.map((/** @type {any} */ l) => [l.id, l.n]), [[0, 2], [2, 2]]);

  const page = /** @type {any} */ (methods['endless.history']({ memoryId, limit: 2 }));
  keysOf(page, ['turns', 'next']);
  assert.equal(page.next, 1);
  assert.deepEqual(page.turns.map((/** @type {any} */ t) => [t.sessionId, t.sessionTitle]), [['chat-b', 'Release notes'], ['chat-a', 'Pricing page']], 'oldest first inside a page');
  keysOf(page.turns[0], ['at', 'sessionId', 'sessionTitle', 'entries']);
  assert.deepEqual(page.turns[0].entries, [{ id: 2, kind: 'user', text: 'Draft the release notes.' }, { id: 3, kind: 'reply', text: 'Drafted, shipped items only.' }]);
  const older = /** @type {any} */ (methods['endless.history']({ memoryId, before: page.next, limit: 2 }));
  keysOf(older, ['turns']);
  assert.deepEqual(older.turns.map((/** @type {any} */ t) => t.entries[0].id), [0]);

  const found = /** @type {any} */ (methods['endless.search']({ memoryId, query: 'RELEASE NOTES' }));
  keysOf(found, ['hits']);
  assert.deepEqual(found.hits.map((/** @type {any} */ h) => [h.id, h.kind, h.sessionTitle]), [[2, 'user', 'Release notes'], [0, 'user', 'Pricing page']], 'newest first, raw words, any case');
  keysOf(found.hits[0], ['id', 'at', 'sessionTitle', 'kind', 'snippet']);
  assert.equal(found.hits[0].snippet, 'Draft the release notes.');
  assert.equal(/** @type {any} */ (methods['endless.search']({ memoryId, query: 'notes', limit: 1 })).hits.length, 1);
  memories.closeAll();
});

test('a memory this process does not hold is read from its files; bad requests are refusals with a code', async () => {
  const { root, memories, methods, memoryId } = await world();
  const live = JSON.stringify(methods['endless.view']({ memoryId }));
  memories.closeAll();
  const cold = endlessMethods(registry(root));
  assert.equal(JSON.stringify(cold['endless.view']({ memoryId })), live);
  assert.equal(/** @type {any} */ (cold['endless.history']({ memoryId })).turns.length, 3);
  const refused = (/** @type {() => unknown} */ call, /** @type {string} */ code) => assert.throws(call, (error) => error instanceof EndlessRefusal && error.code === code);
  refused(() => cold['endless.view']({ memoryId: '0000000000000000' }), 'endless/unknown-memory');
  refused(() => cold['endless.view']({ memoryId: '../etc' }), 'endless/unknown-memory');
  refused(() => cold['endless.zoom']({ memoryId, id: 1, n: 2 }), 'endless/no-line');
  refused(() => cold['endless.zoom']({ memoryId, n: 1 }), 'endless/bad-request');
  refused(() => cold['endless.history']({ memoryId, limit: 201 }), 'endless/bad-request');
  refused(() => cold['endless.search']({ memoryId, query: 'x', limit: 51 }), 'endless/bad-request');
  refused(() => cold['endless.bind']({ sessionId: 'chat-z', agent: SCOUT }), 'endless/bad-request');
  // A chat id is a file name under the root: one too long for a file name is refused, never half written.
  refused(() => cold['endless.bind']({ sessionId: 'é'.repeat(60), agent: SCOUT, project: BOARD }), 'endless/bad-request');
  refused(() => cold['endless.bind']({ sessionId: 'x'.repeat(201), agent: SCOUT, project: BOARD }), 'endless/bad-request');
  assert.deepEqual(Object.keys(/** @type {object} */ (cold['endless.bind']({ sessionId: 'x'.repeat(200), agent: SCOUT, project: BOARD }))), ['memoryId']);
});

test('a history page ends before 2 MB of text, keeps at least one turn, and names the page before it', async () => {
  const memories = registry(roots.fresh());
  const methods = endlessMethods(memories);
  const session = new FakeSession('chat-long');
  session.listeners.push((event) => memories.observe(session, event));
  memories.attach(session);
  const pasted = (/** @type {string} */ mark) => `${mark} `.repeat(550_000);
  for (const [turn, mark] of [[1, 'a'], [2, 'b'], [3, 'c']]) wholeTurn(session, /** @type {number} */ (turn), pasted(/** @type {string} */ (mark)), 'Read.');
  await settleTicks();
  const memoryId = memories.get('chat-long')?.memoryId ?? '';
  const page = /** @type {any} */ (methods['endless.history']({ memoryId }));
  assert.equal(page.turns.length, 1, 'two 1.1 MB turns would pass the budget');
  assert.equal(page.next, 2);
  assert.ok(page.turns[0].entries[0].text.startsWith('c '));
  const before = /** @type {any} */ (methods['endless.history']({ memoryId, before: page.next }));
  assert.deepEqual([before.turns.length, before.next], [1, 1]);
  memories.closeAll();
});

/** A request as node:http hands it over. */
function request(/** @type {unknown} */ body, { peer = '127.0.0.1', host = '127.0.0.1:3487', origin = undefined, method = 'POST' } = {}) {
  const stream = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  return Object.assign(stream, { method, headers: { host, 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) }, socket: { remoteAddress: peer } });
}

function response() {
  const out = { status: 0, body: /** @type {any} */ (null), destroyed: false };
  return Object.assign(out, {
    writeHead: (/** @type {number} */ status) => { out.status = status; },
    end: (/** @type {string} */ text) => { out.body = JSON.parse(text); },
  });
}

test('the route answers this computer in the harness\'s Remote envelope, and nobody else', async () => {
  const { memories, methods, memoryId } = await world();
  const call = async (/** @type {unknown} */ body, /** @type {any} */ options = {}) => {
    const res = response();
    await handleCall('endless.view', methods['endless.view'], /** @type {any} */ (request(body, options)), /** @type {any} */ (res), keptLog());
    return res;
  };
  const envelope = (/** @type {unknown} */ args) => ({ type: 'client-request', rpcId: 'endless.view', method: 'endless.view', payload: { args } });
  const ok = await call(envelope({ memoryId }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.type, 'server-response');
  assert.equal(ok.body.rpcId, 'endless.view');
  assert.equal(ok.body.result.ok, true);
  assert.equal(ok.body.result.value.lines.length, 6);
  const refused = await call(envelope({ memoryId: '0000000000000000' }));
  assert.deepEqual(refused.body.result, { ok: false, error: { code: 'endless/unknown-memory', message: 'That memory does not exist.', details: {} } });
  assert.equal((await call(envelope({ memoryId }), { peer: '192.168.1.5' })).status, 403);
  assert.equal((await call(envelope({ memoryId }), { origin: 'http://127.0.0.1:3487' })).status, 403);
  assert.equal((await call(envelope({ memoryId }), { host: 'evil.example:3487' })).status, 403);
  assert.equal((await call('not json')).status, 400);
  assert.equal((await call({ ...envelope({ memoryId }), method: 'endless.bind' })).status, 400);
  // Six exact routes; one another engine already serves is left to it.
  /** @type {string[]} */
  const paths = [];
  const server = { register: (/** @type {any} */ route) => {
    if (route.path === '/api/endless.search') throw new Error('webserver: duplicate exact route');
    paths.push(route.path);
    return () => {};
  } };
  installEndlessRoutes(server, methods, keptLog());
  assert.deepEqual(paths, ['/api/endless.bind', '/api/endless.memories', '/api/endless.view', '/api/endless.zoom', '/api/endless.history']);
  memories.closeAll();
});
