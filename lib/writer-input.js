// What one summary call reads (UniiChat spec §4), for the writer (writer.js):
// the node's source, its context and its task. Pure: the tree and the
// compaction view come from the writer's host.
//
//   - A node's source is its message, tagged, or its two halves' lines.
//   - Its context is the compaction view up to the node — the lines before the
//     message, or for a merge the lines up to its last message — stopping at the
//     first unbuilt line, so no call ever sees a placeholder or half a message.
//   - Its task is the specification's compress or merge task (prompts.js).

import { compressTask, mergeTask } from './prompts.js';
import { chatBlock, countOf, lineOf, startOf } from './view.js';

/** @typedef {import('./writer.js').WriterHost} WriterHost */

/** What a node summarizes, as the writer reads it. @param {WriterHost} host @param {number} l @param {number} i */
export function nodeSource(host, l, i) {
  const { entries, tree } = host;
  return l === 0 ? host.tagged(entries[i]) : `${tree.text(l - 1, 2 * i)}\n${tree.text(l - 1, 2 * i + 1)}`;
}

/**
 * The compaction view up to the node, as `id+n|text` lines, stopping at the
 * first unbuilt line.
 * @param {WriterHost} host @param {number} l @param {number} i
 */
export function nodeContext(host, l, i) {
  const { compactionView, tree } = host;
  const end = l === 0 ? i : (i + 1) * 2 ** l;
  const lines = [];
  for (const part of compactionView.parts) {
    if (startOf(part) >= end || !tree.built(part.l, part.i)) break;
    lines.push(lineOf(part, tree.text(part.l, part.i)));
  }
  return chatBlock(lines);
}

/**
 * The node's task message, at the line limit or, for a batched first try, a lower aim.
 * @param {WriterHost} host @param {number} l @param {number} i @param {number} [limit]
 */
export function nodeTask(host, l, i, limit = host.lineBytes) {
  const { entries, tree } = host;
  if (l === 0) return compressTask(i, host.tagged(entries[i]), limit);
  const a = { l: l - 1, i: 2 * i };
  const b = { l: l - 1, i: 2 * i + 1 };
  return mergeTask({
    a: `${startOf(a)}+${countOf(a)}`,
    b: `${startOf(b)}+${countOf(b)}`,
    id: startOf(a),
    end: startOf(b) + countOf(b) - 1,
    lineA: lineOf(a, tree.text(a.l, a.i)),
    lineB: lineOf(b, tree.text(b.l, b.i)),
  }, limit);
}
