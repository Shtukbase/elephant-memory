// One memory as its files describe it: the order of finished turns, the
// numbered history over them, the summary tree and the stored view.
//
// Read-only on its own (`Memories.snapshot` reads a memory this process does
// not hold this way); memory.js adds the lock, the writer and appends.
//
// The view is stored (`view-<granularity>-v<projection>.json`) and loaded,
// never recomputed: a recomputed view differs from the live one and every
// cached prefix dies with it (UniiChat spec §3.2). Messages the stored view
// does not cover yet (a crash between the order append and the view write)
// are added as live. Only a missing or unusable file is rebuilt from the
// history, and that is logged.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECTION_VERSION } from './config.js';
import { agentNameOf } from './key.js';
import { entriesOf, orderFile, readOrder } from './order.js';
import { TreeStore, readJson } from './store.js';
import { View, renderView } from './view.js';

/** @typedef {ReturnType<typeof import('./config.js').resolveConfig>} Config */
/** @typedef {{ warn(message: string): void, info?(message: string): void }} Log */
/** @typedef {import('./order.js').Entry} Entry */

/** The stored view of one memory folder. @param {string} dir @param {string} name @param {'turn' | 'step'} granularity */
export function viewFile(dir, name, granularity) {
  return path.join(dir, `${name}-${granularity}-v${PROJECTION_VERSION}.json`);
}

export class MemoryData {
  /**
   * @param {object} options
   * @param {string} options.memoryId
   * @param {import('./key.js').MemoryKey} options.key
   * @param {string} options.dir
   * @param {Config} options.config
   * @param {Log} options.log
   * @param {boolean} [options.repair] false: never write (no lock held)
   */
  constructor({ memoryId, key, dir, config, log, repair = true }) {
    this.memoryId = memoryId;
    this.key = key;
    this.dir = dir;
    // The agent's replies are tagged with this memory's agent name (key.js).
    this.config = Object.freeze({ ...config, agentName: agentNameOf(key, config.agentName) });
    this.log = log;
    this.repair = repair;
    this.orderFile = orderFile(dir, config.granularity);
    this.records = readOrder(this.orderFile, log, repair);
    /** @type {Entry[]} */
    this.entries = entriesOf(this.records);
    this.tree = new TreeStore(path.join(dir, `tree-${config.granularity}-v${PROJECTION_VERSION}`), log, repair);
    // Lines past the first mismatch (or past the end of the history) describe
    // a history that is no longer this one: forget them (in memory only).
    const stale = this.tree.firstMismatch(this.entries);
    const forgotten = this.tree.forgetFrom(stale);
    if (forgotten > 0) log.warn(`[ENDLESS_MEMORY] ${memoryId}: ${forgotten} stored lines no longer match the history from message ${stale} on; they will be written again`);
    this.viewFile = viewFile(dir, 'view', config.granularity);
    this.view = new View(this.tree, config.viewBytes, config.viewFloorBytes);
    /** Whether the view in memory differs from its file. */
    this.viewChanged = this.loadView(this.view, this.viewFile);
  }

  /**
   * Load a stored view and add the messages it does not cover yet. A missing
   * or unusable file is rebuilt from the history, message by message as live.
   * @param {View} view @param {string} file @returns {boolean} whether the view now differs from the file
   */
  loadView(view, file) {
    const T = this.entries.length;
    const stored = readJson(file);
    const reason = stored === undefined ? (fs.existsSync(file) ? 'its file could not be read' : 'its file is missing') : view.load(stored, T);
    if (reason !== '') {
      view.parts = [];
      view.shrinking = false;
      if (T > 0 && this.repair) this.log.warn(`[ENDLESS_MEMORY] ${this.memoryId}: ${path.basename(file)} was rebuilt from the history: ${reason}`);
    }
    const from = view.covered();
    for (let i = from; i < T; i++) view.add(i);
    return T > 0 && (reason !== '' || from < T);
  }

  /** Number of messages in the history. */
  get size() {
    return this.entries.length;
  }

  /** @param {number} i */
  entry(i) {
    return this.entries[i];
  }

  /** The view as the model reads it: `<chat>` … `</chat>`. */
  render() {
    return renderView(this.view, this.tree);
  }

  /** Lines in the view that still wait for their summary. */
  waiting() {
    return this.view.parts.filter((part) => !this.tree.built(part.l, part.i)).length;
  }
}
