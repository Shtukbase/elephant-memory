// The memory's order: one append-only file of finished turns, in the order
// they finished, across every chat bound to the memory.
//
//   order-<granularity>-v<projection>.jsonl   one TurnRecord per line (turns.js)
//
// Each record is written with one write and fsync, so two chats interleave
// whole turns and never parts of one. Every record names its session and turn
// in the harness's session logs, which stay the authority; the order is kept
// because the view's line numbers are addressed by it.
// The numbered history is the records' entries, flattened in order.

import path from 'node:path';
import { PROJECTION_VERSION } from './config.js';
import { appendDurable, readJsonl } from './store.js';
import { bytes } from './text.js';

/** @typedef {import('./turns.js').TurnRecord} TurnRecord */
/** @typedef {import('./history.js').Kind} Kind */
/**
 * One numbered message of the memory's history.
 * @typedef {{ i: number, kind: Kind, text: string, size: number, time: number, record: number, first: boolean, title: string }} Entry
 */

const KINDS = new Set(['user', 'talk', 'tool', 'echo', 'work', 'note']);

/** @param {unknown} value @returns {value is TurnRecord} */
export function isTurnRecord(value) {
  if (typeof value !== 'object' || value === null) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.sessionId === 'string' && typeof record.sessionTitle === 'string' &&
    Number.isSafeInteger(record.turn) && typeof record.at === 'number' && Array.isArray(record.entries) &&
    record.entries.length > 0 && record.entries.every((entry) => typeof entry === 'object' && entry !== null &&
      KINDS.has(entry.kind) && typeof entry.text === 'string' && typeof entry.time === 'number');
}

/** The order file of one memory folder. @param {string} dir @param {'turn' | 'step'} granularity */
export function orderFile(dir, granularity) {
  return path.join(dir, `order-${granularity}-v${PROJECTION_VERSION}.jsonl`);
}

/**
 * The numbered entries of records `from…` onward, starting at message `start`.
 * @param {readonly TurnRecord[]} records @param {number} from @param {number} start
 * @returns {Entry[]}
 */
export function entriesOf(records, from = 0, start = 0) {
  /** @type {Entry[]} */
  const out = [];
  let i = start;
  for (let r = from; r < records.length; r++) {
    const record = records[r];
    record.entries.forEach((entry, k) => {
      out.push(Object.freeze({ i: i++, kind: entry.kind, text: entry.text, size: bytes(entry.text), time: entry.time, record: r, first: k === 0, title: record.sessionTitle }));
    });
  }
  return out;
}

/**
 * Every valid record of an order file. `repair` false reads without touching
 * the file, for a reader that does not hold the memory's lock.
 * @param {string} file @param {{ warn(message: string): void }} log @param {boolean} [repair]
 * @returns {TurnRecord[]}
 */
export function readOrder(file, log, repair = true) {
  const records = [];
  for (const value of readJsonl(file, log, repair)) {
    if (isTurnRecord(value)) records.push(value);
    else log.warn(`[ENDLESS_STORE] skipped a record that is not a finished turn in ${path.basename(file)}`);
  }
  return records;
}

/** Append one finished turn. @param {string} file @param {TurnRecord} record */
export function appendRecord(file, record) {
  const clean = { sessionId: record.sessionId, sessionTitle: record.sessionTitle, turn: record.turn, at: record.at, entries: record.entries.map(({ kind, text, time }) => ({ kind, text, time })) };
  appendDurable(file, `${JSON.stringify(clean)}\n`);
  return clean;
}
