/**
 * THE PAGE'S READS OF THE MEMORY, through the harness's own authenticated
 * connection (`ctx.connection.rpc.call('/api', …)`, the carrier the harness's
 * own methods travel), to the routes of lib/browser-routes.js. Nothing here
 * keeps what it read.
 */

/** Read at call time: the connection may arrive after this module is applied. */
let readConnection = () => undefined;

const READ_FAILED = 'The history could not be read. Try again.';

/** @param {unknown} error */
function sentence(error) {
  return error instanceof Error && error.message.trim() !== '' ? error.message : READ_FAILED;
}

/**
 * @param {string} name the read's short name, `history`
 * @param {Record<string, unknown>} args
 * @param {AbortSignal} [signal]
 */
async function askMemory(name, args, signal) {
  const connection = readConnection();
  if (connection === undefined || connection === null) throw new Error('The history is not available here.');
  let result;
  try {
    result = await connection.rpc.call('/api', `${UI_PREFIX}${name}`, { args }, signal);
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw error;
    throw new Error(READ_FAILED);
  }
  if (result !== undefined && result.ok === true) return result.value;
  throw new Error(result !== undefined && result.error && typeof result.error.message === 'string' && result.error.message !== '' ? result.error.message : READ_FAILED);
}

/** The five questions the History view asks of one memory. */
const memoryPort = {
  memories: (signal) => askMemory('memories', {}, signal),
  history: (memoryId, before, signal) => askMemory('history', { memoryId, limit: PAGE_TURNS, ...(before === undefined ? {} : { before }) }, signal),
  view: (memoryId, signal) => askMemory('view', { memoryId }, signal),
  zoom: (memoryId, id, n, signal) => askMemory('zoom', { memoryId, id, n }, signal),
  search: (memoryId, query, signal) => askMemory('search', { memoryId, query }, signal),
};
