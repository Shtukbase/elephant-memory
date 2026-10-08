// Which memory a conversation belongs to.
//
// A memory belongs to who answers and where: the key is (agent, project), and
// its id is the first 16 hex digits of sha256 over `agent + "\n" + project`.
// A host names the key through `endless.bind` before a chat's first turn;
// a chat nobody bound uses the default key, (its preset id, its workspace).
//
// The preset is the one the chat runs, not the one it was made with: the
// harness's web UI creates a session in its default mode (the header says
// `standard`) and records a mode picked before the first message as an
// `agent-preset/selected` event. The newest such event wins over the header,
// so every chat in the Endless mode in one folder shares one memory however
// its mode was chosen.

import { createHash } from 'node:crypto';

/** `name`: the agent's display name, when the host gave one at the bind. @typedef {{ agent: string, project: string, name?: string }} MemoryKey */

/** The preset this package ships; the default agent of a chat whose header names none. */
export const PRESET_ID = 'endless';

/** @param {string} agent @param {string} project */
export function memoryIdOf(agent, project) {
  return createHash('sha256').update(`${agent}\n${project}`, 'utf8').digest('hex').slice(0, 16);
}

/** A display name: visible text on one line, without a colon (it heads a tag). @param {unknown} value @returns {value is string} */
export function isAgentName(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200 && !/[\u0000-\u001f\u007f:]/u.test(value);
}

/**
 * The name the summary lines tag the agent's replies with: the display name
 * the host bound (`agentName` in `endless.bind`), and only when none was
 * bound a name read from the agent's address, title-cased
 * (`team/agents/release-captain` → "Release Captain"), else the configured
 * `agentName` (a chat nobody bound).
 * @param {MemoryKey} key @param {string} fallback
 */
export function agentNameOf(key, fallback) {
  if (isAgentName(key.name)) return key.name.trim();
  if (!key.agent.includes('/')) return fallback;
  const words = (key.agent.split('/').filter(Boolean).at(-1) ?? '').split(/[-_\s]+/).filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ');
  return isAgentName(words) ? words : fallback;
}

/** @param {unknown} value @returns {value is string} */
export function isMemoryId(value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

/** One side of a key: some visible text, no control characters, bounded. @param {unknown} value @returns {value is string} */
export function isKeyText(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @param {unknown} value @returns {value is string} */
const isPreset = (value) => typeof value === 'string' && value !== '';

/**
 * The preset a chat runs: the newest `agent-preset/selected` event of its log,
 * else its header's, else this package's.
 * @param {{ header?: { agentPreset?: string }, seq?: number, eventAt?(seq: number): any } | undefined} session
 */
export function presetOf(session) {
  for (let seq = (session?.seq ?? 0) - 1; seq >= 0; seq--) {
    const event = session?.eventAt?.(seq);
    if (event?.type === 'agent-preset/selected' && isPreset(event.data?.agentPreset)) return event.data.agentPreset;
  }
  const preset = session?.header?.agentPreset;
  return isPreset(preset) ? preset : PRESET_ID;
}

/**
 * The key of a chat nobody bound: the preset it runs and its workspace.
 * @param {{ header?: { agentPreset?: string, cwd?: string }, seq?: number, eventAt?(seq: number): any } | undefined} session
 * @returns {MemoryKey}
 */
export function defaultKey(session) {
  const cwd = session?.header?.cwd;
  return { agent: presetOf(session), project: typeof cwd === 'string' ? cwd : '' };
}
