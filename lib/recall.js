// The three ways a model looks back, exactly as the OptChat specification
// defines the first two, plus this plugin's raw search (README, deviation 2).
//
//   zoom(id, n)          line id+n opened into its two halves; n = 1: the message whole
//   date(id)             when message id was written
//   recall_search(query) up to RECALL_HITS raw messages, newest first, id|kind|date|snippet
//
// Every answer is plain text; a bad request is a plain sentence, never a throw.

import vm from 'node:vm';
import { RECALL_HITS, RECALL_PATTERN_MS } from './config.js';
import { tagOf, taggedEntry } from './prompts.js';
import { flat, longDate } from './text.js';
import { PLACEHOLDER, lineOf } from './view.js';

/**
 * A /pattern/ search, run where it can be stopped: a script with a time limit,
 * so a pattern that backtracks without end cannot hold the harness's thread.
 * Gives [message, index, width] per hit, newest first.
 */
const PATTERN_SCAN = new vm.Script(`(() => {
  const re = new RegExp(source, flags);
  const hits = [];
  for (let i = texts.length - 1; i >= 0 && hits.length < most; i--) {
    const match = re.exec(texts[i]);
    if (match !== null) hits.push([i, match.index, Math.max(1, match[0].length)]);
  }
  return hits;
})()`);

/**
 * @typedef {object} RecallSource
 * @property {number} size
 * @property {(i: number) => import('./order.js').Entry | import('./history.js').Entry | undefined} entry
 * @property {{ text(l: number, i: number): string | null }} tree
 * @property {import('./prompts.js').PromptConfig} config
 */

/** @param {number} n */
function isPowerOfTwo(n) {
  return Number.isSafeInteger(n) && n >= 1 && (n & (n - 1)) === 0;
}

/** @param {RecallSource} memory @param {unknown} id @param {unknown} n */
export function zoom(memory, id, n) {
  const start = Number(id);
  const count = Number(n);
  const T = memory.size;
  if (!Number.isSafeInteger(start) || start < 0 || !isPowerOfTwo(count) || start % count !== 0 || start + count > T) {
    return `No line ${String(id)}+${String(n)}.`;
  }
  if (count === 1) {
    const entry = /** @type {import('./order.js').Entry} */ (memory.entry(start));
    return `${start}+0|${taggedEntry(entry, memory.config)}`;
  }
  const l = Math.log2(count) - 1;
  const i = (2 * start) / count;
  return [i, i + 1].map((k) => lineOf({ l, i: k }, memory.tree.text(l, k) ?? PLACEHOLDER)).join('\n');
}

/** @param {RecallSource} memory @param {unknown} id */
export function dateOf(memory, id) {
  const entry = Number.isSafeInteger(Number(id)) ? memory.entry(Number(id)) : undefined;
  return entry === undefined ? `No message ${String(id)}.` : longDate(entry.time);
}

/** @param {RecallSource} memory @param {number} i */
const textOf = (memory, i) => /** @type {import('./history.js').Entry} */ (memory.entry(i)).text;

/**
 * Case-insensitive phrase, or `/pattern/flags`, over every message's raw text.
 * A pattern search stops after `patternMs` and says so.
 * @param {RecallSource} memory @param {unknown} query @param {number} [patternMs]
 */
export function recallSearch(memory, query, patternMs = RECALL_PATTERN_MS) {
  const q = String(query ?? '').trim();
  if (q === '') return 'The search needs words to look for.';
  /** @type {[number, number, number][]} [message, index, width] */
  let found = [];
  const pattern = /^\/(.+)\/([a-z]*)$/.exec(q);
  if (pattern) {
    const flags = pattern[2].replace(/[gy]/g, '');
    try {
      new RegExp(pattern[1], flags);
    } catch (error) {
      return `That pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
    }
    const texts = Array.from({ length: memory.size }, (_, i) => textOf(memory, i));
    try {
      found = PATTERN_SCAN.runInNewContext({ texts, source: pattern[1], flags, most: RECALL_HITS }, { timeout: patternMs });
    } catch {
      return `That pattern is not one this search can finish within ${patternMs / 1000} s. Search for plain words, or a simpler pattern.`;
    }
  } else {
    const needle = q.toLowerCase();
    for (let i = memory.size - 1; i >= 0 && found.length < RECALL_HITS; i--) {
      const at = textOf(memory, i).toLowerCase().indexOf(needle);
      if (at >= 0) found.push([i, at, q.length]);
    }
  }
  const hits = found.map(([i, at, width]) => {
    const entry = /** @type {import('./history.js').Entry} */ (memory.entry(i));
    const from = Math.max(0, at - 80);
    const to = Math.min(entry.text.length, at + width + 120);
    const snippet = `${from > 0 ? '…' : ''}${flat(entry.text.slice(from, to))}${to < entry.text.length ? '…' : ''}`;
    return `${i}|${tagOf(entry.kind, memory.config)}|${longDate(entry.time)}|${snippet}`;
  });
  return hits.length > 0 ? hits.join('\n') : `No message contains "${q}".`;
}
