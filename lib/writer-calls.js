// What one writer call does (the writer, writer.js, decides which nodes): one
// line, or several (README, deviation 20).
//
// One line (`buildLine`): at most TRIES calls. Every try loses the `id+n|`
// heads it copied from the view (stripHeads) before it is measured or stored. A
// try in a CJK script its sources do not use is invalid ("Wrong language"
// feedback). A valid try fits up to LINE_TOLERANCE times the limit; one past
// that gets the spec's "Too long" feedback with its cut mark at RETRY_TARGET
// times the limit, so the next try lands under the tolerance. The shortest valid
// try wins; when none fits it is trimmed at a word boundary to the tolerance
// (counted in `trimmed`). With no valid try at all the node fails and is tried
// again later.
//
// Several lines (`buildBatch`, README deviation 20): the jobs packed together,
// up to `writer.batch`, in one call.
//   - The context is the longest of the jobs' own contexts (writer-input.js):
//     each job's context is a prefix of it, and it stops at the first unbuilt
//     line, so the call still sees built lines only.
//   - The task is every job's own compress or merge task, numbered
//     (batch-prompts.js), each aimed at RETRY_TARGET of the limit (384 of 512
//     bytes): ruler, "at most" and the reply tag all name it. A live run asked
//     for the full limit and 81% of first tries came back past the tolerance.
//   - Each job is judged alone, exactly as a one-line call judges its try:
//     heads stripped, the CJK guard, the 1.25× tolerance of the true limit. A
//     job that fits is stored at once, so its parent can start.
//   - Each other job is asked again alone, in the same conversation, so the
//     model sees what it wrote: the per-line feedback ("Too long" with its cut
//     mark at RETRY_TARGET, "Wrong language", or "Missing"). The same live run
//     carried such a job into a new call with the feedback only, and 64% of
//     those retries were still too long. A job gets TRIES tries in all; then its
//     shortest valid try is kept and trimmed when none fits, as for one line. A
//     job with no valid try, or in a call that failed, fails and waits to be
//     tried again (writer.js).

import { LINE_TOLERANCE, RETRY_TARGET, TRIES } from './config.js';
import { batchTask, jobRetryTask, missingTask, replyLines } from './batch-prompts.js';
import { inventsScript, languageTask, retryTask } from './prompts.js';
import { bytes, stripHeads, trimLine } from './text.js';
import { nodeContext, nodeSource, nodeTask } from './writer-input.js';

/** @typedef {import('./writer.js').Writer} Writer */
/** @typedef {import('./writer.js').WriterTurn} WriterTurn */
/** @typedef {{ l: number, i: number }} Job */
/** A job of a batched call. @typedef {Job & { id: number, source: string, valid: string[] }} BatchJob */

/** One line, by up to TRIES calls in one conversation. @param {Writer} writer @param {number} l @param {number} i */
export async function buildLine(writer, l, i) {
  const { host } = writer;
  const fits = Math.floor(host.lineBytes * LINE_TOLERANCE);
  const retryAt = Math.max(1, Math.floor(host.lineBytes * RETRY_TARGET));
  const source = nodeSource(host, l, i);
  // The view first, so consecutive writer calls share a cached prefix.
  /** @type {WriterTurn[]} */
  const turns = [{ role: 'user', texts: [nodeContext(host, l, i), nodeTask(host, l, i)] }];
  /** @type {string[]} */
  const valid = [];
  for (let tries = 1; ; tries++) {
    const answer = await writer.call(turns);
    if (writer.abort.signal.aborted) throw new Error('the memory was closed');
    const line = stripHeads(answer.text);
    if (line === '') throw new Error('the summary came back empty');
    const foreign = inventsScript(line, source);
    if (!foreign) valid.push(line);
    if ((!foreign && bytes(line) <= fits) || tries >= TRIES) break;
    turns.push({ role: 'assistant', message: answer.message }, { role: 'user', texts: [foreign ? languageTask() : retryTask(line, retryAt)] });
  }
  keep(writer, l, i, valid, 'every try was written in a script its messages do not use');
}

/**
 * Store the shortest valid try, trimmed and counted when it is past the
 * tolerance; throw `none` when there is no valid try.
 * @param {Writer} writer @param {number} l @param {number} i @param {readonly string[]} valid @param {string} none
 */
function keep(writer, l, i, valid, none) {
  const { tree, lineBytes } = writer.host;
  const fits = Math.floor(lineBytes * LINE_TOLERANCE);
  if (valid.length === 0) throw new Error(none);
  let best = valid.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
  if (bytes(best) > fits) {
    best = trimLine(best, fits);
    writer.trimmed++;
    writer.host.warn(`[ENDLESS_WRITER] line ${l}:${i} fit in no try and was trimmed to ${bytes(best)} bytes; ${writer.trimmed} lines trimmed since the memory opened`);
  }
  if (!tree.built(l, i)) writer.save(l, i, best);
}

/**
 * One call for `jobs` (two or more), then a retry alone, in the same
 * conversation, for each job that did not fit. Every job ends stored and done,
 * or failed. Never rejects.
 * @param {Writer} writer @param {readonly Job[]} jobs
 */
export async function buildBatch(writer, jobs) {
  const { host } = writer;
  const aim = Math.max(1, Math.floor(host.lineBytes * RETRY_TARGET));
  /** @type {BatchJob[]} */
  const open = jobs.map(({ l, i }, k) => ({ l, i, id: k + 1, source: '', valid: [] }));
  /** @type {WriterTurn[]} */
  let turns;
  let answer;
  try {
    for (const job of open) job.source = nodeSource(host, job.l, job.i);
    const context = jobs.map(({ l, i }) => nodeContext(host, l, i)).reduce((a, b) => (b.length > a.length ? b : a));
    // The view first, so consecutive writer calls share a cached prefix.
    turns = [{ role: 'user', texts: [context, batchTask(jobs.map(({ l, i }) => nodeTask(host, l, i, aim)), aim)] }];
    answer = await writer.call(turns);
    if (writer.abort.signal.aborted) throw new Error('the memory was closed');
  } catch (error) {
    writer.fail(jobs, error);
    return;
  }
  const lines = replyLines(answer.text);
  /** @type {BatchJob[]} */
  const fitted = [];
  /** @type {{ job: BatchJob, feedback: string }[]} */
  const again = [];
  const seen = { missing: 0, foreign: 0, over: 0 };
  for (const job of open) {
    const verdict = judge(writer, job, lines.get(job.id) ?? '');
    if (verdict.kind === 'fit') fitted.push(job);
    else {
      seen[verdict.kind]++;
      again.push({ job, feedback: verdict.feedback });
    }
  }
  // One line per batched call, for measuring a live run (README, deviation 20).
  host.info?.(`[ENDLESS_WRITER_BATCH] ${JSON.stringify({ jobs: jobs.length, tagged: lines.size, ...seen })}`);
  settle(writer, fitted);
  const replied = [...turns, { role: 'assistant', message: answer.message }];
  await Promise.all(again.map(({ job, feedback }) => retryAlone(writer, replied, job, feedback)));
}

/**
 * A job's try: kept when valid, and null feedback when it also fits.
 * @param {Writer} writer @param {BatchJob} job @param {string} text
 * @returns {{ feedback: null, kind: 'fit' } | { feedback: string, kind: 'missing' | 'foreign' | 'over' }}
 */
function judge(writer, job, text) {
  const fits = Math.floor(writer.host.lineBytes * LINE_TOLERANCE);
  const retryAt = Math.max(1, Math.floor(writer.host.lineBytes * RETRY_TARGET));
  const line = stripHeads(text);
  if (line === '') return { feedback: missingTask(job.id), kind: 'missing' };
  if (inventsScript(line, job.source)) return { feedback: languageTask(), kind: 'foreign' };
  job.valid.push(line);
  return bytes(line) <= fits ? { feedback: null, kind: 'fit' } : { feedback: retryTask(line, retryAt), kind: 'over' };
}

/**
 * Up to TRIES - 1 more tries for one job, each a follow-up of the batched call
 * that asked for it, then its best try is kept, or the job fails.
 * @param {Writer} writer @param {readonly WriterTurn[]} replied the batched call and its reply
 * @param {BatchJob} job @param {string} feedback
 */
async function retryAlone(writer, replied, job, feedback) {
  const turns = [...replied];
  try {
    for (let tries = 2; tries <= TRIES; tries++) {
      turns.push({ role: 'user', texts: [jobRetryTask(job.id, feedback)] });
      const answer = await writer.call(turns);
      if (writer.abort.signal.aborted) throw new Error('the memory was closed');
      // A reply to one job may leave out its tag: then the whole reply is the line.
      const verdict = judge(writer, job, replyLines(answer.text).get(job.id) ?? answer.text.replace(/<\/?line[^>]*>/g, ''));
      writer.host.info?.(`[ENDLESS_WRITER_BATCH] ${JSON.stringify({ retry: tries, result: verdict.kind })}`);
      if (verdict.kind === 'fit') break;
      feedback = verdict.feedback;
      turns.push({ role: 'assistant', message: answer.message });
    }
  } catch (error) {
    writer.fail([job], error);
    return;
  }
  settle(writer, [job]);
}

/**
 * Keep each job's best try, or fail the jobs that have none (together, by
 * error); pump once when any was stored.
 * @param {Writer} writer @param {readonly BatchJob[]} jobs
 */
function settle(writer, jobs) {
  /** @type {Map<string, BatchJob[]>} */
  const failed = new Map();
  let stored = 0;
  for (const job of jobs) {
    try {
      keep(writer, job.l, job.i, job.valid, 'no try came back as a line in a script its messages use');
      writer.done(job, false);
      stored++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.set(message, [...(failed.get(message) ?? []), job]);
    }
  }
  for (const [message, group] of failed) writer.fail(group, new Error(message));
  if (stored > 0) writer.pump();
}
