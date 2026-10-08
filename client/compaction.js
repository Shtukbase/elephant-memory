/**
 * AN ENDLESS CHAT DRAWS NO "CONTEXT COMPACTED" ROW.
 *
 * The memory replaces the history with its view at every turn start through
 * the harness's own compaction bracket, so the harness marks every turn
 * "Context compacted · Compacted 5 history items (~152 tokens)". For this
 * memory that says what is not true: the agent never loses a message, and a
 * person has no use for a count of history items.
 *
 * The harness draws each transcript node through the keyed seat
 * `conversation.chat.node`, whose registry lets an entry at a lower priority
 * SHADOW the harness's own entry for the same key ("register at a different
 * priority to shadow it (lowest renders)", the registry's own diagnostic). The
 * shadow for the key `compaction` finds the harness's entry and renders it, unless
 * the node's summary is this memory's note (lib/step-one.js), in which case it
 * draws nothing. Every other compaction, including a person's own `/compact` in
 * a chat without a memory, gets the harness's row untouched.
 */

/** Below the harness's own entries (which stand at 0), and below another plugin's shadow at -1. */
const SHADOW_PRIORITY = -2;
/** The harness's chat dictionary, so the shadowed entry gets the same `t`. */
const CHAT_LOCALE = 'chat';

/** Whether a compaction node is a memory's own checkpoint. @param {any} node */
function isMemoryCompaction(node) {
  const summary = node && node.data ? node.data.summary : null;
  return typeof summary === 'string' && summary.startsWith(NOTE_PREFIX);
}

/** @param {any} ctx the harness's client root context */
function installQuietCompaction(ctx) {
  const slots = ctx.slots;
  // A harness whose registry offers no read of its entries has no cell to shadow.
  if (typeof slots.entries !== 'function') return;
  /** @param {any} props */
  const Quiet = (props) => {
    if (isMemoryCompaction(props.node)) return null;
    const donor = slots.entries(CHAT_NODE_SEAT).find((entry) =>
      entry.options.key === 'compaction' && entry.component !== Quiet && (entry.options.priority || 0) > SHADOW_PRIORITY);
    return donor === undefined ? null : jsxRuntime.jsx(donor.component, props);
  };
  ctx.effect(() => slots.inject(CHAT_NODE_SEAT, () =>
    slots.register({ name: CHAT_NODE_SEAT, key: 'compaction', priority: SHADOW_PRIORITY, locale: CHAT_LOCALE }, Quiet)),
  `${PACKAGE_ID}: quiet compaction`);
}
