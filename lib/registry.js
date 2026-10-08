// The memories one engine serves. A preset's plugins are mounted once per
// preset declaration (SEAMS.md §b), so one engine serves every conversation of
// the preset; each conversation is attached to the memory of its key (key.js):
// its binding (`endless.bind`) or, unbound, the default key.
//
// A memory is opened on the first turn of a chat bound to it and closed when
// its last chat goes. Open memories are also published process-wide, so the
// read API answers from the live memory whichever engine holds it.
//
// A child agent's session (header.origin === 'subagent') gets no memory of its
// own; its tools read its parent's memory when that is attached. No harness
// import: the model call comes from the injected `summarizer`.

import { Attachment } from './attachment.js';
import { EndlessRefusal } from './api.js';
import { ensureMemory, listMemoryIds, memoryDir, readBinding, readKey, writeBinding } from './catalog.js';
import { PACKAGE_NAME } from './identity.js';
import { defaultKey, isAgentName, isKeyText, memoryIdOf } from './key.js';
import { Memory } from './memory.js';
import { MemoryData } from './memory-data.js';
import { pathSegment } from './text.js';
import { readUsage } from './usage.js';

/** A binding's file name is the chat id's path segment: kept well under the 255-byte file-name limit. */
const MAX_SESSION_SEGMENT = 200;

/** @typedef {import('./llm-writer.js').Route} Route */

/** Open memories of this process, by folder, shared by every engine. */
const OPEN_KEY = Symbol.for(`${PACKAGE_NAME}/open-memories`);
/** @type {Map<string, Memory>} */
const published = /** @type {any} */ (globalThis)[OPEN_KEY] ?? new Map();
/** @type {any} */ (globalThis)[OPEN_KEY] = published;

/** @param {any} session */
export function isChildSession(session) {
  return session?.header?.origin === 'subagent';
}

export class Memories {
  /**
   * @param {object} options
   * @param {ReturnType<typeof import('./config.js').resolveConfig>} options.config
   * @param {string} options.root
   * @param {import('./memory-data.js').Log} options.log
   * @param {(memoryId: string, route: () => Route | undefined) => import('./writer.js').Summarize} options.summarizer
   */
  constructor({ config, root, log, summarizer }) {
    this.config = config;
    this.root = root;
    this.log = log;
    this.summarizer = summarizer;
    /** @type {Map<string, Memory>} */
    this.open = new Map();
    /** @type {Map<string, Attachment>} */
    this.attached = new Map();
    /** The chat route last seen per memory, from a turn that passed the model guard. @type {Map<string, Route>} */
    this.routes = new Map();
  }

  /** The attached chat's memory, if any. @param {string} sessionId */
  get(sessionId) {
    return this.attached.get(sessionId)?.memory;
  }

  /**
   * Attach a chat to its memory, opening the memory on first use. Throws when
   * another process holds the memory's lock.
   * @param {any} session
   */
  attach(session) {
    const id = String(session.id);
    const existing = this.attached.get(id);
    if (existing !== undefined) return existing.memory;
    const key = readBinding(this.root, id) ?? defaultKey(session);
    const memoryId = ensureMemory(this.root, key);
    const memory = this.openMemory(memoryId, readKey(this.root, memoryId) ?? key);
    this.attached.set(id, new Attachment(id, session, memory));
    return memory;
  }

  /** @param {string} memoryId @param {import('./key.js').MemoryKey} key */
  openMemory(memoryId, key) {
    const existing = this.open.get(memoryId);
    if (existing !== undefined) return existing;
    const route = () => this.routes.get(memoryId);
    const dir = memoryDir(this.root, memoryId);
    const memory = new Memory({
      memoryId,
      key,
      dir,
      config: this.config,
      summarize: this.summarizer(memoryId, route),
      canCall: () => route() !== undefined,
      log: this.log,
    });
    this.open.set(memoryId, memory);
    published.set(dir, memory);
    memory.pumpSoon();
    return memory;
  }

  /** A live session event of an attached chat. @param {any} session @param {any} event */
  observe(session, event) {
    const attachment = this.attached.get(String(session?.id));
    if (attachment === undefined) return;
    try {
      attachment.observe(event);
    } catch (error) {
      this.log.warn(`[ENDLESS_MEMORY] ${attachment.sessionId}: a finished turn was not stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Remember the chat's route for its memory's writer; a writer waiting for one starts. @param {string} memoryId @param {Route} route */
  noteRoute(memoryId, route) {
    this.routes.set(memoryId, { ...route });
    this.open.get(memoryId)?.pumpSoon();
  }

  /** @param {string} memoryId */
  routeOf(memoryId) {
    return this.routes.get(memoryId);
  }

  /**
   * The memory a tool call reads: the chat's own, or for a child agent its
   * parent's, when attached. Undefined otherwise.
   * @param {any} session
   */
  forTools(session) {
    if (session === undefined || session === null) return undefined;
    if (isChildSession(session)) {
      const parent = session.header?.parentSession;
      return parent === undefined ? undefined : this.get(String(parent));
    }
    try {
      return this.attach(session);
    } catch (error) {
      this.log.warn(`[ENDLESS_MEMORY] ${String(session.id)}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Bind a chat to (agent, project) before its first turn. A chat whose turns
   * are already in another memory keeps that memory. `name` is the agent's
   * display name, which its replies are tagged with in the summaries.
   * @param {string} sessionId @param {string} agent @param {string} project @param {string} [name]
   */
  bind(sessionId, agent, project, name) {
    if (pathSegment(sessionId).length > MAX_SESSION_SEGMENT || /[\u0000-\u001f]/u.test(sessionId) || !isKeyText(agent) || !isKeyText(project) || (name !== undefined && !isAgentName(name))) {
      throw new EndlessRefusal('endless/bad-request', 'The chat, agent or project is not readable.');
    }
    const memoryId = memoryIdOf(agent, project);
    const current = this.attached.get(sessionId)?.memory.memoryId ?? readBinding(this.root, sessionId)?.memoryId;
    if (current !== undefined && current !== memoryId) {
      if (this.snapshot(current)?.data.records.some((record) => record.sessionId === sessionId)) {
        throw new EndlessRefusal('endless/already-bound', 'This chat already remembers with another agent or project.');
      }
      this.detach(sessionId);
    }
    writeBinding(this.root, sessionId, { agent, project, ...(name === undefined ? {} : { name: name.trim() }) });
    return { memoryId };
  }

  /** Every memory under the root. */
  memoryIds() {
    return listMemoryIds(this.root);
  }

  /**
   * A memory to read: the live one when this process holds it, else its files,
   * read without writing.
   * @param {string} memoryId
   * @returns {{ data: MemoryData, usage: import('./usage.js').UsageTotals } | undefined}
   */
  snapshot(memoryId) {
    const dir = memoryDir(this.root, memoryId);
    const live = published.get(dir);
    if (live !== undefined && !live.closed) return { data: live, usage: live.usage.totals };
    const key = readKey(this.root, memoryId);
    if (key === undefined) return undefined;
    return { data: new MemoryData({ memoryId, key, dir, config: this.config, log: this.log, repair: false }), usage: readUsage(dir, this.log) };
  }

  /** A chat went away; its memory closes with its last chat. @param {string} sessionId */
  detach(sessionId) {
    const attachment = this.attached.get(sessionId);
    if (attachment === undefined) return;
    this.attached.delete(sessionId);
    const { memory } = attachment;
    if ([...this.attached.values()].some((other) => other.memory === memory)) return;
    this.close(memory);
  }

  /** @param {Memory} memory */
  close(memory) {
    memory.close();
    this.open.delete(memory.memoryId);
    if (published.get(memory.dir) === memory) published.delete(memory.dir);
  }

  closeAll() {
    for (const memory of this.open.values()) this.close(memory);
    this.attached.clear();
    this.routes.clear();
  }
}
