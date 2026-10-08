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
  }),
  recallSearch: z.boolean().default(DEFAULTS.recallSearch)
    .description('Offer recall_search over the raw history.'),
  root: z.string().default(DEFAULTS.root)
    .description('Folder for the memories; empty means <harness home>/endless.'),
  contextKinds: z.array(z.string()).default([])
    .description('Message source kinds of the host\'s own standing context, kept before the view like the harness\'s context messages; only the newest of each kind is kept.'),
});
