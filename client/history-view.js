/**
 * THE HISTORY VIEW: every chat one agent had in one folder, and what it
 * remembers. One header (the folder, a search field, a choice between the
 * conversation and what the agent remembers) over a scrolling body.
 * Conversation is the feed by day; Remembers is the lines the agent starts
 * its next turn with, each opening down to the exact words. A search shows
 * where its words stand in the whole memory, not only in the pages read here.
 */

/** What one memory's reading holds: the newest page, earlier ones put before it, the lines, a search's finds. */
function MemoryHistory({ memory }) {
  const memoryId = memory.memoryId;
  const [side, setSide] = react.useState('conversation');
  const [reading, setReading] = react.useState({ state: 'reading' });
  const [turns, setTurns] = react.useState([]);
  const [next, setNext] = react.useState(undefined);
  const [loadingEarlier, setLoadingEarlier] = react.useState(false);
  const [lines, setLines] = react.useState(null);
  const [typed, setTyped] = react.useState('');
  const [query, setQuery] = react.useState('');
  const [hits, setHits] = react.useState(null);
  const now = react.useMemo(() => new Date(), [memoryId]);

  react.useEffect(() => {
    const controller = new AbortController();
    setReading({ state: 'reading' });
    setTurns([]);
    setNext(undefined);
    setLines(null);
    setHits(null);
    memoryPort.history(memoryId, undefined, controller.signal).then(
      (page) => { setTurns(page.turns); setNext(page.next); setReading({ state: 'ready' }); },
      (error) => { if (!controller.signal.aborted) setReading({ state: 'refused', says: refusal(error) }); },
    );
    return () => controller.abort();
  }, [memoryId]);

  const earlier = () => {
    if (next === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    memoryPort.history(memoryId, next).then(
      (page) => { setTurns((held) => [...page.turns, ...held]); setNext(page.next); },
      (error) => setReading({ state: 'refused', says: refusal(error) }),
    ).finally(() => setLoadingEarlier(false));
  };
  const choose = (chosen) => {
    setSide(chosen);
    if (chosen === 'remembers' && lines === null) {
      memoryPort.view(memoryId).then((answer) => setLines(answer.lines), (error) => setReading({ state: 'refused', says: refusal(error) }));
    }
  };
  const ask = (words) => {
    setQuery(words);
    if (words === '') { setHits(null); return; }
    memoryPort.search(memoryId, words).then((answer) => setHits(answer.hits), (error) => setReading({ state: 'refused', says: refusal(error) }));
  };

  const searching = query !== '' && hits !== null;
  return h(react.Fragment, null,
    h('div', { className: 'mem-bar' },
      h('form', { className: 'mem-search', role: 'search', onSubmit: (event) => { event.preventDefault(); ask(typed.trim()); } },
        h('input', {
          type: 'search', value: typed, placeholder: 'Search history', 'aria-label': 'Search history',
          onChange: (event) => setTyped(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Escape' && typed !== '') { event.preventDefault(); setTyped(''); ask(''); } },
        })),
      h('div', { className: 'mem-segments' },
        [['conversation', 'Conversation'], ['remembers', 'Remembers']].map(([value, label]) =>
          h('button', { key: value, type: 'button', className: 'mem-segment', 'aria-pressed': side === value, onClick: () => choose(value) }, label)))),
    h('div', { className: 'mem-scroll' },
      reading.state === 'refused' ? h('div', { className: 'mem-error', role: 'alert' }, reading.says) : null,
      reading.state === 'reading' ? h('p', { className: 'mem-quiet' }, 'Reading the history…') : null,
      side === 'conversation' && searching ? h(Hits, { hits, query, memoryId, now }) : null,
      side === 'conversation' && !searching && reading.state === 'ready' && turns.length === 0
        ? h('p', { className: 'mem-quiet' }, 'Nothing here yet. Chats with this agent in this folder appear here once a turn has finished.') : null,
      side === 'conversation' && !searching && turns.length > 0
        ? h(Feed, { turns, now, hasEarlier: next !== undefined, loading: loadingEarlier, onEarlier: earlier }) : null,
      side === 'remembers' && lines !== null && lines.length === 0 ? h('p', { className: 'mem-quiet' }, 'Nothing to remember yet.') : null,
      side === 'remembers' && lines !== null && lines.length > 0 ? h(RememberedLines, { lines, memoryId, now }) : null));
}

/** A memory's name in the picker: its folder, and the agent when it is not the preset's default. @param {any} memory */
function memoryLabel(memory) {
  const where = projectName(memory.project) || 'No folder';
  return memory.agent === DEFAULT_AGENT ? where : `${where} · ${projectName(memory.agent)}`;
}

/**
 * The tab's body. The memory a chat reads is keyed by its preset and its
 * folder (lib/key.js), so that is the one shown first; a person can look at
 * another from the picker.
 * @param {{ sessionId: string, useSessions: (select: (state: any) => any) => any }} props
 */
function HistoryBody({ sessionId, useSessions }) {
  const cwd = useSessions((state) => (state.byId[sessionId] || {}).cwd);
  const preset = useSessions((state) => ((state.byId[sessionId] || {}).projectionValues || {}).agentPreset);
  const [memories, setMemories] = react.useState(null);
  const [failure, setFailure] = react.useState(null);
  const [picked, setPicked] = react.useState(null);
  const [round, setRound] = react.useState(0);

  react.useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    memoryPort.memories(controller.signal).then(
      (answer) => setMemories(answer.memories),
      (error) => { if (!controller.signal.aborted) setFailure(refusal(error)); },
    );
    return () => controller.abort();
  }, [round]);

  const own = memories === null ? undefined : memories.find((memory) => memory.agent === (preset || DEFAULT_AGENT) && memory.project === (cwd || ''));
  const shown = memories === null ? undefined : (memories.find((memory) => memory.memoryId === picked) || own || memories[0]);
  const bar = h('div', { className: 'mem-bar' },
    h('div', { className: 'mem-headline' },
      h('span', { className: 'mem-place' }, shown ? `${projectName(shown.project) || 'No folder'} · History` : 'History'),
      memories !== null && memories.length > 1 ? h('select', {
        className: 'mem-pick', 'aria-label': 'Memory', value: shown ? shown.memoryId : '',
        onChange: (event) => setPicked(event.target.value),
      }, memories.map((memory) => h('option', { key: memory.memoryId, value: memory.memoryId }, memoryLabel(memory)))) : null,
      h('button', { type: 'button', className: 'mem-icon', 'aria-label': 'Reload', title: 'Reload', onClick: () => setRound((value) => value + 1) },
        h(primitives.IconRefreshOutlineRegular, { size: 14 }))));
  return h('div', { className: 'mem-history', 'data-memory-history': '' },
    bar,
    failure !== null ? h('div', { className: 'mem-scroll' }, h('div', { className: 'mem-error', role: 'alert' }, failure)) : null,
    failure === null && memories === null ? h('div', { className: 'mem-scroll' }, h('p', { className: 'mem-quiet' }, 'Reading the history…')) : null,
    failure === null && memories !== null && memories.length === 0
      ? h('div', { className: 'mem-scroll' }, h('p', { className: 'mem-quiet' }, 'No memory yet. Chats in the Endless mode are kept here once a turn has finished.')) : null,
    shown ? h(MemoryHistory, { key: `${shown.memoryId}:${round}`, memory: shown }) : null);
}

/** The tab chip's title. @param {{ useTabInfo: () => { tab: { title: string } } }} props */
function HistoryTitle({ useTabInfo }) {
  const { tab } = useTabInfo();
  return h(react.Fragment, null, h(primitives.IconClockOutlineRegular, { size: 16 }), tab.title);
}
