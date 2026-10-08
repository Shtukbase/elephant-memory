// A conversation's finished turns, folded from its own session events.
//
// The memory's order holds one record per finished turn: which chat, its title
// when the turn ended, the turn's number and the turn's entries (history.js).
// The same fold runs live, on each event as it is appended, and over the
// events a chat already has when it attaches, so a record is always what the
// chat's own session log gives for that turn. A turn that added no entries (a
// refused turn) is no record. Pure: no harness import, no I/O.

import { HistoryProjector } from './history.js';

/** @typedef {import('./history.js').Kind} Kind */
/** @typedef {{ kind: Kind, text: string, time: number }} RecordEntry */
/**
 * One finished turn of one chat, as the order file stores it.
 * @typedef {{ sessionId: string, sessionTitle: string, turn: number, at: number, entries: RecordEntry[] }} TurnRecord
 */

export class TurnCollector {
  /** @param {string} sessionId @param {'turn' | 'step'} granularity */
  constructor(sessionId, granularity) {
    this.sessionId = sessionId;
    this.projector = new HistoryProjector({ granularity });
    /** Entries since the last finished turn. @type {RecordEntry[]} */
    this.pending = [];
    /** The chat's newest title, '' while it has none. */
    this.title = '';
    /** The open turn's number, or null between turns. @type {number | null} */
    this.turn = null;
  }

  /**
   * Fold one session event; returns the finished turn it closed, or null.
   * @param {any} event @returns {TurnRecord | null}
   */
  push(event) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') this.title = event.data.title;
    for (const entry of this.projector.push(event)) this.pending.push({ kind: entry.kind, text: entry.text, time: entry.time });
    if (event?.type === 'turn/start') this.turn = Number(event.data?.turn);
    if (event?.type !== 'turn/end') return null;
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : this.turn;
    const entries = this.pending;
    this.pending = [];
    this.turn = null;
    if (entries.length === 0 || !Number.isSafeInteger(turn)) return null;
    return { sessionId: this.sessionId, sessionTitle: this.title, turn: /** @type {number} */ (turn), at: Number(event.time) || 0, entries };
  }
}
