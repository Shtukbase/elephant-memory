// A compaction is a call like a turn: the conversation's own system prompt and
// tools first (read from the chat that noted the route), then the compaction
// view and the task; without that chat, the plugin's own section as the system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationPrefix, llmSummarizer, writerEffort } from '../lib/llm-writer.js';
import { keptLog } from './fixtures.js';

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

/** @param {string[]} ids */
const offering = (ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id })) } });

test('the writer\'s effort is the wanted one where offered, else off, else the lowest offered, else none', () => {
  assert.deepEqual(writerEffort(offering(['off', 'low', 'high', 'max']), 'off'), { effort: 'off', refused: false });
  assert.deepEqual(writerEffort(offering(['off', 'low', 'high', 'max']), 'high'), { effort: 'high', refused: false });
  assert.deepEqual(writerEffort(offering(['low', 'high', 'max']), 'off'), { effort: 'low', refused: true });
  assert.deepEqual(writerEffort(offering(['high', 'medium', 'xhigh']), 'off'), { effort: 'medium', refused: true });
  assert.deepEqual(writerEffort(offering(['off', 'high']), 'xhigh'), { effort: 'off', refused: true });
  assert.deepEqual(writerEffort({}, 'off'), { effort: undefined, refused: true });
  assert.deepEqual(writerEffort(undefined, ''), { effort: undefined, refused: false });
});

// Round 4 live walk, F4: a route added through "Connect a provider" declares no
// reasoning, and every summary died before leaving: provider "hub-mock" model
// "deepseek-v4-flash" does not support reasoning effort "off", every 10 s.
test('a summary call names only an effort the route\'s model declares, and says once when the wanted one is refused', async () => {
  for (const [declared, sent] of /** @type {const} */ ([[undefined, undefined], [['low', 'high', 'max'], 'low'], [['off', 'low', 'high', 'max'], 'off']])) {
    /** @type {any[]} */
    const seen = [];
    const llm = {
      /** @param {string} provider @param {string} model */
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, ...(declared === undefined ? {} : offering([...declared])) }),
      /** The harness's own check (`resolveCallWithInfo`): an effort the model does not declare never leaves. @param {any} options */
      async *stream(options) {
        seen.push(options);
        const effort = options.reasoningEffort;
        if (effort !== undefined && !(declared ?? []).includes(effort)) throw new Error(`provider "${options.provider}" model "${options.model}" does not support reasoning effort "${effort}"`);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'the line' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const log = keptLog();
    const route = { provider: 'hub-mock', model: 'deepseek-v4-flash' };
    const summarize = llmSummarizer({ llm, route: () => route, writer: { model: '', reasoningEffort: 'off' }, sessionId: 'endless-x', system: 'OWN SECTION', log });
    assert.equal((await summarize(TURNS, new AbortController().signal)).text, 'the line');
    assert.equal((await summarize(TURNS, new AbortController().signal)).text, 'the line');
    assert.deepEqual(seen.map((options) => options.reasoningEffort), [sent, sent]);
    assert.equal(seen[0].reasoningEffort === undefined, !Object.hasOwn(seen[0], 'reasoningEffort'), 'an empty effort was sent as a key');
    assert.equal(log.warnings.length, sent === 'off' ? 0 : 1, 'a refused effort was not said, or said more than once');
  }
});
