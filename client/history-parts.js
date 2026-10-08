/**
 * THE HISTORY VIEW'S PARTS: the words of a turn, a search find and a remembered
 * line. Each part asks the memory only for what it opens, through `memoryPort`,
 * and says a refusal in the refusal's own sentence.
 */

/** @param {unknown} error */
function refusal(error) {
  return error instanceof Error && error.message.trim() !== '' ? error.message : 'This could not be read. Try again.';
}

/** A text that may be long: clipped to six lines, with a way to show the rest. @param {{ text: string }} props */
function Words({ text }) {
  const [more, setMore] = react.useState(false);
  const long = text.length > 420 || text.split('\n').length > 6;
  return h('div', null,
    h('div', { className: `mem-text${long && !more ? ' mem-clamp' : ''}` }, text),
    long ? h('button', { type: 'button', className: 'mem-more', 'aria-expanded': more, onClick: () => setMore(!more) }, more ? 'Show less' : 'Show more') : null);
}

/** A text lit where it holds one of the searched words. @param {{ text: string, query: string }} props */
function LitText({ text, query }) {
  return h(react.Fragment, null, litParts(text, query).map((part, index) =>
    (part.lit ? h('mark', { key: index, className: 'mem-lit' }, part.text) : part.text)));
}

/** One kept entry of a turn: the person's words, a folded trace of the tool work, or the reply. @param {{ entry: { kind: string, text: string } }} props */
function EntryView({ entry }) {
  const [open, setOpen] = react.useState(false);
  const words = react.useMemo(() => plainMessage(entry.kind, entry.text), [entry]);
  if (entry.kind === 'trace') {
    return h('div', { className: 'mem-entry', 'data-kind': 'trace' },
      h('button', { type: 'button', className: 'mem-line-press', 'aria-expanded': open, onClick: () => setOpen(!open) },
        h('span', { className: 'mem-line-mark' }, open ? '▾' : '▸'), 'Worked'),
      open ? h('div', { className: 'mem-said' }, h(Words, { text: words })) : null);
  }
  const who = entry.kind === 'user' ? 'You' : entry.kind === 'work' ? 'Worked' : 'Agent';
  return h('div', { className: 'mem-entry', 'data-kind': entry.kind }, h('span', { className: 'mem-who' }, who), h(Words, { text: words }));
}

/** One finished turn. @param {{ turn: { at: string, entries: { id: number, kind: string, text: string }[] } }} props */
function TurnView({ turn }) {
  return h('div', { className: 'mem-turn', 'data-memory-turn': '' },
    h('div', { className: 'mem-time' }, timeWords(turn.at)),
    turn.entries.map((entry) => h(EntryView, { key: entry.id, entry })));
}

/** The conversation: every turn across the chats, by day, oldest first, with a way to read earlier ones. */
function Feed({ turns, now, hasEarlier, loading, onEarlier }) {
  const items = react.useMemo(() => historyFeed(turns, now), [turns, now]);
  return h('div', { 'data-memory-feed': '' },
    hasEarlier ? h('button', { type: 'button', className: 'mem-more', disabled: loading, onClick: onEarlier }, loading ? 'Reading…' : 'Show earlier') : null,
    items.map((item) => {
      if (item.kind === 'day') return h('div', { key: item.key, className: 'mem-day' }, item.words);
      if (item.kind === 'chat') return h('div', { key: item.key, className: 'mem-chat' }, `in «${item.title}»`);
      return h(TurnView, { key: item.key, turn: item.turn });
    }));
}

/** A kept message opened word for word. @param {{ message: { at: string, kind: string, text: string, sessionTitle: string }, now: Date }} props */
function SaidMessage({ message, now }) {
  return h('blockquote', { className: 'mem-said', 'data-memory-said': '' },
    h('div', { className: 'mem-where' }, `${dayWords(message.at, now)} · in «${message.sessionTitle}»`),
    h(Words, { text: plainMessage(message.kind, message.text) }));
}

/** Where the searched words stand: each find is a button that opens its message. */
function Hits({ hits, query, memoryId, now }) {
  if (hits.length === 0) return h('p', { className: 'mem-quiet' }, 'No words like these were found.');
  return h('ol', { className: 'mem-lines', 'data-memory-hits': '' }, hits.map((hit) => h(Hit, { key: hit.id, hit, query, memoryId, now })));
}

function Hit({ hit, query, memoryId, now }) {
  const [opened, setOpened] = react.useState({ state: 'closed' });
  const press = () => {
    if (opened.state !== 'closed') { setOpened({ state: 'closed' }); return; }
    setOpened({ state: 'opening' });
    memoryPort.zoom(memoryId, hit.id, 1).then(
      (answer) => setOpened({ state: 'open', message: answer.message }),
      (error) => setOpened({ state: 'refused', says: refusal(error) }),
    );
  };
  const snippet = hit.kind === 'trace' ? plainInline(hit.snippet) : withoutLineIds(hit.snippet);
  return h('li', { 'data-memory-hit': hit.kind },
    h('button', { type: 'button', className: 'mem-hit-press', 'aria-expanded': opened.state === 'open', onClick: press },
      h('div', { className: 'mem-where' }, `${dayWords(hit.at, now)} · in «${hit.sessionTitle}»`),
      h('div', { className: 'mem-text' }, h(LitText, { text: snippet, query }))),
    opened.state === 'refused' ? h('div', { className: 'mem-error' }, opened.says) : null,
    opened.state === 'open' ? h(SaidMessage, { message: opened.message, now }) : null);
}

/** The lines the agent starts its next turn with. Each opens to the two lines it was made from, and at the bottom to the message itself. */
function RememberedLines({ lines, memoryId, now }) {
  return h('ol', { className: 'mem-lines' }, lines.map((line) => h(RememberedLine, { key: `${line.n}:${line.id}`, line, memoryId, now })));
}

function RememberedLine({ line, memoryId, now }) {
  const [opened, setOpened] = react.useState({ state: 'closed' });
  const open = opened.state === 'open' || opened.state === 'opening';
  const press = () => {
    if (open) { setOpened({ state: 'closed' }); return; }
    setOpened({ state: 'opening' });
    memoryPort.zoom(memoryId, line.id, line.n).then(
      (answer) => setOpened({ state: 'open', answer }),
      (error) => setOpened({ state: 'refused', says: refusal(error) }),
    );
  };
  const words = line.text === null ? 'Still being written…' : plainInline(line.text);
  return h('li', { 'data-memory-line': '' },
    h('button', { type: 'button', className: 'mem-line-press', 'aria-expanded': open, disabled: opened.state === 'opening', onClick: press },
      h('span', { className: 'mem-line-mark' }, open ? '▾' : '▸'),
      h('span', { className: 'mem-where' }, `${shortDayWords(line.from, now)} `),
      words),
    opened.state === 'refused' ? h('div', { className: 'mem-error' }, opened.says) : null,
    opened.state === 'open' && opened.answer.lines ? h(RememberedLines, { lines: opened.answer.lines, memoryId, now }) : null,
    opened.state === 'open' && opened.answer.message ? h(SaidMessage, { message: opened.answer.message, now }) : null);
}
