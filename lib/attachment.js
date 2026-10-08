// One chat attached to its memory: its session's events are folded into
// finished turns (turns.js), and each finished turn is appended to the memory,
// whole, when its `turn/end` is appended to the session.
//
// Attaching folds the session's events so far first, so a turn that finished
// while nothing was listening (a crash, a restart) is appended then; a turn
// already in the order is never appended twice.

import { TurnCollector } from './turns.js';

/** @typedef {{ snapshotEvents(): readonly any[], eventAt(seq: number): any, readonly seq: number }} SessionLike */

export class Attachment {
  /**
   * @param {string} sessionId
   * @param {SessionLike} session
   * @param {import('./memory.js').Memory} memory
   */
  constructor(sessionId, session, memory) {
    this.sessionId = sessionId;
    this.session = session;
    this.memory = memory;
    this.collector = new TurnCollector(sessionId, memory.config.granularity);
    /** Next session event to fold. */
    this.nextSeq = 0;
    for (const event of session.snapshotEvents()) this.take(event);
  }

  /** @param {any} event */
  take(event) {
    this.nextSeq = Math.max(this.nextSeq, Number(event.seq) + 1);
    const finished = this.collector.push(event);
    if (finished !== null) this.memory.appendTurn(finished);
  }

  /**
   * Take in a live session event; catches up from the session when events were
   * missed. Never appends to the session (this runs inside its append).
   * @param {any} event
   */
  observe(event) {
    if (this.memory.closed || Number(event.seq) < this.nextSeq) return;
    for (let seq = this.nextSeq; seq < Number(event.seq); seq++) {
      const missed = this.session.eventAt(seq);
      if (missed !== undefined) this.take(missed);
    }
    this.take(event);
  }
}
