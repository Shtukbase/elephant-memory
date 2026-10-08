// The tasks scale their ruler with the line budget; configuration refuses
// another provider for the summaries and a floor at or over the ceiling; the
// system section, the same for turns and compactions, never changes between turns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { TASK_MARKER, compressTask, mergeTask, retryTask } from '../lib/prompts.js';
import { systemSection } from '../lib/system-section.js';

test('the ruler is exactly the line budget in dashes, and the word count scales with it', () => {
  const task = compressTask(7, 'you: hi', 256);
  assert.equal(task, `Compaction: compress message 7 into one line of at most 256 bytes\n(about 35 words), the length of this ruler:\n${'-'.repeat(256)}\nWrite the line in the language of the messages it summarizes.\n<input>\nyou: hi\n</input>`);
});

test('the view\'s floor is half its ceiling unless set, and must stay under it', () => {
  assert.equal(resolveConfig({}).viewBytes, 128_000);
  assert.equal(resolveConfig({}).viewFloorBytes, 64_000);
  assert.equal(resolveConfig({ viewBytes: 20_000 }).viewFloorBytes, 10_000);
  assert.equal(resolveConfig({ viewBytes: 20_000, viewFloorBytes: 12_000 }).viewFloorBytes, 12_000);
  assert.throws(() => resolveConfig({ viewBytes: 20_000, viewFloorBytes: 20_000 }), /viewFloorBytes/);
});

test('summaries can never be sent to another provider, and bad values are loud', () => {
  assert.throws(() => resolveConfig({ writer: { provider: 'other', model: 'x' } }), /writer\.provider/);
  assert.throws(() => resolveConfig({ granularity: 'message' }), /granularity/);
  assert.throws(() => resolveConfig({ agentName: 'Two: words' }), /agentName/);
  assert.equal(resolveConfig({ writer: { model: 'deepseek-v4-pro' } }).writer.model, 'deepseek-v4-pro');
  assert.equal(resolveConfig({}).granularity, 'turn');
});

test('the system section also instructs compactions, so a compaction can send the conversation\'s own prompt', () => {
  const section = systemSection(resolveConfig({ agentName: 'Orchestrator' }));
  assert.match(section, /Each call to you is a turn or a compaction/);
  assert.match(section, /A call is a compaction ONLY when\nits last message opens with the summary writer's task marker, "Compaction:",/);
  assert.match(section, /Every other message is the person talking: answer it as a turn/);
  assert.match(section, /Call no tools, and output only the line,\nwithout an id\+n\| head\./);
  assert.match(section, /<chat> is context: use it to understand <input>/);
  // A live trial on 2026-10-08: asked for "word for word", the agent quoted a summary line as the person's sentence.
  assert.match(section, /A\nline is a summary, never anyone's exact words: before you quote what was\nsaid, zoom until you have the message whole\./);
  assert.match(section, /A text too long for one message is split over several in a row\./);
});

test('the system section depends on configuration only', () => {
  const config = resolveConfig({ agentName: 'Orchestrator' });
  assert.equal(systemSection(config), systemSection(config));
  assert.ok(systemSection(config).includes('Files are the truth about the current state; your memory is history. The latest\nruling from the person wins.'));
  assert.ok(systemSection(config).includes('recall_search(query)'));
  assert.ok(!systemSection(resolveConfig({ recallSearch: false })).includes('recall_search'));
});

// Live trial 2026-10-08: the gist's "You keep no memory between turns" made the
// agent tell the person it could not remember, while it answered from the view.
test('the system section tells the agent the view is its memory, never that it has none', () => {
  const section = systemSection(resolveConfig({ agentName: 'Orchestrator' }));
  assert.doesNotMatch(section, /keep no memory/i);
  assert.match(section, /Your memory of this conversation is the view/);
  assert.match(section, /never tell the person you have no memory/);
});

// A 12-turn trial run on 2026-10-08: merged lines of two memories carried "v114 notes", "moved
// search task to wave 12" and "colleague: blames disk reads; wants timing on 9
// folders": the old sample line, numbers widened, copied into merges.
test('no writer task carries example content, and a merge may use only the facts of its lines', () => {
  const tasks = [
    compressTask(3, 'you: A', 512),
    mergeTask({ a: '0+1', b: '1+1', id: 0, end: 1, lineA: '0+1|A', lineB: '1+1|B' }, 512),
    retryTask('A'.repeat(600), 512),
  ];
  for (const task of tasks) {
    assert.doesNotMatch(task, /wave 12|disk reads|9 (largest )?folders|v(ersion )?1*4\b|release notes|benchmark|timing/i);
  }
  assert.match(tasks[1], /\nUse only facts present in the lines being merged and in those messages\.\n<input>/);
  const section = systemSection(resolveConfig({}));
  assert.doesNotMatch(section, /wave 12|disk reads|9 (largest )?folders|version 1*4\b/i);
});

// A 12-turn trial run on 2026-10-08: twice a one-line ruling became 12 unrequested edits in 8 files.
test('the system section says a stated rule is kept and confirmed, and files change only when asked', () => {
  assert.match(systemSection(resolveConfig({})), /When the person states a rule or preference, keep\nit and confirm it; change files only when the person asks for a change\./);
});

// A 12-turn trial run on 2026-10-08: no effort sent meant the adapter's "high", a median 8.8k output tokens a summary.
test('the writer thinks at the lowest effort the DeepSeek adapter accepts unless one is configured', () => {
  assert.equal(resolveConfig({}).writer.reasoningEffort, 'off');
  assert.equal(resolveConfig({ writer: { model: '', reasoningEffort: '' } }).writer.reasoningEffort, 'off', 'the host\'s composed row sends an empty effort');
  assert.equal(resolveConfig({ writer: { reasoningEffort: 'high' } }).writer.reasoningEffort, 'high');
});

// A host binds the agent's display name, so lines read "Orchestrator:",
// while the section, built once from the shared preset row, said "Assistant:".
test('the system section names no agent: one byte-identical section serves every agent, and says replies carry the name the view shows', () => {
  const plain = systemSection(resolveConfig({}));
  for (const agentName of ['Assistant', 'Orchestrator', 'Release captain']) {
    const section = systemSection(resolveConfig({ agentName }));
    assert.equal(section, plain, `the section changed with agentName ${agentName}`);
    assert.ok(!section.includes(agentName), `the section names ${agentName}`);
  }
  assert.match(plain, /your name as the view shows it, for example "<your name>:" \(your replies\)/);
  assert.match(plain, /"you:" \(the person's own words/);
});

// A 201-turn trial run on 2026-10-08: a person's turn was answered as a compaction ("This message is a compaction task").
test('every writer task opens with the marker the section names, and says to write in the messages\' language', () => {
  const tasks = [compressTask(3, 'you: A', 512), mergeTask({ a: '0+1', b: '1+1', id: 0, end: 1, lineA: '0+1|A', lineB: '1+1|B' }, 512)];
  for (const task of tasks) {
    assert.ok(task.startsWith(`${TASK_MARKER} `), task.slice(0, 40));
    assert.match(task, /\nWrite the line in the language of the messages it summarizes\.\n/);
  }
  assert.ok(systemSection(resolveConfig({})).includes(`task marker, "${TASK_MARKER}",`));
});
