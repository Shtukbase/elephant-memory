// Where memories and bindings live under the plugin's root (`<harness home>/endless`):
//
//   memories/<memoryId>/key.json       {agent, project, name?}; written once, and again when a bind names the agent anew
//   memories/<memoryId>/order-…jsonl   the finished turns (order.js)
//   memories/<memoryId>/tree-…/        the summary lines (store.js)
//   memories/<memoryId>/usage.jsonl    the writer's spend (usage.js)
//   memories/<memoryId>/lock           one writing process (lock.js)
//   sessions/<session>.json            {sessionId, memoryId, agent, project}: a chat's binding
//
// Small JSON files are written whole through a sibling file and a rename, so a
// reader never sees half of one.

import fs from 'node:fs';
import path from 'node:path';
import { isAgentName, isKeyText, isMemoryId, memoryIdOf } from './key.js';
import { pathSegment } from './text.js';

/** @typedef {import('./key.js').MemoryKey} MemoryKey */
/** @typedef {{ sessionId: string, memoryId: string, agent: string, project: string }} Binding */

/** @param {string} root @param {string} memoryId */
export const memoryDir = (root, memoryId) => path.join(root, 'memories', memoryId);

/** @param {string} root @param {string} sessionId */
const bindFile = (root, sessionId) => path.join(root, 'sessions', `${pathSegment(sessionId)}.json`);

/** Write a small JSON file whole. @param {string} file @param {unknown} value */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.${process.pid}.next`;
  fs.writeFileSync(next, `${JSON.stringify(value)}\n`);
  fs.renameSync(next, file);
}

/** @param {string} file @returns {unknown} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** @param {unknown} value @returns {value is MemoryKey} */
function isKey(value) {
  if (typeof value !== 'object' || value === null) return false;
  const key = /** @type {Record<string, unknown>} */ (value);
  return typeof key.agent === 'string' && typeof key.project === 'string';
}

/** The key a memory folder was made for, or undefined. @param {string} root @param {string} memoryId */
export function readKey(root, memoryId) {
  const value = readJson(path.join(memoryDir(root, memoryId), 'key.json'));
  if (!isKey(value) || memoryIdOf(value.agent, value.project) !== memoryId) return undefined;
  const name = /** @type {Record<string, unknown>} */ (value).name;
  return { agent: value.agent, project: value.project, ...(isAgentName(name) ? { name } : {}) };
}

/** Make sure a memory folder exists and names its key; returns its id. @param {string} root @param {MemoryKey} key */
export function ensureMemory(root, key) {
  const memoryId = memoryIdOf(key.agent, key.project);
  const stored = readKey(root, memoryId);
  const name = key.name ?? stored?.name;
  if (stored === undefined || name !== stored.name) {
    writeJson(path.join(memoryDir(root, memoryId), 'key.json'), { agent: key.agent, project: key.project, ...(name === undefined ? {} : { name }) });
  }
  return memoryId;
}

/** Every memory id with a valid key under the root, sorted. @param {string} root */
export function listMemoryIds(root) {
  const dir = path.join(root, 'memories');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => isMemoryId(name) && readKey(root, name) !== undefined).sort();
}

/** A chat's binding, or undefined. @param {string} root @param {string} sessionId @returns {Binding | undefined} */
export function readBinding(root, sessionId) {
  const value = /** @type {Record<string, unknown> | undefined} */ (readJson(bindFile(root, sessionId)));
  if (value === undefined || value.sessionId !== sessionId || !isKeyText(value.agent) || typeof value.project !== 'string') return undefined;
  const memoryId = memoryIdOf(value.agent, value.project);
  return value.memoryId === memoryId ? { sessionId, memoryId, agent: value.agent, project: value.project } : undefined;
}

/** Bind a chat to a key; returns the binding. @param {string} root @param {string} sessionId @param {MemoryKey} key */
export function writeBinding(root, sessionId, key) {
  const memoryId = ensureMemory(root, key);
  /** @type {Binding} */
  const binding = { sessionId, memoryId, agent: key.agent, project: key.project };
  writeJson(bindFile(root, sessionId), binding);
  return binding;
}
