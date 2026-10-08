/**
 * WHAT THE MEMORY'S MACHINERY READS AS, IN PLAIN WORDS.
 *
 * The memory keeps a turn's tool work as one trace the model reads
 * (`did: zoom {"id":0,"n":1}`, `result: 0+0|in «chat», you: …`) and answers
 * its look-back tools in the same machine form (`0+0|…`, `id|kind|date|snippet`).
 * A person never reads a line id, a level or a call's JSON, so both the
 * transcript's row and the History view read each answer back as its subject,
 * its date and its chat. No React and no network: pure functions over strings.
 */

const LINE_ID = /^\d+\+\d+\|/;
const INLINE_LINE_ID = /(^|[\s:(])\d+\+\d+\|/g;
/** The fields a search's answer writes before each find, `6|did|Thu, 8 Oct 2026, 13:07|`: place, speaker, date. */
const FIND_FIELDS = /(^|\s)\d+\|[^|\n]{1,200}\|([A-Za-z]{2,4}\.?, \d{1,2} [A-Za-z]{3,5}\.? \d{4}, \d{1,2}:\d{2})\|/g;
/** A call written inline, `did: name {json}`, and the `result:` that may follow it. */
const INLINE_CALL = /(?:did:\s*)+([a-z][a-z0-9_]*)(?:\s*(\{[^{}]*\}))?(\s+result:)?/g;
/** The sentences the tools answer when they found nothing (lib/recall.js, lib/tools.js). */
const NOT_REMEMBERED = /^(No line |No message |This conversation has no endless memory|The search needs words|No message contains|That pattern is not)/;

/** The plain names of the harness tools a trace usually holds; any other is its own name spaced out. */
const TOOL_NAMES = {
  bash: 'Ran a command', pwsh: 'Ran a command', read: 'Read a file', read_image: 'Looked at an image',
  write: 'Wrote a file', edit: 'Edited a file', grep: 'Searched files', glob: 'Listed files',
  web_fetch: 'Read a web page', web_search: 'Searched the web', subagent: 'Asked a helper',
  subagent_fork: 'Asked a helper', todo: 'Updated the to-do list', ask_user: 'Asked a question',
};

/** @param {string} text @param {number} most */
function clipped(text, most) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= most ? flat : `${flat.slice(0, most - 1).trimEnd()}…`;
}

/** A tool's machine name as a name a person reads. @param {string} name */
function plainToolName(name) {
  if (Object.prototype.hasOwnProperty.call(TOOL_NAMES, name)) return TOOL_NAMES[name];
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced === '' ? 'Used a tool' : `${spaced[0].toUpperCase()}${spaced.slice(1)}`;
}

/** @param {string} raw @returns {Record<string, unknown> | null} */
function argsOf(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The words a call was given, as values only: `Scratch`, never `{"query":"Scratch"}`. @param {Record<string, unknown> | null} args */
function givenWords(args) {
  if (args === null) return '';
  return Object.values(args)
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map((value) => clipped(String(value), 60))
    .filter((value) => value !== '')
    .join(' · ');
}

/** Every line without the `id+n|` it may open with, including a `result:` line's answer. @param {string} text */
function withoutLineIds(text) {
  return text.split('\n').map((line) => line.replace(LINE_ID, '').replace(/^(result:\s*)\d+\+\d+\|/, '$1')).join('\n');
}

/**
 * What one look-back answer was about: its subject, and the chat and date where
 * the answer names them; null for an answer that found nothing.
 * @param {string} toolName @param {Record<string, unknown> | null} args @param {string} output
 * @returns {{ subject: string, chat: string, date: string } | null}
 */
function lookedBackAt(toolName, args, output) {
  const text = output.trim();
  if (text === '' || NOT_REMEMBERED.test(text)) return null;
  if (toolName === 'date') return { subject: '', chat: '', date: clipped(text.split('\n')[0] || '', 40) };
  if (toolName === 'recall_search') {
    const query = args !== null && typeof args.query === 'string' ? args.query.trim() : '';
    const first = (text.split('\n')[0] || '').split('|');
    return { subject: clipped(query, 60), chat: '', date: first.length >= 4 ? clipped(first[2] || '', 40) : '' };
  }
  const line = text.split('\n')[0] || '';
  const single = /^\d+\+0\|/.test(line);
  let words = line.replace(LINE_ID, '');
  const chat = (/in «([^»]+)»/.exec(words) || [])[1] || '';
  words = words.replace(/^in «[^»]+»,?\s*/, '');
  if (single) words = words.replace(/^[^:«»]{1,40}:\s*/, '');
  return { subject: clipped(words, 60), chat: clipped(chat, 60), date: '' };
}

/** @param {string} name @param {string | undefined} raw */
function callWords(name, raw) {
  if (LOOK_BACK_TOOLS.includes(name)) return 'Looked back';
  const given = givenWords(raw === undefined ? null : argsOf(raw));
  return given === '' ? plainToolName(name) : `${plainToolName(name)} · ${given}`;
}

/**
 * Words on one line — a remembered line, a search's find — read plainly: no
 * line id anywhere, the fields of a find inside it as its date, and a call
 * written `did: name {json}` by its plain name (a look-back once, with its
 * `result:` as the separator rather than a second label).
 * @param {string} text
 */
function plainInline(text) {
  return text
    .replace(INLINE_LINE_ID, '$1')
    .replace(FIND_FIELDS, '$1$2 · ')
    .replace(INLINE_CALL, (_whole, name, raw, result) =>
      (LOOK_BACK_TOOLS.includes(name) && result !== undefined ? `${callWords(name, raw)} ·` : `${callWords(name, raw)}${result || ''}`));
}

/** A search's answer opened: one find per line, as its date and its words. @param {string} answer */
function plainFinds(answer) {
  return answer.split('\n').map((line) => plainInline(withoutLineIds(line))).join('\n');
}

/**
 * A look-back answer as a person reads it opened: no line ids, and a search's
 * hits as their date and words.
 * @param {string} toolName @param {string} output
 */
function plainLookBack(toolName, output) {
  return toolName === 'recall_search' ? plainFinds(output) : withoutLineIds(output);
}

/**
 * The look-back row's words, in the tense of the call's state. The row never
 * falls back to the call's own words (`{"id":0,"n":1}` is a line id), so its
 * summary is always said, empty while nothing is known.
 * @param {string} toolName @param {Record<string, unknown> | null} args
 * @param {string} state `preparing`, `running`, `ok`, `error` or `stopped`
 * @param {string | null} output the settled answer's text
 * @returns {{ title: string, summary: string, opened: string | null }}
 */
function sayLookBack(toolName, args, state, output) {
  const title = state === 'ok' ? 'Looked back' : state === 'error' ? 'Could not look back'
    : state === 'stopped' ? 'Stopped looking back' : 'Looking back';
  if (state === 'error' && typeof output === 'string' && output.trim() !== '') {
    return { title, summary: clipped(output.split('\n')[0] || '', 80), opened: output };
  }
  if (state !== 'ok' || typeof output !== 'string') return { title, summary: '', opened: null };
  const at = lookedBackAt(toolName, args, output);
  const parts = at === null ? [] : [at.subject === '' ? '' : `«${at.subject}»`, at.date, at.chat === '' ? '' : `in «${at.chat}»`];
  return {
    title,
    summary: parts.filter((part) => part !== '').join(' · '),
    opened: at === null ? 'Nothing was found there.' : plainLookBack(toolName, output),
  };
}

/** The one-line "Looked back · «subject» · date · in «chat»" a History trace step reads as. @param {string} name @param {Record<string, unknown> | null} args @param {string} answer */
function lookBackLine(name, args, answer) {
  const said = sayLookBack(name, args, 'ok', answer);
  return said.summary === '' ? said.title : `${said.title} · ${said.summary}`;
}

/**
 * A kept trace as steps a person reads. A look-back is its one plain row; any
 * other call is its plain name and the words it was given; a `said:` part is its
 * words; every answer is shown without line ids.
 * @param {string} text
 * @returns {{ line: string, opened: string }[]}
 */
function traceSteps(text) {
  const out = [];
  for (const part of text.split(/\n\n(?=did: |said: |result: )/)) {
    if (part.startsWith('said: ')) { out.push({ line: clipped(part.slice(6), 200), opened: '' }); continue; }
    if (part.startsWith('result: ')) { out.push({ line: clipped(withoutLineIds(part.slice(8)), 200), opened: withoutLineIds(part.slice(8)) }); continue; }
    if (!part.startsWith('did: ')) {
      const plain = withoutLineIds(part);
      const first = (plain.split('\n').find((line) => line.trim() !== '') || '').trim();
      if (first !== '') out.push({ line: clipped(first, 200), opened: plain });
      continue;
    }
    const newline = part.indexOf('\n');
    const head = newline === -1 ? part : part.slice(0, newline);
    const answer = (newline === -1 ? '' : part.slice(newline + 1)).replace(/^result:\s?/, '');
    const rest = head.replace(/^(did:\s*)+/, '');
    const space = rest.indexOf(' ');
    const name = space === -1 ? rest.trim() : rest.slice(0, space).trim();
    const args = argsOf(space === -1 ? '' : rest.slice(space + 1).trim());
    if (LOOK_BACK_TOOLS.includes(name)) {
      out.push({ line: lookBackLine(name, args, answer), opened: plainLookBack(name, answer) });
    } else {
      const given = givenWords(args);
      out.push({ line: given === '' ? plainToolName(name) : `${plainToolName(name)} · ${given}`, opened: withoutLineIds(answer) });
    }
  }
  return out;
}

/** A kept message opened in full: a trace as its plain steps, anything else without line ids. @param {string} kind @param {string} text */
function plainMessage(kind, text) {
  if (kind !== 'trace') return withoutLineIds(text);
  return traceSteps(text)
    .map((step) => (step.opened === '' || step.opened === step.line ? step.line : `${step.line}\n${step.opened}`))
    .join('\n');
}
