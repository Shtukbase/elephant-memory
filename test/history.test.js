// The history projection: granularity `turn` (default) and `step`, what is
// kept, what is skipped, and that the same events always give the same numbers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryProjector } from '../lib/history.js';
import { eventLog } from './fixtures.js';

/** One turn with machinery, reasoning, two tool calls and a final reply. */
function oneTurn() {
  const log = eventLog();
  log.turnStart(1);
  log.user('Please check the release notes.');
  log.user('Current time: Tuesday', 'runtime-context');
  log.user('[model changed]', 'model-selection');
  log.assistant([
    { type: 'reasoning', text: 'secret thinking' },
    { type: 'text', text: 'Looking.' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"notes.md"}' },
    { type: 'tool-call', id: 'c2', name: 'grep', arguments: '{"q":"ship"}' },
  ]);
  log.result('c1', 'line one\nline two');
  log.result('c2', 'no match', true);
  log.assistant([{ type: 'reasoning', text: 'more thinking' }, { type: 'text', text: 'The notes list only what ships.' }]);
  log.turnEnd(1);
  return log.events;
}

/** @param {'turn' | 'step'} granularity @param {any[]} events */
function project(granularity, events) {
  const projector = new HistoryProjector({ granularity });
  for (const event of events) projector.push(event);
  return projector.entries;
}

test('turn granularity: the message, one trace of the tool uses, the reply — and no reasoning', () => {
  const entries = project('turn', oneTurn());
  assert.deepEqual(entries.map((e) => [e.i, e.kind]), [[0, 'user'], [1, 'tool'], [2, 'talk']]);
  assert.equal(entries[0].text, 'Please check the release notes.');
  assert.equal(entries[1].text, [
    'said: Looking.',
    'did: read {"path":"notes.md"}\nresult: line one\nline two',
    'did: grep {"q":"ship"}\nresult: error: no match',
  ].join('\n\n'));
  assert.equal(entries[2].text, 'The notes list only what ships.');
  assert.ok(entries.every((e) => !e.text.includes('thinking')), 'reasoning entered the history');
  assert.ok(entries.every((e) => !e.text.includes('Current time') && !e.text.includes('[model changed]')));
});

test('step granularity: one entry per reply, per tool call and per tool result', () => {
  const entries = project('step', oneTurn());
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['user', 'Please check the release notes.'],
    ['talk', 'Looking.'],
    ['tool', 'read {"path":"notes.md"}'],
    ['tool', 'grep {"q":"ship"}'],
    ['echo', 'line one\nline two'],
    ['echo', 'error: no match'],
    ['talk', 'The notes list only what ships.'],
  ]);
});

test('a message sent while the turn runs is the person\'s own entry, and an earlier reply moves into the trace', () => {
  const log = eventLog();
  log.turnStart(1);
  log.user('Start the timing run.');
  log.assistant([{ type: 'text', text: 'Started it.' }]);
  log.user('Use the copy, not the live folder.');
  log.assistant([{ type: 'text', text: 'Switched to the copy.' }]);
  log.turnEnd(1);
  const entries = project('turn', log.events);
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['user', 'Start the timing run.'],
    ['user', 'Use the copy, not the live folder.'],
    ['tool', 'said: Started it.'],
    ['talk', 'Switched to the copy.'],
  ]);
});

test('reports of other agents are colleague entries; replaced copies and machinery are not history', () => {
  const log = eventLog();
  log.checkpoint('<chat>\n0+1|you: old\n</chat>');
  log.turnStart(2);
  log.user('Report: the index is rebuilt.', 'subagent-settled');
  log.user('Approved', 'user-approval');
  log.user('Answer: yes', 'user-question-reply');
  log.assistant([{ type: 'text', text: 'Noted.' }]);
  log.turnEnd(2);
  const entries = project('turn', log.events);
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['work', 'Report: the index is rebuilt.'],
    ['user', 'Answer: yes'],
    ['talk', 'Noted.'],
  ]);
});

test('a call without a result is still recorded, and a long result is capped head and tail', () => {
  const log = eventLog();
  log.turnStart(1);
  log.user('go');
  log.assistant([{ type: 'tool-call', id: 'big', name: 'cat', arguments: '{}' }, { type: 'tool-call', id: 'lost', name: 'sleep', arguments: '{}' }]);
  log.result('big', `${'a'.repeat(40_000)}${'b'.repeat(40_000)}`);
  log.turnEnd(1);
  const [, trace] = project('turn', log.events);
  assert.ok(trace.text.includes('did: sleep {}\nresult: (no result)'));
  assert.ok(trace.text.includes('characters cut from the middle'));
  assert.ok(trace.text.length < 31_000);
  assert.ok(trace.text.includes('aaaa') && trace.text.includes('bbbb'));
});

test('the same events always give the same entries, folded at once or one by one', () => {
  const events = [...oneTurn()];
  const whole = project('turn', events);
  const projector = new HistoryProjector({ granularity: 'turn' });
  const added = events.flatMap((event) => projector.push(event));
  assert.deepEqual(added, whole);
  assert.deepEqual(whole.map((e) => e.size), whole.map((e) => Buffer.byteLength(e.text)));
});

test('a long message that is not tool output is never cut: it becomes several messages of its kind in a row', () => {
  const log = eventLog();
  log.turnStart(1);
  const words = Array.from({ length: 9000 }, (_, k) => `word${k}`).join(' ');
  log.user(words);
  log.assistant([{ type: 'text', text: '😀'.repeat(20_000) }]);
  log.turnEnd(1);
  const entries = project('turn', log.events);
  const user = entries.filter((e) => e.kind === 'user');
  const talk = entries.filter((e) => e.kind === 'talk');
  assert.ok(user.length >= 2 && talk.length >= 2, `${user.length} user and ${talk.length} reply messages`);
  assert.equal(user.map((e) => e.text).join(''), words, 'the person\'s words were cut or changed');
  assert.equal(talk.map((e) => e.text).join(''), '😀'.repeat(20_000), 'the reply was cut or split inside a character');
  for (const entry of [...user, ...talk]) assert.ok(entry.text.length <= 30_000, `a message of ${entry.text.length} characters`);
  assert.deepEqual(entries.map((e) => e.i), entries.map((_, k) => k));
  // Split at a space where there is one, never inside a word.
  assert.ok(user[0].text.endsWith(' '));
});
