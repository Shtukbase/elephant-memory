import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { minimumContextTokens, resolveConfig } from '../lib/config.js';
import { LedgerData, ledgerReply } from '../lib/ledger-data.js';
import { llmSummarizer } from '../lib/llm-writer.js';
import { ledgerPrompt, ledgerSegments, ledgerWindow } from '../lib/ledger-prompt.js';
import { LedgerWriter } from '../lib/ledger-writer.js';
import { Memory } from '../lib/memory.js';
import { MemoryData } from '../lib/memory-data.js';
import { systemSection } from '../lib/system-section.js';
import { keptLog, rootsForThisFile, settleTicks } from './fixtures.js';

const roots = rootsForThisFile();
after(() => roots.removeAll());
const KEY = { agent: 'scout', project: '/synthetic/ledger' };
const turn = (text, n = 1) => ({ sessionId: 's', sessionTitle: 'Rules', turn: n, at: Date.UTC(2026, 9, 1), entries: [{ kind: 'user', text, time: Date.UTC(2026, 9, 1) }] });
const reply = (source, text = 'Use the staging gate.', replaces = null) => ({ records: [{ kind: 'rule', text, turn: source, replaces }], done: [] });
const result = (value) => ({ text: JSON.stringify(value), message: null, usage: { provider: 'fake', model: 'fake', miss: 3, cacheRead: 4, output: 5 } });

test('ledger windows preserve long spoken text, exclude traces and stop at four turns', () => {
  const text = 'Rule: use staging.\n'.repeat(4000);
  const first = turn(text);
  first.entries.push({ kind: 'tool', text: 'private trace', time: first.at });
  const segments = ledgerSegments([first]);
  assert.equal(segments.map((part) => part.text).join(''), text.trim());
  assert.ok(segments.every((part) => part.text.length <= 16000 && !part.text.includes('private trace')));
  assert.equal(ledgerWindow(ledgerSegments(Array.from({ length: 8 }, (_, n) => turn(`Rule ${n}`, n))), 0).length, 4);
  assert.doesNotMatch(ledgerPrompt(segments.slice(0, 1), []), /private trace/);
});

test('a cached ledger is source-bound and read-only recovery never repairs its file', () => {
  const dir = roots.fresh();
  const segments = ledgerSegments([turn('Use staging.')]);
  const data = new LedgerData(dir, segments);
  const parsed = ledgerReply(reply('t00001'), segments, []);
  const batch = data.batchFor(segments, parsed);
  data.saveBatch(batch);
  data.apply(batch, segments);
  const before = fs.readFileSync(data.batchFile(0), 'utf8');
  assert.equal(new LedgerData(dir, segments).records.length, 1);
  const changed = new LedgerData(dir, ledgerSegments([turn('Use production instead.')]));
  assert.equal(changed.covered, 0);
  assert.deepEqual(changed.records, []);
  assert.equal(fs.readFileSync(data.batchFile(0), 'utf8'), before);
});

test('invalid sources, kinds and contradictory replacement operations reject the whole batch', () => {
  const source = ledgerSegments([turn('New rule.')]);
  const current = [{ id: 'R0001', kind: 'rule', text: 'Old rule.', turn: 't00000', date: '2026-09-30', replaces: null, status: 'current' }];
  assert.equal(ledgerReply(reply('t99999'), source, current), undefined);
  assert.equal(ledgerReply({ ...reply('t00001'), records: [{ ...reply('t00001').records[0], kind: 'secret' }] }, source, current), undefined);
  const replacement = reply('t00001', 'New rule.', 'R0001');
  assert.equal(ledgerReply({ ...replacement, records: [...replacement.records, ...replacement.records] }, source, current), undefined);
  assert.equal(ledgerReply({ ...replacement, done: ['R0001'] }, source, current), undefined);
  assert.equal(ledgerReply({ records: [], done: ['R0001', 'R0001'] }, source, current), undefined);
  assert.equal(ledgerReply({ records: [], done: ['R0001'] }, source, current), undefined, 'a standing rule is never completed');
  assert.ok(ledgerReply({ records: [], done: ['R0001'] }, source, [{ ...current[0], kind: 'open-work' }]));
  assert.ok(ledgerReply(replacement, source, current));
});

test('rewriting an invalid prefix never reuses its stale cached suffix', () => {
  const dir = roots.fresh();
  const old = ledgerSegments([turn('Old first rule.', 1), turn('Old second rule.', 2)]);
  const data = new LedgerData(dir, old);
  for (const source of old) {
    const window = [source], batch = data.batchFor(window, reply(source.turn, source.text));
    data.saveBatch(batch); data.apply(batch, window);
  }
  const tail = fs.readFileSync(data.batchFile(1), 'utf8');
  const changed = ledgerSegments([turn('New first rule.', 1), turn('Old second rule.', 2)]);
  const recovering = new LedgerData(dir, changed);
  assert.equal(recovering.covered, 0);
  const batch = recovering.batchFor([changed[0]], reply(changed[0].turn, 'New first rule.'));
  recovering.saveBatch(batch); recovering.apply(batch, [changed[0]]);
  const restarted = new LedgerData(dir, changed);
  assert.equal(restarted.covered, 1);
  assert.equal(restarted.records.length, 1);
  assert.equal(fs.readFileSync(data.batchFile(1), 'utf8'), tail);
});

test('the real memory appends, extracts, accounts, renders and restarts its own ledger', async () => {
  const dir = roots.fresh();
  const config = resolveConfig({ ledger: true });
  let calls = 0;
  const memory = new Memory({ memoryId: 'm', key: KEY, dir, config, log: keptLog(), summarize: async (messages) => {
    calls++;
    assert.match(messages[0].texts[0], /New messages:/);
    return result(reply('t00001'));
  } });
  memory.appendTurn(turn('Use staging.'));
  await settleTicks();
  assert.equal(calls, 1);
  assert.equal(memory.usage.totals.calls, 1);
  assert.match(memory.render(), /<chat>[\s\S]*<\/chat>\n\n<decisions>[\s\S]*Use the staging gate/);
  const rendered = memory.render();
  memory.close();
  const snapshot = new MemoryData({ memoryId: 'm', key: KEY, dir, config, log: keptLog(), repair: false });
  assert.equal(snapshot.render(), rendered);
  const again = new Memory({ memoryId: 'm', key: KEY, dir, config, log: keptLog(), summarize: async () => assert.fail('covered ledger was regenerated') });
  again.pumpSoon();
  await settleTicks();
  assert.equal(again.render(), rendered);
  again.close();
});

test('closing an in-flight writer forbids late ledger publication and releases the memory', async () => {
  const dir = roots.fresh();
  let finish;
  const config = resolveConfig({ ledger: true });
  const memory = new Memory({ memoryId: 'm', key: KEY, dir, config, log: keptLog(), summarize: () => new Promise((resolve) => { finish = resolve; }) });
  memory.appendTurn(turn('Use staging.'));
  await settleTicks();
  memory.close();
  finish(result(reply('t00001')));
  await settleTicks();
  assert.equal(memory.ledger.covered, 0);
  assert.equal(fs.existsSync(memory.ledger.batchFile(0)), false);
  assert.equal(memory.ledgerWriter.controller.signal.aborted, true);
});

test('a failed durable write publishes nothing and retries from the same cursor', async () => {
  const records = [turn('Use staging.')];
  const data = new LedgerData(roots.fresh(), ledgerSegments(records));
  const save = data.saveBatch.bind(data);
  data.saveBatch = () => { throw new Error('disk write failed'); };
  const writer = new LedgerWriter({ data, records, summarize: async () => result(reply('t00001')), canCall: () => true, log: keptLog(), spent: () => {} });
  await assert.rejects(writer.run(), /disk write failed/);
  assert.equal(data.covered, 0);
  assert.deepEqual(data.records, []);
  assert.deepEqual(data.batches, []);
  data.saveBatch = save;
  await writer.run();
  assert.equal(data.covered, 1);
  assert.equal(new LedgerData(path.dirname(data.dir), ledgerSegments(records)).covered, 1);
  writer.close();
});

test('the real ledger writer accepts omitted empty completion lists without weakening validation', async () => {
  const records = [turn('Use staging.')];
  const segments = ledgerSegments(records);
  const data = new LedgerData(roots.fresh(), segments);
  const value = { records: reply('t00001').records };
  const writer = new LedgerWriter({ data, records, summarize: async () => result(value), canCall: () => true, log: keptLog(), spent: () => {} });
  await writer.run();
  assert.equal(data.covered, 1);
  assert.equal(data.records.length, 1);
  assert.deepEqual(data.batches[0].done, []);
  assert.equal(ledgerReply({ ...value, done: null }, segments, []), undefined);
  assert.equal(ledgerReply({ ...value, done: ['R9999'] }, segments, []), undefined);
  assert.equal(ledgerReply({ records: reply('t99999').records }, segments, []), undefined);
  writer.close();
});

test('the background ledger never logs provider exception contents', async () => {
  const records = [turn('Use staging.')];
  const data = new LedgerData(roots.fresh(), ledgerSegments(records));
  const warnings = [];
  let spent = 0;
  const writer = new LedgerWriter({ data, records,
    summarize: async () => { throw Object.assign(new Error('synthetic-private-provider-content'), { usage: { output: 7 } }); },
    canCall: () => true, log: { warn: (message) => warnings.push(message) }, spent: () => { spent++; } });
  writer.pump();
  await settleTicks();
  assert.equal(spent, 1);
  assert.equal(data.covered, 0);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /synthetic-private-provider-content/);
  assert.match(warnings[0], /source cursor is unchanged/);
  writer.close();
});

test('ledger framing counts against the byte limit and feature context floors reserve added bytes', () => {
  const segments = ledgerSegments([turn('Use staging.')]);
  const data = new LedgerData(roots.fresh(), segments);
  data.apply(data.batchFor(segments, reply('t00001', 'Rule '.repeat(100))), segments);
  for (const budget of [64, 256, 600, 1000]) assert.ok(Buffer.byteLength(data.render(budget)) <= budget);
  assert.equal(minimumContextTokens(resolveConfig({ autoRecall: false })), 65536);
  assert.equal(minimumContextTokens(resolveConfig({ ledger: true })), 122560);
  assert.throws(() => resolveConfig({ ledgerBytes: 100000 }), /ledgerBytes/);
});

test('ledger work reaches the real adapter with a recognized JSON task on the chosen account', async () => {
  const config = resolveConfig({ ledger: true });
  const system = { role: 'system', content: [{ type: 'text', text: systemSection(config) }] };
  const seen = [];
  const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }), async *stream(options) {
    seen.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: JSON.stringify(reply('t00001')) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const summarize = llmSummarizer({ llm, route: () => ({ provider: 'chosen', model: 'flash', prefix: () => ({ system }) }), writer: config.writer, sessionId: 's', system: 'unused' });
  const records = [turn('Use staging.')];
  const data = new LedgerData(roots.fresh(), ledgerSegments(records));
  const writer = new LedgerWriter({ data, records, summarize, canCall: () => true, log: keptLog(), spent: () => {} });
  await writer.run();
  assert.equal(data.covered, 1);
  assert.deepEqual([seen[0].provider, seen[0].model, seen[0].reasoningEffort], ['chosen', 'flash', 'off']);
  assert.match(seen[0].messages[0].content[0].text, /followed by "compress message", "merge lines" or "extract ledger"/);
  assert.match(seen[0].messages[0].content[0].text, /return the JSON the task requests, not a summary line/);
  assert.match(seen[0].messages[1].content[0].text, /^Compaction: extract ledger/);
  writer.close();
});
