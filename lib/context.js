// The harness's context messages and the provider's prefix cache (SEAMS.md,
// "Context nodes and the cache").
//
// Three kinds of user-role message are harness context, and each owner sends
// its message again whenever the surface stops showing it: the skill catalog
// (`dsh-tool-skill`), the runtime-context snapshot (the agent loop) and
// workspace instructions (`dsh-agent-instructions`). If the turn replace hid
// them with the history, their owners would send them again AFTER the new
// message, in the part of the request that changes every turn, and every turn
// start would miss the cache on them. So step 1 of a turn lays the surface out
// as
//
//   [system prompt][context block][checkpoint: the view] + the step's messages
//
// The block holds the newest catalog, the newest runtime-context snapshot and
// every workspace-instructions message, in that order, then the newest message
// of each host kind (`contextKinds` config: a host's own standing context). A
// block node already in its place is kept; every other block slot is written as a one-node surface
// replace, and the checkpoint replaces the rest. Pure: no harness import.

/** The harness's context kinds, in block order: the least likely to change first. */
export const CONTEXT_KINDS = Object.freeze(['skill-catalog', 'runtime-context', 'agent-instructions']);
/** Kinds whose owner folds EVERY visible message; every other kind's owner reads only its newest. */
const EVERY_MESSAGE = new Set(['agent-instructions']);
/**
 * The source kind of the view when it opens a chat's first turn: there is no
 * earlier surface for a checkpoint to replace, so the view travels as one of
 * the step's own messages, after the context and before the new message.
 * Not history (history.js skips it) and replaced with the rest at turn 2.
 */
export const VIEW_SOURCE = 'endless-view';

/**
 * The kinds a turn keeps before the view: the harness's own, then the host's
 * (`contextKinds` config, for example a standing context of its own), in order.
 * @param {readonly string[]} [extra]
 * @returns {readonly string[]}
 */
export function contextKinds(extra = []) {
  return Object.freeze([...CONTEXT_KINDS, ...extra.filter((kind) => !CONTEXT_KINDS.includes(kind))]);
}

/** @param {any} message @param {readonly string[]} [kinds] */
export const isContextMessage = (message, kinds = CONTEXT_KINDS) => kinds.includes(message?.source?.kind);

/**
 * One block entry: a surface node (`seq`) or one of the step's own messages
 * (`message`), with the content and source a copy of it carries.
 * @typedef {{ content: any[], source: any, seq?: number, message?: any }} Item
 */

/** The block from context items in log order. @param {Item[]} items @param {readonly string[]} kinds */
function blockOf(items, kinds) {
  /** @type {Item[]} */
  const block = [];
  for (const kind of kinds) {
    const ofKind = items.filter((item) => item.source.kind === kind);
    block.push(...(EVERY_MESSAGE.has(kind) ? ofKind : ofKind.slice(-1)));
  }
  return block;
}

/**
 * A turn with nothing on its surface yet (the first): the step's own context
 * messages go first, in block order, so the next turn finds its block in place.
 * When the memory already holds earlier chats, the view follows them, before
 * every other message of the step.
 * @param {any} decision
 * @param {readonly string[]} [kinds]
 * @param {any} [view] the view as a message of the step, or none
 */
export function contextFirst(decision, kinds = CONTEXT_KINDS, view = undefined) {
  if (decision?.kind !== 'enter') return decision;
  /** @param {any} m */
  const isContext = (m) => isContextMessage(m, kinds);
  const context = decision.messages.filter(isContext);
  if (context.length === 0 && view === undefined) return decision;
  /** @param {any} m */
  const rankOf = (m) => kinds.indexOf(m.source.kind);
  const sorted = context.toSorted((/** @type {any} */ a, /** @type {any} */ b) => rankOf(a) - rankOf(b));
  const rest = decision.messages.filter((/** @type {any} */ m) => !isContext(m));
  return { ...decision, messages: [...sorted, ...(view === undefined ? [] : [view]), ...rest] };
}

/**
 * Plan step 1 of a turn that replaces its history. Reads only.
 * @param {{ surface: { nodes: readonly number[] }, eventAt(seq: number): any }} session
 * @param {readonly any[]} messages the step's messages, as the rest of the chain decided them
 * @param {readonly string[]} [kinds]
 * @returns {{ writes: { slot: number, item: Item }[], span: { start: number, end: number, seqs: number[] }, messages: any[], carried: Item[] } | null}
 *   null when nothing but the system prompt is on the surface
 */
export function planTurn(session, messages, kinds = CONTEXT_KINDS) {
  /** @param {any} m */
  const isContext = (m) => isContextMessage(m, kinds);
  const nodes = session.surface.nodes;
  // Node 0, when it is the system prompt, may only be rewritten by a system message (SEAMS.md §a).
  const head = nodes.length > 0 && session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0;
  const body = nodes.slice(head);
  if (body.length === 0) return null;
  /** @type {Item[]} */
  const items = [];
  for (const seq of body) {
    const event = session.eventAt(seq);
    if (event?.type === 'user/message' && isContext(event.data)) items.push({ content: event.data.content, source: event.data.source, seq });
  }
  for (const message of messages) if (isContext(message)) items.push({ content: message.content, source: message.source, message });
  const block = blockOf(items, kinds);
  // Each block entry takes one surface slot and the checkpoint needs one more.
  // What does not fit stays with the step, after the new message, and moves
  // into the block at a later turn.
  /** @type {Item[]} */
  const overflow = [];
  while (block.length >= body.length) overflow.unshift(/** @type {Item} */ (block.pop()));
  const writes = [];
  for (const [k, item] of block.entries()) if (body[k] !== item.seq) writes.push({ slot: body[k], item });
  const seqs = body.slice(block.length);
  const moved = new Set(block.map((item) => item.message).filter((message) => message !== undefined));
  return {
    writes,
    span: { start: seqs[0], end: seqs[seqs.length - 1], seqs },
    messages: messages.filter((message) => !moved.has(message)),
    // A step's own message that did not fit is still among `messages`.
    carried: overflow.filter((item) => item.message === undefined),
  };
}

/**
 * Lay out step 1 of a turn: write the block, then the checkpoint over the
 * rest, and return the decision the step takes. Appends in one synchronous run.
 * A chat with nothing on its surface yet (its first turn) gets the view, when
 * there is one, as a message of the step (`viewMessage`).
 * @param {any} session
 * @param {any} decision an `enter` decision with at least one message
 * @param {{ makeMessage: (item: Item) => any, checkpoint: (span: { start: number, end: number, seqs: number[] }) => unknown, viewMessage?: () => any }} io
 * @param {readonly string[]} [kinds]
 */
export function layOutTurn(session, decision, { makeMessage, checkpoint, viewMessage }, kinds = CONTEXT_KINDS) {
  const plan = planTurn(session, decision.messages, kinds);
  if (plan === null) return contextFirst(decision, kinds, viewMessage?.());
  for (const { slot, item } of plan.writes) {
    // A step's own message is placed as it is; a surface node is copied (fresh id).
    session.append('user/message', item.message ?? makeMessage(item), {
      surfaceOp: { op: 'replace', startSeq: slot, endSeq: slot },
      sourceEventSeqs: item.seq === undefined ? [slot] : [slot, item.seq],
    });
  }
  checkpoint(plan.span);
  return { ...decision, messages: [...plan.messages, ...plan.carried.map(makeMessage)] };
}
