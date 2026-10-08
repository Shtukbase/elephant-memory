// The seam methods on the harness's own web server, one exact route each,
// `/api/endless.<name>`, in the harness's Remote call envelope, so a host on
// the same machine calls them as it calls the harness's own methods:
//
//   POST {type: 'client-request', rpcId, method, payload: {args}}
//   200  {type: 'server-response', rpcId, result: {ok: true, value} | {ok: false, error: {code, message, details}}}
//
// Only a caller on this computer is answered: loopback peer and Host, POST, no
// Origin (a browser page always sends one, and is never answered here).

import { ENDLESS_METHODS, EndlessRefusal } from './api.js';

/** @typedef {import('node:http').IncomingMessage} Request */
/** @typedef {import('node:http').ServerResponse} Response */
/** @typedef {{ register(route: { kind: 'exact', path: string, handler(request: Request, response: Response): Promise<void> }): () => void }} WebServer */

const MAX_BODY_BYTES = 65_536;

/** @param {Request} request */
export function fromThisComputer(request) {
  if (request.method !== 'POST' || request.headers.origin !== undefined) return false;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress ?? '')) return false;
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${request.headers.host ?? ''}`).hostname);
  } catch {
    return false;
  }
}

/** @param {Request} request @returns {Promise<unknown>} */
async function bodyOf(request) {
  let size = 0;
  /** @type {Buffer[]} */
  const parts = [];
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : /** @type {Buffer} */ (chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    parts.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
}

/** @param {Response} response @param {number} status @param {unknown} value */
function answer(response, status, value) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/**
 * Answer one call. Exported for the tests, which drive it without a server.
 * @param {string} method @param {(args: Record<string, unknown>) => unknown} run
 * @param {Request} request @param {Response} response
 * @param {{ warn(message: string): void }} log
 */
export async function handleCall(method, run, request, response, log) {
  if (!fromThisComputer(request)) return answer(response, 403, { error: 'Only this computer may ask.' });
  /** @type {any} */
  let envelope;
  try {
    envelope = await bodyOf(request);
  } catch {
    return answer(response, 400, { error: 'The request is not readable.' });
  }
  if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== method) {
    return answer(response, 400, { error: 'The request is not readable.' });
  }
  const args = envelope.payload?.args;
  const reply = (/** @type {unknown} */ result) => answer(response, 200, { type: 'server-response', rpcId: envelope.rpcId, result });
  try {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new EndlessRefusal('endless/bad-request', 'The request has no arguments.');
    return reply({ ok: true, value: run(args) });
  } catch (error) {
    if (error instanceof EndlessRefusal) return reply({ ok: false, error: { code: error.code, message: error.message, details: {} } });
    log.warn(`[ENDLESS_API] ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
    return reply({ ok: false, error: { code: 'endless/failed', message: 'The memory could not be read. Try again.', details: {} } });
  }
}

/**
 * Register the six routes; returns their disposer. A route another engine of
 * this process already serves is left to it: every engine reads the same
 * files, and open memories are shared process-wide (registry.js).
 * @param {WebServer} webServer
 * @param {Record<string, (args: Record<string, unknown>) => unknown>} methods
 * @param {{ warn(message: string): void, info?(message: string): void }} log
 */
export function installEndlessRoutes(webServer, methods, log) {
  /** @type {(() => void)[]} */
  const disposers = [];
  for (const method of ENDLESS_METHODS) {
    try {
      disposers.push(webServer.register({ kind: 'exact', path: `/api/${method}`, handler: (request, response) => handleCall(method, methods[method], request, response, log) }));
    } catch (error) {
      log.info?.(`[ENDLESS_API] /api/${method} is already served: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}
