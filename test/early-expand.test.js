// The query step of auto-recall (llm-expand.js) needs only the person's new
// words, so `preStep` starts it at once and it runs while the turn waits on
// the summary writer. The seam then takes that same answer: one model call per
// turn, never two. A turn that never reaches recall leaves no failure behind.
// This file imports the engine, and so the harness's packages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { CONTEXT_KINDS } from '../lib/context.js';
import { EndlessCompactionEngine } from '../lib/engine.js';
import { RECALL_SOURCE } from '../lib/recall-ranked.js';
import { keptLog } from './fixtures.js';
import { FakeSession, userMessage } from './harness-fake.js';

/** A memory with one rule worth recalling, whose settle waits until `release`. @param {string[]} order */
function memoryOf(order, { size = 40, settles = true } = {}) {
  const entries = Array.from({ length: size }, (_, i) => ({ i, kind: 'user', text: `Weather report number ${i}: calm skies.`, time: Date.UTC(2026, 9, 1), record: i, title: 'Synthetic rules' }));
  if (size > 0) entries[0].text = 'Rule: the walrus quota is seventeen crates per sledge.';
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const memory = {
    memoryId: 'm1',
    get size() { return entries.length; },
    entry: (/** @type {number} */ i) => entries[i],
    entries,
    tree: { text: () => null },
    config: resolveConfig({ autoRecall: true }),
    settle: async () => { order.push('settle waits'); await gate; order.push('settle ends'); return settles; },
    render: () => '<chat>\n</chat>',
    waiting: () => 1,
    view: { parts: [] },
    writer: { lastError: '' },
  };
  return { memory, release };
}

/** An engine whose constructor is not run: only what `preStep` reads is set. @param {any} memory @param {(text: string) => Promise<string | undefined>} expand */
function engineOver(memory, expand) {
  const engine = Object.create(EndlessCompactionEngine.prototype);
  engine.log = keptLog();
  engine.kinds = CONTEXT_KINDS;
  engine.guard = { allows: async () => true };
  engine.shown = new Map();
  engine.memories = { attach: () => memory, get: () => memory, noteRoute: () => {} };
  engine.writerRoute = () => undefined;
  engine.expand = (/** @type {any} */ _m, /** @type {string} */ _id, /** @type {string} */ text) => expand(text);
  return engine;
}

const agentOf = (/** @type {string} */ id) => ({ session: new FakeSession(id), options: { provider: 'local', model: 'deepseek-flash' }, inject: () => {} });

test('the query step starts before the writer settles, and the seam reuses its answer: one call per turn', async () => {
  /** @type {string[]} */
  const order = [];
  const { memory, release } = memoryOf(order);
  /** @type {string[]} */
  const asked = [];
  const engine = engineOver(memory, async (text) => { asked.push(text); order.push('query starts'); return 'walrus quota crates sledge'; });
  const claimed = [userMessage('What was the walrus quota in crates?', { kind: 'user' })];
  const turn = engine.preStep({ agent: agentOf('chat-e'), messages: claimed, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: claimed }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...order].sort(), ['query starts', 'settle waits'], 'the query step waited for the writer');
  release();
  const out = await turn;
  assert.deepEqual(asked, ['What was the walrus quota in crates?'], 'the query step ran twice, or for other words');
  const block = out.messages.find((/** @type {any} */ m) => m.source?.kind === RECALL_SOURCE);
  assert.match(block.content[0].text, /seventeen/);
});

test('words the seam asks for that differ from the early ones get their own query', async () => {
  const { memory, release } = memoryOf([]);
  /** @type {string[]} */
  const asked = [];
  const engine = engineOver(memory, async (text) => { asked.push(text); return undefined; });
  const claimed = [userMessage('What was the walrus quota in crates?', { kind: 'user' })];
  // Another listener on the chain adds a person's message after preStep saw the claimed ones.
  const more = [...claimed, userMessage('And per sledge, please.', { kind: 'user' })];
  release();
  await engine.preStep({ agent: agentOf('chat-f'), messages: claimed, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: more }));
  assert.deepEqual(asked, ['What was the walrus quota in crates?', 'What was the walrus quota in crates?\nAnd per sledge, please.']);
});

test('no early query for an empty memory or small talk, and a refused turn leaves no unhandled failure', async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  const catcher = (/** @type {unknown} */ reason) => unhandled.push(reason);
  process.on('unhandledRejection', catcher);
  try {
    /** @type {string[]} */
    const asked = [];
    const empty = memoryOf([], { size: 0 });
    empty.release();
    const claimed = [userMessage('What was the walrus quota in crates?', { kind: 'user' })];
    const payload = (/** @type {string} */ id, /** @type {any[]} */ messages) => ({ agent: agentOf(id), messages, turn: 2, step: 1, signal: new AbortController().signal });
    await engineOver(empty.memory, async (text) => { asked.push(text); return undefined; }).preStep(payload('chat-g', claimed), async () => ({ kind: 'enter', messages: claimed }));
    const talk = memoryOf([]);
    talk.release();
    const ok = [userMessage('ok', { kind: 'user' })];
    await engineOver(talk.memory, async (text) => { asked.push(text); return undefined; }).preStep(payload('chat-h', ok), async () => ({ kind: 'enter', messages: ok }));
    assert.deepEqual(asked, [], 'a query step ran with nothing to recall');
    const refused = memoryOf([], { settles: false });
    refused.release();
    await assert.rejects(engineOver(refused.memory, async () => { throw new Error('provider busy'); }).preStep(payload('chat-i', claimed), async () => assert.fail('the chain ran on a refused turn')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', catcher);
  }
});
