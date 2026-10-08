// One endless memory, open for writing: the memory of one agent in one
// project, shared by every chat bound to it.
//
// It holds the memory's lock for its whole life, so one process writes it:
// finished turns are appended to the order here, one whole turn per record,
// and the summary writer grows the tree. A second process that wants the
// same memory is refused (lock.js) and its turn waits in the existing refusal.
//
// Beside the chat's view it keeps the compaction view (UniiChat spec §4): the
// chat's view merged further, to between a quarter of the view's floor and a
// quarter of its ceiling (16-32 KB by default), with the same sawtooth. It is
// derived from the chat's view once, then takes the same new lines, merges
// again past its ceiling, and is derived again whenever the chat's view
// merges. Both views are written after every change.
//
// No harness import: the model call is an injected `summarize`.

import { acquireLock } from './lock.js';
import { MemoryData, viewFile } from './memory-data.js';
import { appendRecord, entriesOf } from './order.js';
import { taggedEntry } from './prompts.js';
import { readJson, writeDurable } from './store.js';
import { UsageLog } from './usage.js';
import { View } from './view.js';
import { Writer } from './writer.js';

/** @typedef {import('./memory-data.js').Config} Config */
/** @typedef {import('./memory-data.js').Log} Log */
/** @typedef {import('./turns.js').TurnRecord} TurnRecord */

/** @param {string} sessionId @param {number} turn */
const turnKey = (sessionId, turn) => `${sessionId}\n${turn}`;

export class Memory extends MemoryData {
  /**
   * Open (or create) one memory and fold it. Takes the memory's lock for the
   * life of the object; throws LockHeldError when another process holds it.
   * @param {object} options
   * @param {string} options.memoryId
   * @param {import('./key.js').MemoryKey} options.key
   * @param {string} options.dir
   * @param {Config} options.config
   * @param {import('./writer.js').Summarize} options.summarize
   * @param {() => boolean} [options.canCall]
   * @param {Log} options.log
   */
  constructor({ memoryId, key, dir, config, summarize, canCall = () => true, log }) {
    const release = acquireLock(dir);
    try {
      super({ memoryId, key, dir, config, log });
    } catch (error) {
      release();
      throw error;
    }
    this.release = release;
    this.compactionFile = viewFile(dir, 'compaction-view', config.granularity);
    this.compactionView = new View(this.tree, Math.floor(config.viewBytes / 4), Math.floor(config.viewFloorBytes / 4));
    try {
      const stored = readJson(this.compactionFile);
      if (stored === undefined || this.compactionView.load(stored, this.size) !== '' || this.compactionView.covered() !== this.size) {
        this.deriveCompactionView();
        if (this.size > 0) this.viewChanged = true;
      }
      if (this.viewChanged) this.saveViews();
    } catch (error) {
      release();
      throw error;
    }
    this.usage = new UsageLog(memoryId, dir, log);
    /** Every (session, turn) already in the order. */
    this.turns = new Set(this.records.map((record) => turnKey(record.sessionId, record.turn)));
    /** @type {Set<() => void>} */
    this.waiters = new Set();
    this.pumpQueued = false;
    this.closed = false;
    this.writer = new Writer({
      entries: this.entries,
      tree: this.tree,
      compactionView: this.compactionView,
      tagged: (entry) => taggedEntry(/** @type {import('./order.js').Entry} */ (entry), this.config),
      lineBytes: config.lineBytes,
      summarize,
      canCall,
      warn: (message) => log.warn(message),
      saved: () => this.wake(),
      spent: (usage) => this.usage.record(usage),
    });
  }

  /** @param {string} sessionId @param {number} turn */
  hasTurn(sessionId, turn) {
    return this.turns.has(turnKey(sessionId, turn));
  }

  /**
   * Append one finished turn, whole, and take its messages into the view and
   * the writer. A turn already in the order is ignored. Synchronous: it runs
   * inside a session append (the harness's `session/event`).
   * @param {TurnRecord} record @returns {boolean} whether it was appended
   */
  appendTurn(record) {
    if (this.closed) throw new Error(`[ENDLESS_MEMORY] ${this.memoryId} is closed`);
    if (record.entries.length === 0 || this.hasTurn(record.sessionId, record.turn)) return false;
    this.records.push(appendRecord(this.orderFile, record));
    this.turns.add(turnKey(record.sessionId, record.turn));
    for (const entry of entriesOf(this.records, this.records.length - 1, this.entries.length)) {
      this.entries.push(entry);
      this.addMessage(entry.i);
    }
    this.saveViews();
    this.pumpSoon();
    return true;
  }

  /** One new message enters both views. @param {number} i */
  addMessage(i) {
    if (this.view.add(i) > 0) this.deriveCompactionView();
    else this.compactionView.add(i);
  }

  /** The compaction view from the chat's view, merged down to its floor once. */
  deriveCompactionView() {
    const view = this.compactionView;
    view.copyFrom(this.view);
    view.shrink(this.size, view.low);
    view.shrinking = view.size() > view.low;
  }

  /** Write both views, each whole and durably. */
  saveViews() {
    writeDurable(this.viewFile, `${JSON.stringify(this.view)}\n`);
    writeDurable(this.compactionFile, `${JSON.stringify(this.compactionView)}\n`);
    this.viewChanged = false;
  }

  /** Run the writer after the current append has finished publishing. */
  pumpSoon() {
    if (this.pumpQueued || this.closed) return;
    this.pumpQueued = true;
    setImmediate(() => {
      this.pumpQueued = false;
      if (!this.closed) this.writer.pump();
    });
  }

  wake() {
    for (const waiter of [...this.waiters]) waiter();
  }

  /**
   * Resolve true once every line of the view is a summary; false on timeout,
   * on abort and when the memory closes.
   * @param {AbortSignal | undefined} signal @param {number} timeoutMs
   */
  settle(signal, timeoutMs) {
    if (this.view.allBuilt()) return Promise.resolve(true);
    this.pumpSoon();
    return new Promise((resolve) => {
      /** @param {boolean} value */
      const finish = (value) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', aborted);
        resolve(value);
      };
      const check = () => {
        if (this.closed) finish(false);
        else if (this.view.allBuilt()) finish(true);
      };
      const aborted = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(check);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) finish(false);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.writer.close();
    this.wake();
    this.release();
  }
}
