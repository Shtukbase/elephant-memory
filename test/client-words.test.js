// The look-back row and the History view read the memory's machine answers
// back as plain words. The answers here are the ones lib/recall.js really
// gives, so a change of either side that breaks the other reddens this file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateOf, recallSearch, zoom } from '../lib/recall.js';
import { longDate } from '../lib/text.js';
import { pureFunctions } from './client-fake.js';
import { MemoryTree } from './fixtures.js';

const words = pureFunctions(['sayLookBack', 'plainInline', 'plainMessage', 'traceSteps', 'withoutLineIds', 'dayWords', 'shortDayWords', 'historyFeed', 'litParts', 'projectName', 'timeWords', 'dayKey']);

const CONFIG = { agentName: 'Assistant', you: 'you', granularity: 'turn', lineBytes: 512 };
const DAY = 86_400_000;

/** A memory of invented messages, the shape lib/recall.js reads. */
function memory() {
  const texts = [
    ['user', 'Draft the pricing page.'], ['talk', 'Noted.'],
    ['user', 'Rule: release notes list only what ships.'], ['talk', 'Understood.'],
  ];
  const tree = new MemoryTree();
  for (let l = 0; 2 ** l <= texts.length; l++) for (let i = 0; (i + 1) * 2 ** l <= texts.length; i++) tree.set(l, i, `in «Pricing page», you: line ${l}.${i}`);
  const entries = texts.map(([kind, text], i) => ({ i, kind, text, size: text.length, time: Date.UTC(2026, 9, 8, 13, 7) + i * 60_000, title: 'Pricing page', first: kind === 'user' }));
  return { size: entries.length, entry: (/** @type {number} */ i) => entries[i], tree, config: CONFIG };
}

test('a zoom to one message reads as its words and its chat, never as the call or an id', () => {
  const answer = zoom(memory(), 2, 1);
  assert.equal(answer, '2+0|in «Pricing page», you: Rule: release notes list only what ships.');
  const said = words.sayLookBack('zoom', { id: 2, n: 1 }, 'ok', answer);
  assert.equal(said.title, 'Looked back');
  assert.equal(said.summary, '«Rule: release notes list only what ships.» · in «Pricing page»');
  assert.doesNotMatch(`${said.title} ${said.summary} ${said.opened}`, /\d+\+\d+\||"id"|"n"/);
  assert.match(said.opened, /release notes list only what ships/);
});

test('a zoom to two halves, a date and a search each read as a look-back with the words they found', () => {
  const m = memory();
  const halves = words.sayLookBack('zoom', { id: 0, n: 4 }, 'ok', zoom(m, 0, 4));
  assert.doesNotMatch(halves.opened, /\d+\+\d+\|/);
  const when = words.sayLookBack('date', { id: 2 }, 'ok', dateOf(m, 2));
  assert.deepEqual([when.title, when.summary], ['Looked back', longDate(Date.UTC(2026, 9, 8, 13, 9))]);
  const found = recallSearch(m, 'release');
  assert.match(found, /^2\|you\|/);
  const searched = words.sayLookBack('recall_search', { query: 'release' }, 'ok', found);
  assert.match(searched.summary, /^«release» · /);
  assert.doesNotMatch(searched.opened, /^\d+\|/m);
  assert.match(searched.opened, /Rule: release notes list only what ships/);
});

test('an answer that found nothing says so, and the states are said in their tense', () => {
  for (const [tool, answer] of [['zoom', 'No line 9+1.'], ['date', 'No message 99.'], ['recall_search', 'No message contains "x".'], ['zoom', 'This conversation has no endless memory to look into.']]) {
    const said = words.sayLookBack(tool, {}, 'ok', answer);
    assert.deepEqual([said.summary, said.opened], ['', 'Nothing was found there.']);
  }
  assert.equal(words.sayLookBack('zoom', {}, 'running', null).title, 'Looking back');
  assert.equal(words.sayLookBack('zoom', {}, 'preparing', null).title, 'Looking back');
  assert.equal(words.sayLookBack('zoom', {}, 'stopped', null).title, 'Stopped looking back');
  const failed = words.sayLookBack('zoom', {}, 'error', 'The memory is busy.\nTry later.');
  assert.deepEqual([failed.title, failed.summary, failed.opened], ['Could not look back', 'The memory is busy.', 'The memory is busy.\nTry later.']);
  assert.deepEqual({ ...words.sayLookBack('date', {}, 'running', null) }, { title: 'Looking back', summary: '', opened: null });
});

test('a kept trace reads as plain steps: a look-back once, other calls by their plain names, no line ids', () => {
  const trace = [
    'said: Checking.',
    'did: grep {"pattern":"tier","path":"docs"}\nresult: docs/pricing.md:12: Starter, Team',
    'did: zoom {"id":0,"n":1}\nresult: 0+0|in «Pricing page», you: Rule: release notes list only what ships.',
    'did: recall_search {"query":"tiers"}\nresult: 3|did|Thu, 8 Oct 2026, 13:07|did: grep {"pattern":"tier"} result: Starter',
    'did: subagent_fork {"task":"Summarise"}\nresult: done',
    'did: make_report {"title":"Q3"}\nresult: done',
  ].join('\n\n');
  const lines = words.traceSteps(trace).map((step) => step.line);
  assert.deepEqual(lines.slice(0, 2), ['Checking.', 'Searched files · tier · docs']);
  assert.match(lines[2], /^Looked back · «Rule: release notes list only what ships\.?.*» · in «Pricing page»$/);
  assert.match(lines[3], /^Looked back · «tiers» · Thu, 8 Oct 2026, 13:07$/);
  assert.deepEqual(lines.slice(4), ['Asked a helper · Summarise', 'Make report · Q3']);
  const plain = words.plainMessage('trace', trace);
  assert.doesNotMatch(plain, /\d+\+\d+\||\{"id"|\{"query"|did: /);
  assert.equal(words.plainMessage('user', '0+0|hello'), 'hello');
});

test('inline words — a remembered line, a search snippet — lose ids, fields and call JSON', () => {
  assert.equal(words.plainInline('6|did|Thu, 8 Oct 2026, 13:07|did: grep {"q":"x"} result: hit'), 'Thu, 8 Oct 2026, 13:07 · Searched files · x result: hit');
  assert.equal(words.plainInline('did: zoom {"id":1,"n":1} result: 1+0|in «A», you: hi'), 'Looked back · in «A», you: hi');
  assert.equal(words.plainInline('plain words stay'), 'plain words stay');
  // The writer reads a look-back as `did: looked back at …` (lib/look-back-words.js); the view shows it as the row does.
  assert.equal(words.plainInline('did: looked back at «cheese-maker» in «Pricing page»'), 'Looked back at «cheese-maker» in «Pricing page»');
});

test('days: Today, Yesterday and dated headings, and the feed names a day and a chat where each changes', () => {
  const now = new Date(2026, 9, 8, 15, 0);
  const at = (/** @type {number} */ daysAgo, hour = 12) => new Date(2026, 9, 8 - daysAgo, hour, 5).toISOString();
  assert.deepEqual([words.dayWords(at(0), now), words.dayWords(at(1), now), words.dayWords(at(2), now)], ['Today', 'Yesterday', 'Tuesday 6 October']);
  assert.equal(words.dayWords(new Date(2025, 11, 25, 9).toISOString(), now), 'Thursday 25 December 2025');
  assert.equal(words.shortDayWords(at(2), now), '6 Oct');
  assert.equal(words.dayWords('garbage', now), 'Earlier');
  assert.equal(words.timeWords(at(0, 9)), '09:05');
  const turns = [
    { at: at(0), sessionId: 'b', sessionTitle: 'B', entries: [] },
    { at: at(2), sessionId: 'a', sessionTitle: 'A', entries: [] },
    { at: at(2, 13), sessionId: 'a', sessionTitle: 'A', entries: [] },
    { at: at(0, 14), sessionId: 'a', sessionTitle: 'A', entries: [] },
  ];
  const feed = words.historyFeed(turns, now).map((item) => (item.kind === 'day' ? `day ${item.words}` : item.kind === 'chat' ? `chat ${item.title}` : 'turn'));
  assert.deepEqual(feed, ['day Tuesday 6 October', 'chat A', 'turn', 'turn', 'day Today', 'chat B', 'turn', 'chat A', 'turn']);
});

test('a search lights its words in the text, and a project reads as its folder name', () => {
  assert.deepEqual(words.litParts('Release notes ship', 'release SHIP'), [
    { text: 'Release', lit: true }, { text: ' notes ', lit: false }, { text: 'ship', lit: true },
  ]);
  assert.deepEqual(words.litParts('a.b', 'a.b'), [{ text: 'a.b', lit: true }]);
  assert.deepEqual(words.litParts('text', ' '), [{ text: 'text', lit: false }]);
  assert.equal(words.projectName('/work/board/'), 'board');
  assert.equal(words.projectName(''), '');
  assert.equal(words.dayKey(new Date(2026, 0, 5, 3).toISOString()), '2026-01-05');
});
