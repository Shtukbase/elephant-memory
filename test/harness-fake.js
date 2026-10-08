// A fake of the harness pieces a turn's layout meets, after the installed
// 0.2.0-rc.2 source cited in SEAMS.md, "Context nodes and the cache":
//
// - the session's surface fold (append, replace, its checks);
// - the agent loop's runtime-context projection and step 1 (claim, project,
//   pre-step waterfall, system prompt at node 0, append the step's messages);
// - the skill catalog's owner and the workspace instructions' baseline owner;
// - the provider adapter's wire request, to compare prefixes.

/** @param {string} text @param {any} source */
export const userMessage = (text, source) => ({ id: `m${++userMessage.count}`, role: 'user', content: [{ type: 'text', text }], source });
userMessage.count = 0;

/** @param {any} message */
export const textOf = (message) => message.content.map((/** @type {any} */ block) => block.text).join('');

export class FakeSession {
  /** @param {string} [id] @param {{ agentPreset?: string, cwd?: string, origin?: string, parentSession?: string }} [header] */
  constructor(id = 'session-1', header = { agentPreset: 'endless', cwd: '/work/board' }) {
    this.id = id;
    this.header = header;
    /** @type {any[]} */
    this.events = [];
    this.surface = { nodes: /** @type {number[]} */ ([]) };
    /** @type {((event: any) => void)[]} */
    this.listeners = [];
  }

  get seq() {
    return this.events.length;
  }

  /** @param {number} seq */
  eventAt(seq) {
    return this.events[seq];
  }

  snapshotEvents() {
    return this.events;
  }

  /** @param {string} type @param {any} data @param {{ surfaceOp?: any, sourceEventSeqs?: number[] }} [opts] */
  append(type, data, opts = {}) {
    const event = { type, seq: this.events.length, time: 1_760_000_000_000 + this.events.length * 1000, data, ...opts };
    const nodes = this.surface.nodes;
    if (opts.surfaceOp === 'append') nodes.push(event.seq);
    else if (opts.surfaceOp !== undefined) {
      // dsh-session/lib/index.js:311-329, :361-372, :416-420
      const { startSeq, endSeq } = opts.surfaceOp;
      const startIdx = nodes.indexOf(startSeq);
      const endIdx = nodes.indexOf(endSeq);
      if (startIdx < 0 || endIdx < startIdx) throw new Error(`replace ${startSeq}..${endSeq} is not a current span`);
      const shadowed = nodes.slice(startIdx, endIdx + 1);
      const sources = opts.sourceEventSeqs ?? [];
      if (new Set(sources).size !== sources.length || sources.some((s) => s >= event.seq)) throw new Error('bad sourceEventSeqs');
      if (shadowed.some((s) => !sources.includes(s))) throw new Error('sourceEventSeqs must include every shadowed node');
      if (startIdx === 0 && this.events[nodes[0]].type === 'system/message' && (type !== 'system/message' || shadowed.length !== 1)) {
        throw new Error('node 0 holds the system prompt');
      }
      nodes.splice(startIdx, shadowed.length, event.seq);
    }
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** The request's messages: the surface, node by node. */
  deriveMessages() {
    return this.surface.nodes.map((seq) => {
      const event = this.events[seq];
      return event.type === 'user/message' ? event.data : event.data.message;
    });
  }

  /** @param {string} kind */
  visible(kind) {
    return this.surface.nodes.map((seq) => this.events[seq]).filter((e) => e.type === 'user/message' && e.data.source.kind === kind);
  }
}

/** The loop's runtime-context projection (dsh-agent-loop/lib/index.js:298-350). */
export class RuntimeContext {
  /** @param {FakeSession} session */
  constructor(session) {
    /** @type {{ seq: number, text: string } | null | undefined} */
    this.retained = undefined;
    session.listeners.push((event) => {
      if (event.type === 'user/message' && event.data.source.kind === 'runtime-context') this.retained = { seq: event.seq, text: textOf(event.data) };
      else if (this.retained && event.surfaceOp !== 'append' && event.surfaceOp !== undefined && event.sourceEventSeqs?.includes(this.retained.seq)) this.retained = null;
    });
  }

  /** @param {string} text */
  project(text) {
    if (this.retained?.text === text) return undefined;
    return userMessage(text, { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'policy', text }] });
  }
}

/**
 * The skill catalog's owner (dsh-tool-skill/lib/index.js:203-236, :331-348):
 * after the chain, compare the newest VISIBLE catalog's entries with the
 * current ones; publish (or republish as an update) when they differ.
 * @param {FakeSession} session @param {{ entries: string[] }} skills
 */
export function skillCatalogOwner(session, skills) {
  return async (/** @type {any} */ _payload, /** @type {() => Promise<any>} */ next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const digest = JSON.stringify(skills.entries);
    let published = false;
    let visibleDigest;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue;
      published = true;
      if (session.surface.nodes.includes(seq)) {
        visibleDigest = JSON.stringify(event.data.source.entries);
        break;
      }
    }
    if (visibleDigest === digest) return decision;
    const head = published ? 'The available skill catalog changed.' : 'The following skills are available.';
    const catalog = userMessage(`${head}\n${skills.entries.map((e) => `- ${e}: ${'a long description '.repeat(8)}`).join('\n')}`, { kind: 'skill-catalog', form: 'catalog', ...(published ? { update: true } : {}), entries: [...skills.entries] });
    return { ...decision, messages: [...decision.messages, catalog] };
  };
}

/**
 * The workspace instructions' baseline (dsh-agent-instructions/lib/index.js:
 * 1074-1080, :1271-1289): sent after the last claimed message whenever no
 * baseline is visible.
 * @param {FakeSession} session @param {string} text
 */
export function instructionsOwner(session, text) {
  return async (/** @type {any} */ { messages }, /** @type {() => Promise<any>} */ next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const isBaseline = (/** @type {any} */ m) => m.source.kind === 'agent-instructions' && m.source.baseline === true;
    if (session.visible('agent-instructions').some((e) => isBaseline(e.data)) || decision.messages.some(isBaseline)) return decision;
    const baseline = userMessage(text, { kind: 'agent-instructions', form: 'instructions', baseline: true, baselineIdentity: 'root', changes: [{ action: 'set', scope: 'AGENTS.md', path: 'AGENTS.md' }] });
    const at = decision.messages.findLastIndex((/** @type {any} */ m) => messages.includes(m)) + 1;
    return { ...decision, messages: decision.messages.toSpliced(at, 0, baseline) };
  };
}

/**
 * Step 1 of a turn as the loop runs it (dsh-agent-loop/lib/index.js:902-925,
 * :1041-1066): claim, project the runtime context, run the waterfall
 * outermost-first (cordis/lib/index.js:317-325), put the system prompt at node
 * 0, append the step's messages. Returns the request's messages.
 * @param {FakeSession} session @param {RuntimeContext} runtime
 * @param {{ turn: number, text: string, context: string, listeners: Function[] }} input
 */
export async function stepOne(session, runtime, { turn, text, context, listeners }) {
  session.append('turn/start', { turn });
  const claimed = [userMessage(text, { kind: 'user' })];
  const fresh = runtime.project(context);
  const queue = [...listeners];
  const payload = { messages: claimed, turn, step: 1 };
  /** @returns {Promise<any>} */
  const next = () => {
    const listener = queue.shift();
    return listener ? listener(payload, next) : Promise.resolve({ kind: 'enter', messages: fresh === undefined ? claimed : [...claimed, fresh] });
  };
  const decision = await next();
  if (session.surface.nodes.length === 0) session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] } }, { surfaceOp: 'append' });
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' });
  return session.deriveMessages();
}

/**
 * What the adapter sends (dsh-llm-deepseek/lib/index.js:1649-1679): the system
 * prompt apart, then consecutive same-role messages merged, content only.
 * @param {any[]} messages
 */
export function wire(messages) {
  /** @type {{ role: string, content: string[] }[]} */
  const merged = [];
  let system = '';
  for (const message of messages) {
    if (message.role === 'system') {
      system = textOf(message);
      continue;
    }
    const previous = merged.at(-1);
    if (previous?.role === message.role) previous.content.push(textOf(message));
    else merged.push({ role: message.role, content: [textOf(message)] });
  }
  return JSON.stringify({ system, messages: merged });
}

/** Length of the common prefix of two strings. @param {string} a @param {string} b */
export function commonPrefix(a, b) {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}
