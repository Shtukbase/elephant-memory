// The harness's own page reads the memory through routes on the connection
// service, never through the loopback-only routes a host process uses.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { endlessMethods } from '../lib/api.js';
import { BROWSER_METHODS, BROWSER_PREFIX, handleBrowserCall, installBrowserRoutes } from '../lib/browser-routes.js';
import { resolveConfig } from '../lib/config.js';
import { Memories } from '../lib/registry.js';
import { keptLog, rootsForThisFile, settleTicks, wholeTurn } from './fixtures.js';
import { FakeSession } from './harness-fake.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());

/** A memory with two turns, and the seam methods over it. */
async function world() {
  const memories = new Memories({ config: resolveConfig({}), root: roots.fresh(), log: keptLog(), summarizer: () => async () => ({ text: 'S', message: null }) });
  const session = new FakeSession('chat-a');
  session.listeners.push((event) => memories.observe(session, event));
  memories.attach(session);
  session.append('session/title', { title: 'Pricing page' });
  wholeTurn(session, 1, 'Rule: release notes list only what ships.', 'Noted.');
  wholeTurn(session, 2, 'Where are the notes?', 'In docs/releases.');
  await settleTicks();
  return { methods: endlessMethods(memories), memoryId: memories.get('chat-a')?.memoryId ?? '' };
}

/** A connection that records what is registered, as the harness's would serve it. */
function fakeConnection(taken = new Set()) {
  /** @type {Map<string, any>} */
  const routes = new Map();
  return {
    routes,
    fetch: {
      register(/** @type {any} */ route) {
        if (taken.has(route.path)) throw new Error(`connection: exact Fetch route ${route.path} is already registered`);
        routes.set(route.path, route);
      },
    },
  };
}

/** @param {string} method @param {unknown} args @param {object} [extra] */
const call = (method, args, extra = {}) => new Request(`http://127.0.0.1/api/${method}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'r-1', method, payload: { args }, ...extra }),
});

test('the page gets the five reads as POST routes under /api, and never bind', async () => {
  const { methods } = await world();
  const connection = fakeConnection();
  installBrowserRoutes(connection, methods, keptLog());
  assert.deepEqual([...connection.routes.keys()].sort(), BROWSER_METHODS.map((name) => `/api/${BROWSER_PREFIX}${name}`).sort());
  for (const route of connection.routes.values()) {
    assert.deepEqual(route.methods, ['POST']);
    assert.equal(route.requestBody, 'buffered');
  }
  assert.ok(![...connection.routes.keys()].some((path) => path.includes('bind')));
});

test('a path another engine already serves is left to it, and logged', async () => {
  const { methods } = await world();
  const log = keptLog();
  const connection = fakeConnection(new Set([`/api/${BROWSER_PREFIX}view`]));
  installBrowserRoutes(connection, methods, log);
  assert.equal(connection.routes.size, BROWSER_METHODS.length - 1);
  assert.ok(log.infos.some((line) => line.includes('already served')));
});

test('a registered route answers the harness\'s Remote envelope with the same value the seam method gives', async () => {
  const { methods, memoryId } = await world();
  const connection = fakeConnection();
  installBrowserRoutes(connection, methods, keptLog());
  const send = async (/** @type {string} */ name, /** @type {unknown} */ args) => {
    const method = `${BROWSER_PREFIX}${name}`;
    const response = await connection.routes.get(`/api/${method}`).fetch(call(method, args));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    return response.json();
  };
  const memories = await send('memories', {});
  assert.deepEqual(memories, { type: 'server-response', rpcId: 'r-1', result: { ok: true, value: methods['endless.memories']({}) } });
  const history = await send('history', { memoryId, limit: 1 });
  assert.equal(history.result.ok, true);
  assert.equal(history.result.value.turns.length, 1);
  assert.equal(history.result.value.next, 1);
  const hits = await send('search', { memoryId, query: 'RELEASE' });
  assert.equal(hits.result.value.hits[0].sessionTitle, 'Pricing page');
  const opened = await send('zoom', { memoryId, id: 0, n: 1 });
  assert.equal(opened.result.value.message.text, 'Rule: release notes list only what ships.');
});

test('a refusal is an answer in the envelope; an unreadable request is a 400', async () => {
  const { methods } = await world();
  const log = keptLog();
  const run = methods['endless.view'];
  const refused = await handleBrowserCall('endless-ui.view', run, call('endless-ui.view', { memoryId: '0123456789abcdef' }), log);
  assert.equal(refused.status, 200);
  const body = await refused.json();
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, 'endless/unknown-memory');
  const noArgs = await handleBrowserCall('endless-ui.view', run, call('endless-ui.view', null), log);
  assert.equal((await noArgs.json()).result.error.code, 'endless/bad-request');
  const json = { 'content-type': 'application/json; charset=utf-8' };
  for (const bad of [
    new Request('http://127.0.0.1/api/x', { method: 'POST', headers: json, body: 'not json' }),
    call('endless-ui.memories', {}),
    call('endless-ui.view', {}, { type: 'something-else' }),
    call('endless-ui.view', {}, { rpcId: 7 }),
  ]) {
    assert.equal((await handleBrowserCall('endless-ui.view', run, bad, log)).status, 400);
  }
  const huge = new Request('http://127.0.0.1/api/x', { method: 'POST', headers: json, body: 'x'.repeat(70_000) });
  assert.equal((await handleBrowserCall('endless-ui.view', run, huge, log)).status, 400);
  // Counted in bytes, not characters: 30,000 three-byte characters are over 64 KiB.
  const wide = new Request('http://127.0.0.1/api/x', { method: 'POST', headers: json, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'endless-ui.view', payload: { args: { pad: '€'.repeat(30_000) } } }) });
  assert.equal((await handleBrowserCall('endless-ui.view', run, wide, log)).status, 400);
});

test('a body that is not declared JSON is refused before it is read, as the harness\'s own Remote handler refuses it', async () => {
  const { methods } = await world();
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: 'endless-ui.memories', payload: { args: {} } });
  for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }]) {
    const response = await handleBrowserCall('endless-ui.memories', methods['endless.memories'], new Request('http://127.0.0.1/api/x', { method: 'POST', headers, body: envelope }), keptLog());
    assert.equal(response.status, 415, JSON.stringify(headers));
  }
});

test('a read that throws something else says so plainly and logs it', async () => {
  const log = keptLog();
  const response = await handleBrowserCall('endless-ui.view', () => { throw new Error('disk gone'); }, call('endless-ui.view', {}), log);
  const body = await response.json();
  assert.equal(body.result.error.code, 'endless/failed');
  assert.equal(body.result.error.message, 'The memory could not be read. Try again.');
  assert.ok(log.warnings.some((line) => line.includes('disk gone')));
});
