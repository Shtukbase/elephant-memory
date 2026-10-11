import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { llmExpander } from '../lib/llm-expand.js';
import { registerTools } from '../lib/tools.js';

const config = resolveConfig({});
const route = { provider: 'chosen-account', model: 'flash' };
const info = async () => ({ reasoning: { efforts: [{ id: 'off' }] } });
const memory = () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ kind: 'user', text: i ? `Weather ${i}: clear.` : 'Walrus quota: seventeen crates.', time: 0, record: i }));
  return { entries, get size() { return entries.length; }, entry: (i) => entries[i], config, tree: {}, usage: { record: () => {} } };
};
function toolFor(m, expand) {
  const tools = [];
  registerTools({ tools: { register: (tool) => tools.push(tool) } }, config, () => m, expand, () => new Set());
  return tools.find((tool) => tool.name === 'recall');
}

test('registered recall freezes its sources before expansion and forwards the actual execution context', async () => {
  const m = memory();
  const exec = { agent: { session: { id: 's' }, options: route }, signal: new AbortController().signal };
  const tool = toolFor(m, async (snapshot, session, text, received) => {
    assert.equal(received, exec);
    assert.equal(snapshot.size, 30);
    assert.equal(session.id, 's');
    m.entries.push({ ...m.entries[0], text: 'Walrus quota: ninety-nine crates.' });
    return 'walrus quota crates';
  });
  const answer = await tool.execute({ question: 'walrus quota crates' }, exec);
  assert.match(answer, /seventeen/);
  assert.doesNotMatch(answer, /ninety-nine/);
});

test('tool cancellation reaches the provider stream, stops its work and publishes no result', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let stopped = false;
  const llm = { resolveModelInfo: info, async *stream(options) {
    assert.equal(options.provider, route.provider);
    try {
      started();
      await new Promise((resolve) => options.signal?.addEventListener('abort', resolve, { once: true }));
      options.signal?.throwIfAborted();
    } finally { stopped = true; }
  } };
  const expand = llmExpander({ llm, log: { warn: () => {} } });
  const tool = toolFor(memory(), (m, session, text, exec) => expand({ route: exec.agent.options, sessionId: session.id, text, signal: exec.signal }));
  const answer = tool.execute({ question: 'walrus quota crates' }, { agent: { session: { id: 's' }, options: route }, signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(answer, /abort/i);
  assert.equal(stopped, true);
});

test('a non-cooperative model lookup cannot hold recall past its deadline or start a late stream', async () => {
  let resolve;
  let streamed = false;
  const llm = { resolveModelInfo: () => new Promise((done) => { resolve = done; }), async *stream() { streamed = true; } };
  const expand = llmExpander({ llm, timeoutMs: 10, log: { warn: () => {} } });
  assert.equal(await expand({ route, sessionId: 's', text: 'walrus quota' }), undefined);
  resolve(await info());
  await new Promise((done) => setImmediate(done));
  assert.equal(streamed, false);
});

test('expansion bounds assembled output and never logs provider exception text', async () => {
  const warnings = [];
  let chunks = 0;
  const llm = { resolveModelInfo: info, async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (let i = 0; i < 1000; i++) { chunks++; yield { type: 'text-delta', index: 0, text: 'x'.repeat(1000) }; }
    throw new Error('PRIVATE_PROVIDER_PAYLOAD');
  } };
  const expand = llmExpander({ llm, log: { warn: (line) => warnings.push(line) } });
  assert.equal(await expand({ route, sessionId: 's', text: 'walrus quota' }), undefined);
  await new Promise((done) => setImmediate(done));
  assert.ok(chunks < 30);
  assert.doesNotMatch(warnings.join('\n'), /PRIVATE_PROVIDER_PAYLOAD/);
  const rejected = llmExpander({ llm: { resolveModelInfo: info, async *stream() { throw new Error('PRIVATE_PROVIDER_PAYLOAD'); } }, log: { warn: (line) => warnings.push(line) } });
  assert.equal(await rejected({ route, sessionId: 's', text: 'walrus quota' }), undefined);
  assert.doesNotMatch(warnings.join('\n'), /PRIVATE_PROVIDER_PAYLOAD/);
});
