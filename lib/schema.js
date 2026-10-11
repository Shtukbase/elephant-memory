// The configuration schema the harness validates a row's `config` against.
// `resolveConfig` (config.js) applies the same defaults and refuses the same
// bad values, so the engine never depends on the schema having run.

import z from '@deepseek-ai/schemastery';
import { DEFAULTS } from './config.js';

export const Config = z.object({
  agentName: z.string().default(DEFAULTS.agentName)
    .description('The name the summary lines use for the agent ("<agentName>: …").'),
  you: z.string().default(DEFAULTS.you)
    .description('The word the summary lines use for the person.'),
  viewBytes: z.natural().default(DEFAULTS.viewBytes)
    .description('The view passes this many bytes, then one batch of merges brings it down to viewFloorBytes.'),
  viewFloorBytes: z.natural()
    .description('Bytes the view is merged down to once it passes viewBytes; absent, half of viewBytes.'),
  lineBytes: z.natural().default(DEFAULTS.lineBytes)
    .description('Target bytes of one summary line.'),
  granularity: z.union([z.const('turn'), z.const('step')]).default(DEFAULTS.granularity)
    .description('turn: per turn, the person\'s message, one trace of the tool uses, the reply. step: one entry per reply, tool call and tool result.'),
  writer: z.object({
    model: z.string().default('')
      .description('Another model of the conversation\'s own provider for the summaries; empty means the conversation\'s model.'),
    reasoningEffort: z.string().default('')
      .description('Reasoning effort for the summary calls; empty means "off", the lowest the DeepSeek adapter accepts.'),
    batch: z.natural().min(1).default(DEFAULTS.writer.batch)
      .description('Most summary lines one writer call writes when several are ready at once; 1 is one line per call.'),
  }),
  recallSearch: z.boolean().default(DEFAULTS.recallSearch)
    .description('Offer recall_search over the raw history.'),
  recall: z.boolean().default(DEFAULTS.recall)
    .description('Offer recall: one ranked search that returns the best past messages with the messages around them.'),
  autoRecall: z.boolean().default(DEFAULTS.autoRecall)
    .description('Search the memory with each new message of the person and put the best matches after the view, before the first model step.'),
  lineTools: z.boolean().default(DEFAULTS.lineTools)
    .description('Offer zoom and recall_search; false leaves recall as the one way to look back.'),
  lookBackRules: z.boolean().default(DEFAULTS.lookBackRules)
    .description('Add the look-back rules to the system prompt: search first, stop after two empty searches, cite the date or say it is not recorded.'),
  recallMost: z.natural().min(1).max(50).default(DEFAULTS.recallMost)
    .description('Most passages one recall result or one auto-recall block shows; a passage is about 300 to 500 tokens.'),
  ledger: z.boolean().default(DEFAULTS.ledger)
    .description('Extract dated decisions and rules from finished turns in the background. The shipped preset enables this.'),
  ledgerBytes: z.natural().min(512).max(64000).default(DEFAULTS.ledgerBytes)
    .description('Most bytes of the dated decision ledger added after the summary view.'),
  root: z.string().default(DEFAULTS.root)
    .description('Folder for the memories; empty means <harness home>/endless.'),
  contextKinds: z.array(z.string()).default([])
    .description('Message source kinds of the host\'s own standing context, kept before the view like the harness\'s context messages; only the newest of each kind is kept.'),
});
