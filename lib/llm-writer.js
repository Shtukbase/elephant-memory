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

/** Reasoning levels from least to most thinking; an unknown level ranks after them. */
const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The reasoning effort a summary call sends, from the efforts the route's
 * model declares (`ctx.llm.resolveModelInfo`, `reasoning.efforts`): the wanted
 * one (`writer.reasoningEffort`, `off` by default) where the model offers it,
 * else `off`, else the lowest it offers; none at all for a model that declares
 * no reasoning, because the harness refuses any effort sent to such a model
 * before the request leaves (`UNSUPPORTED_REASONING_EFFORT`).
 * @param {{ reasoning?: { efforts?: readonly { id: string }[] } } | undefined} info
 * @param {string} wanted
 * @returns {{ effort: string | undefined, refused: boolean }} `refused` when the wanted effort is not offered
 */
export function writerEffort(info, wanted) {
  const offered = (info?.reasoning?.efforts ?? []).map((effort) => effort.id);
  if (wanted !== '' && offered.includes(wanted)) return { effort: wanted, refused: false };
  const refused = wanted !== '';
  if (offered.length === 0) return { effort: undefined, refused };
  if (offered.includes('off')) return { effort: 'off', refused };
  const rank = (/** @type {string} */ id) => (EFFORT_ORDER.includes(id) ? EFFORT_ORDER.indexOf(id) : EFFORT_ORDER.length);
  return { effort: offered.reduce((low, id) => (rank(id) < rank(low) ? id : low)), refused };
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
 * @param {{ warn(message: string): void }} [options.log]
 * @returns {import('./writer.js').Summarize}
 */
export function llmSummarizer({ llm, route, writer, sessionId, system, log }) {
  /** Routes already told that they refuse the wanted effort. @type {Set<string>} */
  const told = new Set();
  /** @param {string} provider @param {string} model @param {AbortSignal} signal */
  const effortFor = async (provider, model, signal) => {
    let info;
    try {
      info = await llm.resolveModelInfo(provider, model, signal);
    } catch {
      // Unknown: send what is wanted, as before; a refusal comes back as the call's own error.
      return writer.reasoningEffort === '' ? undefined : writer.reasoningEffort;
    }
    const { effort, refused } = writerEffort(info, writer.reasoningEffort);
    const name = `${provider}/${model}`;
    if (refused && !told.has(name)) {
      told.add(name);
      log?.warn(`[ENDLESS_WRITER] ${name} does not offer reasoning effort "${writer.reasoningEffort}"; summaries are written with ${effort === undefined ? 'no effort named' : `effort "${effort}"`}`);
    }
    return effort;
  };
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
    const effort = await effortFor(target.provider, model, signal);
    try {
      const stream = llm.stream({
        provider: target.provider,
        model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
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
