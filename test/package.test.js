// The package as something to publish on its own: its name stands in the few
// places that must spell it, its browser bundle is the one its sources make,
// it ships every file it names, and nothing in it points at a machine.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertClientFresh } from '../scripts/build-client.js';
import { COMPACTION_NOTE_PREFIX, DISPLAY_NAME, PACKAGE_NAME } from '../lib/identity.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const manifest = JSON.parse(read('package.json'));

/** Every file of the package that is not a test, a run folder or a dependency, as a path under the package. */
function shipped(dir = '') {
  /** @type {string[]} */
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.runs', 'test', '.git'].includes(entry.name)) continue;
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...shipped(here));
    else found.push(here);
  }
  return found;
}

test('lib/client.js is exactly what client/ and the build make', async () => {
  await assertClientFresh();
});

test('the browser bundle names no host product and touches no harness code, only its public seats', () => {
  const bundle = read('lib/client.js');
  assert.doesNotMatch(bundle, /shtukbase|__SHTUKBASE/i);
  // Nothing patched into the harness is read: the row, the quiet node and the tab all go through keyed seats.
  assert.doesNotMatch(bundle, /toolWords|readToolWords|fileFaces/);
  // The page asks through the harness's connection, never by its own fetch.
  assert.doesNotMatch(bundle, /\bfetch\(/);
  assert.match(bundle, /rpc\.call\('\/api'/);
});

test('the package name is one value: package.json, lib/identity.js and the preset\'s memory row agree', () => {
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.match(read('presets/endless.patch.yml'), new RegExp(`\\n {16}name: ${PACKAGE_NAME}\\n`));
  assert.match(read('lib/client.js'), new RegExp(`id: '${PACKAGE_NAME}'`));
  assert.match(read('README.md'), new RegExp(`^# ${DISPLAY_NAME}\\n`, 'm'));
  assert.ok(COMPACTION_NOTE_PREFIX.endsWith(':'));
});

test('the name is spelled only where a rename has to touch it', () => {
  const holders = shipped().filter((file) => !file.endsWith('.png') && read(file).includes(PACKAGE_NAME)).sort();
  assert.deepEqual(holders, [
    'README.md',
    'SEAMS.md',
    'TRY.md',
    'lib/client.js',
    'lib/identity.js',
    'package.json',
    'presets/endless.patch.yml',
  ]);
});

test('the preset also mounts the browser half at the top of the profile, by a path from the patch to a file with no server code', async () => {
  const patch = read('presets/endless.patch.yml');
  const row = /- id: endless-client\n {6}name: (\S+)\n/.exec(patch);
  assert.ok(row, 'the client row is in the patch');
  const file = path.resolve(ROOT, 'presets', row[1]);
  assert.equal(file, path.join(ROOT, 'lib', 'client-host.js'));
  const host = (await import(pathToFileURL(file).href)).default;
  assert.equal(typeof host.apply, 'function');
  assert.deepEqual([...host.inject], []);
  assert.doesNotMatch(read('lib/client-host.js'), /^import /m);
});

test('package.json is ready for a package of its own: licence, repository, keywords, engines, files, client entry', () => {
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.author, 'Shtukbase');
  assert.equal(manifest.repository.url, 'git+https://github.com/Shtukbase/elephant-memory.git');
  assert.equal(manifest.homepage, 'https://github.com/Shtukbase/elephant-memory#readme');
  assert.equal(manifest.bugs.url, 'https://github.com/Shtukbase/elephant-memory/issues');
  for (const word of ['deepseek', 'deepseek-harness', 'dsh-plugin', 'memory']) assert.ok(manifest.keywords.includes(word), word);
  assert.equal(manifest.engines.node, '>=22');
  assert.match(manifest.engines.dsh, /0\.2\.0-rc\.2 <0\.3\.0-0/);
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.deepEqual({ ...manifest.dsh.client }, { platform: 'web', inject: [] });
  assert.deepEqual([...manifest.dsh.bundle.patch], ['./presets/endless.patch.yml']);
  // No dependency of its own: only the harness's own packages, as optional peers.
  assert.equal(manifest.dependencies, undefined);
  assert.ok(Object.keys(manifest.peerDependencies).every((name) => name.startsWith('@deepseek-ai/')));
  assert.match(manifest.scripts.test, /node --test/);
});

test('every file the package names in `files` exists, and the client bundle and the logo are among them', () => {
  const lib = fs.readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`);
  assert.ok(manifest.files.includes('lib/*.js'));
  for (const file of ['lib/client.js', 'lib/client-host.js', 'lib/index.js']) assert.ok(lib.includes(file), file);
  for (const entry of manifest.files.filter((/** @type {string} */ name) => !name.includes('*'))) assert.ok(fs.existsSync(path.join(ROOT, entry)), entry);
  assert.ok(manifest.files.includes('assets/elephant.png'));
  assert.ok(fs.statSync(path.join(ROOT, 'assets', 'elephant.png')).size > 1000);
});

test('the licence is MIT, held by the publisher', () => {
  const licence = read('LICENSE');
  assert.match(licence, /^MIT License\n\nCopyright \(c\) 2026 Shtukbase\n/);
  assert.match(licence, /Permission is hereby granted, free of charge/);
});

test('the CI workflow travels with the package: Node 22 and 24, a read-only token and the package\'s own tests', () => {
  const workflow = read('.github/workflows/test.yml');
  assert.match(workflow, /node-version: \[22, 24\]/);
  assert.match(workflow, /permissions:\n {2}contents: read\n/);
  assert.match(workflow, /node --test --test-timeout=20000 --test-force-exit test\/\*\.test\.js/);
  assert.match(workflow, /node scripts\/build-client\.js --check/);
  assert.doesNotMatch(workflow, /npm publish|pnpm publish/);
});

test('nothing published points at a machine: no home folder, no local path, no private host', () => {
  for (const file of shipped().filter((name) => !name.endsWith('.png'))) {
    assert.doesNotMatch(read(file), /\/Users\/|\/home\/[a-z]|\.shtukbase|~\/projects|C:\\Users/i, file);
  }
});

test('the README opens with the logo, the name and the tagline, and has what a stranger needs', () => {
  const readme = read('README.md');
  assert.match(readme, /^<img src="assets\/elephant\.png" width="128" alt="Elephant Memory">\n/);
  assert.match(readme, /^# Elephant Memory\n/m);
  assert.match(readme, /Your DeepSeek agent never forgets/);
  for (const needle of ['## Install', 'dsh plugin --profile web add dsh-elephant-memory', '## Choose the Endless preset', '## How memory is keyed', '## History', '## Looking back', '## Cost and cache', '## Configuration', '## Limitations', '## How it works', '### Deviations from the specification', '## Contributing', '## License', 'github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449', 'github.com/Shtukbase/elephant-memory']) {
    assert.ok(readme.includes(needle), needle);
  }
  // The repository and the npm package exist (0.1.0 is published): the README carries both badges.
  assert.match(readme, /img\.shields\.io\/npm\/v\/dsh-elephant-memory/);
  assert.match(readme, /actions\/workflows\/test\.yml\/badge\.svg/);
});

test('every configuration key is in the README\'s table, and every deviation the code names is in its list', () => {
  const readme = read('README.md');
  for (const key of ['agentName', 'you', 'viewBytes', 'viewFloorBytes', 'lineBytes', 'granularity', 'writer.model', 'writer.batch', 'writer.reasoningEffort', 'recallSearch', 'root', 'contextKinds']) {
    assert.match(readme, new RegExp(`\\| \`${key.replace('.', '\\.')}\` \\|`), key);
  }
  for (const words of ['Three tries, then a trim; a 1.25× tolerance', 'Writer reasoning effort `off`', 'The language guard', '"Compaction:" marker', 'Retries every 10 s', 'Several lines per summary call']) {
    assert.ok(readme.includes(words), words);
  }
});
