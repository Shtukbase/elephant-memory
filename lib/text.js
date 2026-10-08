// Byte-exact text helpers. Every size is UTF-8 bytes, never tokens: a
// tokenizer changes between models, a byte count never does (OptChat spec).

/** @param {string} text */
export function bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * The first `limit` bytes of `text`, never splitting a UTF-8 character.
 * @param {string} text @param {number} limit
 */
export function cutBytes(text, limit) {
  return Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8').replace(/�+$/u, '');
}

/** A view line's head, `id+n|`, at the start of a line, with any spaces around it. */
const LINE_HEAD = /^[ \t]*(?:\d+\+\d+\|[ \t]*)+/gm;

/**
 * A model's reply without the `id+n|` heads it copied from the view: one at the
 * start of the reply, and one at the start of every later line, because a merge
 * reply that copies both of its input lines carries two (a 235-turn run stored
 * `625+1|` on a second line). A head in the middle of a line is left alone: it
 * cannot be told from the line's own words (`3+4|5`).
 * @param {string} text
 */
export function stripHeads(text) {
  return text.trim().replace(LINE_HEAD, '').trim();
}

/**
 * Keep the head and tail of an over-long text, with a note of what was cut.
 * Never splits a surrogate pair.
 * @param {string} text @param {number} cap
 */
export function capText(text, cap) {
  if (text.length <= cap) return text;
  let head = Math.floor(cap / 2);
  let tail = text.length - (cap - head);
  if (isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
  if (isLowSurrogate(text.charCodeAt(tail))) tail += 1;
  return `${text.slice(0, head)}\n[… ${tail - head} characters cut from the middle …]\n${text.slice(tail)}`;
}

/**
 * A line cut to at most `limit` bytes at a word boundary, ending in "…".
 * @param {string} text @param {number} limit
 */
export function trimLine(text, limit) {
  if (bytes(text) <= limit) return text;
  const head = cutBytes(text, limit - bytes('…'));
  const space = head.search(/\s\S*$/);
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * A long text as pieces of at most `cap` characters, in order, nothing cut:
 * each piece ends at its last newline or space in its second half when it has
 * one, and never splits a surrogate pair. Joined, the pieces are the text.
 * @param {string} text @param {number} cap @returns {string[]}
 */
export function splitText(text, cap) {
  const pieces = [];
  let rest = text;
  while (rest.length > cap) {
    let end = Math.max(rest.lastIndexOf('\n', cap - 1), rest.lastIndexOf(' ', cap - 1)) + 1;
    if (end <= cap / 2) end = isHighSurrogate(rest.charCodeAt(cap - 1)) ? cap - 1 : cap;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  pieces.push(rest);
  return pieces;
}

/** @param {number} code */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** @param {number} code */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Newlines become single spaces: how a line is shown in the view. @param {string} text */
export function flat(text) {
  return text.replace(/\r?\n/g, ' ');
}

/** Local calendar day, YYYY-MM-DD: the day file a record goes to. @param {Date} date */
export function localDay(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local date and time a model can read. @param {number} ms */
export function longDate(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * One safe path segment for a session id: letters, digits, `-` and `_` stay,
 * every other UTF-16 unit becomes `.xxxx`, so two ids never share a folder.
 * @param {string} id
 */
export function pathSegment(id) {
  return id.replace(/[^A-Za-z0-9_-]/g, (ch) => `.${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
