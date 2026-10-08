// The model tools, registered once in the preset scope so the tool list is the
// same on every turn (SEAMS.md §d). Descriptions of zoom and date are the
// OptChat specification's, verbatim.

import { defineTool } from '@deepseek-ai/dsh-tools';
import { RECALL_HITS } from './config.js';
import { dateOf, recallSearch, zoom } from './recall.js';

const NO_MEMORY = 'This conversation has no endless memory to look into.';

/** Every tool answers in plain text. */
const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (/** @type {unknown} */ _args, /** @type {string} */ value) => [{ type: 'text', text: value }],
});

/**
 * @param {any} ctx the plugin's context (`ctx.tools`)
 * @param {{ recallSearch: boolean }} config
 * @param {(session: any) => import('./recall.js').RecallSource | undefined} memoryFor
 */
export function registerTools(ctx, config, memoryFor) {
  /** @param {any} exec */
  const memoryOf = (exec) => memoryFor(exec?.agent?.session);

  ctx.tools.register(defineTool({
    name: 'zoom',
    description: 'Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.',
    parameters: {
      id: { type: 'integer', required: true },
      n: { type: 'integer', required: true },
    },
    output: TEXT_OUTPUT,
    async execute(/** @type {{ id: number, n: number }} */ args, /** @type {any} */ exec) {
      const memory = memoryOf(exec);
      return memory === undefined ? NO_MEMORY : zoom(memory, args.id, args.n);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'date',
    description: 'The date and time of message id.',
    parameters: { id: { type: 'integer', required: true } },
    output: TEXT_OUTPUT,
    async execute(/** @type {{ id: number }} */ args, /** @type {any} */ exec) {
      const memory = memoryOf(exec);
      return memory === undefined ? NO_MEMORY : dateOf(memory, args.id);
    },
  }));

  if (!config.recallSearch) return;
  ctx.tools.register(defineTool({
    name: 'recall_search',
    description: 'Search every message ever written, word for word, for a phrase (case-insensitive) or a /regex/flags. ' +
      `Returns up to ${RECALL_HITS} hits, newest first, as id|kind|date|snippet; zoom(id, 1) opens one.`,
    parameters: { query: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    async execute(/** @type {{ query: string }} */ args, /** @type {any} */ exec) {
      const memory = memoryOf(exec);
      return memory === undefined ? NO_MEMORY : recallSearch(memory, args.query);
    },
  }));
}
