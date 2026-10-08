// The summary tree on disk: one append-only stream of day files.
//
//   tree-<granularity>-v<projection>/YYYY-MM-DD.jsonl   {l, i, text, size, src?}
//
// Every line is written with one write and fsync before the call returns, so
// a crash loses nothing written. At load, a line that is not valid JSON (a
// crash mid-write) is reported and skipped, and a file not ending in "\n" gets
// one appended, so the next write starts on its own line. Nothing is ever
// edited or deleted; when two records name one node, the later one wins.
//
// The tree is a cache in principle (rebuildable from the history) but costs
// model calls to rebuild, so it is stored and never recomputed.

import fs from 'node:fs';
import path from 'node:path';
import { bytes, localDay } from './text.js';

/** @typedef {{ l: number, i: number, text: string, size: number, src?: number }} TreeNode */
/** @typedef {{ warn(message: string): void }} Log */

/** Append one text with a single write and fsync. @param {string} file @param {string} text */
export function appendDurable(file, text) {
  const data = Buffer.from(text, 'utf8');
  const fd = fs.openSync(file, 'a');
  try {
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replace one small file whole and durably: write a sibling, fsync it, rename
 * it over the file, fsync the folder. A crash leaves the old file or the new.
 * @param {string} file @param {string} text
 */
export function writeDurable(file, text) {
  const next = `${file}.next`;
  const fd = fs.openSync(next, 'w');
  try {
    const data = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(next, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

/** A small JSON file, or undefined when it is missing or unreadable. @param {string} file */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Every valid JSON line of one file; torn lines are reported and skipped.
 * `repair` false never writes: a reader that does not hold the lock leaves a
 * line being written alone.
 * @param {string} file @param {Log} log @param {boolean} [repair] @returns {unknown[]}
 */
export function readJsonl(file, log, repair = true) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (repair && raw.length > 0 && !raw.endsWith('\n')) {
    log.warn(`[ENDLESS_STORE] ${path.basename(file)} did not end in a newline; one was appended`);
    appendDurable(file, '\n');
  }
  const out = [];
  const lines = raw.split('\n');
  for (let n = 0; n < lines.length; n++) {
    if (lines[n].trim() === '') continue;
    try {
      out.push(JSON.parse(lines[n]));
    } catch {
      log.warn(`[ENDLESS_STORE] skipped a torn line, ${path.basename(file)}:${n + 1}`);
    }
  }
  return out;
}

/** @param {unknown} value @returns {value is TreeNode} */
function isNode(value) {
  if (typeof value !== 'object' || value === null) return false;
  const node = /** @type {Record<string, unknown>} */ (value);
  return Number.isSafeInteger(node.l) && Number.isSafeInteger(node.i) && /** @type {number} */ (node.l) >= 0 &&
    /** @type {number} */ (node.i) >= 0 && typeof node.text === 'string';
}

const key = (/** @type {number} */ l, /** @type {number} */ i) => `${l}:${i}`;

export class TreeStore {
  /** @param {string} dir @param {Log} log @param {boolean} [repair] false: read only, never write */
  constructor(dir, log, repair = true) {
    this.dir = dir;
    this.log = log;
    /** @type {Map<string, TreeNode>} */
    this.nodes = new Map();
    if (!fs.existsSync(dir)) return;
    const days = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    for (const day of days) {
      for (const record of readJsonl(path.join(dir, day), log, repair)) {
        if (isNode(record)) this.nodes.set(key(record.l, record.i), { ...record, size: bytes(record.text) });
      }
    }
  }

  /** @param {number} l @param {number} i */
  built(l, i) {
    return this.nodes.has(key(l, i));
  }

  /** @param {number} l @param {number} i @returns {string | null} */
  text(l, i) {
    return this.nodes.get(key(l, i))?.text ?? null;
  }

  /** @param {number} l @param {number} i */
  bytes(l, i) {
    return this.nodes.get(key(l, i))?.size ?? 0;
  }

  /**
   * Store one built node. `src` is the byte size of a level-0 node's source
   * entry, kept so a later load can tell that the history it summarized is
   * still the same history.
   * @param {number} l @param {number} i @param {string} text @param {number} [src]
   */
  save(l, i, text, src) {
    /** @type {TreeNode} */
    const node = { l, i, text, size: bytes(text), ...(src === undefined ? {} : { src }) };
    fs.mkdirSync(this.dir, { recursive: true });
    appendDurable(path.join(this.dir, `${localDay(new Date())}.jsonl`), `${JSON.stringify(node)}\n`);
    this.nodes.set(key(l, i), node);
    return node;
  }

  /**
   * Forget, in memory only, every node whose stretch reaches past `end`
   * messages. The records stay in the files; a rebuilt node is appended later
   * and wins at the next load.
   * @param {number} end
   */
  forgetFrom(end) {
    let forgotten = 0;
    for (const [name, node] of this.nodes) {
      if ((node.i + 1) * 2 ** node.l > end) {
        this.nodes.delete(name);
        forgotten++;
      }
    }
    return forgotten;
  }

  /**
   * The first message whose stored level-0 line no longer matches the history
   * (missing entry or a different source size), or `entries.length`.
   * @param {readonly { size: number }[]} entries
   */
  firstMismatch(entries) {
    let first = entries.length;
    for (const node of this.nodes.values()) {
      if (node.l !== 0) continue;
      const entry = entries[node.i];
      if (entry === undefined || (node.src !== undefined && node.src !== entry.size)) first = Math.min(first, node.i);
    }
    return first;
  }
}
