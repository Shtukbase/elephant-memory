// One writing process per memory. Two writers appending to one order or one
// tree would interleave and corrupt it.
//
// Every chat of a memory in this process shares one open memory, so their
// finished turns are appended one at a time, whole. A second process that
// wants the same memory (a second app build, say) is refused while the first
// holds it: a lock file created exclusively, holding the owner's process id,
// plus a process-wide set so a reloaded module in the same process cannot
// open the same memory twice. A lock whose owner process is gone is stale and
// taken over. Weakness, stated: if the operating system reuses that process id
// for a live process, the lock looks held; delete the `lock` file by hand then.

import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_NAME } from './identity.js';

const HELD_KEY = Symbol.for(`${PACKAGE_NAME}/held-locks`);
/** @type {Set<string>} */
const held = /** @type {any} */ (globalThis)[HELD_KEY] ?? new Set();
/** @type {any} */ (globalThis)[HELD_KEY] = held;

export class LockHeldError extends Error {
  /** @param {string} file @param {number | null} pid */
  constructor(file, pid) {
    super(`[ENDLESS_LOCK] ${file} is held by ${pid === process.pid || pid === null ? 'this process' : `process ${pid}`}`);
    this.name = 'LockHeldError';
  }
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** @param {string} file @returns {number | null} */
function ownerOf(file) {
  try {
    const pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock of one memory folder for as long as this process keeps it open.
 * @param {string} dir @returns {() => void} the release
 */
export function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'lock');
  if (held.has(file)) throw new LockHeldError(file, process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      held.add(file);
      return () => {
        if (!held.delete(file)) return;
        fs.rmSync(file, { force: true });
      };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      const pid = ownerOf(file);
      if (pid !== null && pid !== process.pid && alive(pid)) throw new LockHeldError(file, pid);
      // The owner is gone (or was an earlier, released life of this process): stale.
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockHeldError(file, null);
}
