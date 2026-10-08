// The six seam methods a host calls, as plain functions over the memories,
// with the shapes below. Read-only except `endless.bind`. Times are ISO 8601.
//
//   endless.bind     {sessionId, agent, project, agentName?} → {memoryId}
//   endless.memories {agent?}                          → {memories: [{memoryId, agent, project, turns, firstAt, lastAt, writerUsage}]}
//   endless.view     {memoryId}                        → {lines: [{id, n, text, from, to}]}
//   endless.zoom     {memoryId, id, n}                 → {lines} | {message: {id, kind, text, at, sessionId, sessionTitle}}
//   endless.history  {memoryId, before?, limit? ≤ 200} → {turns: [{at, sessionId, sessionTitle, entries: [{id, kind, text}]}], next?}
//   endless.search   {memoryId, query, limit? ≤ 50}    → {hits: [{id, at, sessionTitle, kind, snippet}]}
//
// A line not summarized yet has `text: null`. `history` pages backwards by
// turn: `before` is a turn's place in the order (exclusive), `next` the value
// to pass for the page before this one; inside a page the oldest comes first.
// A page also ends before HISTORY_PAGE_BYTES of text (never below one turn),
// so one answer stays a size a page can hold.

import { HISTORY_PAGE, HISTORY_PAGE_BYTES, HISTORY_PAGE_MAX, SEARCH_HITS, SEARCH_HITS_MAX } from './config.js';
import { isMemoryId } from './key.js';
import { flat } from './text.js';
import { countOf, startOf } from './view.js';

/** A refusal the caller may show; `code` tells refusals apart. */
export class EndlessRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'EndlessRefusal';
    this.code = code;
  }
}

/** @typedef {import('./memory-data.js').MemoryData} MemoryData */
/** @typedef {{ data: MemoryData, usage: import('./usage.js').UsageTotals }} Snapshot */
/**
 * What the methods read and the one write they make.
 * @typedef {object} ApiSource
 * @property {(sessionId: string, agent: string, project: string, agentName?: string) => { memoryId: string }} bind
 * @property {() => string[]} memoryIds
 * @property {(memoryId: string) => Snapshot | undefined} snapshot
 */

/** The entry kinds as a reader sees them. */
const KIND = Object.freeze({ user: 'user', talk: 'reply', tool: 'trace', echo: 'trace', work: 'work', note: 'trace' });

/** @param {number} ms */
const iso = (ms) => new Date(Number.isFinite(ms) ? ms : 0).toISOString();

/** @param {Record<string, unknown>} args @param {string} name */
function text(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') throw new EndlessRefusal('endless/bad-request', `The request needs ${name}.`);
  return value;
}

/**
 * A whole number in [min, max]; `fallback` undefined means it is required.
 * @param {Record<string, unknown>} args @param {string} name @param {number | undefined} fallback @param {number} min @param {number} max
 */
function whole(args, name, fallback, min, max) {
  const value = args[name];
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
    throw new EndlessRefusal('endless/bad-request', `The request's ${name} is out of range.`);
  }
  return /** @type {number} */ (value);
}

/** @param {ApiSource} source @param {Record<string, unknown>} args */
function snapshotOf(source, args) {
  const memoryId = args.memoryId;
  const snapshot = isMemoryId(memoryId) ? source.snapshot(memoryId) : undefined;
  if (snapshot === undefined) throw new EndlessRefusal('endless/unknown-memory', 'That memory does not exist.');
  return snapshot.data;
}

/** One view line. @param {MemoryData} data @param {{ l: number, i: number }} part */
function lineOf(data, part) {
  const id = startOf(part);
  const n = countOf(part);
  return { id, n, text: data.tree.text(part.l, part.i), from: iso(data.entries[id].time), to: iso(data.entries[id + n - 1].time) };
}

/** @param {ApiSource} source @param {Record<string, unknown>} args */
function memories(source, args) {
  const agent = args.agent === undefined || args.agent === null ? undefined : text(args, 'agent');
  const list = [];
  for (const memoryId of source.memoryIds()) {
    const snapshot = source.snapshot(memoryId);
    if (snapshot === undefined || (agent !== undefined && snapshot.data.key.agent !== agent)) continue;
    const { records, key } = snapshot.data;
    list.push({
      memoryId,
      agent: key.agent,
      project: key.project,
      turns: records.length,
      firstAt: records.length === 0 ? null : iso(records[0].at),
      lastAt: records.length === 0 ? null : iso(records[records.length - 1].at),
      writerUsage: { ...snapshot.usage },
    });
  }
  return { memories: list };
}

/** @param {ApiSource} source @param {Record<string, unknown>} args */
function zoom(source, args) {
  const data = snapshotOf(source, args);
  const id = whole(args, 'id', undefined, 0, Number.MAX_SAFE_INTEGER);
  const n = whole(args, 'n', undefined, 1, 2 ** 40);
  if (!Number.isInteger(Math.log2(n)) || id % n !== 0 || id + n > data.size) throw new EndlessRefusal('endless/no-line', 'That line is not in this memory.');
  if (n === 1) {
    const entry = data.entries[id];
    const record = data.records[entry.record];
    return { message: { id, kind: KIND[entry.kind], text: entry.text, at: iso(entry.time), sessionId: record.sessionId, sessionTitle: record.sessionTitle } };
  }
  const l = Math.log2(n) - 1;
  const i = (2 * id) / n;
  return { lines: [lineOf(data, { l, i }), lineOf(data, { l, i: i + 1 })] };
}

/** @param {ApiSource} source @param {Record<string, unknown>} args */
function history(source, args) {
  const data = snapshotOf(source, args);
  const count = data.records.length;
  const end = whole(args, 'before', count, 0, Number.MAX_SAFE_INTEGER);
  const limit = whole(args, 'limit', HISTORY_PAGE, 1, HISTORY_PAGE_MAX);
  const to = Math.min(end, count);
  let from = Math.max(0, to - limit);
  /** @type {Map<number, { id: number, kind: string, text: string }[]>} */
  const byRecord = new Map();
  /** @type {Map<number, number>} */
  const bytesOf = new Map();
  for (const entry of data.entries) {
    if (entry.record < from || entry.record >= to) continue;
    const list = byRecord.get(entry.record) ?? [];
    list.push({ id: entry.i, kind: KIND[entry.kind], text: entry.text });
    byRecord.set(entry.record, list);
    bytesOf.set(entry.record, (bytesOf.get(entry.record) ?? 0) + entry.size);
  }
  // Newest first, until the next older turn would pass the byte budget.
  for (let r = to - 1, total = 0; r >= from; r--) {
    total += bytesOf.get(r) ?? 0;
    if (total > HISTORY_PAGE_BYTES && r < to - 1) {
      from = r + 1;
      break;
    }
  }
  const turns = data.records.slice(from, to).map((record, k) => ({
    at: iso(record.at),
    sessionId: record.sessionId,
    sessionTitle: record.sessionTitle,
    entries: byRecord.get(from + k) ?? [],
  }));
  return from > 0 ? { turns, next: from } : { turns };
}

/** @param {ApiSource} source @param {Record<string, unknown>} args */
function search(source, args) {
  const data = snapshotOf(source, args);
  const query = text(args, 'query').trim();
  if (query.length > 1000) throw new EndlessRefusal('endless/bad-request', 'The search is too long.');
  const limit = whole(args, 'limit', SEARCH_HITS, 1, SEARCH_HITS_MAX);
  const needle = query.toLowerCase();
  const hits = [];
  for (let i = data.size - 1; i >= 0 && hits.length < limit; i--) {
    const entry = data.entries[i];
    const at = entry.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - 80);
    const to = Math.min(entry.text.length, at + query.length + 120);
    const snippet = `${from > 0 ? '…' : ''}${flat(entry.text.slice(from, to))}${to < entry.text.length ? '…' : ''}`;
    hits.push({ id: i, at: iso(entry.time), sessionTitle: entry.title, kind: KIND[entry.kind], snippet });
  }
  return { hits };
}

/**
 * The six methods by name. Each takes the call's `args` and returns its value
 * or throws an EndlessRefusal.
 * @param {ApiSource} source
 * @returns {Record<string, (args: Record<string, unknown>) => unknown>}
 */
export function endlessMethods(source) {
  return {
    'endless.bind': (args) => source.bind(text(args, 'sessionId'), text(args, 'agent'), text(args, 'project'), args.agentName === undefined || args.agentName === null ? undefined : text(args, 'agentName')),
    'endless.memories': (args) => memories(source, args),
    'endless.view': (args) => {
      const data = snapshotOf(source, args);
      return { lines: data.view.parts.map((part) => lineOf(data, part)) };
    },
    'endless.zoom': (args) => zoom(source, args),
    'endless.history': (args) => history(source, args),
    'endless.search': (args) => search(source, args),
  };
}

/** The method names, in the contract's order. */
export const ENDLESS_METHODS = Object.freeze(['endless.bind', 'endless.memories', 'endless.view', 'endless.zoom', 'endless.history', 'endless.search']);
