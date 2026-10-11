// @clauses POCK-22
// On a phone the harness runs in a browser worker whose `node:vm` refuses every
// call. Recall must still load there, and only its /pattern/ search says it
// cannot run. TEETH: compile the scan at import again (the old
// `const PATTERN_SCAN = new vm.Script(…)`) and the import below throws, so the
// first case fails — exactly how the plugin failed to load on the phone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { MemoryTree } from './fixtures.js';

const CONFIG = { agentName: 'Assistant', you: 'you', granularity: /** @type {const} */ ('turn'), lineBytes: 512 };

test('recall loads and searches words where no script can be made, and says so for a pattern', async () => {
  const real = vm.Script;
  // As upstream's worker host answers `new vm.Script`: a refusal, thrown.
  vm.Script = /** @type {typeof vm.Script} */ (/** @type {unknown} */ (class {
    constructor() {
      throw new Error('web-preview: node:vm.Script is not available in the worker host');
    }
  }));
  try {
    const { recallSearch } = await import('../lib/recall.js?without-vm');
    const texts = ['the harbour gauge reads high', 'tide tables arrived'];
    const tree = new MemoryTree();
    tree.set(0, 0, 'L0.0');
    tree.set(0, 1, 'L0.1');
    tree.set(1, 0, 'L1.0');
    const entries = texts.map((text, i) => ({ i, kind: 'user', text, size: Buffer.byteLength(text), time: 1_760_000_000_000 + i * 60_000 }));
    const memory = { size: entries.length, entry: (/** @type {number} */ i) => entries[i], tree, config: CONFIG };
    assert.match(recallSearch(memory, 'tide'), /tide tables arrived/u);
    assert.equal(recallSearch(memory, '/ti.e/'), 'A pattern search cannot run here. Search for plain words instead.');
  } finally {
    vm.Script = real;
  }
});
