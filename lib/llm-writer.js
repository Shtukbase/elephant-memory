// The writer's model call, through the harness's own `ctx.llm.stream()`
// (SEAMS.md §f), on the provider of the memory's chats (the route a turn that
// passed the model guard last noted). Configuration may name
// another model of that SAME provider; it can never name another provider, and
// nothing falls back: when the call fails, the line waits and is tried again.
// Every call reports what it spent (usage.js), whether it succeeds or not.
//
// A compaction is a call like a turn (UniiChat spec §4): it sends the
// conversation's own system prompt and tool schemas (never calling a tool),
// so it reads them from the turns' cache, then the compaction view and the
// task. They are read from the chat that last noted the route, the way the
// shipped backend replays them (`buildSummarizationInput`, SEAMS.md §f): the
// `system/message` at surface node 0, the request header's tools and the
// session's tool history. Without that chat, the call sends the plugin's own
// section as its system prompt instead.

import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm';
import { callUsage } from './usage.js';

/**
 * What a turn of the conversation sends before its messages.
 * @typedef {{ system?: any, tools?: readonly any[], toolHistory?: any }} Prefix
 */
/**
 * The chat route a memory's writer follows; `sessionId` is the chat that last
 * noted it, `prefix` reads that chat's system prompt and tools.
 * @typedef {{ provider: string, model: string, sessionId?: string, prefix?: () => Prefix }} Route
 */

/**
 * A session's system prompt (its `system/message` at surface node 0, as the
 * request derives it), its latest request's tool schemas and its tool history.
 * @param {any} session @returns {Prefix}
 */
export function conversationPrefix(session) {
  const head = session.surface?.nodes?.[0];
  const event = head === undefined ? undefined : session.eventAt(head);
  const system = event?.type === 'system/message' ? session.deriveEventMessage(event) : null;
  const tools = session.requestHeader?.()?.tools;
  return {
    ...(system === null || system === undefined ? {} : { system }),
    ...(tools === undefined ? {} : { tools }),
    ...(typeof session.toolHistory === 'function' ? { toolHistory: session.toolHistory() } : {}),
  };
}

/** The route's prefix, or none when the chat cannot give one. @param {Route} route @returns {Prefix} */
function prefixOf(route) {
  try {
    return route.prefix?.() ?? {};
  } catch {
    return {};
  }
}

/**
 * @param {object} options
 * @param {any} options.llm `ctx.llm`
 * @param {() => Route | undefined} options.route
 * @param {{ model: string, reasoningEffort: string }} options.writer
 * @param {string} options.sessionId the id the provider sees when the route names no chat
 * @param {string} options.system the system prompt when the chat gives none: the plugin's own section
 * @returns {import('./writer.js').Summarize}
 */
export function llmSummarizer({ llm, route, writer, sessionId, system }) {
  return async (turns, signal) => {
    const target = route();
    if (target === undefined) throw new Error('no provider and model are known for this memory yet');
    const model = writer.model === '' ? target.model : writer.model;
    const asked = turns.map((turn) => (turn.role === 'user'
      ? { role: 'user', content: turn.texts.map((text) => ({ type: 'text', text })) }
      : turn.message));
    const prefix = prefixOf(target);
    const head = prefix.system === undefined
      ? { system, messages: asked }
      : {
        messages: [prefix.system, ...asked],
        ...(prefix.tools === undefined ? {} : { tools: [...prefix.tools] }),
        ...(prefix.toolHistory === undefined ? {} : { toolHistory: prefix.toolHistory }),
      };
    const assembler = new BlockAssembler();
    // From here on the call reached the model: what it spent travels with its
    // answer, or with its error (writer.js reports both).
    const spent = () => callUsage({ provider: target.provider, model }, assembler.usage);
    try {
      const stream = llm.stream({
        provider: target.provider,
        model,
        ...(writer.reasoningEffort === '' ? {} : { reasoningEffort: writer.reasoningEffort }),
        ...head,
        sessionId: target.sessionId ?? sessionId,
        purpose: 'compaction',
        signal,
      });
      for await (const chunk of stream) assembler.push(chunk);
      const finish = assembler.finish;
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
      }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { usage: spent() });
    }
    // Reasoning blocks are kept in the message sent back on a retry, and never
    // in the line itself.
    const text = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('');
    const replayState = assembler.replayState;
    return {
      text,
      message: assembler.message({ provider: target.provider, model, ...(replayState === undefined ? {} : { replayState }) }),
      usage: spent(),
    };
  };
}
