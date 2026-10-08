// The summary writer's task messages, verbatim from the UniiChat specification
// §4 (the compaction tasks with their ruler, and the "Too long" retry):
// https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449
// The writer's instructions live in the conversation's own system prompt
// (system-section.js), so a compaction reads it from the turns' cache.
//
// Adaptations: the line limit is `lineBytes` (the spec's 512) and the word
// count scales with it; sources are tagged in plain words ("you:",
// "<agentName>:", "did:", "result:", "colleague:", "note:") instead of
// user/unii/tool/echo/work. Models cannot count bytes, so a ruler of exactly
// the limit in dashes shows the length; a real sample line got its content
// copied, and the sample line once used here leaked its invented facts
// ("version 114", "wave 12", "9 largest folders") into merged lines of real
// memories; the merge task now also says to use only the lines' own facts.
// The "Too long" retry is the spec's wording, but the writer passes it a limit
// of RETRY_TARGET (0.75) times the line limit, so its cut mark and its number
// ask for a clearly shorter line (config.js). Both tasks also carry KEEP: a real
// summary of a long first message kept its ten-item checklist and dropped the
// rule the person stated in the same message (README, deviation 18).

import { bytes, cutBytes, flat } from './text.js';

/**
 * Every writer task opens with this marker, and only writer tasks do: the
 * shared system section tells the model a call is a compaction ONLY when its
 * last message opens with it (a 201-turn trial run once answered a person's
 * turn as a compaction).
 */
export const TASK_MARKER = 'Compaction:';
/** The sentence every task adds: a 201-turn trial run wrote 6% of its lines in Chinese, from no Chinese source. */
const LANGUAGE = 'Write the line in the language of the messages it summarizes.';
/** The sentence both tasks add after it: a live run's first line kept a checklist and lost "release notes list only what ships". */
export const KEEP = 'Keep every rule, instruction, decision or preference the person states, word for word where short, before any other detail.';

/** @typedef {import('./history.js').Kind} Kind */
/** @typedef {{ agentName: string, you: string, granularity: 'turn' | 'step', lineBytes: number }} PromptConfig */

/** The plain word an entry kind is tagged with. @param {Kind} kind @param {PromptConfig} config */
export function tagOf(kind, config) {
  switch (kind) {
    case 'user':
      return config.you;
    case 'talk':
      return config.agentName;
    case 'tool':
      return 'did';
    case 'echo':
      return 'result';
    case 'work':
      return 'colleague';
    default:
      return 'note';
  }
}

/**
 * One message as the writer reads it: its source tag, and on the first message
 * of a turn the chat it was said in, `in «title», `, so a line that merges
 * turns of two chats can say where each thing was said.
 * @param {{ kind: Kind, text: string, first?: boolean, title?: string }} entry @param {PromptConfig} config
 */
export function taggedEntry(entry, config) {
  const chat = entry.first === true && typeof entry.title === 'string' && entry.title.trim() !== '' ? `in «${flat(entry.title.trim())}», ` : '';
  // A turn's trace (granularity `turn`) already tags every part of itself
  // ("did:", "result:", "said:"): a second tag would read "did: did: …". What
  // the agent said inside it is tagged with the agent's own name, so the
  // writer copies one tag for the agent's words.
  if (config.granularity === 'turn' && entry.kind === 'tool') return `${chat}${entry.text.replace(/^said: /gm, `${config.agentName}: `)}`;
  return `${chat}${tagOf(entry.kind, config)}: ${entry.text}`;
}

/** A ruler of exactly `limit` bytes, and the words that many bytes hold. @param {number} limit */
function measure(limit) {
  return { ruler: '-'.repeat(limit), words: Math.round((limit * 70) / 512) };
}

/**
 * The task for one message's line.
 * @param {number} id the message @param {string} taggedMessage the message whole, "tag: text" @param {number} limit
 */
export function compressTask(id, taggedMessage, limit) {
  const { ruler, words } = measure(limit);
  return `${TASK_MARKER} compress message ${id} into one line of at most ${limit} bytes
(about ${words} words), the length of this ruler:
${ruler}
${LANGUAGE}
${KEEP}
<input>
${taggedMessage}
</input>`;
}

/**
 * The task for merging two adjacent lines.
 * @param {{ a: string, b: string, id: number, end: number, lineA: string, lineB: string }} pair
 *   `a`/`b` the lines' names (`id+n`), `id`..`end` the messages they cover, `lineA`/`lineB` the lines as the view shows them
 * @param {number} limit
 */
export function mergeTask({ a, b, id, end, lineA, lineB }, limit) {
  const { ruler, words } = measure(limit);
  return `${TASK_MARKER} merge lines ${a} and ${b}, adjacent, into one line of at most
${limit} bytes (about ${words} words), the length of this ruler:
${ruler}
${LANGUAGE}
${KEEP}
<chat> may hold their messages, ${id} to ${end}, in more detail: take details
of them from there too.
Use only facts present in the lines being merged and in those messages.
<input>
${flat(lineA)}
${flat(lineB)}
</input>`;
}

/** The "Too long" feedback, sent in the same conversation. @param {string} line @param {number} limit */
export function retryTask(line, limit) {
  return `Too long: your line is ${bytes(line)} bytes, over the ${limit}-byte limit. Write
the whole line again for the same <input>, cutting just enough of the
least valuable items to fit before this cut:
${cutBytes(line, limit)}| ← LIMIT`;
}

/** CJK script: Han, kana, Hangul and their compatibility ranges. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/u;

/** Whether `line` uses a CJK script its `source` does not. @param {string} line @param {string} source */
export function inventsScript(line, source) {
  return CJK.test(line) && !CJK.test(source);
}

/** The feedback for a line in a script its messages do not use, sent in the same conversation. */
export function languageTask() {
  return `Wrong language: <input> holds no Chinese, Japanese or Korean text. Write
the whole line again for the same <input>, in the language of its messages.`;
}
