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
//
// A turn the person stopped (Esc: `turn/end` with reason `aborted`, cause
// `user`) keeps what it has: the messages, what the agent already said
// (the harness commits a cut reply as an `interrupted` assistant message), the
// tool uses so far, then one `note` entry saying the person stopped it. The
// loop claims a turn's messages from its inbox before step 1 and appends them
// only once the request is prepared, so a turn stopped while it waits (the
// step-one hold, or before the request) has its messages only in the inbox
// claim; they are taken from there, once. A turn the harness closed after a
// crash (`turn/end` reason `interrupted`, written on the next start) loses its
// claimed messages the same way: they are kept, and the turn ends with an
// `interrupted` note instead.

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

/** The note a turn the person stopped ends with. */
export const STOPPED_NOTE = 'stopped by the person';
/** The note a turn closed after a crash ends with. */
export const INTERRUPTED_NOTE = 'interrupted';

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
    /** The agent's pending input, folded from its inbox splices like the harness's own projection. */
    /** @type {Record<string, any[]>} */
    this.inbox = { 'next-turn': [], 'next-step': [] };
    /** Messages claimed by the open turn and not yet in the log, by id. */
    /** @type {Map<string, { message: any, time: number }>} */
    this.claimed = new Map();
    /** The first entry of the open turn. */
    this.turnFrom = 0;
  }

  /**
   * Fold one session event; returns the entries it added (often none).
   * @param {any} event @returns {Entry[]}
   */
  push(event) {
    const before = this.entries.length;
    switch (event.type) {
      case 'turn/start':
        this.turnFrom = this.entries.length;
        if (this.granularity === 'turn') {
          if (this.open !== null) this.flush(event.time);
          this.open = { parts: [], calls: new Map(), reply: null };
        }
        break;
      case 'turn/end':
        this.end(event);
        break;
      case 'agent/inbox/spliced':
        this.splice(event);
        break;
      case 'user/message':
        this.claimed.delete(String(event.data?.id));
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

  /** Close a turn; a stopped or crashed turn keeps its unsent messages and ends with a note. @param {any} event */
  end(event) {
    const reason = event.data?.reason;
    const claimed = [...this.claimed.values()];
    this.claimed.clear();
    const cut = reason?.kind === 'aborted' || reason?.kind === 'interrupted';
    if (cut) for (const { message, time } of claimed) this.person({ data: message, time });
    if (this.open !== null) this.flush(event.time);
    const note = reason?.kind === 'interrupted' ? INTERRUPTED_NOTE : reason?.kind === 'aborted' && reason.reason?.kind === 'user' ? STOPPED_NOTE : '';
    // A cut turn that kept nothing (its messages went back to the inbox) is no record.
    if (note !== '' && this.entries.length > this.turnFrom) this.add('note', note, event.time);
  }

  /**
   * One inbox splice. A removal without an outcome is the loop's claim of a
   * step's messages (the only removal it records without one); a message put
   * back (a refused turn's) is pending again, not claimed.
   * @param {any} event
   */
  splice(event) {
    const data = event.data ?? {};
    const list = Object.hasOwn(this.inbox, data.target) ? this.inbox[data.target] : undefined;
    if (list === undefined) return;
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    const removed = list.splice(Number(data.start) || 0, Number(data.removedCount) || 0, ...inserted);
    for (const message of inserted) this.claimed.delete(String(message?.id));
    if (data.outcome === undefined) for (const message of removed) this.claimed.set(String(message?.id), { message, time: event.time });
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
