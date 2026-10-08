/**
 * The browser half of the memory plugin, in the harness's own client-bundle
 * form: a classic script that only REGISTERS a factory, whose body runs when
 * the module system materializes it. scripts/build-client.js composes the
 * fragments named below into lib/client.js, the one file the harness serves at
 * /plugins/<package>/client.js. The generated file is never edited by hand;
 * `node scripts/build-client.js --check` (and test/package.test.js) refuses a
 * stale one.
 *
 * What it adds, each through a seat the harness offers to a client plugin and
 * none by changing harness code:
 *
 * 1. a look-back row for the memory's tools (client/lookback-row.js);
 * 2. no "Context compacted" row for a memory's checkpoint (client/compaction.js);
 * 3. a History tab in the right sidebar and the /history command
 *    (client/history-view.js, client/open.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-elephant-memory',
  // The parameter the loader hands in is the harness's synchronous resolver
  // for the modules every client bundle shares.
  factory: (resolve) => {
    const react = resolve('react');
    const primitives = resolve('@deepseek-ai/dsh-client-ui-primitives');
    const jsxRuntime = resolve('react/jsx-runtime');
    const h = react.createElement;
    /**
     * Names the browser half agrees with the server half on. The build writes the
     * two `@…@` values from lib/identity.js and package.json, so the name of the
     * package is spelled in no source file of this folder.
     */

    /** The module id the harness loads this bundle under, and the key of the History tab's body. */
    const PACKAGE_ID = 'dsh-elephant-memory';
    /** The text a memory's checkpoint carries as its compaction summary (lib/step-one.js). */
    const NOTE_PREFIX = 'Endless memory:';
    /** The History tab's kind in the right sidebar. */
    const TAB_KIND = 'memory-history';
    /** The endpoint prefix of the server's page reads (lib/browser-routes.js). */
    const UI_PREFIX = 'endless-ui.';
    /** The memory's own tools, whose calls read as a look-back. */
    const LOOK_BACK_TOOLS = ['zoom', 'date', 'recall_search'];
    /** The harness's keyed seats this half draws into. */
    const TOOL_SEAT = 'tool.call.toolview';
    const CHAT_NODE_SEAT = 'conversation.chat.node';
    /** The preset a chat runs when its header names none (lib/key.js, PRESET_ID). */
    const DEFAULT_AGENT = 'endless';
    /** How many turns one History page asks for. */
    const PAGE_TURNS = 30;
    /**
     * WHAT THE MEMORY'S MACHINERY READS AS, IN PLAIN WORDS.
     *
     * The memory keeps a turn's tool work as one trace the model reads
     * (`did: zoom {"id":0,"n":1}`, `result: 0+0|in «chat», you: …`) and answers
     * its look-back tools in the same machine form (`0+0|…`, `id|kind|date|snippet`).
     * A person never reads a line id, a level or a call's JSON, so both the
     * transcript's row and the History view read each answer back as its subject,
     * its date and its chat. No React and no network: pure functions over strings.
     */

    const LINE_ID = /^\d+\+\d+\|/;
    const INLINE_LINE_ID = /(^|[\s:(])\d+\+\d+\|/g;
    /** The fields a search's answer writes before each find, `6|did|Thu, 8 Oct 2026, 13:07|`: place, speaker, date. */
    const FIND_FIELDS = /(^|\s)\d+\|[^|\n]{1,200}\|([A-Za-z]{2,4}\.?, \d{1,2} [A-Za-z]{3,5}\.? \d{4}, \d{1,2}:\d{2})\|/g;
    /** A call written inline, `did: name {json}`, and the `result:` that may follow it. */
    const INLINE_CALL = /(?:did:\s*)+([a-z][a-z0-9_]*)(?:\s*(\{[^{}]*\}))?(\s+result:)?/g;
    /** The sentences the tools answer when they found nothing (lib/recall.js, lib/tools.js). */
    const NOT_REMEMBERED = /^(No line |No message |This conversation has no endless memory|The search needs words|No message contains|That pattern is not)/;

    /** The plain names of the harness tools a trace usually holds; any other is its own name spaced out. */
    const TOOL_NAMES = {
      bash: 'Ran a command', pwsh: 'Ran a command', read: 'Read a file', read_image: 'Looked at an image',
      write: 'Wrote a file', edit: 'Edited a file', grep: 'Searched files', glob: 'Listed files',
      web_fetch: 'Read a web page', web_search: 'Searched the web', subagent: 'Asked a helper',
      subagent_fork: 'Asked a helper', todo: 'Updated the to-do list', ask_user: 'Asked a question',
    };

    /** @param {string} text @param {number} most */
    function clipped(text, most) {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length <= most ? flat : `${flat.slice(0, most - 1).trimEnd()}…`;
    }

    /** A tool's machine name as a name a person reads. @param {string} name */
    function plainToolName(name) {
      if (Object.prototype.hasOwnProperty.call(TOOL_NAMES, name)) return TOOL_NAMES[name];
      const spaced = name.replace(/[_-]+/g, ' ').trim();
      return spaced === '' ? 'Used a tool' : `${spaced[0].toUpperCase()}${spaced.slice(1)}`;
    }

    /** @param {string} raw @returns {Record<string, unknown> | null} */
    function argsOf(raw) {
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    }

    /** The words a call was given, as values only: `Scratch`, never `{"query":"Scratch"}`. @param {Record<string, unknown> | null} args */
    function givenWords(args) {
      if (args === null) return '';
      return Object.values(args)
        .filter((value) => typeof value === 'string' || typeof value === 'number')
        .map((value) => clipped(String(value), 60))
        .filter((value) => value !== '')
        .join(' · ');
    }

    /** Every line without the `id+n|` it may open with, including a `result:` line's answer. @param {string} text */
    function withoutLineIds(text) {
      return text.split('\n').map((line) => line.replace(LINE_ID, '').replace(/^(result:\s*)\d+\+\d+\|/, '$1')).join('\n');
    }

    /**
     * What one look-back answer was about: its subject, and the chat and date where
     * the answer names them; null for an answer that found nothing.
     * @param {string} toolName @param {Record<string, unknown> | null} args @param {string} output
     * @returns {{ subject: string, chat: string, date: string } | null}
     */
    function lookedBackAt(toolName, args, output) {
      const text = output.trim();
      if (text === '' || NOT_REMEMBERED.test(text)) return null;
      if (toolName === 'date') return { subject: '', chat: '', date: clipped(text.split('\n')[0] || '', 40) };
      if (toolName === 'recall_search') {
        const query = args !== null && typeof args.query === 'string' ? args.query.trim() : '';
        const first = (text.split('\n')[0] || '').split('|');
        return { subject: clipped(query, 60), chat: '', date: first.length >= 4 ? clipped(first[2] || '', 40) : '' };
      }
      const line = text.split('\n')[0] || '';
      const single = /^\d+\+0\|/.test(line);
      let words = line.replace(LINE_ID, '');
      const chat = (/in «([^»]+)»/.exec(words) || [])[1] || '';
      words = words.replace(/^in «[^»]+»,?\s*/, '');
      if (single) words = words.replace(/^[^:«»]{1,40}:\s*/, '');
      return { subject: clipped(words, 60), chat: clipped(chat, 60), date: '' };
    }

    /** @param {string} name @param {string | undefined} raw */
    function callWords(name, raw) {
      if (LOOK_BACK_TOOLS.includes(name)) return 'Looked back';
      const given = givenWords(raw === undefined ? null : argsOf(raw));
      return given === '' ? plainToolName(name) : `${plainToolName(name)} · ${given}`;
    }

    /**
     * Words on one line — a remembered line, a search's find — read plainly: no
     * line id anywhere, the fields of a find inside it as its date, and a call
     * written `did: name {json}` by its plain name (a look-back once, with its
     * `result:` as the separator rather than a second label).
     * @param {string} text
     */
    function plainInline(text) {
      return text
        .replace(INLINE_LINE_ID, '$1')
        .replace(FIND_FIELDS, '$1$2 · ')
        .replace(INLINE_CALL, (_whole, name, raw, result) =>
          (LOOK_BACK_TOOLS.includes(name) && result !== undefined ? `${callWords(name, raw)} ·` : `${callWords(name, raw)}${result || ''}`));
    }

    /** A search's answer opened: one find per line, as its date and its words. @param {string} answer */
    function plainFinds(answer) {
      return answer.split('\n').map((line) => plainInline(withoutLineIds(line))).join('\n');
    }

    /**
     * A look-back answer as a person reads it opened: no line ids, and a search's
     * hits as their date and words.
     * @param {string} toolName @param {string} output
     */
    function plainLookBack(toolName, output) {
      return toolName === 'recall_search' ? plainFinds(output) : withoutLineIds(output);
    }

    /**
     * The look-back row's words, in the tense of the call's state. The row never
     * falls back to the call's own words (`{"id":0,"n":1}` is a line id), so its
     * summary is always said, empty while nothing is known.
     * @param {string} toolName @param {Record<string, unknown> | null} args
     * @param {string} state `preparing`, `running`, `ok`, `error` or `stopped`
     * @param {string | null} output the settled answer's text
     * @returns {{ title: string, summary: string, opened: string | null }}
     */
    function sayLookBack(toolName, args, state, output) {
      const title = state === 'ok' ? 'Looked back' : state === 'error' ? 'Could not look back'
        : state === 'stopped' ? 'Stopped looking back' : 'Looking back';
      if (state === 'error' && typeof output === 'string' && output.trim() !== '') {
        return { title, summary: clipped(output.split('\n')[0] || '', 80), opened: output };
      }
      if (state !== 'ok' || typeof output !== 'string') return { title, summary: '', opened: null };
      const at = lookedBackAt(toolName, args, output);
      const parts = at === null ? [] : [at.subject === '' ? '' : `«${at.subject}»`, at.date, at.chat === '' ? '' : `in «${at.chat}»`];
      return {
        title,
        summary: parts.filter((part) => part !== '').join(' · '),
        opened: at === null ? 'Nothing was found there.' : plainLookBack(toolName, output),
      };
    }

    /** The one-line "Looked back · «subject» · date · in «chat»" a History trace step reads as. @param {string} name @param {Record<string, unknown> | null} args @param {string} answer */
    function lookBackLine(name, args, answer) {
      const said = sayLookBack(name, args, 'ok', answer);
      return said.summary === '' ? said.title : `${said.title} · ${said.summary}`;
    }

    /**
     * A kept trace as steps a person reads. A look-back is its one plain row; any
     * other call is its plain name and the words it was given; a `said:` part is its
     * words; every answer is shown without line ids.
     * @param {string} text
     * @returns {{ line: string, opened: string }[]}
     */
    function traceSteps(text) {
      const out = [];
      for (const part of text.split(/\n\n(?=did: |said: |result: )/)) {
        if (part.startsWith('said: ')) { out.push({ line: clipped(part.slice(6), 200), opened: '' }); continue; }
        if (part.startsWith('result: ')) { out.push({ line: clipped(withoutLineIds(part.slice(8)), 200), opened: withoutLineIds(part.slice(8)) }); continue; }
        if (!part.startsWith('did: ')) {
          const plain = withoutLineIds(part);
          const first = (plain.split('\n').find((line) => line.trim() !== '') || '').trim();
          if (first !== '') out.push({ line: clipped(first, 200), opened: plain });
          continue;
        }
        const newline = part.indexOf('\n');
        const head = newline === -1 ? part : part.slice(0, newline);
        const answer = (newline === -1 ? '' : part.slice(newline + 1)).replace(/^result:\s?/, '');
        const rest = head.replace(/^(did:\s*)+/, '');
        const space = rest.indexOf(' ');
        const name = space === -1 ? rest.trim() : rest.slice(0, space).trim();
        const args = argsOf(space === -1 ? '' : rest.slice(space + 1).trim());
        if (LOOK_BACK_TOOLS.includes(name)) {
          out.push({ line: lookBackLine(name, args, answer), opened: plainLookBack(name, answer) });
        } else {
          const given = givenWords(args);
          out.push({ line: given === '' ? plainToolName(name) : `${plainToolName(name)} · ${given}`, opened: withoutLineIds(answer) });
        }
      }
      return out;
    }

    /** A kept message opened in full: a trace as its plain steps, anything else without line ids. @param {string} kind @param {string} text */
    function plainMessage(kind, text) {
      if (kind !== 'trace') return withoutLineIds(text);
      return traceSteps(text)
        .map((step) => (step.opened === '' || step.opened === step.line ? step.line : `${step.line}\n${step.opened}`))
        .join('\n');
    }
    /**
     * THE HISTORY VIEW'S READINGS, as pure derivations: which day a turn falls on,
     * where the feed names a day or a chat, and which words a search lights. A
     * day is the reader's own calendar day; its words are written out rather than
     * left to the runner's locale.
     */

    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    /** The reader's calendar day of an instant, as `YYYY-MM-DD`; null for an unreadable one. @param {string} at */
    function dayKey(at) {
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) return null;
      return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
    }

    /** "Today", "Yesterday", or "Monday 5 October", with the year only when it is not this one. @param {string} at @param {Date} now */
    function dayWords(at, now) {
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) return 'Earlier';
      const key = dayKey(at);
      if (key === dayKey(now.toISOString())) return 'Today';
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
      const words = `${WEEKDAYS[when.getDay()]} ${when.getDate()} ${MONTHS[when.getMonth()]}`;
      return when.getFullYear() === now.getFullYear() ? words : `${words} ${when.getFullYear()}`;
    }

    /** The short form a Remembers row ends with: "Today", "Yesterday", "3 Oct", or "3 Oct 2025". @param {string} at @param {Date} now */
    function shortDayWords(at, now) {
      const long = dayWords(at, now);
      if (long === 'Today' || long === 'Yesterday' || long === 'Earlier') return long;
      const when = new Date(at);
      const words = `${when.getDate()} ${MONTHS[when.getMonth()].slice(0, 3)}`;
      return when.getFullYear() === now.getFullYear() ? words : `${words} ${when.getFullYear()}`;
    }

    /** The time of day of an instant, `13:07`. @param {string} at */
    function timeWords(at) {
      const when = new Date(at);
      return Number.isNaN(when.getTime()) ? '' : `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    }

    /**
     * The feed, oldest first: a day's heading where the day changes, and a chat's
     * one-line label where the chat changes, again at the start of each day, so a
     * day read alone still says which chat it is in.
     * @param {{ at: string, sessionId: string, sessionTitle: string }[]} turns @param {Date} now
     * @returns {({ kind: 'day', key: string, words: string } | { kind: 'chat', key: string, title: string } | { kind: 'turn', key: string, turn: any })[]}
     */
    function historyFeed(turns, now) {
      const ordered = [...turns].sort((left, right) => left.at.localeCompare(right.at));
      const items = [];
      let day = null;
      let chat = null;
      for (const turn of ordered) {
        const key = dayKey(turn.at) || 'earlier';
        if (key !== day) {
          items.push({ kind: 'day', key: `day:${key}`, words: dayWords(turn.at, now) });
          day = key;
          chat = null;
        }
        if (turn.sessionId !== chat) {
          items.push({ kind: 'chat', key: `chat:${turn.sessionId}:${turn.at}`, title: turn.sessionTitle });
          chat = turn.sessionId;
        }
        items.push({ kind: 'turn', key: `turn:${turn.sessionId}:${turn.at}`, turn });
      }
      return items;
    }

    /** @param {string} word */
    function escapedWord(word) {
      return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** The text cut where any of the query's words stands, case aside. @param {string} text @param {string} query @returns {{ text: string, lit: boolean }[]} */
    function litParts(text, query) {
      const words = query.trim().split(/\s+/).filter((word) => word !== '');
      if (words.length === 0) return [{ text, lit: false }];
      const pattern = new RegExp(`(${words.map(escapedWord).join('|')})`, 'gi');
      return text
        .split(pattern)
        .filter((part) => part !== '')
        .map((part) => ({ text: part, lit: words.some((word) => word.toLowerCase() === part.toLowerCase()) }));
    }

    /** The base name of a folder path, for a heading; the whole text when it has none. @param {string} project */
    function projectName(project) {
      const parts = project.split(/[\\/]+/).filter((part) => part !== '');
      return parts.length === 0 ? project : parts[parts.length - 1];
    }
    /**
     * THE PAGE'S READS OF THE MEMORY, through the harness's own authenticated
     * connection (`ctx.connection.rpc.call('/api', …)`, the carrier the harness's
     * own methods travel), to the routes of lib/browser-routes.js. Nothing here
     * keeps what it read.
     */

    /** Read at call time: the connection may arrive after this module is applied. */
    let readConnection = () => undefined;

    const READ_FAILED = 'The history could not be read. Try again.';

    /** @param {unknown} error */
    function sentence(error) {
      return error instanceof Error && error.message.trim() !== '' ? error.message : READ_FAILED;
    }

    /**
     * @param {string} name the read's short name, `history`
     * @param {Record<string, unknown>} args
     * @param {AbortSignal} [signal]
     */
    async function askMemory(name, args, signal) {
      const connection = readConnection();
      if (connection === undefined || connection === null) throw new Error('The history is not available here.');
      let result;
      try {
        result = await connection.rpc.call('/api', `${UI_PREFIX}${name}`, { args }, signal);
      } catch (error) {
        if (signal !== undefined && signal.aborted) throw error;
        throw new Error(READ_FAILED);
      }
      if (result !== undefined && result.ok === true) return result.value;
      throw new Error(result !== undefined && result.error && typeof result.error.message === 'string' && result.error.message !== '' ? result.error.message : READ_FAILED);
    }

    /** The five questions the History view asks of one memory. */
    const memoryPort = {
      memories: (signal) => askMemory('memories', {}, signal),
      history: (memoryId, before, signal) => askMemory('history', { memoryId, limit: PAGE_TURNS, ...(before === undefined ? {} : { before }) }, signal),
      view: (memoryId, signal) => askMemory('view', { memoryId }, signal),
      zoom: (memoryId, id, n, signal) => askMemory('zoom', { memoryId, id, n }, signal),
      search: (memoryId, query, signal) => askMemory('search', { memoryId, query }, signal),
    };
    /**
     * THE BROWSER HALF'S STYLE: one sheet, on the harness's own `--dsw-*` tokens
     * and the content font sizes it publishes, so it follows the theme and the
     * font-size setting. Every class starts with `mem-`.
     */

    const STYLE_TAG = 'data-plugin-css';

    const STYLES = `
    .mem-tool{display:flex;flex-direction:column}
    .mem-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}
    .mem-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));flex:auto;overflow:hidden}
    .mem-tool[data-state=error] .mem-summary{color:var(--dsw-alias-state-error-primary)}
    .mem-body{flex-direction:column;display:flex;margin:4px 0 4px 4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);padding:12px 16px;max-height:220px;overflow-y:auto}
    .mem-words{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}
    .mem-hidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}

    .mem-history{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
    .mem-bar{display:flex;flex-direction:column;gap:8px;padding:12px 14px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}
    .mem-headline{display:flex;align-items:center;gap:8px;min-width:0}
    .mem-place{flex:1;min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:14px}
    .mem-pick{max-width:50%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:2px 6px}
    .mem-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;background:none;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
    .mem-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
    .mem-search{display:flex}
    .mem-search input{flex:1;min-width:0;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:4px 8px}
    .mem-search input:focus-visible,.mem-pick:focus-visible,.mem-icon:focus-visible,.mem-more:focus-visible,.mem-line-press:focus-visible,.mem-hit-press:focus-visible,.mem-segment:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
    .mem-segments{display:flex;gap:2px}
    .mem-segment{font:inherit;padding:2px 10px;border:none;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
    .mem-segment[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
    .mem-scroll{flex:1;min-height:0;overflow-y:auto;padding:4px 14px 16px}
    .mem-day{position:sticky;top:0;z-index:1;padding:10px 0 4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
    .mem-chat{padding:6px 0 2px;color:var(--dsw-alias-label-caption);font-size:12px}
    .mem-turn{padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
    .mem-time{color:var(--dsw-alias-label-caption);font-size:11px}
    .mem-entry{margin-top:4px}
    .mem-who{color:var(--dsw-alias-label-caption);font-size:11px;margin-right:6px}
    .mem-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
    .mem-entry[data-kind=user] .mem-text{color:var(--dsw-alias-label-primary)}
    .mem-entry[data-kind=trace] .mem-text,.mem-entry[data-kind=work] .mem-text{color:var(--dsw-alias-label-tertiary)}
    .mem-clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
    .mem-more{font:inherit;font-size:11px;border:none;background:none;padding:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-decoration:underline 1px dotted;text-underline-offset:3px}
    .mem-quiet{padding:20px 0;color:var(--dsw-alias-label-tertiary)}
    .mem-error{padding:8px 0;color:var(--dsw-alias-state-error-primary)}
    .mem-lines{list-style:none;margin:0;padding:0}
    .mem-lines .mem-lines{margin-left:14px;border-left:.5px solid var(--dsw-alias-border-l2);padding-left:8px}
    .mem-line-press,.mem-hit-press{display:block;width:100%;text-align:left;font:inherit;color:var(--dsw-alias-label-secondary);background:none;border:none;border-radius:var(--dsw-radius-sm);padding:4px 6px;cursor:pointer}
    .mem-line-press:hover,.mem-hit-press:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .mem-line-mark{display:inline-block;width:12px;color:var(--dsw-alias-label-caption)}
    .mem-said{margin:2px 0 8px 14px;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l3)}
    .mem-where{color:var(--dsw-alias-label-caption);font-size:11px;margin-bottom:2px}
    .mem-lit{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(77,107,254,.18));color:inherit;border-radius:2px}
    `;

    /** Add the sheet once. */
    function installStyles() {
      if (typeof document === 'undefined') return;
      const tagId = `${PACKAGE_ID}/styles`;
      if (document.querySelector(`style[${STYLE_TAG}=${JSON.stringify(tagId)}]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_ID;
      tag.dataset.pluginCss = tagId;
      tag.textContent = STYLES;
      document.head.appendChild(tag);
    }
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
    /**
     * WHERE THE HISTORY VIEW LIVES, AND HOW A PERSON OPENS IT.
     *
     * The harness's right sidebar is a docking column of tabs, and a tab type is
     * registered in two stages (`dsh-client-ui-sidebar-right`, "Extension seats"):
     * the type through `ctx.sidebarRightTabs.register`, whose `guide` entry is a
     * door on the sidebar's start page, and its body and chip title through the
     * keyed slots `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`.
     * The harness's own Files and Terminal tabs are registered the same way.
     * A slash command, `/history`, opens the tab from the composer
     * (`ctx.commandUi.register`, an action contribution like the composer's File).
     */

    const HISTORY_WORDS = {
      title: 'History',
      description: 'Everything this agent remembers, by day',
    };

    /** @param {any} ctx the harness's client root context */
    function installHistoryTab(ctx) {
      ctx.inject(['sidebarRightTabs'], (scope) => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: PACKAGE_ID,
          kind: TAB_KIND,
          title: () => HISTORY_WORDS.title,
          keepMounted: true,
          guide: [{ id: 'history', order: 60, title: () => HISTORY_WORDS.title, description: () => HISTORY_WORDS.description, icon: primitives.IconClockOutlineRegular }],
        }), `${PACKAGE_ID}: history tab type`);
        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () =>
          scope.slots.register({ name: 'sidebar.right.pane.tab', key: PACKAGE_ID }, HistoryBody)), `${PACKAGE_ID}: history tab body`);
        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () =>
          scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: PACKAGE_ID }, HistoryTitle)), `${PACKAGE_ID}: history tab title`);
      });
    }

    /** @param {any} ctx the harness's client root context */
    function installHistoryCommand(ctx) {
      ctx.inject(['commandUi', 'sidebarRight'], (scope) => {
        try {
          scope.effect(() => scope.commandUi.register({
            name: 'history',
            label: () => HISTORY_WORDS.title,
            description: () => HISTORY_WORDS.description,
            icon: primitives.IconClockOutlineRegular,
            available: () => true,
            ui: { kind: 'action', run: () => { scope.sidebarRight.openTab(TAB_KIND); } },
          }), `${PACKAGE_ID}: history command`);
        } catch (error) {
          // A command of this name is already the harness's, or another plugin's: the tab stays reachable from the sidebar.
          console.warn(`[ENDLESS_CLIENT] /history is taken: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }

    return {
      // Every other service is asked for where it is used, so a harness that
      // lacks one loses that one feature and nothing else.
      inject: ['slots'],
      apply(ctx) {
        readConnection = () => ctx.get('connection');
        installStyles();
        installLookBackRows(ctx);
        installQuietCompaction(ctx);
        installHistoryTab(ctx);
        installHistoryCommand(ctx);
      },
    };
  },
});
