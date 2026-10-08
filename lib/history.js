// The numbered history, projected from the session's own events (SEAMS.md §e).
//
// The harness session log is the authority; this is a pure fold over it. The
// same events always give the same entries with the same numbers, because the
// stored summary lines are addressed by those numbers across restarts. Entry
// text never contains a configurable word (agent name, the person's word):
// tags are added when a line is rendered.
//
// Granularity `turn` (default): per turn, each message of the person, then ONE
// trace entry with the turn's tool uses and capped results, then the final
// reply. Granularity `step`: the OptChat specification's one entry per reply,
// per tool call and per tool result.
//
// Model reasoning is never part of the history. A tool result is clipped to its
// head and tail (RESULT_CAP), and so is a turn's trace (TRACE_CAP); any other
// text longer than MESSAGE_CAP is never cut: it becomes several entries of the
// same kind in a row (UniiChat spec §1).

import { MESSAGE_CAP, RESULT_CAP, TRACE_CAP } from './config.js';
import { bytes, capText, splitText } from './text.js';

/** @typedef {'user' | 'talk' | 'tool' | 'echo' | 'work' | 'note'} Kind */
/** @typedef {{ i: number, kind: Kind, text: string, size: number, time: number }} Entry */

/** User-message sources that are the person's own words. */
const PERSON = new Set(['user', 'user-question-reply']);
/** User-message sources that are another agent speaking. */
const COLLEAGUE = new Set(['agent-message', 'subagent-settled']);
/** User-message sources kept as context. Every other source is machinery and skipped. */
const NOTE = new Set(['goal', 'schedule', 'session-reference']);

/** @param {{ kind?: string } | undefined} source @returns {Kind | null} */
export function kindOfSource(source) {
  const kind = source?.kind ?? '';
  if (PERSON.has(kind)) return 'user';
  if (COLLEAGUE.has(kind)) return 'work';
  if (NOTE.has(kind)) return 'note';
  return null;
}

/** Plain text of message content; reasoning is dropped, images and files are named. @param {readonly any[]} content */
export function contentText(content) {
  const parts = [];
  for (const block of content ?? []) {
    if (block?.type === 'text') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[image]');
    else if (block?.type === 'file') parts.push(`[file${typeof block.name === 'string' ? ` ${block.name}` : ''}]`);
  }
  return parts.join('\n').trim();
}

/** Only events that entered the surface at their own position are history. @param {any} event */
function isAppendOrigin(event) {
  return event.surfaceOp === 'append';
}

export class HistoryProjector {
  /** @param {{ granularity: 'turn' | 'step', resultCap?: number, traceCap?: number }} options */
  constructor({ granularity, resultCap = RESULT_CAP, traceCap = TRACE_CAP }) {
    this.granularity = granularity;
    this.resultCap = resultCap;
    this.traceCap = traceCap;
    /** @type {Entry[]} */
    this.entries = [];
    /** The open turn while granularity is `turn`; null between turns. */
    /** @type {{ parts: string[], calls: Map<string, { name: string, args: string }>, reply: { text: string, time: number } | null } | null} */
    this.open = null;
  }

  /**
   * Fold one session event; returns the entries it added (often none).
   * @param {any} event @returns {Entry[]}
   */
  push(event) {
    const before = this.entries.length;
    switch (event.type) {
      case 'turn/start':
        if (this.granularity === 'turn') {
          if (this.open !== null) this.flush(event.time);
          this.open = { parts: [], calls: new Map(), reply: null };
        }
        break;
      case 'turn/end':
        if (this.open !== null) this.flush(event.time);
        break;
      case 'user/message':
        if (isAppendOrigin(event)) this.person(event);
        break;
      case 'assistant/message':
        if (isAppendOrigin(event)) this.assistant(event);
        break;
      case 'tool/result':
        if (isAppendOrigin(event)) this.result(event);
        break;
      default:
        break;
    }
    return this.entries.slice(before);
  }

  /** @param {any} event */
  person(event) {
    const kind = kindOfSource(event.data?.source);
    if (kind === null) return;
    const text = contentText(event.data.content);
    if (text === '') return;
    // A message arriving after a reply in the same turn means that reply was
    // not the last word: it moves into the trace.
    if (this.open?.reply) this.saidInTrace();
    this.add(kind, text, event.time);
  }

  /** @param {any} event */
  assistant(event) {
    const content = event.data?.message?.content ?? [];
    const text = contentText(content.filter((/** @type {any} */ block) => block?.type === 'text'));
    const calls = content.filter((/** @type {any} */ block) => block?.type === 'tool-call');
    const open = this.open;
    if (open === null) {
      if (text !== '') this.add('talk', text, event.time);
      for (const call of calls) this.add('tool', callText(call), event.time);
      return;
    }
    if (open.reply) this.saidInTrace();
    if (calls.length === 0) {
      if (text !== '') open.reply = { text, time: event.time };
      return;
    }
    if (text !== '') open.parts.push(`said: ${text}`);
    for (const call of calls) open.calls.set(String(call.id), { name: String(call.name ?? ''), args: String(call.arguments ?? '').trim() });
  }

  /** @param {any} event */
  result(event) {
    const message = event.data?.message;
    const body = contentText(message?.content ?? []) || '(empty)';
    const text = capText(message?.isError === true ? `error: ${body}` : body, this.resultCap);
    const open = this.open;
    if (open === null) {
      this.add('echo', text, event.time);
      return;
    }
    const id = String(message?.toolCallId ?? '');
    const call = open.calls.get(id);
    open.calls.delete(id);
    open.parts.push(call ? `did: ${call.name} ${call.args}\nresult: ${text}` : `result: ${text}`);
  }

  /** The pending reply was not the turn's last word; keep it in the trace. */
  saidInTrace() {
    const open = /** @type {NonNullable<HistoryProjector['open']>} */ (this.open);
    if (open.reply) open.parts.push(`said: ${open.reply.text}`);
    open.reply = null;
  }

  /** Close the open turn: one trace entry, then the final reply. @param {number} time */
  flush(time) {
    const open = /** @type {NonNullable<HistoryProjector['open']>} */ (this.open);
    this.open = null;
    for (const call of open.calls.values()) open.parts.push(`did: ${call.name} ${call.args}\nresult: (no result)`);
    if (open.parts.length > 0) this.add('tool', capText(open.parts.join('\n\n'), this.traceCap), time);
    if (open.reply) this.add('talk', open.reply.text, open.reply.time);
  }

  /** @param {Kind} kind @param {string} text @param {number} time */
  add(kind, text, time) {
    const pieces = kind === 'tool' || kind === 'echo' ? [text] : splitText(text, MESSAGE_CAP);
    for (const piece of pieces) {
      this.entries.push(Object.freeze({ i: this.entries.length, kind, text: piece, size: bytes(piece), time: Number(time) || 0 }));
    }
  }
}

/** A tool call as the specification logs it: name and JSON input. @param {any} call */
function callText(call) {
  return `${String(call.name ?? '')} ${String(call.arguments ?? '').trim()}`.trim();
}
