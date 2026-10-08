// Compose the browser half: client/template.js with the fragments named in
// FRAGMENTS laid into its markers, written to lib/client.js, the one file the
// harness serves for this package (`exports["./client"]`). No dependencies.
//
//   node scripts/build-client.js          write lib/client.js
//   node scripts/build-client.js --check  fail when lib/client.js is not what the sources make

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT = join('lib', 'client.js');

/** The fragments, in the order they appear in the bundle: marker name, file. */
export const FRAGMENTS = Object.freeze([
  ['memory-constants', 'constants.js'],
  ['memory-words', 'words.js'],
  ['memory-days', 'days.js'],
  ['memory-api', 'api.js'],
  ['memory-styles', 'styles.js'],
  ['memory-lookback-row', 'lookback-row.js'],
  ['memory-compaction', 'compaction.js'],
  ['memory-history-parts', 'history-parts.js'],
  ['memory-history-view', 'history-view.js'],
  ['memory-open', 'open.js'],
]);

/**
 * Replace one marker line with a fragment, keeping the marker's indentation.
 * @param {string} source @param {string} name @param {string} body
 */
function lay(source, name, body) {
  const token = `/* @${name} */`;
  const lines = source.split('\n');
  const at = lines.findIndex((line) => line.trim() === token);
  if (at < 0 || lines.filter((line) => line.includes(token)).length !== 1) throw new Error(`the client template needs exactly one ${token} line`);
  const indent = /^\s*/.exec(lines[at])?.[0] ?? '';
  lines[at] = body.trimEnd().split('\n').map((line) => (line === '' ? '' : `${indent}${line}`)).join('\n');
  return lines.join('\n');
}

/**
 * The bundle the sources make.
 * @param {string} [packageDir]
 * @returns {Promise<string>}
 */
export async function assembledClient(packageDir = PACKAGE) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const { COMPACTION_NOTE_PREFIX } = await import(pathToFileURL(join(packageDir, 'lib', 'identity.js')).href);
  if (!/^[\w .:-]+$/.test(manifest.name) || !/^[\w .:-]+$/.test(COMPACTION_NOTE_PREFIX)) throw new Error('the package name and the note prefix must be plain words');
  let source = readFileSync(join(packageDir, 'client', 'template.js'), 'utf8');
  for (const [marker, file] of FRAGMENTS) source = lay(source, marker, readFileSync(join(packageDir, 'client', file), 'utf8'));
  source = source.replaceAll('@PACKAGE_NAME@', manifest.name).replaceAll('@NOTE_PREFIX@', COMPACTION_NOTE_PREFIX);
  // A syntax error is found here, not in a person's browser.
  new vm.Script(source, { filename: 'client.js' });
  return source;
}

/** @param {string} [packageDir] */
export async function assertClientFresh(packageDir = PACKAGE) {
  const made = await assembledClient(packageDir);
  if (readFileSync(join(packageDir, OUTPUT), 'utf8') !== made) throw new Error(`${OUTPUT} is stale: run \`node scripts/build-client.js\``);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes('--check')) {
    await assertClientFresh();
    console.log(`${OUTPUT} is current`);
  } else {
    writeFileSync(join(PACKAGE, OUTPUT), await assembledClient());
    console.log(`wrote ${OUTPUT}`);
  }
}
