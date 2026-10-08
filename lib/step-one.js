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

import { layOutTurn, contextFirst } from './context.js';
import { COMPACTION_NOTE_PREFIX } from './identity.js';

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
 */

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
  const settled = await memory.settle(signal, timeoutMs);
  signal.throwIfAborted();
  if (!settled) {
    const last = memory.writer.lastError === '' ? '' : `; last error: ${memory.writer.lastError}`;
    throw new TurnRefusal(`${memory.waiting()} summary lines were not written within ${timeoutMs / 1000} s${last}`);
  }
  const view = memory.render();
  const note = noteOf(memory);
  // The rest of the chain decides first whether a step is taken at all and
  // adds its context messages. A checkpoint is written only for a step that
  // will be sent.
  const decision = await next();
  signal.throwIfAborted();
  if (decision?.kind !== 'enter' || decision.messages.length === 0) return decision;
  if (io.bracketOpen()) throw new TurnRefusal('the session log has a compaction bracket that was never closed');
  // From here to the checkpoint nothing awaits.
  try {
    return layOutTurn(session, decision, {
      makeMessage: io.makeMessage,
      checkpoint: (span) => io.checkpoint(span, view, note),
      viewMessage: () => io.viewMessage(view),
    }, kinds);
  } catch (error) {
    // Never send the unreplaced history in its place: refuse loudly instead.
    throw new TurnRefusal(`the view could not replace the history: ${error instanceof Error ? error.message : String(error)}`);
  }
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
 * @param {(memoryId: string) => StepIo} input.io
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
  return stepOne({ memory, session, signal, next, kinds, timeoutMs, io: io(memory.memoryId) });
}
