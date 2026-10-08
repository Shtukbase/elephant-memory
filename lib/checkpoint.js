// The turn seam's write: replace the conversation before the new message with
// ONE checkpoint message holding the view, through the compaction contract's
// own log bracket (SEAMS.md §a):
//
//   compaction/start → compaction/summary → user/message (replace) → compaction/end
//
// Which nodes it replaces is decided by the turn layout (context.js), which
// keeps the harness's context messages before it. The bracket is appended in
// one synchronous run, so no crash or abort can leave it half open. The
// checkpoint carries the view; the summary record carries one short line, not
// a second copy of it.

import { randomUUID } from 'node:crypto';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * The turn a bracket belongs to: the open turn, or null between turns.
 * @param {any} session
 */
export function openTurn(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'turn/end') return null;
    if (event?.type === 'turn/start') return event.data.turn;
  }
  return null;
}

/**
 * Whether a compaction bracket is still open (another engine, or a log that
 * ended mid-bracket); a second bracket must not start then.
 * @param {any} session
 */
export function bracketOpen(session) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const type = session.eventAt(seq)?.type;
    if (type === 'compaction/end' || type === 'session/end-seed') return false;
    if (type === 'compaction/start') return true;
  }
  return false;
}

/** A rough token count for the record: four characters a token. @param {any} session @param {readonly number[]} seqs */
function estimateTokens(session, seqs) {
  let chars = 0;
  for (const seq of seqs) {
    const message = session.deriveEventMessage(session.eventAt(seq));
    if (message !== null && message !== undefined) chars += JSON.stringify(message.content ?? []).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Replace surface nodes [start .. end] with one checkpoint holding `view`.
 * @param {any} session
 * @param {{ start: number, end: number, turn: number | null, view: string, note: string, route: { provider: string, model: string } }} input
 */
export function writeCheckpoint(session, { start, end, turn, view, note, route }) {
  const nodes = session.surface.nodes;
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx < 0 || endIdx < startIdx) throw new Error(`[ENDLESS_TURN] surface span ${start}..${end} is not a current span`);
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
  const shadowedTokenCount = estimateTokens(session, shadowedSeqs);
  const compactionId = randomUUID();
  const lifecycle = { compactionId, turn };
  const startEvent = session.append('compaction/start', lifecycle);
  let summaryEvent;
  try {
    const summary = [{ type: 'text', text: note }];
    summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary,
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
      provider: route.provider,
      model: route.model,
    });
    const checkpoint = createUserMessage({ content: [{ type: 'text', text: view }], source: compactCheckpointSource(compactionId) });
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    });
  } catch (error) {
    try {
      session.append('compaction/end', { ...lifecycle, error: error instanceof Error ? error.message : String(error) });
    } catch {
      // A failed close leaves the open start as the harness's own busy signal.
    }
    throw error;
  }
  const endEvent = session.append('compaction/end', lifecycle);
  return {
    compactionId,
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary: [{ type: 'text', text: note }],
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    endSeq: endEvent.seq,
  };
}
