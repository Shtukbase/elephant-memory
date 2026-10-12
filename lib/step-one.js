// Step 1 of a turn, the turn seam's decision (SEAMS.md §c), without the
// harness: the engine supplies the writes (checkpoint.js) through `io`.
//
// 1. An empty memory: only the step's context messages go first.
// 2. Otherwise wait until every line of the view is a summary, and
//    take the view as it is NOW: the view as of the turn's start. Another
//    chat of the same memory may finish a turn while this one waits on the
//    rest of the chain; that turn reaches this chat at its next turn.
// 3. Let the rest of the chain decide whether a step is taken at all.
// 4. Lay the surface out (context.js): on a chat's first turn the view is a
//    message of the step; after that one checkpoint replaces the history.
// 5. Auto-recall (recall-ranked.js): the memory is searched with the person's
//    new message, and the best matches go into the step as one message right
//    before the person's. It comes after the view on every turn, so the cached
//    prefix (system prompt, context block, view) is byte-identical with or
//    without it. It is not history, and the next turn's checkpoint replaces it.

import { layOutTurn, contextFirst } from './context.js';
import { contentText, kindOfSource } from './history.js';
import { COMPACTION_NOTE_PREFIX } from './identity.js';
import { autoRecall, freezeRecall, worthExpanding } from './recall-ranked.js';

/**
 * What the person reads when a turn is refused (ENDL-4): one plain sentence in
 * the chat's own refusal line. Why it was refused goes to the log.
 */
export const REFUSAL_WORDS = 'The memory of earlier messages is not ready yet, so this message will be sent with your next one.';

/**
 * A claimed message as it goes back to the inbox: the same message without
 * the browser's submission id (`source.rpcId`), so the harness's web UI settles
 * the person's pending copy when the refused turn ends rather than keeping it
 * as a message still starting. Its words and every other field are unchanged.
 * @param {any} message
 */
export function waitingCopy(message) {
  const source = message?.source;
  if (source === null || typeof source !== 'object' || !Object.hasOwn(source, 'rpcId')) return message;
  const { rpcId: _rpcId, ...rest } = source;
  return { ...message, source: rest };
}

/** A turn that must not start; its messages wait for the next turn. */
export class TurnRefusal extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = 'TurnRefusal';
  }
}

/**
 * @typedef {object} StepMemory
 * @property {number} size
 * @property {(signal: AbortSignal | undefined, timeoutMs: number) => Promise<boolean>} settle
 * @property {() => string} render
 * @property {() => number} waiting
 * @property {{ parts: readonly unknown[] }} view
 * @property {{ lastError: string }} writer
 */

/**
 * @typedef {object} StepIo
 * @property {(item: import('./context.js').Item) => any} makeMessage
 * @property {(view: string) => any} viewMessage  the view as a message of the step
 * @property {(span: { start: number, end: number, seqs: number[] }, view: string, note: string) => unknown} checkpoint
 * @property {() => boolean} bracketOpen
 * @property {(recalled: import('./recall-ranked.js').Recalled) => import('./context.js').Item} [recallMessage]  the recalled excerpts as a message of the step; absent: no auto-recall
 * @property {(text: string, signal?: AbortSignal) => Promise<string | undefined>} [expand]  other searches for the person's message (llm-expand.js)
 * @property {() => Set<string>} [shown]  the passages this turn was shown; auto-recall adds its own
 */

/** @typedef {{ source?: { kind?: string }, content: Parameters<typeof contentText>[0] }} RecallMessage */
/** @typedef {{ kind: string, messages: RecallMessage[] }} RecallDecision */
/** @param {RecallMessage} m */
const isPerson = (m) => kindOfSource(m?.source) === 'user';

/** The person's words in a list of messages, as auto-recall searches them. @param {readonly RecallMessage[]} messages */
export const personText = (messages) => messages.filter(isPerson).map((m) => contentText(m.content)).join('\n').trim();

/**
 * Auto-recall for a step: the memory searched with the words of the person's
 * messages in it (and, where `io.expand` gives them, the other searches written
 * for them). Undefined when it is switched off, the step
 * holds no message of the person (a colleague's report, a scheduled task) or
 * nothing passes the floor. Never throws: a turn does not fail on its recall.
 * @param {RecallDecision} decision @param {StepMemory & import('./recall.js').RecallSource} memory @param {StepIo} io @param {AbortSignal} [signal]
 * @returns {Promise<import('./recall-ranked.js').Recalled | undefined>}
 */
export async function recalledFor(decision, memory, io, signal) {
  if (io.recallMessage === undefined || memory.config?.autoRecall !== true || decision?.kind !== 'enter') return undefined;
  const text = personText(decision.messages);
  if (!worthExpanding(text)) return undefined;
  try {
    return autoRecall(memory, text, await io.expand?.(text, signal), io.shown?.());
  } catch {
    return undefined;
  }
}

/**
 * The step's messages with the recalled excerpts placed right before the
 * person's first message.
 * @param {RecallDecision} decision @param {import('./recall-ranked.js').Recalled | undefined} recalled @param {StepIo} io
 */
export function withRecall(decision, recalled, io) {
  if (recalled === undefined || io.recallMessage === undefined || decision?.kind !== 'enter') return decision;
  const at = decision.messages.findIndex(isPerson);
  if (at < 0) return decision;
  return { ...decision, messages: [...decision.messages.slice(0, at), io.recallMessage(recalled), ...decision.messages.slice(at)] };
}

/** @param {StepMemory} memory */
export function noteOf(memory) {
  return `${COMPACTION_NOTE_PREFIX} the conversation before this message, as ${memory.view.parts.length} summary lines over ${memory.size} messages.`;
}

/**
 * @param {object} input
 * @param {StepMemory} input.memory
 * @param {any} input.session
 * @param {AbortSignal} input.signal
 * @param {() => Promise<any>} input.next
 * @param {readonly string[]} input.kinds
 * @param {number} input.timeoutMs
 * @param {StepIo} input.io
 * @returns {Promise<any>} the step's decision; throws TurnRefusal
 */
export async function stepOne({ memory, session, signal, next, kinds, timeoutMs, io }) {
  if (memory.size === 0) return contextFirst(await next(), kinds);
  // With a grace (settleGraceMs), the turn waits that long for the writer; newest lines still unwritten are shown as their messages, clipped (memory.js).
  const settled = await memory.settle(signal, timeoutMs, memory.config?.settleGraceMs ?? 0);
  signal.throwIfAborted();
  if (!settled) {
    const last = memory.writer.lastError === '' ? '' : `; last error: ${memory.writer.lastError}`;
    throw new TurnRefusal(`${memory.waiting()} summary lines were not written within ${timeoutMs / 1000} s${last}`);
  }
  const view = memory.render();
  const boundary = memory.size;
  const note = noteOf(memory);
  // The rest of the chain decides first whether a step is taken at all and
  // adds its context messages. A checkpoint is written only for a step that
  // will be sent.
  const decision = await next();
  signal.throwIfAborted();
  if (decision?.kind !== 'enter' || decision.messages.length === 0) return decision;
  const question = decision.messages.filter(isPerson).map((message) => contentText(message.content)).join('\n');
  const recallMemory = io.recallMessage && memory.config?.autoRecall === true && worthExpanding(question) ? freezeRecall(memory, boundary) : memory;
  // The one wait of auto-recall (the query step's model call) ends before the layout starts.
  const recalled = await recalledFor(decision, recallMemory, io, signal);
  signal.throwIfAborted();
  if (io.bracketOpen()) throw new TurnRefusal('the session log has a compaction bracket that was never closed');
  // From here to the checkpoint nothing awaits.
  let laid;
  try {
    laid = layOutTurn(session, decision, {
      makeMessage: io.makeMessage,
      checkpoint: (span) => io.checkpoint(span, view, note),
      viewMessage: () => io.viewMessage(view),
    }, kinds);
  } catch (error) {
    // Never send the unreplaced history in its place: refuse loudly instead.
    throw new TurnRefusal(`the view could not replace the history: ${error instanceof Error ? error.message : String(error)}`);
  }
  return withRecall(laid, recalled, io);
}

/**
 * The whole seam on step 1 of a turn, around `stepOne`: the model guard
 * first (below it the turn is an ordinary chat and nothing is replaced), then
 * the chat's memory, then the layout.
 * @param {object} input
 * @param {string} input.sessionId
 * @param {{ provider: string, model: string } | undefined} input.route the turn's model
 * @param {{ allows(sessionId: string, route: { provider: string, model: string } | undefined, signal?: AbortSignal): Promise<boolean> }} input.guard
 * @param {() => StepMemory & { memoryId: string }} input.attach opens the chat's memory; may throw
 * @param {(memoryId: string, route: { provider: string, model: string, sessionId: string }) => void} input.noteRoute
 * @param {any} input.session
 * @param {AbortSignal} input.signal
 * @param {() => Promise<any>} input.next
 * @param {readonly string[]} input.kinds
 * @param {number} input.timeoutMs
 * @param {(memoryId: string, memory: any) => StepIo} input.io the memory is the one just opened for this turn
 */
export async function seamStepOne({ sessionId, route, guard, attach, noteRoute, session, signal, next, kinds, timeoutMs, io }) {
  if (!(await guard.allows(sessionId, route, signal)) || route === undefined) return next();
  signal.throwIfAborted();
  let memory;
  try {
    memory = attach();
  } catch (error) {
    throw new TurnRefusal(`the memory could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  noteRoute(memory.memoryId, { provider: route.provider, model: route.model, sessionId });
  return stepOne({ memory, session, signal, next, kinds, timeoutMs, io: io(memory.memoryId, memory) });
}
