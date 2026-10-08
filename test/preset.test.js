// The Endless preset is Creator's rows with the changes its patch file names:
// no plugin manager tool, no persona row of its own (the
// deployment's `system-prompt` persona applies), the endless group in place
// of compaction, and the plugin's whole config restated with its defaults.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/config.js';

const preset = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'endless.patch.yml'), 'utf8');
/** The YAML without its comments. */
const rows = preset.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

test('the preset carries no plugin manager tool, no plan mode and no persona row of its own', () => {
  assert.doesNotMatch(rows, /tool-plugin-manager|dsh-plugin-manager/);
  assert.doesNotMatch(rows, /dsh-plan-mode|id: planning\b/);
  assert.doesNotMatch(rows, /dsh-persona|id: persona\b/);
  assert.doesNotMatch(rows, /You are a coding agent/);
});

test('the preset is `endless`, with the endless group isolated in place of compaction', () => {
  assert.match(rows, /^ {4}- id: preset-endless\n {6}name: '@deepseek-ai\/dsh-agent-preset'\n {6}config:\n {8}id: endless\n {8}name: Endless\n/m);
  assert.match(rows, /- id: endless\n {12}name: cordis:group\n {12}group: true\n {12}isolate:\n {14}compaction: true\n/);
  assert.doesNotMatch(rows, /dsh-compaction-basic|dsh-command-compact|tool-result-pruner/);
  // Every configuration key of the plugin is restated, so a profile copying the row sees them all.
  for (const key of Object.keys(DEFAULTS)) assert.match(rows, new RegExp(`\\n {18}${key}:`), key);
  assert.match(rows, /\n {18}contextKinds: \[\]\n/);
});
