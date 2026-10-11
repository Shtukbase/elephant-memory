// Ranked search over the raw history: BM25 over passages of every message.
//
// `recall_search` finds a phrase word for word, so a question worded unlike
// its source finds nothing. This index ranks instead: any word order, word
// forms folded by a light stemmer (Russian and English), numbers and
// identifiers kept whole. No dictionary, no model, no dependency.
//
// A message is cut into passages of about PASSAGE_CHARS, and a passage is the
// unit that is ranked and shown: one message may be a 30,000-character report,
// and what answers a question is one part of it. The index is append-only like
// the history it covers; `extend` adds the messages it does not hold yet.

/** Characters of one passage; a passage ends at a line or word boundary. */
export const PASSAGE_CHARS = 1_200;
/** BM25's usual constants. */
const K1 = 1.2;
const B = 0.75;

/** A word, or an identifier held together by . _ - / : @ + # (a path, a version, a branch, a key). */
const TOKEN = /[\p{L}\p{N}]+(?:[._\-/:@+#][\p{L}\p{N}]+)*/gu;
const PART = /[\p{L}\p{N}]+/gu;
const CYRILLIC = /[а-я]/;
const DIGIT = /\p{N}/u;
/** Russian endings, longest first; one is cut when at least three letters stay. */
const RU = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'ием', 'иях', 'ете', 'ите', 'ешь', 'ишь', 'ила', 'или', 'ило', 'ала', 'али', 'ало',
  'ах', 'ях', 'ов', 'ев', 'ей', 'ий', 'ый', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ым', 'им', 'ом', 'ем', 'ам', 'ям', 'ую', 'юю', 'ию', 'ью', 'ия', 'ья',
  'ть', 'ет', 'ит', 'ут', 'ют', 'ат', 'ят', 'ла', 'ло', 'ли', 'ил', 'ал', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й', 'л'];
const EN = ['ing', 'ed', 'es', 's'];

/**
 * Words that say nothing about a topic. They are left out of a QUESTION only
 * (never of the index): in a short history "go" and "on" are rare by count, and
 * "thanks, go on" would otherwise pass for a question about the past.
 */
const STOP = new Set(`a an the and or but if then else of to in on at by for from with without into onto over under about as is are was were be been being
do does did done have has had having will would can could should shall may might must not no yes it its this that these those there here
i you he she we they me my your our their them us what which who whom whose when where why how all any some each every more most other such
only own same so than too very just also again once go going get got let lets please thanks thank ok okay tell told say said
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда
даже ну ли если уже или ни быть был него до вас нибудь уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их
чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем
чтобы нее сейчас были куда зачем всех никогда можно при наконец об другой хоть после над больше тот через эти нас про всего них какая много
разве эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это спасибо пожалуйста
давай ладно ок`.split(/\s+/));

/** @param {string} word @param {readonly string[]} endings */
function cut(word, endings) {
  for (const ending of endings) if (word.length - ending.length >= 3 && word.endsWith(ending)) return word.slice(0, -ending.length);
  return word;
}

/**
 * A word without one common ending, so "серверы" meets "сервера" and
 * "deploys" meets "deploy". A word that holds a digit is never cut.
 * @param {string} word lower case
 */
export function stem(word) {
  if (DIGIT.test(word)) return word;
  if (CYRILLIC.test(word)) return cut(word.length > 5 ? word.replace(/с[яь]$/, '') : word, RU);
  if (word.endsWith('ss')) return word;
  const base = cut(word, EN);
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base;
}

/**
 * The search terms of a text: lower case, "ё" read as "е", camelCase split.
 * An identifier (`main-ds-review`, `0.4.1-rc.3`, `lib/step-one.js`) is one
 * term whole and each of its parts is a term too; a number is one term.
 * `question` leaves out the words that name no topic (STOP).
 * @param {string} text @param {boolean} [question] @returns {string[]}
 */
export function termsOf(text, question = false) {
  const out = [];
  const lower = String(text ?? '').replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').toLowerCase().replaceAll('ё', 'е');
  for (const token of lower.match(TOKEN) ?? []) {
    const parts = token.match(PART) ?? [];
    if (parts.length > 1 && token.length <= 80) out.push(token);
    for (const part of parts) if ((part.length >= 2 || DIGIT.test(part)) && !(question && STOP.has(part))) out.push(stem(part));
  }
  return out;
}

/**
 * A text as [start, end) passages of about `size` characters, in order,
 * covering it whole; each ends at its last newline or space in its second half.
 * @param {string} text @param {number} [size] @returns {[number, number][]}
 */
export function passagesOf(text, size = PASSAGE_CHARS) {
  /** @type {[number, number][]} */
  const out = [];
  let from = 0;
  while (text.length - from > size) {
    let end = Math.max(text.lastIndexOf('\n', from + size - 1), text.lastIndexOf(' ', from + size - 1)) + 1;
    if (end - from <= size / 2) end = from + size;
    out.push([from, end]);
    from = end;
  }
  if (from < text.length || out.length === 0) out.push([from, text.length]);
  return out;
}

/**
 * @typedef {object} Hit
 * @property {number} message  the message's number
 * @property {number} start    the passage, as characters of the message
 * @property {number} end
 * @property {number} score    BM25 of the passage
 * @property {number} matched  distinct query terms the passage holds
 * @property {number} rare     of those, the ones under RARE_SHARE of all passages
 * @property {number} coverage the matched terms' share of the query's whole IDF weight, 0 to 1
 */

/** A term is rare when fewer than this share of all passages hold it. */
export const RARE_SHARE = 0.1;

export class RankIndex {
  constructor() {
    /** Messages indexed so far. */
    this.messages = 0;
    /** Per passage: its message, its span and its length in terms. */
    /** @type {number[]} */
    this.message = [];
    /** @type {number[]} */
    this.start = [];
    /** @type {number[]} */
    this.end = [];
    /** @type {number[]} */
    this.length = [];
    this.terms = 0;
    /** term -> [passage, count, passage, count, ...] */
    /** @type {Map<string, number[]>} */
    this.postings = new Map();
  }

  get passages() {
    return this.message.length;
  }

  /** An immutable prefix for an active search; never made for small talk. */
  snapshot(size = this.messages) {
    const copy = new RankIndex();
    let n = this.message.findIndex((message) => message >= size);
    if (n < 0) n = this.passages;
    copy.messages = Math.min(size, this.messages);
    copy.message = this.message.slice(0, n);
    copy.start = this.start.slice(0, n);
    copy.end = this.end.slice(0, n);
    copy.length = this.length.slice(0, n);
    copy.terms = copy.length.reduce((sum, length) => sum + length, 0);
    for (const [term, positions] of this.postings) {
      let stop = 0;
      while (stop < positions.length && positions[stop] < n) stop += 2;
      if (stop > 0) copy.postings.set(term, positions.slice(0, stop));
    }
    return copy;
  }

  /**
   * Index the messages this index does not hold yet.
   * @param {number} size messages in the history @param {(i: number) => string} textOf
   */
  extend(size, textOf) {
    for (let i = this.messages; i < size; i++) {
      const text = textOf(i);
      for (const [start, end] of passagesOf(text)) {
        const p = this.message.length;
        /** @type {Map<string, number>} */
        const counts = new Map();
        let length = 0;
        for (const term of termsOf(text.slice(start, end))) {
          counts.set(term, (counts.get(term) ?? 0) + 1);
          length++;
        }
        for (const [term, count] of counts) {
          let list = this.postings.get(term);
          if (list === undefined) this.postings.set(term, (list = []));
          list.push(p, count);
        }
        this.message.push(i);
        this.start.push(start);
        this.end.push(end);
        this.length.push(length);
        this.terms += length;
      }
    }
    this.messages = Math.max(this.messages, size);
  }

  /** @param {number} holding passages that hold the term */
  idf(holding) {
    return Math.log(1 + (this.passages - holding + 0.5) / (holding + 0.5));
  }

  /**
   * The passages that hold a query term, best first.
   * @param {string} query @param {number} [most] @returns {Hit[]}
   */
  search(query, most = 50) {
    const N = this.passages;
    const terms = [...new Set(termsOf(query, true))];
    if (N === 0 || terms.length === 0) return [];
    const mean = this.terms / N || 1;
    const score = new Float64Array(N);
    const weight = new Float64Array(N);
    const matched = new Uint16Array(N);
    const rare = new Uint16Array(N);
    let whole = 0;
    for (const term of terms) {
      const list = this.postings.get(term);
      const holding = list === undefined ? 0 : list.length / 2;
      const idf = this.idf(holding);
      // A term no message holds still counts in the query's weight: a question about what was never said covers little.
      whole += idf;
      if (list === undefined) continue;
      const isRare = holding < N * RARE_SHARE;
      for (let k = 0; k < list.length; k += 2) {
        const p = list[k];
        const n = list[k + 1];
        score[p] += idf * (n * (K1 + 1)) / (n + K1 * (1 - B + B * this.length[p] / mean));
        weight[p] += idf;
        matched[p] += 1;
        if (isRare) rare[p] += 1;
      }
    }
    const ranked = [];
    for (let p = 0; p < N; p++) if (score[p] > 0) ranked.push(p);
    return ranked
      .sort((a, b) => score[b] - score[a] || b - a)
      .slice(0, most)
      .map((p) => ({ message: this.message[p], start: this.start[p], end: this.end[p], score: score[p], matched: matched[p], rare: rare[p], coverage: whole > 0 ? weight[p] / whole : 0 }));
  }
}
