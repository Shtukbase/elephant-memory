// The query step of ranked recall: one small model call that writes other
// searches for the person's message: other wordings of its key terms, the
// identifiers its answer is likely to sit beside and, when the history holds a
// second language, the same terms in that language. Word search matches words:
// on a real session 22 of 60 questions were asked in English about a Russian
// source and BM25 found none of them, and over 118 questions the expansion
// raised the sources found in the first ten hits from 62 to 75.
//
// The call goes through the harness's own `ctx.llm.stream()` on the chat's
// provider and model, like the summary writer's (llm-writer.js), with the
// lowest reasoning effort the model offers, no tools and a system prompt of
// one sentence. It is bounded by EXPAND_TIMEOUT_MS, and a failed or late call
// is not an error: the search runs on the words as written.

import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { EXPAND_CHARS, EXPAND_TIMEOUT_MS } from './config.js';
import { writerEffort } from './llm-writer.js';
import { callUsage } from './usage.js';

const SYSTEM = 'You write keyword searches. Reply with the searches only, one per line: no numbers, no quotes, no notes.';

/**
 * The task: two searches, or three when the history has another language.
 * @param {string} text the person's message @param {string | undefined} language the history's other language
 */
export function expandTask(text, language) {
  const kinds = [
    'other wordings and synonyms of its key terms',
    ...(language === undefined ? [] : [`the same key terms in ${language}`]),
    'the identifiers likely to stand in that message (file names, paths, commands, feature or tool names, versions)',
  ];
  return `A person wrote the message below in a long working conversation. A keyword search will look through the conversation's earlier messages for what it is about. Write ${kinds.length} different searches that would find the earlier message that matters most:
${kinds.map((kind, k) => `${k + 1}. ${kind},`).join('\n').replace(/,$/, '.')}
Each search is a short list of words, not a sentence. Output exactly ${kinds.length} lines, one search per line, and nothing else.
Message: ${text.slice(0, EXPAND_CHARS)}`;
}

/**
 * @param {object} options
 * @param {Parameters<typeof import('./llm-writer.js').llmSummarizer>[0]['llm']} options.llm `ctx.llm`
 * @param {{ warn(message: string): void }} options.log
 * @returns {(input: { route: { provider: string, model: string }, sessionId: string, text: string, language?: string, signal?: AbortSignal, spent?: (usage: import('./usage.js').CallUsage) => void }) => Promise<string | undefined>}
 */
export function llmExpander({ llm, log, timeoutMs = EXPAND_TIMEOUT_MS }) {
  return async ({ route, sessionId, text, language, signal, spent }) => {
    const controller = new AbortController();
    const both = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const assembler = new BlockAssembler();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const work = (async () => { try {
      let effort;
      try {
        effort = writerEffort(await llm.resolveModelInfo(route.provider, route.model, both), 'off').effort;
      } catch {
        effort = 'off';
      }
      both.throwIfAborted();
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: expandTask(text, language) }] }],
        sessionId,
        purpose: 'compaction',
        signal: both,
      });
      let received = 0;
      for await (const chunk of stream) {
        both.throwIfAborted();
        received += JSON.stringify(chunk).length;
        if (received > EXPAND_CHARS * 8) { controller.abort(); break; }
        assembler.push(chunk);
      }
      both.throwIfAborted();
      const finish = assembler.finish;
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind);
      const out = assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
      // At most the lines asked for, each without a list number.
      const searches = out.split('\n').map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean).slice(0, 3);
      return searches.length === 0 ? undefined : searches.join('\n').slice(0, EXPAND_CHARS);
    } catch {
      log.warn(`[ENDLESS_RECALL] ${sessionId}: no other searches were written; the search uses its own words`);
      return undefined;
    } finally {
      try {
        spent?.(callUsage({ provider: route.provider, model: route.model }, assembler.usage));
      } catch {
        // What the call spent is a record, never a reason to stop a turn.
      }
    } })();
    let aborted;
    const stopped = new Promise((resolve) => {
      aborted = () => resolve(undefined);
      both.addEventListener('abort', aborted, { once: true });
      if (both.aborted) aborted();
    });
    try { return await Promise.race([work, stopped]); }
    finally { clearTimeout(timer); both.removeEventListener('abort', aborted); }
  };
}
