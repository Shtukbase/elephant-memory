// The summary writer's task when one call writes several lines (writer-calls.js,
// README deviation 20). Each job is the specification's own compress or merge
// task (prompts.js), whole — ruler, language sentence, KEEP and <input> — with
// its marker moved to the head of the message, which names every job, so the
// call still opens with "Compaction:" followed by "compress message" or "merge
// lines". Each line comes back in a tag of its own, so every job is read,
// judged and stored alone. A job asked again is asked alone, in the same
// conversation, with the per-line feedback ("Too long", "Wrong language") or
// `missingTask`.

import { TASK_MARKER } from './prompts.js';

/** What a single task does, from its first line: "compress message 5" or "merge lines 0+1 and 1+1". */
const WHAT = /^Compaction: (compress message \d+|merge lines [^\s,]+ and [^\s,]+)/;

/** The form the reply takes, for the job numbers `ids`, each naming its byte limit. @param {readonly number[]} ids @param {number} limit */
function form(ids, limit) {
  return ids.map((id) => `<line id="${id}">job ${id}'s line, at most ${limit} bytes</line>`).join('\n');
}

/**
 * One call's task for several lines; job k (from 1) is `tasks[k - 1]`.
 * @param {readonly string[]} tasks each a compressTask or a mergeTask, at `limit`
 * @param {number} limit the bytes each line may take, named in each reply tag
 */
export function batchTask(tasks, limit) {
  const what = tasks.map((task) => WHAT.exec(task)?.[1] ?? task.split('\n')[0]);
  const ids = tasks.map((_, k) => k + 1);
  const jobs = tasks.map((task, k) => `<job id="${k + 1}">\n${task.slice(task.startsWith(TASK_MARKER) ? TASK_MARKER.length + 1 : 0)}\n</job>`);
  return `${TASK_MARKER} ${what.join('; ')}.
These are ${tasks.length} jobs. Do each one as if it were sent alone, and answer
all of them in one reply, each line inside its own tag, and nothing else:
${form(ids, limit)}

${jobs.join('\n\n')}`;
}

/** The feedback for a job whose line did not come back. @param {number} id */
export function missingTask(id) {
  return `Missing: your reply held no <line id="${id}">.`;
}

/**
 * A retry for one job, in the batched call's conversation: its per-line
 * feedback ("Too long", "Wrong language" or `missingTask`), then its tag alone.
 * @param {number} id @param {string} feedback
 */
export function jobRetryTask(id, feedback) {
  return `Job ${id} only. ${feedback}
Answer with that one line inside its tag, and nothing else:
<line id="${id}">job ${id}'s line</line>`;
}

/** A tagged line: `<line id="3">…</line>`, quotes optional. */
const LINE = /<line\s+id\s*=\s*["']?(\d+)["']?\s*>([\s\S]*?)<\/line\s*>/gi;

/**
 * The lines a reply holds, by job number; the first of a repeated number wins.
 * @param {string} text @returns {Map<number, string>}
 */
export function replyLines(text) {
  /** @type {Map<number, string>} */
  const lines = new Map();
  for (const [, id, line] of text.matchAll(LINE)) {
    if (!lines.has(Number(id))) lines.set(Number(id), line);
  }
  return lines;
}
