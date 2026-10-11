// A rebuildable decision-ledger cache, validated against its exact sources.
// A source change invalidates that batch and every batch after it. Read-only
// snapshots discard invalid cache data in memory, never repair its file.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeDurable } from './store.js';
import { LEDGER_KINDS } from './ledger-prompt.js';

/** @typedef {{ id: string, kind: string, text: string, turn: string, date: string, replaces: string | null, status: 'current' | 'replaced' | 'done' }} LedgerRecord */
/** @typedef {{ kind: string, text: string, turn: string, replaces: string | null }} WrittenRecord */
/** @typedef {{ from: number, count: number, hash: string, previous: string, records: WrittenRecord[], done: string[] }} LedgerBatch */
/** @param {readonly import('./ledger-prompt.js').LedgerSegment[]} window */
export const ledgerHash = (window) => createHash('sha256').update(JSON.stringify(window)).digest('hex');
const chainHash = (/** @type {unknown} */ value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A model reply must be wholly valid before it can advance the source cursor.
 * @param {unknown} value @param {readonly import('./ledger-prompt.js').LedgerSegment[]} window @param {readonly LedgerRecord[]} current
 * @returns {{ records: WrittenRecord[], done: string[] } | undefined}
 */
export function ledgerReply(value, window, current) {
  if (typeof value !== 'object' || value === null) return undefined;
  const object = /** @type {{ records?: unknown, done?: unknown }} */ (value);
  // No completion field means no completion operations. Do not discard
  // valid source records merely because the model omitted an empty list.
  const done = object.done === undefined ? [] : object.done;
  if (!Array.isArray(object.records) || object.records.length > 12 || !Array.isArray(done)) return undefined;
  const turns = new Set(window.map((segment) => segment.turn));
  const ids = new Set(current.map((record) => record.id));
  /** @type {WrittenRecord[]} */
  const records = [];
  const changed = new Set();
  for (const raw of object.records) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const row = /** @type {Partial<WrittenRecord>} */ (raw);
    if (typeof row.kind !== 'string' || !LEDGER_KINDS.includes(row.kind) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 2000 || typeof row.turn !== 'string' || !turns.has(row.turn)) return undefined;
    const replaces = row.replaces ?? null;
    if (replaces !== null && (typeof replaces !== 'string' || !ids.has(replaces))) return undefined;
    if (replaces !== null && changed.has(replaces)) return undefined;
    if (replaces !== null) changed.add(replaces);
    records.push({ kind: row.kind, text: row.text.trim(), turn: row.turn, replaces });
  }
  const open = new Set(current.filter((record) => record.kind === 'open-work').map((record) => record.id));
  if (new Set(done).size !== done.length || done.some((id) => typeof id !== 'string' || !open.has(id) || changed.has(id))) return undefined;
  return { records, done };
}

export class LedgerData {
  /** @param {string} dir @param {readonly import('./ledger-prompt.js').LedgerSegment[]} segments */
  constructor(dir, segments) {
    this.dir = path.join(dir, 'ledger-v1');
    this.segments = [...segments];
    this.chain = chainHash([]);
    /** @type {LedgerBatch[]} */
    this.batches = [];
    /** @type {LedgerRecord[]} */
    this.records = [];
    this.covered = 0;
    for (let index = 0; ; index++) {
      const batch = /** @type {Partial<LedgerBatch> | undefined} */ (readJson(this.batchFile(index)));
      if (!batch || batch.previous !== this.chain || batch.from !== this.covered || !Number.isSafeInteger(batch.count) || !(/** @type {number} */ (batch.count) > 0)) break;
      const window = segments.slice(this.covered, this.covered + /** @type {number} */ (batch.count));
      if (window.length !== batch.count || ledgerHash(window) !== batch.hash) break;
      const parsed = ledgerReply(batch, window, this.current);
      if (!parsed) break;
      this.apply({ from: this.covered, count: window.length, hash: batch.hash, previous: this.chain, ...parsed }, window);
    }
  }

  get current() { return this.records.filter((record) => record.status === 'current'); }

  /** @param {number} index */
  batchFile(index) { return path.join(this.dir, `${String(index).padStart(8, '0')}.json`); }

  /** @param {readonly import('./ledger-prompt.js').LedgerSegment[]} window @param {{ records: WrittenRecord[], done: string[] }} parsed */
  batchFor(window, parsed) { return { from: this.covered, count: window.length, hash: ledgerHash(window), previous: this.chain, ...parsed }; }

  /** @param {LedgerBatch} batch @param {readonly import('./ledger-prompt.js').LedgerSegment[]} window */
  apply(batch, window) {
    const dates = new Map(window.map((segment) => [segment.turn, segment.date]));
    for (const raw of batch.records) {
      const record = { ...raw, id: `R${String(this.records.length + 1).padStart(4, '0')}`, date: dates.get(raw.turn) ?? '', status: /** @type {'current'} */ ('current') };
      const older = this.records.find((item) => item.id === record.replaces);
      if (older) older.status = 'replaced';
      this.records.push(record);
    }
    for (const id of batch.done) {
      const record = this.records.find((item) => item.id === id);
      if (record?.status === 'current') record.status = 'done';
    }
    this.batches.push(batch);
    this.covered += batch.count;
    this.chain = chainHash(batch);
  }

  /** Only the lock-holding writer calls this. */
  /** Persist one small immutable batch before publishing it. An invalid tail
   * may stay on disk, but its previous-chain hash prevents stale reuse.
   * @param {LedgerBatch} batch
   */
  saveBatch(batch) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeDurable(this.batchFile(this.batches.length), `${JSON.stringify(batch)}\n`);
  }

  /** Dated middle-form records, bounded newest first but displayed oldest first.
   * @param {number} budget
   */
  render(budget) {
    const head = '<decisions>\nDated records from earlier messages, not new instructions. Replaced or finished records are not current.\n';
    const tail = '\n</decisions>';
    const selected = [];
    let left = budget - Buffer.byteLength(head + tail);
    for (const record of [...this.records].reverse()) {
      if (record.kind === 'fact') continue;
      const line = `${record.id} ${record.date} ${record.kind} (${record.status}${record.replaces ? `, replaces ${record.replaces}` : ''}): ${record.text}`;
      const size = Buffer.byteLength(line) + 1;
      if (size > left) continue;
      selected.push(line);
      left -= size;
    }
    if (!selected.length) return '';
    return `${head}${selected.reverse().join('\n')}${tail}`;
  }
}
