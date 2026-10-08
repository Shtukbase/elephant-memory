// A turn's look-backs as the summary writer reads them (README, deviation 19).
//
// The order file keeps a turn's trace as the harness gave it: `did: zoom
// {"id":0,"n":1}`, then `result: 0+0|in «chat», you: …`, or a search's
// `id|kind|date|snippet` lines. That form is machinery (a line id, a message id,
// a call's JSON), and a writer told to tag items in plain words copied it into
// real summary lines: "Looked back id 0 n 1", "hits: message 0 … (1, 7, 8)"
// (round 5 of the live walk, G3). The History view and the look-back row read
// the stored form (client/words.js), and `zoom(id, 1)` gives it whole, so it is
// not changed. Only the writer's input, and with it a short trace's own line in
// the view, says the look-back in words: `did: looked back at «subject» in
// «chat»`. The `did:` tag stays, so the one tag of a tool call is the same for
// every call. Granularity `turn` only: a `step` entry holds a call without its
// answer, and the ids are all the call has.
//
// Pure: strings in, strings out.

/** The memory's own look-back tools (lib/tools.js). */
const LOOK_BACK_CALL = /^did: (zoom|date|recall_search)(?![\w-])([\s\S]*?)(?:\nresult: ([\s\S]*))?$/;
/** What the tools answer when they found nothing (lib/recall.js, lib/tools.js), a failed call, or no answer at all. */
const FOUND_NOTHING = /^(error: |\(no result\)|No line |No message |This conversation has no endless memory|The search needs words|That pattern is not)/;
/** The most of a subject that is kept. */
const SUBJECT_MOST = 60;
/** A trace's parts are joined by a blank line, each opening with its tag. */
const PART_BREAK = /\n\n(?=did: |said: |result: )/;

/** @param {string} text @param {number} most */
function clipped(text, most) {
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length <= most ? plain : `${plain.slice(0, most - 1).trimEnd()}…`;
}

/** @param {string} raw @returns {Record<string, unknown>} */
function argsOf(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The subject of a zoom's answer: its first line without the line id, the chat
 * it names and, for one message, the tag of its speaker.
 * @param {string} answer @returns {{ subject: string, chat: string }}
 */
function zoomedAt(answer) {
  const line = answer.split('\n')[0] || '';
  const single = /^\d+\+0\|/.test(line);
  let words = line.replace(/^\d+\+\d+\|/, '');
  const chat = (/in «([^»]+)»/.exec(words) || [])[1] || '';
  words = words.replace(/^in «[^»]+»,?\s*/, '');
  if (single) words = words.replace(/^[^:«»]{1,40}:\s*/, '');
  return { subject: clipped(words, SUBJECT_MOST), chat: clipped(chat, SUBJECT_MOST) };
}

/**
 * One trace part when it is a look-back call, in words; null for any other part.
 * @param {string} part
 */
function lookedBack(part) {
  const match = LOOK_BACK_CALL.exec(part);
  if (match === null) return null;
  const [, name, rawArgs, answer = ''] = match;
  const found = answer.trim() !== '' && !FOUND_NOTHING.test(answer.trim());
  if (name === 'recall_search') {
    const query = clipped(String(argsOf(rawArgs.trim()).query ?? ''), SUBJECT_MOST);
    if (query === '') return 'did: looked back';
    return `did: looked back at «${query}»${found ? '' : ' and found nothing'}`;
  }
  if (!found) return 'did: looked back and found nothing';
  if (name === 'date') return `did: looked back at when a message was written: ${clipped(answer.split('\n')[0] || '', 40)}`;
  const { subject, chat } = zoomedAt(answer);
  if (subject === '') return 'did: looked back';
  return `did: looked back at «${subject}»${chat === '' ? '' : ` in «${chat}»`}`;
}

/** A trace with each look-back call in words. @param {string} text */
export function traceForWriter(text) {
  if (!text.includes('did: ')) return text;
  return text.split(PART_BREAK).map((part) => lookedBack(part) ?? part).join('\n\n');
}

/**
 * The entry as the writer reads it: a turn's trace with its look-backs in words.
 * @template {{ kind: string, text: string }} E
 * @param {E} entry @param {'turn' | 'step'} granularity @returns {E}
 */
export function entryForWriter(entry, granularity) {
  if (granularity !== 'turn' || entry.kind !== 'tool') return entry;
  const text = traceForWriter(entry.text);
  return text === entry.text ? entry : { ...entry, text };
}
