// The plugin's log: every line goes to the harness's logger AND to the
// process's standard error, one line each.
//
// The harness's `ctx.logger` has no printing exporter at run time: only a
// ring buffer, and the boot's startup diagnostics (warnings and errors before
// the tree is up). What the harness itself prints, it writes to standard error
// (`dsh/lib/bin.js`, `dsh: warning: …`). A trial run found 0 `[ENDLESS_WRITER_USAGE]`
// lines in the run log after 61 writer calls, while usage.jsonl was right.

/**
 * @param {{ warn(message: string): void, info(message: string): void }} logger `ctx.logger`
 * @param {(text: string) => void} [write] standard error by default
 */
export function pluginLog(logger, write = (text) => process.stderr.write(text)) {
  /** @param {string} message */
  const print = (message) => {
    try {
      write(`${message}\n`);
    } catch {
      // A closed standard error must never stop a turn.
    }
  };
  return {
    warn: (/** @type {string} */ message) => {
      logger.warn(message);
      print(message);
    },
    info: (/** @type {string} */ message) => {
      logger.info(message);
      print(message);
    },
  };
}
