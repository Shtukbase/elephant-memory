// One background ledger call at a time, on the summary writer's own route.
// Published batches never grow when another turn arrives. A restart resumes
// at their exact source cursor, including split long messages.
import { ledgerReply } from './ledger-data.js';
import { ledgerPrompt, ledgerSegments, ledgerWindow } from './ledger-prompt.js';
import { RETRY_MS } from './config.js';

export class LedgerWriter {
  /** @param {object} input
   * @param {import('./ledger-data.js').LedgerData} input.data
   * @param {readonly import('./turns.js').TurnRecord[]} input.records
   * @param {import('./writer.js').Summarize} input.summarize
   * @param {() => boolean} input.canCall
   * @param {import('./memory-data.js').Log} input.log
   * @param {(usage: import('./usage.js').CallUsage) => void} input.spent
   */
  constructor({ data, records, summarize, canCall, log, spent }) {
    this.data = data;
    this.records = records;
    this.summarize = summarize;
    this.canCall = canCall;
    this.log = log;
    this.spent = spent;
    this.segmentedRecords = records.length;
    this.closed = false;
    this.busy = false;
    this.controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.retry = undefined;
  }

  pump() {
    if (this.busy || this.closed || !this.canCall()) return;
    this.busy = true;
    void this.run().catch((error) => {
      const usage = /** @type {{ usage?: import('./usage.js').CallUsage }} */ (error)?.usage;
      if (usage) this.spent(usage);
      if (this.closed) return;
      // Provider exceptions may contain source messages or credentials.
      this.log.warn('[ENDLESS_LEDGER] no new records were saved; the source cursor is unchanged');
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { this.retry = undefined; this.pump(); }, RETRY_MS);
      this.retry.unref?.();
    }).finally(() => { this.busy = false; });
  }

  async run() {
    while (!this.closed && this.canCall()) {
      if (this.segmentedRecords < this.records.length) {
        this.data.segments.push(...ledgerSegments(this.records, this.segmentedRecords));
        this.segmentedRecords = this.records.length;
      }
      const window = ledgerWindow(this.data.segments, this.data.covered);
      if (!window.length) return;
      // The shared system section recognizes background work only by this
      // marker. Without it a chat persona can answer the extracted messages.
      const prompt = `Compaction: extract ledger as JSON.\n${ledgerPrompt(window, this.data.current)}`;
      const result = await this.summarize([{ role: 'user', texts: [prompt] }], this.controller.signal);
      if (result.usage) this.spent(result.usage);
      if (this.closed) return;
      const match = /\{[\s\S]*\}/.exec(result.text);
      let value;
      try { value = JSON.parse(match?.[0] ?? ''); } catch { throw new Error('the ledger reply was not readable JSON'); }
      const parsed = ledgerReply(value, window, this.data.current);
      if (!parsed) throw new Error('the ledger reply named an invalid kind, source or replacement');
      // Save a candidate snapshot before publishing it in memory. A failed
      // write must not advance the cursor or make an unsaved record visible.
      const batch = this.data.batchFor(window, parsed);
      this.data.saveBatch(batch);
      this.data.apply(batch, window);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.controller.abort();
  }
}
