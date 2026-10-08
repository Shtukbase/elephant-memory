// The reads of the seam methods, for the harness's OWN page.
//
// The routes of routes.js refuse a request that carries an `Origin` header:
// they are for a host process on this computer, never for a browser page, and
// they check nothing else about who asks. A page of the harness's web UI always
// carries one, and must not be answered there. So the page has routes of its
// own, `POST /api/endless-ui.<name>`, registered on the harness's connection
// service (`ctx.connection.fetch.register`, the seat the harness's own file,
// upload and export routes use). The connection serves them behind its fence:
// the Host/Origin check and the signed browser-session cookie. Only the reads
// are offered; `bind` is a host's call.
//
// Body and answer are the harness's Remote envelope, as in routes.js, so the
// page calls them with its own `connection.rpc.call('/api', 'endless-ui.view', {args})`.
// Like the harness's own Remote handler, a body that is not
// `application/json` is refused (415), and so is one over 64 KiB (400); the
// connection has already capped the body before this runs.

import { EndlessRefusal } from './api.js';

/** The reads a page may ask, by their short names. */
export const BROWSER_METHODS = Object.freeze(['memories', 'view', 'zoom', 'history', 'search']);

/** The prefix of a page route's endpoint. */
export const BROWSER_PREFIX = 'endless-ui.';

const MAX_BODY_BYTES = 65_536;

/**
 * @param {unknown} value @param {number} status
 * @returns {Response}
 */
function reply(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/**
 * Answer one page call. Exported for the tests, which drive it without a server.
 * @param {string} method the endpoint, `endless-ui.<name>`
 * @param {(args: Record<string, unknown>) => unknown} run the read
 * @param {Request} request
 * @param {{ warn(message: string): void }} log
 * @returns {Promise<Response>}
 */
export async function handleBrowserCall(method, run, request, log) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return reply({ error: 'The request must be JSON.' }, 415);
  }
  /** @type {any} */
  let envelope;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('too large');
    envelope = JSON.parse(body);
  } catch {
    return reply({ error: 'The request is not readable.' }, 400);
  }
  if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== method) {
    return reply({ error: 'The request is not readable.' }, 400);
  }
  const answer = (/** @type {unknown} */ result) => reply({ type: 'server-response', rpcId: envelope.rpcId, result });
  const args = envelope.payload?.args;
  try {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new EndlessRefusal('endless/bad-request', 'The request has no arguments.');
    return answer({ ok: true, value: run(args) });
  } catch (error) {
    if (error instanceof EndlessRefusal) return answer({ ok: false, error: { code: error.code, message: error.message, details: {} } });
    log.warn(`[ENDLESS_API] ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
    return answer({ ok: false, error: { code: 'endless/failed', message: 'The memory could not be read. Try again.', details: {} } });
  }
}

/**
 * @typedef {object} Connection
 * @property {{ register(route: { path: string, methods: string[], requestBody: 'buffered', fetch(request: Request): Promise<Response> }): unknown }} fetch
 */

/**
 * Register the page's reads. A path another engine of this process already
 * serves is left to it: every engine reads the same files.
 * @param {Connection} connection
 * @param {Record<string, (args: Record<string, unknown>) => unknown>} methods the seam methods by their `endless.<name>`
 * @param {{ warn(message: string): void, info?(message: string): void }} log
 */
export function installBrowserRoutes(connection, methods, log) {
  for (const name of BROWSER_METHODS) {
    const run = methods[`endless.${name}`];
    const path = `/api/${BROWSER_PREFIX}${name}`;
    try {
      connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleBrowserCall(`${BROWSER_PREFIX}${name}`, run, request, log),
      });
    } catch (error) {
      log.info?.(`[ENDLESS_API] ${path} is already served: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
