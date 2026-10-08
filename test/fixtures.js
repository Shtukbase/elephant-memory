// Shared test fixtures: harness-shaped session events and an in-memory tree.
// Event shapes follow the harness's own declarations (SEAMS.md §e).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function eventLog() {
  /** @type {any[]} */
  const events = [];
  const at = (/** @type {number} */ seq) => 1_760_000_000_000 + seq * 1000;
  /** @param {string} type @param {any} data @param {Record<string, unknown>} [extra] */
  const push = (type, data, extra = {}) => {
    const event = { type, seq: events.length, time: at(events.length), data, ...extra };
    events.push(event);
    return event;
  };
  return {
    events,
    turnStart: (/** @type {number} */ turn) => push('turn/start', { turn }),
    turnEnd: (/** @type {number} */ turn) => push('turn/end', { turn, reason: { kind: 'completed' } }),
    /** @param {string} text @param {string} [kind] */
    user: (text, kind = 'user') => push('user/message', { id: `u${events.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind } }, { surfaceOp: 'append' }),
    /** @param {any[]} content */
    assistant: (content) => push('assistant/message', { turn: 1, step: 1, message: { id: `a${events.length}`, role: 'assistant', content, source: { kind: 'model' } }, stream: [] }, { surfaceOp: 'append' }),
    /** @param {string} callId @param {string} text @param {boolean} [isError] */
    result: (callId, text, isError = false) => push('tool/result', { turn: 1, step: 1, message: { id: `r${events.length}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId }, ...(isError ? { isError: true } : {}) } }, { surfaceOp: 'append' }),
    /** A checkpoint that replaced earlier nodes: not history. @param {string} text */
    checkpoint: (text) => push('user/message', { id: `c${events.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint', compactionId: 'x' } }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }),
  };
}

/** A session the memory can read. @param {any[]} events */
export function fakeSession(events) {
  return {
    snapshotEvents: () => events,
    eventAt: (/** @type {number} */ seq) => events[seq],
    get seq() {
      return events.length;
    },
  };
}

/** An in-memory tree: every (l, i) in `built` has `text`. */
export class MemoryTree {
  constructor() {
    /** @type {Map<string, string>} */
    this.nodes = new Map();
  }

  /** @param {number} l @param {number} i @param {string} text */
  set(l, i, text) {
    this.nodes.set(`${l}:${i}`, text);
    return this;
  }

  /** @param {number} l @param {number} i */
  built(l, i) {
    return this.nodes.has(`${l}:${i}`);
  }

  /** @param {number} l @param {number} i */
  text(l, i) {
    return this.nodes.get(`${l}:${i}`) ?? null;
  }

  /** @param {number} l @param {number} i */
  bytes(l, i) {
    return Buffer.byteLength(this.nodes.get(`${l}:${i}`) ?? '', 'utf8');
  }

  /** Build every node of a complete tree over T messages, each `size` bytes. @param {number} T @param {number} size */
  fill(T, size) {
    for (let l = 0; 2 ** l <= T; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= T; i++) this.set(l, i, `${l}.${i}`.padEnd(size, '.'));
    }
    return this;
  }
}

/** Let pending callbacks, promises and setImmediate work run. @param {number} [rounds] */
export async function settleTicks(rounds = 50) {
  for (let k = 0; k < rounds; k++) await new Promise((resolve) => setImmediate(resolve));
}

// Folders for the tests' memories: inside the package (test/.runs, ignored by
// git), never a system temporary folder. Each test file removes its own.

const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), '.runs');

/** A list of roots made by one test file, and their removal. */
export function rootsForThisFile() {
  /** @type {string[]} */
  const made = [];
  return {
    fresh() {
      fs.mkdirSync(RUNS, { recursive: true });
      const root = fs.mkdtempSync(path.join(RUNS, 'root-'));
      made.push(root);
      return root;
    },
    removeAll() {
      for (const root of made) fs.rmSync(root, { recursive: true, force: true });
      try {
        fs.rmdirSync(RUNS);
      } catch {
        // Another test file still has roots there.
      }
    },
  };
}

/** A log that keeps what it was told. */
export function keptLog() {
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const infos = [];
  return { warnings, infos, warn: (/** @type {string} */ m) => warnings.push(m), info: (/** @type {string} */ m) => infos.push(m) };
}

/**
 * One whole turn appended to a harness-shaped session (`FakeSession`):
 * turn/start, the person's message, the reply, turn/end.
 * @param {{ append(type: string, data: any, opts?: any): any }} session
 * @param {number} turn @param {string} text @param {string} reply
 */
export function wholeTurn(session, turn, text, reply) {
  session.append('turn/start', { turn });
  session.append('user/message', { id: `u${turn}-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model' } } }, { surfaceOp: 'append' });
  return session.append('turn/end', { turn, reason: { kind: 'completed' } });
}
