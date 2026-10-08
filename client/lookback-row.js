/**
 * A LOOK-BACK ROW SAYS WHAT WAS LOOKED UP, NEVER THE CALL'S JSON.
 *
 * The harness draws a tool call it has no row for as its generic row, whose
 * summary is the call's own arguments: `zoom {"id":0,"n":1}`, a line id. The
 * harness's seat for a row of one's own is the keyed `tool.call.toolview`
 * slot (a keyed entry replaces the generic row for that tool name), so the
 * memory's three tools, `zoom`, `date` and `recall_search`, each get an entry
 * that draws the harness's own `DisclosureRow`: "Looked back · «subject» ·
 * date · in «chat»" folded, and the answer without its line ids when opened.
 * No harness code is changed; the entries are removed with this plugin.
 */

/** The state of a call, as the harness's own tool rows name it. @param {string} phase @param {any} block */
function callState(phase, block) {
  if (phase === 'preparing') return 'preparing';
  if (phase === 'start') return 'running';
  if (block && block.error && block.error.code === 'interrupted') return 'stopped';
  return block && block.isError ? 'error' : 'ok';
}

/** The call's arguments as the model wrote them, once there are any. @param {string} phase @param {any} block @returns {string | null} */
function callArgsRaw(phase, block) {
  if (phase === 'result') return block && block.call && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : '';
  if (phase === 'start' && block && typeof block.argsRaw === 'string') return block.argsRaw;
  return null;
}

/** The settled answer's text; null while there is none. @param {string} phase @param {any} block @returns {string | null} */
function callOutput(phase, block) {
  if (phase !== 'result' || !block || !Array.isArray(block.content)) return null;
  return block.content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n');
}

/** @param {any} props the harness's owner props for one call, with its disclosure hook */
function LookBackRow(props) {
  const { phase, block, toolName, useDisclosure } = props;
  const state = callState(phase, block);
  const said = react.useMemo(
    () => sayLookBack(toolName, argsOf(callArgsRaw(phase, block) || ''), state, callOutput(phase, block)),
    [toolName, phase, block, state],
  );
  const { expanded, toggle } = useDisclosure();
  const expandable = state !== 'preparing' && said.opened !== null && said.opened !== '';
  const open = expanded && expandable;
  const running = state === 'running' || state === 'preparing';
  const status = state === 'running' ? 'Running' : state === 'preparing' ? 'Preparing' : state === 'error' ? 'Failed' : state === 'stopped' ? 'Stopped' : null;
  const collapsed = said.summary === '' ? null : h(react.Fragment, null,
    h('span', { className: 'mem-sep', 'aria-hidden': true }),
    h('span', { className: 'mem-summary' }, said.summary));
  return h('div', { className: 'mem-tool', 'data-tool': toolName, 'data-state': state },
    status === null ? null : h('span', { className: 'mem-hidden' }, status),
    h(primitives.DisclosureRow, {
      icon: h(primitives.IconClockOutlineRegular, { size: 14 }),
      title: said.title,
      running,
      open,
      expandable,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: toggle,
      collapsedContent: collapsed,
    }, open ? h('div', { className: 'mem-body' }, h('span', { className: 'mem-words' }, said.opened)) : undefined));
}

/**
 * Seat the three entries. Where the harness has no such seat the harness
 * draws its own generic rows, as it would without this plugin.
 * @param {any} ctx the harness's client root context
 */
function installLookBackRows(ctx) {
  ctx.effect(() => ctx.slots.inject(TOOL_SEAT, function* () {
    for (const key of LOOK_BACK_TOOLS) yield ctx.slots.register({ name: TOOL_SEAT, key }, LookBackRow);
  }), `${PACKAGE_ID}: look-back rows`);
}
