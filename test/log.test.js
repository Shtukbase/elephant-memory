// A 12-turn trial run on 2026-10-08: 0 `[ENDLESS_WRITER_USAGE]` lines in the run log after 61
// writer calls. The harness's logger prints nothing at run time; the plugin's
// lines go to standard error too, where the harness prints its own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pluginLog } from '../lib/log.js';

test('every plugin log line reaches the harness logger and standard error, one line each', () => {
  /** @type {string[]} */
  const logged = [];
  /** @type {string[]} */
  const printed = [];
  const log = pluginLog({ warn: (m) => logged.push(`warn ${m}`), info: (m) => logged.push(`info ${m}`) }, (text) => printed.push(text));
  log.info('[ENDLESS_WRITER_USAGE] {"calls":1}');
  log.warn('[ENDLESS_WRITER] line 0:3 failed');
  assert.deepEqual(logged, ['info [ENDLESS_WRITER_USAGE] {"calls":1}', 'warn [ENDLESS_WRITER] line 0:3 failed']);
  assert.deepEqual(printed, ['[ENDLESS_WRITER_USAGE] {"calls":1}\n', '[ENDLESS_WRITER] line 0:3 failed\n']);
  // A broken standard error never throws into a turn.
  const quiet = pluginLog({ warn: () => {}, info: () => {} }, () => {
    throw new Error('EPIPE');
  });
  assert.doesNotThrow(() => quiet.info('x'));
});
