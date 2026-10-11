import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { CONTEXT_KINDS } from '../lib/context.js';
import { kindOfSource } from '../lib/history.js';
import { traceForWriter } from '../lib/look-back-words.js';
import { RankIndex, passagesOf, stem, termsOf } from '../lib/rank.js';
import { RECALL_SOURCE, autoRecall, freezeRecall, otherLanguage, recall } from '../lib/recall-ranked.js';
import { stepOne } from '../lib/step-one.js';
import { pureFunctions } from './client-fake.js';
import { FakeSession, userMessage } from './harness-fake.js';

function memory() {
  const entries = Array.from({ length: 80 }, (_, i) => ({ i, kind: 'user', text: `Weather report number ${i}: calm skies.`, time: Date.UTC(2026, 9, 1), record: i, title: 'Synthetic rules' }));
  entries[0].text = 'Rule: the walrus quota is seventeen crates per sledge.';
  entries[1] = { ...entries[1], kind: 'tool', text: 'The private tracemark is banana.' };
  return { get size() { return entries.length; }, entry: (i) => entries[i], tree: { text: () => null }, config: resolveConfig({}), entries };
}

test('rank folds word forms, preserves identifiers and partitions without losing text', () => {
  assert.equal(stem('серверы'), stem('сервера'));
  assert.equal(stem('deploys'), stem('deploy'));
  const terms = termsOf('main-ds-review 0.4.1-rc.3 lib/stepOne.js 3018');
  for (const word of ['main-ds-review', '0.4.1-rc.3', 'step', 'one', '3018']) assert.ok(terms.includes(word));
  const text = 'word '.repeat(1200);
  assert.equal(passagesOf(text).map(([a, b]) => text.slice(a, b)).join(''), text);
  assert.ok(passagesOf(text).every(([a, b]) => b - a <= 1200));
});

test('ranked tools omit traces, deduplicate shown passages and bound headers too', () => {
  const m = memory();
  const seen = new Set();
  const answer = recall(m, 'walrus quota crates sledge', undefined, seen);
  assert.match(answer, /seventeen crates/);
  assert.match(answer, /^0\|you\|/m);
  assert.equal(seen.size, 1);
  assert.match(recall(m, 'walrus quota crates sledge', undefined, seen), /^No further passage/);
  assert.match(recall(m, 'private tracemark'), /^No message matches/);
  assert.ok(Buffer.byteLength(recall(m, 'Absentword '.repeat(100000))) < 100);
  m.entries[0].title = 'A'.repeat(100000);
  assert.ok(Buffer.byteLength(recall(m, 'walrus quota')) <= 40000);
});

test('automatic recall skips small talk, crosses languages and never becomes history', () => {
  const m = memory();
  for (const text of ['ok', 'thanks go on', 'продолжай', 'unrelated aardvark vacuum']) assert.equal(autoRecall(m, text), undefined);
  assert.match(autoRecall(m, 'What was the walrus quota in crates?').text, /seventeen/);
  const mixed = memory();
  mixed.entries[0].text = 'Правило: квота моржа составляет семнадцать ящиков на одни сани.';
  mixed.entries[3].text = 'Квота моржа неизменна.';
  mixed.entries[4].text = 'Русские заметки.';
  mixed.entries[5].text = 'Старые правила.';
  assert.equal(otherLanguage(mixed, 'What was the walrus quota?'), 'Russian');
  assert.match(autoRecall(mixed, 'What was the walrus quota?', 'квота моржа ящиков сани').text, /семнадцать/);
  assert.equal(kindOfSource({ kind: RECALL_SOURCE }), null);
});

test('a snapshot and the actual turn seam exclude messages arriving during query expansion', async () => {
  const m = memory();
  const snapshot = freezeRecall(m);
  const index = new RankIndex();
  index.extend(1, () => 'walrus quota seventeen');
  const frozen = index.snapshot();
  index.extend(2, () => 'walrus quota ninety-nine');
  assert.equal(frozen.messages, 1);
  assert.equal(recall(snapshot, 'walrus quota').includes('ninety-nine'), false);
  const session = new FakeSession('s');
  const message = userMessage('What was the walrus quota in crates?', { kind: 'user' });
  const out = await stepOne({
    memory: Object.assign(m, { settle: async () => true, render: () => '<chat>view</chat>', waiting: () => 0, view: { parts: [] }, writer: { lastError: '' } }),
    session, signal: new AbortController().signal, kinds: CONTEXT_KINDS, timeoutMs: 1000,
    next: async () => ({ kind: 'enter', messages: [message] }),
    io: { makeMessage: (item) => item, viewMessage: (text) => userMessage(text, { kind: 'endless-view' }), checkpoint: () => {}, bracketOpen: () => false,
      recallMessage: (value) => userMessage(value.text, { kind: RECALL_SOURCE }),
      expand: async () => { m.entries.push({ ...m.entries[0], i: m.size, text: 'Walrus quota: ninety-nine crates per sledge.' }); return 'walrus quota crates sledge'; } },
  });
  assert.deepEqual(out.messages.map((item) => item.source.kind), ['endless-view', RECALL_SOURCE, 'user']);
  const block = out.messages[1].content[0].text;
  assert.match(block, /seventeen/);
  assert.doesNotMatch(block, /ninety-nine/);
});

test('the real ranked result reads as the existing plain look-back row and writer trace', () => {
  const answer = recall(memory(), 'walrus quota');
  const words = pureFunctions(['sayLookBack']);
  const row = words.sayLookBack('recall', { question: 'walrus quota' }, 'ok', answer);
  assert.match(row.summary, /«walrus quota».*Synthetic rules/);
  assert.match(row.opened, /seventeen crates/);
  assert.doesNotMatch(row.opened, /\d+\|you\||best passages|id\|who/);
  assert.equal(traceForWriter(`did: recall {"question":"walrus quota"}\nresult: ${answer}`), 'did: looked back at «walrus quota»');
  assert.equal(words.sayLookBack('recall', {}, 'ok', 'No further passage matches "x".').opened, 'Nothing was found there.');
});
