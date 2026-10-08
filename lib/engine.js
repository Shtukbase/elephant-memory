// EndlessCompactionEngine: the harness's compaction service, rewritten so that
// every turn starts fresh from the endless view (SEAMS.md, "The chosen seam").
//
// Mounted inside its own `cordis:group` with `isolate: { compaction: true }`,
// once per preset declaration. Every chat is attached to the memory of its
// key (agent, project) — its binding, or unbound, (preset, workspace) — and
// each finished turn is appended to that memory, whole. On step 1 of each turn
// on a model that passes the guard (guard.js) it waits until every line of the
// view is a summary, then lays the surface out (step-one.js): the harness's
// and the host's context messages first, then the view, then the new message.
// Steps after the first are untouched, so inside a turn the provider's cache
// works as usual. The seam methods (api.js) are served on the harness's own
// web server (routes.js).

import { CompactionEngine } from '@deepseek-ai/dsh-compaction';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { endlessMethods } from './api.js';
import { installBrowserRoutes } from './browser-routes.js';
import { bracketOpen, openTurn, writeCheckpoint } from './checkpoint.js';
import { PROMPT_ORDER, SETTLE_TIMEOUT_MS, resolveConfig } from './config.js';
import { VIEW_SOURCE, contextKinds } from './context.js';
import { ModelGuard, routeOfOptions } from './guard.js';
import { conversationPrefix, llmSummarizer } from './llm-writer.js';
import { pluginLog } from './log.js';
import { Memories, isChildSession } from './registry.js';
import { installEndlessRoutes } from './routes.js';
import { Config } from './schema.js';
import { TurnRefusal, noteOf, seamStepOne } from './step-one.js';
import { systemSection } from './system-section.js';
import { registerTools } from './tools.js';

export class EndlessCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tools', 'systemPrompt'];
  static Config = Config;

  /** @param {any} ctx @param {Record<string, unknown>} [config] */
  constructor(ctx, config = {}) {
    super(ctx);
    this.config = resolveConfig(config);
    this.kinds = contextKinds(this.config.contextKinds);
    this.log = pluginLog(ctx.logger);
    // Used only when no chat can give its own system prompt (llm-writer.js).
    const system = systemSection(this.config);
    this.memories = new Memories({
      config: this.config,
      root: this.config.root === '' ? dshHomePath('endless') : this.config.root,
      log: this.log,
      summarizer: (memoryId, route) => llmSummarizer({ llm: ctx.llm, route, writer: this.config.writer, sessionId: `endless-${memoryId}`, system }),
    });
    this.guard = new ModelGuard({ resolve: (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal), log: this.log });
    // Static text only: the system prompt stays byte-identical across turns.
    ctx.systemPrompt.section({ name: 'endless:memory', order: PROMPT_ORDER, text: systemSection(this.config), interpolate: false });
    registerTools(ctx, this.config, (/** @type {any} */ session) => this.memories.forTools(session));
    ctx.on('agent/disposed', (/** @type {any} */ { agent }) => this.memories.detach(String(agent.session?.id ?? agent.id)));
    ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => this.memories.observe(session, event));
    // Outermost (`prepend`): the step's messages arrive complete, with every
    // context message the chain added, before the turn is laid out (SEAMS.md,
    // "Context nodes and the cache").
    ctx.on('agent/pre-step', (/** @type {any} */ payload, /** @type {() => Promise<any>} */ next) => this.preStep(payload, next), { prepend: true });
    // Only where the harness runs a web server (SEAMS.md, "The seam methods").
    ctx.inject(['webServer'], (/** @type {any} */ scoped) => installEndlessRoutes(scoped.webServer, endlessMethods(this.memories), this.log));
    // The harness's own page reads the same memory through its authenticated connection (browser-routes.js).
    ctx.inject(['connection'], (/** @type {any} */ scoped) => installBrowserRoutes(scoped.connection, endlessMethods(this.memories), this.log));
    ctx.effect(() => () => this.memories.closeAll());
  }

  /**
   * The turn seam (SEAMS.md §c): step 1 of each turn, before the new message
   * is admitted.
   * @param {{ agent: any, messages: any[], turn: number, step: number, signal: AbortSignal }} payload
   * @param {() => Promise<any>} next
   */
  async preStep({ agent, messages, turn, step, signal }, next) {
    const session = agent?.session;
    if (step !== 1 || session === undefined || isChildSession(session)) return next();
    const id = String(session.id);
    try {
      return await seamStepOne({
        sessionId: id,
        route: routeOfOptions(agent.options),
        guard: this.guard,
        attach: () => this.memories.attach(session),
        // The writer reads this chat's system prompt and tools at each call.
        noteRoute: (memoryId, route) => this.memories.noteRoute(memoryId, { ...route, prefix: () => conversationPrefix(session) }),
        session,
        signal,
        next,
        kinds: this.kinds,
        timeoutMs: SETTLE_TIMEOUT_MS,
        io: (memoryId) => ({
          makeMessage: (item) => createUserMessage({ content: item.content, source: item.source }),
          viewMessage: (view) => createUserMessage({ content: [{ type: 'text', text: view }], source: { kind: VIEW_SOURCE } }),
          checkpoint: (span, view, note) => writeCheckpoint(session, { start: span.start, end: span.end, turn, view, note, route: this.writerRoute(memoryId) }),
          bracketOpen: () => bracketOpen(session),
        }),
      });
    } catch (error) {
      if (error instanceof TurnRefusal) return this.refuse(agent, messages, error.message);
      throw error;
    }
  }

  /**
   * Refuse a turn whose memory is not ready. Its messages go back to the
   * inbox, so they are delivered with the next turn and never lost.
   * @param {any} agent @param {any[]} messages @param {string} reason
   */
  refuse(agent, messages, reason) {
    this.log.warn(`[ENDLESS_TURN] ${String(agent.session.id)}: turn refused, its messages wait for the next turn: ${reason}`);
    for (const message of messages) agent.inject(message);
    return { kind: 'reject' };
  }

  /** The route the checkpoint record names: the memory's writer route. @param {string} memoryId */
  writerRoute(memoryId) {
    const route = this.memories.routeOf(memoryId) ?? { provider: '', model: '' };
    return { provider: route.provider, model: this.config.writer.model === '' ? route.model : this.config.writer.model };
  }

  /** Endless has no pressure policy: the history is replaced at every turn start. */
  compactIfNeeded() {
    return Promise.resolve(null);
  }

  /** Nothing to condense on demand: the next turn starts from the view anyway. */
  compactNow() {
    return Promise.resolve(null);
  }

  /**
   * The contract's region replace: surface nodes [start .. end] become one
   * checkpoint holding the settled view. Needs an open turn, like the shipped
   * backend's automatic path.
   * @param {number} start @param {number} end @param {any} agent @param {AbortSignal} [signal]
   */
  async compactRegion(start, end, agent, signal) {
    const session = agent.session;
    const memory = this.memories.attach(session);
    if (!(await memory.settle(signal, SETTLE_TIMEOUT_MS))) throw new Error('[ENDLESS_TURN] the summary lines are not written yet');
    const turn = openTurn(session);
    if (turn === null) throw new Error('compactRegion: no open turn; compaction events must be enclosed in a turn');
    return writeCheckpoint(session, { start, end, turn, view: memory.render(), note: noteOf(memory), route: this.writerRoute(memory.memoryId) });
  }
}
