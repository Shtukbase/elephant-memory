// The summary writer (UniiChat spec §4): builds tree nodes in a strict order,
// from queues of nodes that are ready, never by scanning the tree.
//
//   - A message's line starts once fewer than UNBUILT_AHEAD lines before it
//     are still unbuilt (`next0` walks the messages; `open0` holds the started
//     ones not built yet).
//   - A merge starts once both its halves are built: saving a node queues its
//     parent when its sibling is built too.
//   - A call's context is the compaction view (memory.js) up to the node, and
//     stops at the first unbuilt line (writer-input.js).
//
// A node whose source already fits in the line budget IS the node, with no
// model call ("free node"). Up to JOBS calls run at once. A failed node waits
// RETRY_MS and is tried again, forever, reported only on its first failure: no
// back-off, because the next turn waits for it. Each node gets TRIES attempts
// with the "Too long" cut as feedback (or "Wrong language" for a script its
// sources do not use); the shortest valid attempt wins, trimmed when none
// fits. Saving a node never changes the views: lines merge only when a message
// arrives (view.js). A free node that cannot be stored (a full disk) leaves the
// queues as they were and is tried again after RETRY_MS: the writer never
// throws into the harness's event loop.

import { JOBS, LINE_TOLERANCE, RETRY_MS, RETRY_TARGET, TRIES, UNBUILT_AHEAD } from './config.js';
import { inventsScript, languageTask, retryTask } from './prompts.js';
import { bytes, stripHeads, trimLine } from './text.js';
import { nodeContext, nodeSource, nodeTask } from './writer-input.js';

/**
 * A writer call's conversation, provider-neutral. `summarize` turns it into a
 * model request and returns the reply's text, an opaque `message` to send
 * back on the next attempt, and what the call spent. A call that reached the
 * model and failed throws an error carrying `usage` too.
 * @typedef {{ role: 'user', texts: string[] } | { role: 'assistant', message: unknown }} WriterTurn
 * @typedef {import('./usage.js').CallUsage} CallUsage
 * @typedef {(turns: WriterTurn[], signal: AbortSignal) => Promise<{ text: string, message: unknown, usage?: CallUsage }>} Summarize
 */

/**
 * @typedef {object} WriterHost
 * @property {readonly import('./history.js').Entry[]} entries
 * @property {import('./store.js').TreeStore} tree
 * @property {import('./view.js').View} compactionView  the writer's own view
 * @property {(entry: import('./history.js').Entry) => string} tagged  the entry as "tag: text"
 * @property {number} lineBytes
 * @property {Summarize} summarize
 * @property {() => boolean} canCall  false while no model route is known
 * @property {(message: string) => void} warn
 * @property {() => void} saved  called after every node is stored
 * @property {(usage: CallUsage) => void} [spent]  called once per model call, failed or not
 */

export class Writer {
  /** @param {WriterHost} host */
  constructor(host) {
    this.host = host;
    /** Nodes with a call running or waiting to retry. @type {Set<string>} */
    this.busy = new Set();
    /** @type {Set<string>} */
    this.failed = new Set();
    /** The next message whose line is neither built nor started. */
    this.next0 = 0;
    /** Messages whose line was started and is not built yet. @type {Set<number>} */
    this.open0 = new Set();
    /** Merges whose halves are built, in the order they became ready. @type {{ l: number, i: number }[]} */
    this.merges = [];
    /** @type {Set<string>} */
    this.queued = new Set();
    /** Failed nodes whose wait is over. @type {{ l: number, i: number }[]} */
    this.again = [];
    this.abort = new AbortController();
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    this.timers = new Set();
    this.lastError = '';
    /** Lines that fit in no try and were trimmed, since the memory opened. */
    this.trimmed = 0;
    // Once, at open: the merges a stored tree left ready (one linear pass over
    // the levels, never repeated).
    const { tree, entries } = host;
    for (let l = 1; 2 ** l <= entries.length; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= entries.length; i++) {
        if (!tree.built(l, i) && tree.built(l - 1, 2 * i) && tree.built(l - 1, 2 * i + 1)) this.queue(l, i);
      }
    }
  }

  /** @param {number} l @param {number} i */
  queue(l, i) {
    const name = `${l}:${i}`;
    if (this.queued.has(name)) return;
    this.queued.add(name);
    this.merges.push({ l, i });
  }

  /** @param {number} k */
  unqueue(k) {
    const [{ l, i }] = this.merges.splice(k, 1);
    this.queued.delete(`${l}:${i}`);
  }

  /** The node's text when its source fits as is, else null. @param {number} l @param {number} i */
  freeText(l, i) {
    const text = nodeSource(this.host, l, i);
    return bytes(text) <= this.host.lineBytes ? text : null;
  }

  canStart() {
    return this.busy.size < JOBS && this.host.canCall();
  }

  /** Save every free node and start every call the queues allow. Never throws. */
  pump() {
    if (this.abort.signal.aborted) return;
    try {
      let progressed = true;
      while (progressed) progressed = this.retry() || this.messages() || this.readyMerges();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) this.host.warn(`[ENDLESS_WRITER] a line could not be stored, trying again every ${RETRY_MS / 1000} s: ${message}`);
      this.lastError = message;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.pump();
      }, RETRY_MS);
      this.timers.add(timer);
    }
  }

  /** Failed nodes whose wait is over start again first. */
  retry() {
    let progressed = false;
    while (this.again.length > 0 && this.canStart()) {
      const { l, i } = /** @type {{ l: number, i: number }} */ (this.again.shift());
      if (this.host.tree.built(l, i)) continue;
      this.start(l, i);
      progressed = true;
    }
    return progressed;
  }

  /** Message lines, in order, while fewer than UNBUILT_AHEAD before the next one are unbuilt. */
  messages() {
    const { entries, tree } = this.host;
    let progressed = false;
    while (this.next0 < entries.length) {
      const i = this.next0;
      if (tree.built(0, i)) {
        this.next0++;
        continue;
      }
      if (this.open0.size >= UNBUILT_AHEAD) break;
      const free = this.freeText(0, i);
      if (free === null && !this.canStart()) break;
      // Stored first, then counted: a save that throws leaves the line to try again.
      if (free !== null) this.save(0, i, free);
      this.next0++;
      if (free === null) {
        this.open0.add(i);
        this.start(0, i);
      }
      progressed = true;
    }
    return progressed;
  }

  /** Ready merges: a free one is saved at once, the others start while calls are free. */
  readyMerges() {
    const { tree } = this.host;
    let progressed = false;
    for (let k = 0; k < this.merges.length;) {
      const { l, i } = this.merges[k];
      if (tree.built(l, i)) {
        this.unqueue(k);
        continue;
      }
      const free = this.freeText(l, i);
      if (free === null && !this.canStart()) {
        k++;
        continue;
      }
      // Stored before it leaves the queue (saving only appends to it), so a save that throws keeps it queued.
      if (free !== null) this.save(l, i, free);
      this.unqueue(k);
      if (free === null) this.start(l, i);
      progressed = true;
    }
    return progressed;
  }

  /** @param {number} l @param {number} i */
  start(l, i) {
    const name = `${l}:${i}`;
    this.busy.add(name);
    this.build(l, i).then(
      () => {
        this.busy.delete(name);
        this.failed.delete(name);
        this.pump();
      },
      (/** @type {unknown} */ error) => {
        if (this.abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        if (!this.failed.has(name)) {
          this.failed.add(name);
          this.host.warn(`[ENDLESS_WRITER] line ${name} failed, retrying every ${RETRY_MS / 1000} s: ${message}`);
        }
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.busy.delete(name);
          this.again.push({ l, i });
          this.pump();
        }, RETRY_MS);
        this.timers.add(timer);
      },
    );
  }

  /** Store a node; its parent is queued when the sibling is built too. @param {number} l @param {number} i @param {string} text */
  save(l, i, text) {
    const { entries, tree } = this.host;
    tree.save(l, i, text, l === 0 ? entries[i].size : undefined);
    if (l === 0) this.open0.delete(i);
    if (tree.built(l, i ^ 1) && !tree.built(l + 1, i >> 1)) this.queue(l + 1, i >> 1);
    this.host.saved();
  }

  /**
   * At most TRIES calls. Every try loses the `id+n|` heads it copied from the
   * view (stripHeads) before it is measured or stored. A try in a CJK script
   * its sources do not use is invalid ("Wrong language" feedback). A valid try
   * fits up to LINE_TOLERANCE times the limit; one past that gets the spec's
   * "Too long" feedback with its cut mark at RETRY_TARGET times the limit, so
   * the next try lands under the tolerance. The shortest valid try wins; when
   * none fits it is trimmed at a word boundary to the tolerance (counted in
   * `trimmed`). With no valid try at all the node fails and is tried again later.
   * @param {number} l @param {number} i
   */
  async build(l, i) {
    const { tree, lineBytes } = this.host;
    const fits = Math.floor(lineBytes * LINE_TOLERANCE);
    const retryAt = Math.max(1, Math.floor(lineBytes * RETRY_TARGET));
    const source = nodeSource(this.host, l, i);
    // The view first, so consecutive writer calls share a cached prefix.
    /** @type {WriterTurn[]} */
    const turns = [{ role: 'user', texts: [nodeContext(this.host, l, i), nodeTask(this.host, l, i)] }];
    /** @type {string[]} */
    const valid = [];
    for (let tries = 1; ; tries++) {
      const answer = await this.call(turns);
      if (this.abort.signal.aborted) throw new Error('the memory was closed');
      const line = stripHeads(answer.text);
      if (line === '') throw new Error('the summary came back empty');
      const foreign = inventsScript(line, source);
      if (!foreign) valid.push(line);
      if ((!foreign && bytes(line) <= fits) || tries >= TRIES) break;
      turns.push({ role: 'assistant', message: answer.message }, { role: 'user', texts: [foreign ? languageTask() : retryTask(line, retryAt)] });
    }
    if (valid.length === 0) throw new Error('every try was written in a script its messages do not use');
    let best = valid.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
    if (bytes(best) > fits) {
      best = trimLine(best, fits);
      this.trimmed++;
      this.host.warn(`[ENDLESS_WRITER] line ${l}:${i} fit in no try and was trimmed to ${bytes(best)} bytes; ${this.trimmed} lines trimmed since the memory opened`);
    }
    if (!tree.built(l, i)) this.save(l, i, best);
  }

  /** One model call; what it spent is reported whether it succeeds or not. @param {WriterTurn[]} turns */
  async call(turns) {
    let answer;
    try {
      answer = await this.host.summarize(turns, this.abort.signal);
    } catch (error) {
      const usage = /** @type {{ usage?: CallUsage } | null} */ (error)?.usage;
      if (usage !== undefined) this.host.spent?.(usage);
      throw error;
    }
    if (answer.usage !== undefined) this.host.spent?.(answer.usage);
    return answer;
  }

  close() {
    this.abort.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
