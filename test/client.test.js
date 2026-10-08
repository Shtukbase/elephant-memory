// The plugin's real browser bundle (lib/client.js), run under node against a fake
// of the harness's client: what it registers on which seat, and what the
// components it registers draw and ask for. It touches no harness code, so the
// only things it can read are what the fake hands it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeContext, findAll, loadBundle, mount, settle, textOf } from './client-fake.js';

const ID = 'dsh-elephant-memory';
/** Values made inside the bundle's own realm, as this realm's. @param {any} value */
const plain = (value) => JSON.parse(JSON.stringify(value));
const DAY = 86_400_000;

/** The bundle applied to a fake context; `options` as `fakeContext`. */
function applied(options) {
  const bundle = loadBundle();
  const fake = fakeContext(options);
  bundle.exported.apply(fake.ctx);
  return { bundle, ...fake };
}

/** One tool call's owner props, as the harness's tool seat hands them. */
function call(toolName, args, answer, { phase = 'result', isError = false, expanded = false } = {}) {
  const block = phase === 'result'
    ? { kind: 'result', callId: 'c1', call: { name: toolName, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text: answer }], isError }
    : { callId: 'c1', phase, name: toolName, argsRaw: JSON.stringify(args) };
  return { callId: 'c1', toolName, phase, block, useDisclosure: () => ({ expanded, toggle: () => {} }) };
}

test('the bundle registers under the package\'s name and asks the harness only for what every client bundle shares', () => {
  const { definition, exported } = loadBundle();
  assert.equal(definition.id, ID);
  assert.deepEqual([...exported.inject], ['slots']);
  assert.equal(typeof exported.apply, 'function');
});

test('it seats the three look-back rows, one quiet compaction, the History tab and the /history command', () => {
  const { registered, tabTypes, commands, bundle } = applied();
  const seats = registered.map((r) => `${r.seat}:${r.options.key}`);
  assert.deepEqual(seats.filter((s) => s.startsWith('tool.call.toolview')), ['tool.call.toolview:zoom', 'tool.call.toolview:date', 'tool.call.toolview:recall_search']);
  const quiet = registered.find((r) => r.seat === 'conversation.chat.node');
  assert.deepEqual([quiet.options.key, quiet.options.priority, quiet.options.locale], ['compaction', -2, 'chat']);
  assert.deepEqual(seats.filter((s) => s.startsWith('sidebar.right')), [`sidebar.right.pane.tab:${ID}`, `sidebar.right.pane.tab.title:${ID}`]);
  assert.equal(tabTypes.length, 1);
  assert.deepEqual([tabTypes[0].id, tabTypes[0].kind, tabTypes[0].title(), tabTypes[0].keepMounted], [ID, 'memory-history', 'History', true]);
  assert.deepEqual(plain(tabTypes[0].guide.map((g) => [g.id, g.title(), g.icon === bundle.primitives.IconClockOutlineRegular])), [['history', 'History', true]]);
  assert.deepEqual(commands.map((c) => [c.name, c.label(), c.ui.kind]), [['history', 'History', 'action']]);
  assert.equal(bundle.styles.length, 1);
  assert.match(bundle.styles[0].textContent, /\.mem-history\{/);
});

test('/history opens the History tab of the sidebar; a harness without the command seat loses only the command', () => {
  const { commands, opened } = applied();
  commands[0].ui.run({ sessionId: 's1' });
  assert.deepEqual(opened, ['memory-history']);
  const bare = applied({ services: { commandUi: null, sidebarRightTabs: null } });
  assert.deepEqual([bare.commands.length, bare.tabTypes.length], [0, 0]);
  assert.equal(bare.registered.filter((r) => r.seat === 'tool.call.toolview').length, 3);
});

test('a command name that is already taken is logged, not thrown, and the tab stays open-able from the sidebar', () => {
  const warnings = [];
  const bundle = loadBundle({ console: { warn: (/** @type {string} */ line) => warnings.push(line) } });
  const { ctx, tabTypes } = fakeContext({ services: { commandUi: { register: () => { throw new Error('ui-commands: duplicate contribution for /history'); } } } });
  assert.doesNotThrow(() => bundle.exported.apply(ctx));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[ENDLESS_CLIENT\] \/history is taken: .*duplicate contribution/);
  assert.equal(tabTypes.length, 1);
});

test('a zoom row says what was looked up, never the call, and opens to the answer without line ids', () => {
  const { registered } = applied();
  const Row = registered.find((r) => r.options.key === 'zoom').component;
  const answer = '2+0|in «Pricing page», you: Rule: release notes list only what ships.';
  const closed = mount(Row, call('zoom', { id: 2, n: 1 }, answer));
  const row = findAll(closed.tree, (n) => n.type === 'DisclosureRow')[0];
  assert.equal(row.props.title, 'Looked back');
  assert.equal(textOf(row.props.collapsedContent), '«Rule: release notes list only what ships.» · in «Pricing page»');
  assert.equal(row.props.expandable, true);
  assert.equal(row.props.open, false);
  assert.doesNotMatch(textOf(closed.tree), /"id"|"n"|2\+0/);

  const open = mount(Row, call('zoom', { id: 2, n: 1 }, answer, { expanded: true }));
  const opened = findAll(open.tree, (n) => n.type === 'DisclosureRow')[0];
  assert.equal(opened.props.open, true);
  assert.equal(textOf(opened), 'in «Pricing page», you: Rule: release notes list only what ships.');
});

test('the row follows the call\'s state: running, nothing found, failed', () => {
  const { registered } = applied();
  const Row = registered.find((r) => r.options.key === 'recall_search').component;
  const rowOf = (/** @type {any} */ props) => findAll(mount(Row, props).tree, (n) => n.type === 'DisclosureRow')[0];
  const running = rowOf(call('recall_search', { query: 'tiers' }, '', { phase: 'start' }));
  assert.deepEqual([running.props.title, running.props.running, running.props.expandable], ['Looking back', true, false]);
  // While nothing is known the row says nothing more, never the call's own words.
  assert.equal(running.props.collapsedContent, null);
  const preparing = rowOf(call('recall_search', {}, '', { phase: 'preparing' }));
  assert.deepEqual([preparing.props.title, preparing.props.expandable], ['Looking back', false]);
  const none = rowOf(call('recall_search', { query: 'zzz' }, 'No message contains "zzz".'));
  assert.equal(textOf(none.props.collapsedContent), '');
  const failed = mount(Row, call('recall_search', { query: 'x' }, 'The memory is busy.', { isError: true }));
  assert.equal(findAll(failed.tree, (n) => n.props['data-state'] === 'error').length, 1);
  assert.equal(rowOf(call('recall_search', { query: 'x' }, 'The memory is busy.', { isError: true })).props.title, 'Could not look back');
});

test('a memory\'s own compaction draws nothing; any other compaction is drawn by the harness\'s own row', () => {
  const { registered, ctx } = applied();
  const Quiet = registered.find((r) => r.seat === 'conversation.chat.node').component;
  const Donor = () => null;
  // The harness's own entry stands at priority 0 for the same key.
  const slots = ctx.slots;
  slots.register({ name: 'conversation.chat.node', key: 'compaction' }, Donor);
  const own = { data: { summary: 'Endless memory: the conversation before this message, as 3 summary lines over 3 messages.' } };
  assert.equal(Quiet({ node: own }), null);
  const other = { data: { summary: 'The user asked for a pricing page.' } };
  const drawn = Quiet({ node: other });
  assert.deepEqual([drawn.type, drawn.props.node === other], [Donor, true]);
  assert.equal(Quiet({ node: { data: { summary: null } } }).type, Donor);
});

test('a harness that cannot list its seat\'s entries gets no quiet compaction, and the harness\'s row stands', () => {
  const { registered } = applied({ entries: false });
  assert.equal(registered.filter((r) => r.seat === 'conversation.chat.node').length, 0);
});

/** A connection whose RPC answers from a script and records what it was asked. */
function connection() {
  /** @type {{ channel: string, endpoint: string, args: any }[]} */ const asked = [];
  const memory = { memoryId: '0123456789abcdef', agent: 'endless', project: '/work/board', turns: 2, firstAt: null, lastAt: null, writerUsage: {} };
  const other = { memoryId: 'fedcba9876543210', agent: 'endless', project: '/work/site', turns: 1, firstAt: null, lastAt: null, writerUsage: {} };
  // Days before now, at noon, so "Yesterday" and "Today" hold whenever the test runs.
  const at = (/** @type {number} */ n) => { const d = new Date(Date.now() - n * DAY); d.setHours(12, 0, 0, 0); return d.toISOString(); };
  const answers = {
    memories: { memories: [other, memory] },
    history: { turns: [
      { at: at(1), sessionId: 'a', sessionTitle: 'Pricing page', entries: [{ id: 0, kind: 'user', text: 'Rule: release notes list only what ships.' }, { id: 1, kind: 'reply', text: 'Understood.' }] },
      { at: at(0), sessionId: 'b', sessionTitle: 'Release notes', entries: [{ id: 2, kind: 'trace', text: 'did: zoom {"id":0,"n":1}\nresult: 0+0|in «Pricing page», you: Rule' }] },
    ], next: 7 },
    view: { lines: [{ id: 0, n: 2, text: '0+0|in «Pricing page», you: Rule', from: at(1), to: at(0) }, { id: 2, n: 1, text: 'Assistant: Done.', from: at(0), to: at(0) }] },
    zoom: { message: { id: 2, kind: 'reply', text: 'Done and shipped.', at: at(0), sessionId: 'b', sessionTitle: 'Release notes' } },
    search: { hits: [{ id: 0, at: at(1), sessionTitle: 'Pricing page', kind: 'user', snippet: 'Rule: release notes list only what ships.' }] },
  };
  return {
    asked,
    rpc: {
      async call(/** @type {string} */ channel, /** @type {string} */ endpoint, /** @type {any} */ payload) {
        asked.push({ channel, endpoint, args: payload.args });
        const name = endpoint.replace('endless-ui.', '');
        if (endpoint === 'endless-ui.history' && payload.args.before === 7) return { ok: true, value: { turns: [{ at: at(6), sessionId: 'a', sessionTitle: 'Older chat', entries: [{ id: 9, kind: 'user', text: 'First words.' }] }] } };
        return name in answers ? { ok: true, value: answers[/** @type {keyof typeof answers} */ (name)] } : { ok: false, error: { code: 'endless/unknown-memory', message: 'That memory does not exist.' } };
      },
    },
  };
}

/** The History tab's body, mounted for a chat in /work/board. */
async function historyBody(extra = {}, cwd = '/work/board') {
  const link = connection();
  const { registered } = applied({ services: { connection: link, ...extra } });
  const Body = registered.find((r) => r.seat === 'sidebar.right.pane.tab').component;
  const sessions = { byId: { s1: { cwd, projectionValues: { agentPreset: 'endless' } } } };
  const view = mount(Body, { sessionId: 's1', useSessions: (/** @type {any} */ select) => select(sessions) });
  await settle();
  return { view, link };
}

test('History shows the memory of the chat\'s preset and folder, by day, asking through the harness\'s own connection', async () => {
  const { view, link } = await historyBody();
  assert.deepEqual(plain(link.asked.map((a) => [a.channel, a.endpoint])), [['/api', 'endless-ui.memories'], ['/api', 'endless-ui.history']]);
  assert.equal(link.asked[1].args.memoryId, '0123456789abcdef');
  const words = textOf(view.tree);
  assert.match(words, /board · History/);
  assert.match(words, /Yesterday in «Pricing page» 12:00 You Rule: release notes list only what ships\. Agent Understood\./);
  assert.match(words, /Today in «Release notes» 12:00 ▸ Worked/);
  assert.doesNotMatch(words, /"id"|0\+0\|/);
  assert.equal(findAll(view.tree, (n) => n.props['data-memory-turn'] !== undefined).length, 2);
  // Two memories exist: a picker offers both, and the chat's own is the one shown.
  const pick = findAll(view.tree, (n) => n.type === 'select')[0];
  assert.deepEqual(plain(pick.children.map((o) => textOf(o))), ['site', 'board']);
  assert.equal(pick.props.value, '0123456789abcdef');
});

test('earlier turns are read a page at a time, and a chat in another folder is shown the first memory', async () => {
  const { view, link } = await historyBody();
  const more = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === 'Show earlier')[0];
  more.props.onClick();
  await settle();
  assert.equal(link.asked.at(-1).args.before, 7);
  assert.match(textOf(view.tree), /in «Older chat» 12:00 You First words\./);
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === 'Show earlier').length, 0);
  const elsewhere = await historyBody({}, '/somewhere/else');
  assert.match(textOf(elsewhere.view.tree), /site · History/);
});

test('Remembers lists the lines the agent starts with, and a line opens down to the exact words', async () => {
  const { view, link } = await historyBody();
  const remembers = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === 'Remembers')[0];
  remembers.props.onClick();
  await settle();
  assert.equal(link.asked.at(-1).endpoint, 'endless-ui.view');
  const lines = findAll(view.tree, (n) => n.props['data-memory-line'] !== undefined);
  assert.equal(lines.length, 2);
  assert.doesNotMatch(textOf(lines[0]), /0\+0\|/);
  findAll(lines[1], (n) => n.type === 'button')[0].props.onClick();
  await settle();
  assert.deepEqual(plain(link.asked.at(-1)), { channel: '/api', endpoint: 'endless-ui.zoom', args: { memoryId: '0123456789abcdef', id: 2, n: 1 } });
  assert.match(textOf(view.tree), /Done and shipped\./);
});

test('a search shows where its words stand in the whole memory, and a find opens its message', async () => {
  const { view, link } = await historyBody();
  const form = findAll(view.tree, (n) => n.type === 'form')[0];
  const input = findAll(form, (n) => n.type === 'input')[0];
  input.props.onChange({ target: { value: 'ships' } });
  await settle();
  findAll(view.tree, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(plain(link.asked.at(-1)), { channel: '/api', endpoint: 'endless-ui.search', args: { memoryId: '0123456789abcdef', query: 'ships' } });
  const hit = findAll(view.tree, (n) => n.props['data-memory-hit'] !== undefined)[0];
  assert.match(textOf(hit), /in «Pricing page» Rule: release notes list only what\s+ships\s*\./);
  assert.equal(findAll(hit, (n) => n.type === 'mark').length, 1);
});

test('a refusal is said in its own words, and with no memory the view says there is none yet', async () => {
  const link = connection();
  link.rpc.call = async () => ({ ok: false, error: { code: 'endless/failed', message: 'The memory could not be read. Try again.' } });
  const { registered } = applied({ services: { connection: link } });
  const Body = registered.find((r) => r.seat === 'sidebar.right.pane.tab').component;
  const view = mount(Body, { sessionId: 's1', useSessions: (/** @type {any} */ select) => select({ byId: { s1: { cwd: '/x' } } }) });
  await settle();
  assert.match(textOf(view.tree), /The memory could not be read\. Try again\./);
  const empty = connection();
  empty.rpc.call = async () => ({ ok: true, value: { memories: [] } });
  const second = applied({ services: { connection: empty } });
  const Empty = second.registered.find((r) => r.seat === 'sidebar.right.pane.tab').component;
  const none = mount(Empty, { sessionId: 's1', useSessions: (/** @type {any} */ select) => select({ byId: {} }) });
  await settle();
  assert.match(textOf(none.tree), /No memory yet/);
  const missing = applied({ services: { connection: null } });
  const NoLink = missing.registered.find((r) => r.seat === 'sidebar.right.pane.tab').component;
  const unlinked = mount(NoLink, { sessionId: 's1', useSessions: (/** @type {any} */ select) => select({ byId: {} }) });
  await settle();
  assert.match(textOf(unlinked.tree), /The history is not available here\./);
});

test('a read of the turns that is refused is said in the view, with the memory still named', async () => {
  const link = connection();
  const ask = link.rpc.call;
  link.rpc.call = async (/** @type {string} */ channel, /** @type {string} */ endpoint, /** @type {any} */ payload) => (endpoint === 'endless-ui.history'
    ? { ok: false, error: { code: 'endless/failed', message: 'The memory could not be read. Try again.' } }
    : ask(channel, endpoint, payload));
  const { registered } = applied({ services: { connection: link } });
  const Body = registered.find((r) => r.seat === 'sidebar.right.pane.tab').component;
  const view = mount(Body, { sessionId: 's1', useSessions: (/** @type {any} */ select) => select({ byId: { s1: { cwd: '/work/board', projectionValues: { agentPreset: 'endless' } } } }) });
  await settle();
  const words = textOf(view.tree);
  assert.match(words, /board · History/);
  assert.match(words, /The memory could not be read\. Try again\./);
  assert.equal(findAll(view.tree, (n) => n.props.role === 'alert').length, 1);
});
