// The view (UniiChat spec §3): a list of tree nodes ("parts") tiling the whole
// history, oldest first. Two things decide it:
//
//   WHICH lines merge — the adjacent sibling pair that is most due,
//     due = (T - last) / 2^l, `last` the pair's LAST message, oldest of equal
//     pairs, whose parent is already built. With the length of Taelin's
//     rollback `push` list as the budget this makes exactly push's merges
//     (test/view.test.js).
//   WHEN they merge — a sawtooth: each new message only appends its line; once
//     the view passes `high` bytes, ONE batch merges until it is at most `low`.
//     When missing parents stop the batch above `low`, it merges what it can at
//     each new message until it gets there (`shrinking`).
//
// A merged part is never split. The view is stored (`toJSON`, memory-data.js)
// and loaded, never recomputed: a recomputed view differs from the live one and
// every cached prefix dies with it.
//
// Pure: no I/O, no model. The tree is anything with built(l, i) and bytes(l, i).

export const PLACEHOLDER = '(not summarized yet: zoom it)';
const PLACEHOLDER_BYTES = Buffer.byteLength(PLACEHOLDER, 'utf8');

/** @typedef {{ l: number, i: number }} Part */
/** @typedef {{ built(l: number, i: number): boolean, bytes(l: number, i: number): number }} TreeLike */
/** @typedef {{ parts: [number, number][], shrinking: boolean }} ViewJson */

/** First message a part covers. @param {Part} part */
export const startOf = (part) => part.i * 2 ** part.l;
/** How many messages a part covers. @param {Part} part */
export const countOf = (part) => 2 ** part.l;

export class View {
  /** @param {TreeLike} tree @param {number} high @param {number} low */
  constructor(tree, high, low) {
    this.tree = tree;
    this.high = high;
    this.low = low;
    /** @type {Part[]} */
    this.parts = [];
    /** A batch stopped above `low`: merge what can be merged at each new message. */
    this.shrinking = false;
  }

  /** @param {Part} part */
  partBytes(part) {
    return this.tree.built(part.l, part.i) ? this.tree.bytes(part.l, part.i) : PLACEHOLDER_BYTES;
  }

  size() {
    let size = 0;
    for (const part of this.parts) size += this.partBytes(part);
    return size;
  }

  /** Messages the view covers: the end of its last part. */
  covered() {
    const last = this.parts.at(-1);
    return last === undefined ? 0 : startOf(last) + countOf(last);
  }

  /**
   * A new message: append its line, then batch if the view passed `high` (or a
   * batch is still owed). Returns the number of merges.
   * @param {number} i the message, always the next one
   */
  add(i) {
    this.parts.push({ l: 0, i });
    if (!this.shrinking && this.size() <= this.high) return 0;
    const merges = this.shrink(i + 1, this.low);
    this.shrinking = this.size() > this.low;
    return merges;
  }

  /**
   * How due the pair starting at `a` is: how long ago it ended, in its own line
   * size. The spec's code form `(T + 1) / 2^l - i` gives the same order.
   * @param {Part} a the pair's older half @param {number} T number of messages
   */
  due(a, T) {
    const last = (a.i + 2) * 2 ** a.l - 1;
    return (T - last) / 2 ** a.l;
  }

  /**
   * Merge the most due pairs whose parent is built until at most `target`
   * bytes, or until no pair can merge. Returns the merge count.
   * @param {number} T number of messages @param {number} target
   */
  shrink(T, target) {
    const parts = this.parts;
    let size = this.size();
    let merges = 0;
    while (size > target) {
      let best = -1;
      let bestDue = -Infinity;
      for (let k = 0; k + 1 < parts.length; k++) {
        const a = parts[k];
        const b = parts[k + 1];
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
        if (!this.tree.built(a.l + 1, a.i / 2)) continue;
        const due = this.due(a, T);
        // Strictly greater: of equal pairs the oldest (found first) wins.
        if (due > bestDue) {
          bestDue = due;
          best = k;
        }
      }
      if (best < 0) break;
      const a = parts[best];
      const parent = { l: a.l + 1, i: a.i / 2 };
      size += this.partBytes(parent) - this.partBytes(a) - this.partBytes(parts[best + 1]);
      parts.splice(best, 2, parent);
      merges++;
    }
    return merges;
  }

  /** Take another view's parts (never its thresholds). @param {View} other */
  copyFrom(other) {
    this.parts = other.parts.map((part) => ({ ...part }));
    this.shrinking = false;
  }

  /** Whether every line of the view is a summary. */
  allBuilt() {
    return this.parts.every((part) => this.tree.built(part.l, part.i));
  }

  /** @returns {ViewJson} */
  toJSON() {
    return { parts: this.parts.map((part) => [part.l, part.i]), shrinking: this.shrinking };
  }

  /**
   * Take a stored view, or say why it cannot be used: its parts must tile the
   * messages from 0 without a gap, cover no more than `T`, and every merged
   * part must be built.
   * @param {unknown} value @param {number} T @returns {string} '' when taken
   */
  load(value, T) {
    const json = /** @type {Partial<ViewJson> | null} */ (typeof value === 'object' ? value : null);
    if (json === null || !Array.isArray(json.parts) || typeof json.shrinking !== 'boolean') return 'it is not a view';
    /** @type {Part[]} */
    const parts = [];
    let next = 0;
    for (const pair of json.parts) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((n) => Number.isSafeInteger(n) && n >= 0)) return 'a line is not an [l, i] pair';
      const part = { l: pair[0], i: pair[1] };
      if (startOf(part) !== next) return `a line does not start at message ${next}`;
      if (part.l > 0 && !this.tree.built(part.l, part.i)) return `line ${next}+${countOf(part)} is not in the tree`;
      next += countOf(part);
      parts.push(part);
    }
    if (next > T) return `it covers ${next} messages and the history holds ${T}`;
    this.parts = parts;
    this.shrinking = json.shrinking;
    return '';
  }
}

/** One view line: `id+n|text`, newlines shown as single spaces. @param {Part} part @param {string | null} text */
export function lineOf(part, text) {
  return `${startOf(part)}+${countOf(part)}|${(text ?? PLACEHOLDER).replace(/\r?\n/g, ' ')}`;
}

/** Lines inside `<chat>` tags. @param {readonly string[]} lines */
export function chatBlock(lines) {
  return `<chat>\n${lines.join('\n')}\n</chat>`;
}

/**
 * The view as the model reads it.
 * @param {{ parts: readonly Part[] }} view @param {{ text(l: number, i: number): string | null }} tree
 */
export function renderView(view, tree) {
  return chatBlock(view.parts.map((part) => lineOf(part, tree.text(part.l, part.i))));
}
