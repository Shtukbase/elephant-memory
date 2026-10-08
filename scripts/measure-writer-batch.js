// Calls per tree node with and without batched writer calls (README, deviation
// 20), on one synthetic 300-message history and a deterministic fake model.
//
//   node scripts/measure-writer-batch.js [batch ...]   (default: 1 6)
//
// 100 turns of three messages (the person, a trace, the reply), sizes from a
// seeded generator. Each turn waits for its view to be summarized, as a real
// turn does. The fake model decides each line from a hash of its job and try:
// on a first try 62% fit, 30% run past 1.25× the limit, 5% come back in an
// invented CJK script, and in a batched call 3% are left out; a retry follows
// the cut mark, 5% still too long. A batched job asked again is a follow-up call
// in its batch's conversation. Memories go under test/.runs, removed after.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../lib/config.js';
import { Memory } from '../lib/memory.js';

const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', '.runs');

/** A seeded generator in [0, 1). @param {number} seed */
function random(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [0, 1) from a text. @param {string} text */
const hash = (text) => createHash('sha256').update(text).digest().readUInt32BE(0) / 4294967296;

const words = (/** @type {number} */ bytes) => 'word '.repeat(Math.ceil(bytes / 5)).slice(0, bytes).trim();

/** The fake model's line for one job on one try. @param {string} job @param {number} round @param {boolean} batched */
function lineFor(job, round, batched) {
  const r = hash(`${job}\n${round}`);
  if (round === 1) {
    if (r < 0.62) return words(300 + Math.floor(r * 500));
    if (r < 0.92) return words(700 + Math.floor(r * 200));
    if (r < 0.97 || !batched) return `发布说明 ${words(200)}`;
    return null;
  }
  return r < 0.95 ? words(300 + Math.floor(r * 150)) : words(700);
}

/** A summarize that counts its calls. */
function fakeModel() {
  const counts = { calls: 0, jobs: 0, retries: 0 };
  /** @type {import('../lib/writer.js').Summarize} */
  const summarize = async (turns) => {
    counts.calls++;
    const task = /** @type {{ texts: string[] }} */ (turns[0]).texts[1];
    const round = turns.filter((turn) => turn.role === 'assistant').length + 1;
    const jobs = [...task.matchAll(/<job id="(\d+)">\n([\s\S]*?)\n<\/job>/g)].map((match) => ({ id: Number(match[1]), text: match[2] }));
    if (jobs.length === 0) {
      if (round === 1) counts.jobs++;
      else counts.retries++;
      return { text: lineFor(task, round, false) ?? '', message: { round } };
    }
    if (round === 1) {
      counts.jobs += jobs.length;
      const text = jobs.map((job) => {
        const line = lineFor(job.text, 1, true);
        return line === null ? '' : `<line id="${job.id}">${line}</line>`;
      }).join('\n');
      return { text, message: { round } };
    }
    // A retry asks for one job alone, in the batched call's conversation.
    counts.retries++;
    const last = /** @type {{ texts: string[] }} */ (turns.at(-1)).texts[0];
    const id = Number(/^Job (\d+) only\./.exec(last)?.[1]);
    const job = jobs.find((x) => x.id === id);
    const text = `<line id="${id}">${lineFor(job?.text ?? last, round, true) ?? ''}</line>`;
    return { text, message: { round } };
  };
  return { counts, summarize };
}

/** One run over the synthetic history with `batch` lines per call at most. @param {number} batch */
async function run(batch) {
  fs.mkdirSync(RUNS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(RUNS, 'measure-'));
  const { counts, summarize } = fakeModel();
  const log = { warn: () => {}, info: () => {} };
  const memory = new Memory({ memoryId: '0123456789abcdef', key: { agent: 'scout', project: '/board' }, dir, config: resolveConfig({ writer: { batch } }), summarize, log });
  let nodes = 0;
  const save = memory.writer.save.bind(memory.writer);
  memory.writer.save = (l, i, text) => {
    save(l, i, text);
    nodes++;
  };
  const next = random(20261008);
  const size = (/** @type {number} */ low, /** @type {number} */ high) => low + Math.floor(next() * (high - low));
  try {
    for (let turn = 1; turn <= 100; turn++) {
      const at = 1_760_000_000_000 + turn * 60_000;
      memory.appendTurn({
        sessionId: 's1',
        sessionTitle: 'Chat',
        turn,
        at,
        entries: [['user', size(80, 1500)], ['tool', size(300, 5000)], ['talk', size(150, 1200)]].map(([kind, bytes], k) => ({ kind, text: `t${turn}.${k} ${words(/** @type {number} */ (bytes))}`, time: at + k })),
      });
      if (!(await memory.settle(undefined, 60_000))) throw new Error(`turn ${turn} waited too long`);
    }
    // The merges the last turns made ready.
    // A failed line waits RETRY_MS (10 s) before it is tried again.
    const idle = () => memory.writer.busy.size === 0 && memory.writer.calls === 0;
    for (let k = 0; k < 1_200 && !idle(); k++) await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.rmdirSync(RUNS);
    } catch {
      // Another run's folder is still there.
    }
  }
  return { batch, messages: memory.size, nodes, modelNodes: counts.jobs, retries: counts.retries, calls: counts.calls, trimmed: memory.writer.trimmed, failed: memory.writer.failed.size };
}

const batches = process.argv.slice(2).map(Number);
const results = [];
for (const batch of batches.length > 0 ? batches : [1, 6]) results.push(await run(batch));
for (const r of results) {
  console.log(`batch ${r.batch}: ${r.messages} messages, ${r.nodes} tree nodes (${r.modelNodes} written by the model, ${r.retries} retries), ${r.calls} calls, ${(r.calls / r.nodes).toFixed(2)} calls per node, ${(r.calls / r.modelNodes).toFixed(2)} per model-written node, ${r.trimmed} trimmed`);
}
if (results.length > 1) console.log(`calls: ${results.map((r) => r.calls).join(' -> ')}, ${(100 * (1 - results.at(-1).calls / results[0].calls)).toFixed(1)}% fewer`);
