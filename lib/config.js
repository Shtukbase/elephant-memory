// Every number and switch of the plugin, in one place.
//
// The constants follow the UniiChat specification (the OptChat gist, rewritten
// 2026-10-08), except TRACE_CAP and RECALL_HITS, which belong to this plugin's
// deviations (README, "Deviations from the specification"):
// https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

import { PACKAGE_NAME } from './identity.js';

/** Compactor calls running at once. */
export const JOBS = 8;
/** A message's line starts once fewer than this many lines before it are still unbuilt. */
export const UNBUILT_AHEAD = 8;
/** Attempts per summary line to get under the line budget; the shortest wins. */
export const TRIES = 3;
/**
 * A try up to this many times the line limit counts as fitting: no retry and
 * no cut. In a 201-turn trial run 27.5% of lines ended over 512 bytes, the
 * 90th percentile at 610; a hard cut would have dropped the tail of a quarter
 * of the memory.
 */
export const LINE_TOLERANCE = 1.25;
/**
 * A try past the tolerance gets a "Too long" retry that asks for this fraction
 * of the line limit, with its cut mark drawn there. At the true limit the
 * retries barely shrank: in a 235-turn run on deepseek-flash 66% of new lines
 * were over 512 bytes and 29% fit in no try even at 640. Models overshoot a
 * stated length by up to ~1.25x (p90 610 at 512), so at 0.75 a retry that
 * overshoots by even 1.67x (0.75 * 1.67 = 1.25) still fits, while its usual
 * landing (about 384 to 480) keeps most of the content.
 */
export const RETRY_TARGET = 0.75;
/** Wait before a failed line is tried again. No back-off: the next turn waits on it. */
export const RETRY_MS = 10_000;
/**
 * The summary writer's reasoning effort when none is configured: the lowest
 * the DeepSeek adapter accepts ("off", `dsh-llm-deepseek`, efforts off / low /
 * high / max). Without it the adapter thinks at "high": a 12-turn trial run
 * measured a median 8.8k output tokens per summary and turns waiting 120 s for
 * them.
 */
export const WRITER_EFFORT = 'off';
/** Characters of one tool result kept in the history, head and tail. */
export const RESULT_CAP = 30_000;
/** Characters of one message; any longer text that is not tool output goes over several messages in a row, never cut. */
export const MESSAGE_CAP = 30_000;
/** Characters of one turn's trace (granularity `turn`), head and tail. */
export const TRACE_CAP = 60_000;
/** How long a turn waits for the summary lines before it is refused. */
export const SETTLE_TIMEOUT_MS = 180_000;
/** Most hits `recall_search` returns. */
export const RECALL_HITS = 20;
/**
 * The longest one `recall_search` over a /pattern/ may run. A pattern can take
 * exponential time (`/(a+)+$/`), and the search runs on the harness's own
 * thread, so a pattern search is stopped at this limit.
 */
export const RECALL_PATTERN_MS = 2_000;
/** Where the plugin's system-prompt section sits: after first-party guidance, before the persona suffix (10200). */
export const PROMPT_ORDER = 10_100;
/** The history projection's version. Bump it when the projection rules change, so old trees are not reused. */
export const PROJECTION_VERSION = 1;
/** Smallest chat-model context window that runs endless memory (guard.js). */
export const MIN_CONTEXT_TOKENS = 65_536;
/** Default and largest page of `endless.history`, in turns. */
export const HISTORY_PAGE = 50;
export const HISTORY_PAGE_MAX = 200;
/** A page of `endless.history` stops before this many bytes of text, keeping at least one turn. */
export const HISTORY_PAGE_BYTES = 2_000_000;
/** Default and largest number of `endless.search` hits. */
export const SEARCH_HITS = 20;
export const SEARCH_HITS_MAX = 50;

export const DEFAULTS = Object.freeze({
  agentName: 'Assistant',
  you: 'you',
  viewBytes: 128_000,
  viewFloorBytes: 64_000,
  lineBytes: 512,
  granularity: 'turn',
  writer: Object.freeze({ model: '', reasoningEffort: WRITER_EFFORT }),
  recallSearch: true,
  root: '',
  contextKinds: Object.freeze([]),
});

const GRANULARITIES = new Set(['turn', 'step']);

/** @param {unknown} value */
function isName(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\r\n:]/.test(value);
}

/** A list of message source kinds, each a plain word, none repeated. @param {unknown} value */
function isKindList(value) {
  return Array.isArray(value) && new Set(value).size === value.length &&
    value.every((kind) => typeof kind === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(kind));
}

/** @param {unknown} value @param {number} min */
function isWhole(value, min) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= min;
}

/**
 * The plugin's configuration with every default applied. Unknown keys are
 * ignored; a present but invalid value throws, naming the key, so a typo in a
 * patch file is loud rather than silently replaced by a default.
 * @param {Record<string, unknown>} [input]
 */
export function resolveConfig(input = {}) {
  /** @param {string} key @param {(value: unknown) => boolean} valid @param {unknown} fallback */
  const take = (key, valid, fallback) => {
    const value = input[key];
    if (value === undefined || value === null || value === '') return fallback;
    if (!valid(value)) throw new TypeError(`[ENDLESS_CONFIG] ${PACKAGE_NAME}: "${key}" has an invalid value`);
    return value;
  };
  const lineBytes = /** @type {number} */ (take('lineBytes', (v) => isWhole(v, 64), DEFAULTS.lineBytes));
  const viewBytes = /** @type {number} */ (take('viewBytes', (v) => isWhole(v, lineBytes * 8), DEFAULTS.viewBytes));
  // Absent, the floor is half the ceiling (64,000 of the default 128,000).
  const viewFloorBytes = /** @type {number} */ (take('viewFloorBytes', (v) => isWhole(v, lineBytes * 4) && /** @type {number} */ (v) < viewBytes, Math.floor(viewBytes / 2)));
  const writerInput = /** @type {Record<string, unknown>} */ (take('writer', (v) => typeof v === 'object' && !Array.isArray(v), {}));
  const writerModel = writerInput.model ?? '';
  const writerEffort = writerInput.reasoningEffort ?? '';
  if (typeof writerModel !== 'string' || typeof writerEffort !== 'string') {
    throw new TypeError(`[ENDLESS_CONFIG] ${PACKAGE_NAME}: "writer" takes only the strings "model" and "reasoningEffort"`);
  }
  if (Object.hasOwn(writerInput, 'provider')) {
    throw new TypeError(`[ENDLESS_CONFIG] ${PACKAGE_NAME}: "writer.provider" is not accepted; summaries always use the conversation's own provider`);
  }
  return Object.freeze({
    agentName: /** @type {string} */ (take('agentName', isName, DEFAULTS.agentName)).trim(),
    you: /** @type {string} */ (take('you', isName, DEFAULTS.you)).trim(),
    viewBytes,
    viewFloorBytes,
    lineBytes,
    granularity: /** @type {'turn' | 'step'} */ (take('granularity', (v) => GRANULARITIES.has(/** @type {string} */ (v)), DEFAULTS.granularity)),
    writer: Object.freeze({ model: writerModel.trim(), reasoningEffort: writerEffort.trim() === '' ? WRITER_EFFORT : writerEffort.trim() }),
    recallSearch: /** @type {boolean} */ (take('recallSearch', (v) => typeof v === 'boolean', DEFAULTS.recallSearch)),
    root: /** @type {string} */ (take('root', (v) => typeof v === 'string', DEFAULTS.root)),
    contextKinds: Object.freeze([.../** @type {string[]} */ (take('contextKinds', isKindList, DEFAULTS.contextKinds))]),
  });
}
