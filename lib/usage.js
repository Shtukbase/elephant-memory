// What the summary writer spends: one structured log line per model call, and
// a running total per memory, kept durable beside it.
//
//   usage.jsonl   one line per writer call: {at, provider, model, cacheRead, miss, output}
//
// `cacheRead` is the provider's prefix-cache hit, `miss` the rest of the
// prompt (the adapter's `inputTokens`), `output` the reply. A call whose
// adapter reported nothing is still one line, with null numbers.

import path from 'node:path';
import { appendDurable, readJsonl } from './store.js';

/** @typedef {{ provider: string, model: string, cacheRead: number | null, miss: number | null, output: number | null }} CallUsage */
/** @typedef {{ calls: number, cacheRead: number, miss: number, output: number }} UsageTotals */

/** @param {unknown} value */
const count = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null);

/**
 * One call's usage from the adapter's numbers (`BlockAssembler.usage`).
 * @param {{ provider: string, model: string }} route
 * @param {{ inputTokens?: unknown, cacheReadTokens?: unknown, outputTokens?: unknown } | undefined} usage
 * @returns {CallUsage}
 */
export function callUsage(route, usage) {
  return {
    provider: route.provider,
    model: route.model,
    cacheRead: usage === undefined ? null : (count(usage.cacheReadTokens) ?? 0),
    miss: usage === undefined ? null : count(usage.inputTokens),
    output: usage === undefined ? null : count(usage.outputTokens),
  };
}

/** The log line of one call. @param {string} memoryId @param {CallUsage} usage */
export function usageLine(memoryId, usage) {
  return `[ENDLESS_WRITER_USAGE] ${JSON.stringify({ memoryId, ...usage })}`;
}

/** @returns {UsageTotals} */
export const noUsage = () => ({ calls: 0, cacheRead: 0, miss: 0, output: 0 });

/** @param {UsageTotals} totals @param {Partial<CallUsage>} usage */
function add(totals, usage) {
  totals.calls += 1;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.miss += usage.miss ?? 0;
  totals.output += usage.output ?? 0;
}

/** @param {string} dir */
const usageFile = (dir) => path.join(dir, 'usage.jsonl');

/**
 * The running total of one memory folder, read without writing.
 * @param {string} dir @param {{ warn(message: string): void }} log
 */
export function readUsage(dir, log) {
  const totals = noUsage();
  for (const value of readJsonl(usageFile(dir), log, false)) {
    if (typeof value === 'object' && value !== null) add(totals, /** @type {Partial<CallUsage>} */ (value));
  }
  return totals;
}

export class UsageLog {
  /** @param {string} memoryId @param {string} dir @param {{ warn(message: string): void, info?(message: string): void }} log */
  constructor(memoryId, dir, log) {
    this.memoryId = memoryId;
    this.dir = dir;
    this.log = log;
    this.totals = readUsage(dir, log);
  }

  /** Record one writer call: the log line, the durable line, the total. @param {CallUsage} usage */
  record(usage) {
    this.log.info?.(usageLine(this.memoryId, usage));
    add(this.totals, usage);
    try {
      appendDurable(usageFile(this.dir), `${JSON.stringify({ at: Date.now(), ...usage })}\n`);
    } catch (error) {
      this.log.warn(`[ENDLESS_WRITER_USAGE] ${this.memoryId}: the usage line was not stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
