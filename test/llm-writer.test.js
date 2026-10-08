// A compaction is a call like a turn: the conversation's own system prompt and
// tools first (read from the chat that noted the route), then the compaction
// view and the task; without that chat, the plugin's own section as the system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationPrefix, llmSummarizer } from '../lib/llm-writer.js';

const SYSTEM = { role: 'system', content: [{ type: 'text', text: 'THE CONVERSATION SYSTEM PROMPT' }] };
const TOOLS = [{ name: 'zoom', description: 'Open a line', parameters: {} }];
const HISTORY = { tools: [], updates: [] };
const TEXTS = ['<chat>\n0+1|you: hi\n</chat>', 'Compaction: compress message 1 …'];
const TURNS = /** @type {import('../lib/writer.js').WriterTurn[]} */ ([{ role: 'user', texts: TEXTS }]);

/** An llm whose stream records its options and answers one text block. */
function recordingLlm() {
  /** @type {any[]} */
  const seen = [];
  return {
    seen,
    llm: {
      /** @param {any} options */
      async *stream(options) {
        seen.push(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'the line' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
}

/** A harness-shaped session with a system prompt at surface node 0. */
function session() {
  const events = [{ type: 'system/message', seq: 0, data: { message: SYSTEM } }, { type: 'user/message', seq: 1 }];
  return {
    surface: { nodes: [0, 1] },
    eventAt: (/** @type {number} */ seq) => events[seq],
    deriveEventMessage: (/** @type {any} */ event) => (event.type === 'system/message' ? event.data.message : null),
    requestHeader: () => ({ tools: TOOLS }),
    toolHistory: () => HISTORY,
  };
}

test('the writer sends the conversation\'s system prompt and tools before the compaction view and task, and no system of its own', async () => {
  const { llm, seen } = recordingLlm();
  const route = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'chat-a', prefix: () => conversationPrefix(session()) };
  const summarize = llmSummarizer({ llm, route: () => route, writer: { model: '', reasoningEffort: '' }, sessionId: 'endless-x', system: 'OWN SECTION' });
  const answer = await summarize(TURNS, new AbortController().signal);
  assert.equal(answer.text, 'the line');
  const [options] = seen;
  assert.equal(options.system, undefined, 'a compaction sent a system prompt of its own');
  assert.deepEqual(options.messages[0], SYSTEM);
  assert.deepEqual(options.tools, TOOLS);
  assert.equal(options.toolHistory, HISTORY);
  assert.deepEqual(options.messages.slice(1), [{ role: 'user', content: TEXTS.map((text) => ({ type: 'text', text })) }]);
  assert.equal(options.sessionId, 'chat-a');
  assert.equal(options.purpose, 'compaction');
});

test('without a chat that can give its prompt, the writer sends the plugin\'s own section', async () => {
  for (const prefix of [undefined, () => ({}), () => {
    throw new Error('the session is gone');
  }]) {
    const { llm, seen } = recordingLlm();
    const route = { provider: 'deepseek-official', model: 'deepseek-flash', ...(prefix === undefined ? {} : { prefix }) };
    const summarize = llmSummarizer({ llm, route: () => route, writer: { model: '', reasoningEffort: '' }, sessionId: 'endless-x', system: 'OWN SECTION' });
    await summarize(TURNS, new AbortController().signal);
    assert.equal(seen[0].system, 'OWN SECTION');
    assert.equal(seen[0].tools, undefined);
    assert.equal(seen[0].messages.length, 1);
    assert.equal(seen[0].sessionId, 'endless-x');
  }
});

test('a session without a system prompt at node 0 gives no system message', () => {
  const s = session();
  s.surface.nodes = [1];
  assert.deepEqual(conversationPrefix(s), { tools: TOOLS, toolHistory: HISTORY });
});
