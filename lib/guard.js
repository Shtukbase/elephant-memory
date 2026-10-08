// The model guard: endless memory runs only on a chat
// model whose context window holds at least MIN_CONTEXT_TOKENS. The view
// alone grows to about 30,000 tokens, so a smaller model would be handed more
// than it can read. Below the floor, or when the window is not known, the
// turn proceeds as an ordinary chat: nothing is replaced, and the guard says
// so once per chat and model in the log.

import { MIN_CONTEXT_TOKENS } from './config.js';

/** @typedef {{ provider: string, model: string }} Route */
/** @typedef {(provider: string, model: string, signal?: AbortSignal) => Promise<{ context?: { contextWindow?: number } } | undefined>} ResolveModel */

export class ModelGuard {
  /**
   * @param {object} options
   * @param {ResolveModel} options.resolve `ctx.llm.resolveModelInfo`
   * @param {{ warn(message: string): void }} options.log
   * @param {number} [options.minTokens]
   */
  constructor({ resolve, log, minTokens = MIN_CONTEXT_TOKENS }) {
    this.resolve = resolve;
    this.log = log;
    this.minTokens = minTokens;
    /** Context window per provider/model; null when it is not known. @type {Map<string, number | null>} */
    this.windows = new Map();
    /** Chats already told about a model. @type {Set<string>} */
    this.told = new Set();
  }

  /** @param {Route} route @param {AbortSignal} [signal] */
  async windowOf(route, signal) {
    const name = `${route.provider}/${route.model}`;
    if (this.windows.has(name)) return /** @type {number | null} */ (this.windows.get(name));
    let window = null;
    try {
      const info = await this.resolve(route.provider, route.model, signal);
      const tokens = info?.context?.contextWindow;
      window = Number.isSafeInteger(tokens) ? /** @type {number} */ (tokens) : null;
      this.windows.set(name, window);
    } catch (error) {
      // Not cached: a lookup that failed may succeed at the next turn.
      this.log.warn(`[ENDLESS_GUARD] ${name}: the model's context window could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return window;
  }

  /**
   * Whether this chat's turn may run with endless memory.
   * @param {string} sessionId @param {Route | undefined} route @param {AbortSignal} [signal]
   */
  async allows(sessionId, route, signal) {
    if (route === undefined || route.provider === '' || route.model === '') {
      this.once(sessionId, 'no model', 'the chat names no model yet');
      return false;
    }
    const window = await this.windowOf(route, signal);
    if (window !== null && window >= this.minTokens) return true;
    const name = `${route.provider}/${route.model}`;
    this.once(sessionId, name, window === null
      ? `${name} does not state its context window`
      : `${name} has a ${window}-token context window, below ${this.minTokens}`);
    return false;
  }

  /** @param {string} sessionId @param {string} name @param {string} why */
  once(sessionId, name, why) {
    const key = `${sessionId}\n${name}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    this.log.warn(`[ENDLESS_GUARD] ${sessionId}: ${why}; this chat runs without endless memory`);
  }
}

/** The route a turn runs on, from the agent's options. @param {any} options @returns {Route | undefined} */
export function routeOfOptions(options) {
  return typeof options?.provider === 'string' && typeof options?.model === 'string'
    ? { provider: options.provider, model: options.model }
    : undefined;
}
