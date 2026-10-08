# The harness seams Elephant Memory uses, read from the harness source

Read 2026-10-08, before any engine code was written; sections h–k were read
the same day for memory per agent and project. Every answer below cites
the installed JavaScript (or, where the installed package ships no `.d.ts`, the
type declarations the harness embeds in its `typert.host.js` files). Nothing
here was booted or run, except the trial measurement quoted in "Context nodes
and the cache".

## Verdict

1. **The turn seam works as designed:** an `EndlessCompactionEngine` (a
   `CompactionEngine` subclass) mounted in its own `cordis:group` with
   `isolate: { compaction: true }`, acting in `agent/pre-step` on step 1 of
   each turn.
2. **One region replace covers the earlier conversation every turn**,
   previous checkpoint included. The session fold accepts any contiguous run of
   current surface nodes; only node 0 (the system prompt) is protected. The
   harness's context messages stay before the checkpoint (see "Context nodes
   and the cache").
3. **At that moment the new message is not on the surface yet**, so
   "everything before the new message" is simply "every node after the system
   head". The request is derived from the surface after the listener returns.
4. **No `llm/stream` interceptor and no byte patch.** An interceptor would
   break the harness's own invariant that a request equals the log's derived
   messages.
5. **Two costs come with the seam:** the rendered view is written into the
   session log once per turn, and the harness's context messages (skill
   catalog, runtime context, workspace instructions) must be kept before the
   view by the plugin itself (both explained below).

## Which harness version

- **Read and run:** `@deepseek-ai/dsh@0.2.0-rc.2`, the installed npm package.
  This file is written against it. Below, `$H` means the `node_modules/@deepseek-ai`
  folder of that installation. Line numbers are of the installed JavaScript.
- The installed packages ship `lib/*.js` only; their `lib/types/*.d.ts` files
  are absent. Types were read from the declaration strings in
  `$H/dsh-api-session-controller/lib/typert.host.js` and
  `$H/dsh-llm/lib/typert.host.js`. The `agent/pre-step` decision type was read
  from the harness's source repository (0.1.5-alpha.2,
  `packages/core/agent/src/runtime-types.ts:112-119,330`) and matches how the
  0.2.0-rc.2 JavaScript uses it.

## a. `@deepseek-ai/dsh-compaction`: the contract and one replace per turn

**The contract is a named service with no enforced methods.**
`$H/dsh-compaction/lib/index.js:169-173`:
`var CompactionEngine = class extends Service { constructor(ctx) { super(ctx, "compaction"); } }`.
The README names three operations a backend implements: `compactIfNeeded`
(automatic triggers), `compactNow` (manual), `compactRegion` (an explicit
range). The only other consumer of `ctx.compaction` in the whole install is
`$H/dsh-command-compact/lib/index.js:55` (`compactNow`).

**`compactRegion(start, end, agent, signal)` exists only in the shipped
backend**, `$H/dsh-compaction-basic/lib/index.js:971-976`, which delegates to a
private `compactSurfaceRegion` (`:450-522`). That backend adds two rules of its
own that Endless must not inherit: balanced tool pairing at both edges
(`validateSurfaceRegion`, `:550-566`) and "the summary must be smaller than
what it replaces" (`:601`). Endless implements `compactRegion` itself with the
same bracket.

**The bracket every backend writes** (`commitCompactionBody`, `:628-675`, and
the invariant `$H/dsh-compaction/lib/invariant.js:103-155`):

1. `compaction/start {compactionId, turn}`; `turn` must equal the open turn
   (`validateOwner`, `invariant.js:94-101`).
2. `compaction/summary {compactionId, summary, shadowedRange, shadowedSeqs,
   shadowedTokenCount, provider, model}`; `shadowedSeqs` must list every node
   of the current span (`invariant.js:34-48`). Without an `llm/stream` record
   the payload omits `llmStreamCall` (declaration in
   `dsh-api-session-controller/lib/typert.host.js`, `'compaction/summary'`).
3. `user/message` with `surfaceOp: { op: 'replace', startSeq, endSeq }`,
   `source: compactCheckpointSource(compactionId)` and `sourceEventSeqs`
   covering the bracket and every shadowed node (`index.js:650-661`).
4. `compaction/end {compactionId, turn}`.

`compactCheckpointSource` is exported (`$H/dsh-compaction/lib/index.js:116-122`).

**One replace may cover the whole earlier surface, every turn.** The session
fold, `$H/dsh-session/lib/index.js`:

- `replacementRange` (`:361-372`) accepts any `startSeq`/`endSeq` that are
  current surface nodes with `startIdx <= endIdx`;
- `applySurfacePlan` (`:460-478`) splices that run into the one new node:
  `state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)`;
- a previous checkpoint is an ordinary surface node, so a later replace may
  start at it;
- the one protection is `assertSystemHeadRewrite` (`:416-420`): "node 0 holds
  the system prompt and may be rewritten only by a system/message over exactly
  that node", so the span starts at surface index 1;
- `assertSourceEventReferences` (`:311-329`) requires `sourceEventSeqs` to
  include every shadowed node.

So a turn replace may cover `[surface.nodes[1] .. surface.nodes.at(-1)]`.
Endless covers that run minus a leading block of context messages, and writes
the block itself with one-node replaces (see "Context nodes and the cache").

## b. Presets and an isolated compaction group

**A preset is one composition row.** `$H/dsh-agent-preset/lib/index.js`: the
`AgentPreset` plugin takes `{ id, name, description, order, plugins }` and
registers it with `ctx.agentPresets`. Its README: "Define an Agent's child
plugins in ordinary Cordis YAML".

**Each preset gets its own scope and plugin tree, once.**
`$H/dsh-agent-preset-registry/README.md`, implementation notes: "Each
declaration eagerly creates a registry-owned scope and an in-memory Loader
tree." and "Activation auditing checks imports, missing services and globally
leaked services." So the Endless engine is one instance per preset declaration,
serving every session of that preset; per-session state is the plugin's own.

**The isolated group.** The Creator preset (`cordis`,
`$H/dsh-web-app/presets/cordis.patch.yml:62-78`) mounts its backend as:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - { id: compaction-basic, name: '@deepseek-ai/dsh-compaction-basic' }
```

A host that composes its own profile copies the same shape.
Endless uses `isolate: { compaction: true }` around its own row, so the service
never leaks out of the preset and other presets keep their own compaction.

**How a package ships a preset.** A bundle declares `dsh.bundle.patch` in
`package.json` (`$H/dsh-web-app/package.json`, `"dsh": { "bundle": { "patch": [...] } }`)
and its patch `insert`s an `@deepseek-ai/dsh-agent-preset` row. `dsh plugin
--profile <name> add <path>` installs the package and, because it declares a
bundle, appends it to `dsh.profile.bundles`
(`$H/dsh-plugin-manager/lib/types/operations.js:44-72`, `reconcile`).

**"Creator mode" is the `cordis` preset** (`$H/dsh-client-ui-agent-preset/README.md`:
"Creator starts a new task using the `cordis` preset").

## c. `agent/pre-step`

**Dispatch and payload.** `$H/dsh-agent-loop/lib/index.js:911-918`:

```js
const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal },
  () => Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] }));
```

`agentEvents` adds `agent` to the payload (`$H/dsh-agent/lib/index.js:242-273`).
So a listener gets `{ agent, messages, turn, step, signal }` and `next()`.
The decision is `{ kind: 'reject' }` or `{ kind: 'enter', messages,
startsRequestSeries? }`.

**When it fires on step 1.** `turn()` (`:936-1040`) appends `turn/start`
(`:943`), then calls `preStep(target, { turn, step: 1 })` (`:954`). `preStep`
first claims the inbox (`:906`, which logs an `agent/inbox/spliced` event),
assembles the prompt and projects the runtime context (`:907-910`), and only
then runs the waterfall.

**A listener may await.** It is a waterfall; the shipped backend awaits a whole
model call inside it (`$H/dsh-compaction-basic/lib/index.js:839-852`).

**A listener may change the surface before the request is derived.** The
claimed messages are appended only later, in `step()`
(`:1061`, `if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", ...)`),
and the request is `session.deriveMessages()` in `buildRequest` (`:1262`).
The loop notices the replace (`contentGeneration` changed) and starts a new
request series (`:1211`), re-logging the request header with `reason: 'series'`
and reconciling the system prompt at the head (`SystemPromptProjection`,
`:239-296`). The invariant `$H/dsh-agent-loop/lib/invariant.js:26-27` requires
the request messages to equal `session.deriveMessages()`, which is why the
log is the only legal place to change them.

**Refusing loses nothing durable but drops the claim.** A step that is not
taken leaves the claimed messages unappended. They stay in the log as the
`agent/inbox/spliced` that queued them (`ReactLoopInbox.claim`, `:103-111`).
Endless puts them back with `agent.inject(message)` (`:812-814`, next-step, no
wake), so the next turn delivers them, and then THROWS one plain sentence
instead of returning `reject`. On `reject` the turn ends `blocked`
(`:958-961`), which the web UI drew as "Completed in 3m 0s" with nothing said
(round-4 live walk, F5); a throw ends it `{ kind: 'error' }` (`:1012-1024`),
drawn as the chat's refusal line, and `kick` contains it (`:887-891`). The
messages go back without `source.rpcId`: the web UI keeps a person's pending
copy while an inbox insertion carries its submission id
(`dsh-api-session-controller/lib/types/client/sessions/session.js:704-716`,
`observeSubmissionInsertions`) and settles it at `turn/end` once the claim
removed it (`:700-703`), so with the id the copy was drawn as still starting
for as long as the chat was open.

**The runtime-context snapshot must stay visible.** `RuntimeContextProjection`
(`:298-350`) decides before the waterfall whether to add a fresh snapshot, and
adds one only when its text changed. When a replace shadows the retained
snapshot it forgets it (`:325`), but too late for this turn. Endless therefore
never shadows the newest snapshot without writing it again: it keeps it in the
context block (next section).

**Other listeners.** The model-switch notice is a `prepend` pre-step listener
registered per agent (`$H/dsh-agent/lib/index.js:193-204`), so it stays outside
Endless and appends after the new message; the harness guidance says to spread
a decision when rewriting it
(`$H/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`).

## Context nodes and the cache

**The defect, measured** (an isolated trial on 0.2.0-rc.2, read from its
session log). Before the fix, every turn read `turn/start`, the checkpoint bracket, the new
`user/message`, then a `runtime-context` (~500 chars) and a `skill-catalog`
(~13,000 chars) message (seqs 37-39, 87-89, 118-120). The replace had hidden
the previous ones, so their owners sent them again after the new message, in
the part of the request that changes every turn. Step 1 missed the cache on
them every turn: turn 2 read 8,064 tokens from cache and missed 3,381; turn 3,
8,320 and 3,403. The catalog also came back in its "update" form, "The available
skill catalog changed", every turn, which was false. Workspace instructions
(`agent-instructions`, ~1,100 chars, seq 72) are the third kind.

**Who sends them, and when** (all after the rest of the chain, all by what the
surface shows):

1. **Skill catalog**, `$H/dsh-tool-skill/lib/index.js:203-236`, an
   `agent/pre-step` listener on every step. It compares the entries of the
   newest VISIBLE catalog (`catalogHistory`, `:331-348`) with the current ones
   and adds a catalog only when they differ; once any catalog was published,
   the new one is the "changed" form (`:262-286`).
2. **Runtime context**, the agent loop (`$H/dsh-agent-loop/lib/index.js:907-918`),
   projected before the waterfall: a fresh snapshot only when the text differs
   from the retained one. The retained one follows every `runtime-context`
   `user/message` event, replace or not (`:319-324`), and is forgotten when a
   replace cites it in `sourceEventSeqs` (`:325`).
3. **Workspace instructions**, `$H/dsh-agent-instructions/lib/index.js:1271-1289`.
   The baseline is sent when no visible baseline exists (`:1074-1080`); later
   changes come from file reads (`:1264-1270`, `:1290-1309`) and are compared
   with the fold of ALL visible instruction messages (`:822-835`). Sent right
   after the step's last claimed message (`:1283-1284`).

**No public setting moves them out of the history.** `dsh-tool-skill`'s only
setting is `catalogDescriptionMaxLength` (`:49`).
`systemPromptUpdate: "in-history"` (the `request/context` event) governs only
how a changed SYSTEM PROMPT reaches the surface (`SystemPromptProjection`,
`$H/dsh-agent-loop/lib/index.js:264-282`, used at `:1052-1055`).
`systemPrompt.suppressRuntimeContext()` (`$H/dsh-system-prompt/lib/index.js:270-278`)
would hide the sandbox and approval facts from the model, not move them.

**The fix: a context block before the view**
(`lib/context.js`, called from `engine.js`). At step 1 of a turn that has
history, the surface is laid out as

```text
[system prompt][skill catalog][runtime context][instructions …][checkpoint: the view] + the step's messages
```

1. **The block** holds the newest catalog, the newest runtime-context snapshot
   and every workspace-instructions message, in that order, taken from the
   surface and from the step's own messages (newest wins).
2. **A block entry already in its place is kept.** Every other block position
   is written as a one-node `user/message` replace over the node there, with
   the entry's exact content and source (a surface entry gets a fresh id; one of
   the step's own messages is placed as it is). The checkpoint then replaces the
   rest. The fold allows a one-node user-message replace (`$H/dsh-session/lib/index.js:361-372`,
   `:311-329`); node 0 is never touched (`:416-420`); the compaction invariant
   checks only `compact-checkpoint` replaces (`$H/dsh-compaction/lib/invariant.js:109-112`).
3. **Whatever does not fit** (each entry needs one surface node, the checkpoint
   one more) stays with the step, after the new message, and enters the block
   at a later turn.
4. **The first turn** has nothing to replace: the step's context messages are
   only put before its new message, so turn 2 finds its block in place.
5. **The listener is outermost** (`ctx.on(…, { prepend: true })`; Cordis runs
   waterfall listeners outermost-first and `prepend` unshifts,
   `$H/cordis/lib/index.js:317-325`, `:335-345`). Only a `prepend` listener
   registered later stays outside it: the per-agent model-switch notice, which
   is not context. So Endless sees the step's complete messages, and content
   that changed this turn enters the block this turn. In the trial the catalog
   owner was outside Endless (its catalog came after Endless's replace), which
   registration order alone decided.
6. **Ordering costs, stated.** Endless now waits for its summary lines before
   every inner listener runs, including the session controller's refusal of
   an archived session (`$H/dsh-api-session-controller/lib/index.js:2430`). A
   refusal after `next()` (a bracket left open, a failed write) re-queues the
   claimed messages only. The catalog, the runtime context and the baseline
   instructions are derived again from the surface at the next turn; a nested
   instructions update queued by a file read is dropped until the next read.

**Why nothing is sent twice.** Each owner looks for its own message on the
surface, and the block keeps exactly that message visible with the same content
and source: the catalog owner finds the newest visible catalog with the current
entries, the loop retains the block's snapshot (`:319-324`), and the
instructions owner finds the same baseline and the same fold of changes. The
owners that run inside Endless read the surface before the replace and those
outside it read it after; both see the same messages. The unit tests run both
orders (`test/context.test.js`).

**When content really changes.** The changed message enters the block in the
turn it is sent (or, when it arrives during a turn, at the next turn start).
That turn's step 1 misses the cache from that message to the end, the whole
view included; the next turn hits again up to the end of the old view.

**A host's own context.** A host that keeps standing context of its own in
user-role messages (re-sent when the surface stops showing its latest
snapshot) names those kinds in the
`contextKinds` config; they join the block after the harness's three, newest
message only (`contextKinds`, `lib/context.js`), so they are never summarised
and never re-sent after the new message.

**Volatile context stays after the message.** Only the kinds above enter
the block. A timestamp (`$H/dsh-time-context/lib/index.js:215-246`, not seen in
the trial), a model-switch notice or a skill invocation stays in the step,
after the new message, and is replaced with the history at the next turn.

**Not shown to the person.** Block copies are replacement events; the Web UI
draws only append-origin user messages (`$H/dsh-client-ui-chat/lib/client.js:9272`,
fallback `:9136`), and the history projection reads only append-origin events
(`lib/history.js`).

**On the wire.** The DeepSeek adapter merges consecutive user-role messages into
one wire message and sends only their content
(`$H/dsh-llm-deepseek/lib/index.js:1666-1679`), so a block copy is byte-identical
to its original.

## d. Registering a model tool and receiving its calls

`ctx.tools.register(defineTool({ name, description, parameters, output: {
schema, render }, execute(args, exec) }))` — the shape every shipped tool uses
(`$H/dsh-tool-todo/lib/index.js:78-95`, `$H/dsh-tools/lib/index.js:838`).
Parameters use the harness schema DSL (`{ id: { type: 'integer', required: true } }`).
`exec` carries `agent`, `callId` and `signal` (`$H/dsh-tools/lib/index.js:1201-1204`),
so a tool finds its session as `exec.agent.session`. A tool registered in the
preset scope is visible to every agent of that preset (a plugin mounted
outside presets registers per agent instead).

## e. Reading a session's events, and where a plugin may keep files

**Live events.** `ctx.on('session/event', (session, event) => ...)` fires once
per appended event, synchronously, inside the append
(`$H/dsh-session/lib/index.js:1441-1481`); appending from inside it throws
("session append cannot reenter", `:1452`). `session.snapshotEvents()`,
`session.eventAt(seq)`, `session.surface.nodes`, `session.header` (`id`,
`cwd`, `parentSession`, `origin: 'subagent'`, `agentPreset`) and
`session.requestHeader()` are on the `Session` declaration.

**Which events are the history.** `user/message`, `assistant/message` and
`tool/result` with `surfaceOp: 'append'` (`isAppendSurfaceEvent`,
`$H/dsh-session/lib/index.js:189-191`: "Append-origin events are that
transcript's durable source material; replacement copies stay model-only").
`turn/start`/`turn/end` bound turns. User-message sources come from
`MessageSourceMap`: `user`, `user-question-reply` (the person), `agent-message`
and `subagent-settled` (another agent), `runtime-context`, `system-prompt`,
`model-selection`, `tool-registry`, `compact-checkpoint` and others
(machinery). Assistant `reasoning` blocks are skipped.

**Persisted sessions.** `dsh-session-persistence-jsonl` keeps
`<root>/--<cwd>--/<encoded-id>/session.vN.jsonl[.zstd]`, root
`!!js dshHomePath('sessions')` (`$H/dsh-base/cordis.patch.yml:130-133`).
The directory layout and id encoding are backend-internal; only the backend's
diagnostics hook `locate(meta)` exposes the file
(`$H/dsh-session-persistence-jsonl/lib/index.js:2416-2421`), and the abstract
persistence contract has no such method. `ctx.sessionQuery` reads non-live
sessions.

**Plugin files.** `dsh-storage-domain` is a validated key-value store that
loads a whole domain into memory (`$H/dsh-storage-domain/README.md`) — wrong
for an append-only tree of tens of thousands of lines. `dsh-home-paths`
exports `resolveDshHome()` and `dshHomePath(...)`, the root every harness store
derives from ("all harness user data lives under one root",
`$H/dsh-home-paths/README.md`). **Endless keeps its memories under
`dshHomePath('endless')`** (section h): inside the harness home, beside
`sessions/` and `storages/`, never inside the backend-owned session directory.

## f. `ctx.llm.stream()` on the conversation's route

`GenerateOptions` (`$H/dsh-llm/lib/typert.host.js`): `provider`, `model`,
`reasoningEffort?`, `messages`, `system?`, `tools?`, `maxTokens?`, `signal?`,
`sessionId?`, `purpose?: 'compaction' | 'session-title'`. The stream yields
chunks ending in one `finish`; `BlockAssembler` (exported,
`$H/dsh-llm/lib/index.js:954-1123`) assembles them. "Request-only inputs
carry user-role content with no `id` or `source`" (`$H/dsh-llm/README.md`).

**Same route as the conversation.** The shipped backend resolves
`session.requestHeader()?.config` (provider and model of the latest routed
request), then `agent.options` (`$H/dsh-compaction-basic/lib/index.js:292-303`).
Endless does the same and allows only a different `model` of that provider.

**The conversation's own system prompt and tools.** The shipped backend
replays the conversation's cacheable prefix (`buildSummarizationInput`,
`$H/dsh-compaction-basic/lib/index.js:684-704`, and `summarizeWithLlm`,
`:291-335`): the `system/message` at surface node 0 through
`session.deriveEventMessage(event)` as the first message (no `system` option),
`session.requestHeader().tools` as `tools`, and `session.toolHistory()` as
`toolHistory`. All three are on the `Session` declaration
(`dsh-api-session-controller/lib/typert.host.js`), and `tools` and
`toolHistory` are `GenerateOptions` fields. Endless's writer does the same
(`conversationPrefix`, `lib/llm-writer.js`) on the chat that last noted the
memory's route, then sends `<chat>` with the writer's view and the task, so a
compaction reads the tools and the system prompt from the turns' cache. The
compaction instructions are in the plugin's system section for that reason. No
`toolChoice` exists in `GenerateOptions`; the section tells the writer to call
no tool, and a reply with no text is a failed try. A memory with no live chat
falls back to the plugin's section as `system`. A chat on its first turn has
no `system/message` yet while its step-1 listener waits (the loop writes it in
`step()`, after the waterfall, `$H/dsh-agent-loop/lib/index.js:1051-1060`), so
the registry reads the newest other chat of the same memory that has one
(`prefixOfChats`, `lib/registry.js`). The round-4 stand's first writer calls
went out with `tools=0` for exactly that reason, not because of the adapter.

**Reasoning effort.** The DeepSeek adapter accepts `off`, `low`, `high` and
`max` and thinks at `high` when none is sent
(`$H/dsh-llm-deepseek/lib/index.js:313-318`, `:1694-1700`); `off` disables
thinking. The writer wants `off` unless `writer.reasoningEffort` names another,
and sends only what the model declares: `ctx.llm.resolveModelInfo(provider,
model)` answers `reasoning.efforts` (`$H/dsh-llm/lib/index.js:2098-2150`), and
`resolveCallWithInfo` (`:2163-2185`) refuses any effort a model does not
declare, and any effort at all for a model with no `reasoning`, before the
request leaves. A `dsh-llm-pi-ai` model row with no `reasoningEfforts` and no
installed catalogue entry has no `reasoning` (`reasoningInfo`,
`$H/dsh-llm-pi-ai/lib/index.js:1711-1729`). So the writer sends the wanted
effort where declared, else `off`, else the lowest declared, else none.

**The writer's route.** `agent.options` hold the route the agent was created
with and never change. The route a turn's request uses comes from the session
controller's model selection (`selectionFor`,
`$H/dsh-api-session-controller/lib/index.js:281-312`): the person's pick not yet
used, else the logged request header, applied through `system-prompt/assemble`
and `agent/request` (`$H/dsh-agent/lib/index.js:166-192`). The same two facts
are the public `modelSelection` session projection (`pending`, `lastUsed`,
`:2066-2090`), read with `ctx.sessionProjections.stateOf`. Endless reads that
projection, then `session.requestHeader().config`, then `agent.options`
(`routeOfTurn`, `lib/guard.js`), for the model guard and the writer.

**Logging.** `ctx.logger` has only a ring-buffer exporter at run time
(`$H/cordis/lib/index.js:588-605`); the boot's exporter keeps startup
warnings only (`$H/dsh-app-boot/lib/index.js:4054-4066`). The harness prints
its own lines to standard error (`$H/dsh/lib/bin.js:144`). The plugin's log
(`lib/log.js`) writes every line to both.

**`purpose: 'compaction'`** adds the request header
`x-deepseek-harness-compact: 1` on the DeepSeek adapter
(`$H/dsh-llm-deepseek/lib/index.js:2202`). That adapter speaks DeepSeek's
Anthropic-compatible Messages API (`https://api.deepseek.com/anthropic`,
`:337`), defaults thinking to `high` unless an effort is given (`:1694`), and
maps `cache_read_input_tokens` to `cacheReadTokens` (`:1811-1814`). The
provider id is `deepseek-official` (`$H/dsh-llm-deepseek-api-key/lib/index.js:36`);
its default models are `deepseek-flash` and `deepseek-v4-pro`
(`$H/dsh-llm-deepseek/lib/index.js:42-54`).

## g. Sub-agents (recorded for a later packet)

`ctx.subagents` starts a child through a provider (`spawn` in process, `fork`).
`SubagentStartRequest` is `{ label?, prompt: ContentBlock[], parent, signal,
agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`
(`$H/dsh-subagent/lib/typert.host.js`). Seeding a child with the view means
putting the rendered view as the first text block of `prompt` — through the
delegation tool's `tools/pre-execute` waterfall or a tool of our own. A child
session carries `header.origin === 'subagent'` and `header.parentSession`; its
report reaches the parent as a `user/message` with source `subagent-settled`
or `agent-message`. In this version a child gets no memory of its own; its
`zoom`, `date` and `recall_search` read the parent's memory when it is loaded.

## h. One memory per agent and project

The harness has no notion of an agent across sessions, so the key is the
plugin's own: `(agent, project)`, id = first 16 hex of
`sha256(agent + "\n" + project)` (`lib/key.js`). A host binds a session to a
key through `endless.bind` (section i) before its first turn; an unbound
session uses `(header.agentPreset, header.cwd)` (the `SessionHeader`
declaration, `$H/dsh-api-session-controller/lib/typert.host.js`).

```text
<dshHomePath('endless')>/
  memories/<memoryId>/key.json            {agent, project, name?}
  memories/<memoryId>/order-turn-v1.jsonl one finished turn per line
  memories/<memoryId>/tree-turn-v1/       the summary lines, by day
  memories/<memoryId>/view-turn-v1.json   the view as [l, i] pairs, written after every change
  memories/<memoryId>/compaction-view-turn-v1.json  the writer's own view, the same shape
  memories/<memoryId>/usage.jsonl         the writer's spend, one line per call
  memories/<memoryId>/lock                the writing process
  sessions/<session>.json                 a session's binding
```

**Turn-end append.** Each attached session's events (`session/event`, §e) are
folded into finished turns (`lib/turns.js`); `turn/end` appends one record —
`{sessionId, sessionTitle, turn, at, entries}` — with one write and `fsync`,
so two chats interleave whole turns only. Attaching folds the session's events
so far, so a turn that finished while nothing listened is appended then, once.
The order is a cache of the session logs: `rebuildRecords` derives every record
again from them.

**One writing process.** The memory's lock (`lib/lock.js`) moved from the
session to the memory. Every chat of a memory in one process shares one open
memory; a second process is refused and its turn re-queued (§c).

**A new chat's first turn.** Its surface is empty at step 1, so there is no
node a checkpoint could replace. The view then travels as one of the step's
own messages, source kind `endless-view`, after the context messages and
before the new message (`contextFirst`, `lib/context.js`). A plugin's own
source kind on a step message is accepted: a host's standing context, kept
before the view through `contextKinds`, rides the same way. The history
projection skips it, and turn 2's
checkpoint replaces it. The harness Web UI draws a non-`user` append-origin
user message as a context node (`$H/dsh-client-ui-chat/lib/client.js:9268-9300`).

**The view as of a turn's start.** `lib/step-one.js` renders the view right
after it settles, before the rest of the chain runs, and writes that text; a
turn another chat finishes meanwhile reaches this chat at its next turn.

## i. The seam methods

`endless.bind`, `endless.memories`, `endless.view`, `endless.zoom`,
`endless.history` and `endless.search` (`lib/api.js`, shapes in its header) are
served as exact routes `/api/endless.<name>` on the harness web server
(`lib/routes.js`), registered through `ctx.inject(['webServer'], …)`.

- `webServer.register({ kind: 'exact', path, handler })`; an exact path wins
  over the `/api` prefix route, and a duplicate throws
  (`$H/dsh-host-webserver/lib/index.js:177-184`, `:322-331`). A second engine
  in one process finds the routes taken and leaves them to the first: every
  engine reads the same files, and open memories are shared process-wide
  (`lib/registry.js`).
- Body and answer use the harness's Remote envelope, so a host's Remote
  client reads them as any harness method:
  `{type: 'client-request', rpcId, method, payload: {args}}` →
  `{type: 'server-response', rpcId, result: {ok, value} | {ok: false, error: {code, message, details}}}`
  (`$H/dsh-client-connection/lib/index.js:480-512`).
- Only this computer is answered: POST, no `Origin`, loopback peer and
  `Host`. A browser page always sends `Origin`, so it is never answered here;
  the harness's own page reads through the routes of section l, item 5.

## j. Session titles

`dsh-session-title` appends `session/title {title, messageSeqs, source}` to the
session log (`$H/dsh-session-title/lib/index.js:177`, `:302`, `:465`); the
latest one is the title. The turn fold keeps the newest title seen before a
turn's `turn/end`, and the writer reads a turn's first message as
`in «title», you: …` (`taggedEntry`, `lib/prompts.js`).

## k. The model guard

`ctx.llm.resolveModelInfo(provider, model, signal)` answers
`context.contextWindow` when the adapter states one
(`$H/dsh-llm/lib/index.js:2098-2124`); the DeepSeek catalog states it for both
default models (`$H/dsh-llm-deepseek/lib/index.js:42-54`). Below 65,536 tokens,
or when no window is stated, step 1 calls `next()` untouched and logs once per
chat and model (`lib/guard.js`); the turn is an ordinary chat and nothing is
appended for it then (a later turn on a large model appends the chat's missing
finished turns when it attaches).

## l. The browser half

**Verdict: the harness offers a public seat for every piece, and none of this
patches the harness.** Read and measured on 0.2.0-rc.2, with the harness's web
UI served by `dsh` from an isolated home and a recorded session. Nothing was
missing, so no fallback page is shipped. One thing needed care: how the bundle
reaches the page (item 1).

1. **How a bundle reaches the page, and why a second row.** A package declares
   `dsh.client: { platform: 'web' }` and `exports["./client"]`
   (`$H/dsh-client-modules/lib/index.js:62-75`, `resolveMeta` `:706-740`, the
   export read `:723`); the harness serves it under `/plugins` (`:202`, `:553`).
   **Only entries of the profile's own Loader tree are scanned**:
   `ctx.loader.entries()` (`:545`, `:840`) walks groups
   (`$H/cordis-plugin-loader/lib/index.js:142-147`), but an agent preset's
   plugins live in a separate in-memory tree whose owner link is deleted
   (`$H/dsh-agent-preset-registry/lib/index.js:63-76`, scope made at `:527`).
   Measured: with `dsh.client` declared and the memory engine mounted only inside
   the preset, the page's boot graph did not list the package. So the bundle
   patch also inserts a top-level row, `endless-client`, whose file
   (`lib/client-host.js`) has no server code. A bundle's rows resolve from the
   patch file's own folder (measured: a row named `./node_modules/…` was looked
   up under `presets/`), so the row is `../lib/client-host.js`, found wherever
   the package is installed. After it, the boot graph lists the package and
   `/plugins/<package>/client.js` serves it. **Recheck:** a harness that also
   scans preset trees would find the package from two Loader sources, which is a
   composition error (`:881`); then drop the `endless-client` row.
2. **The look-back row: the keyed seat `tool.call.toolview`.** The tool tree
   dispatches each call by `entryKey: toolName`, with the generic row as the
   fallback (`$H/dsh-client-ui-tool/lib/client.js:1871-1878`); a keyed entry
   replaces the generic row (its own comment, `:80-82`), and the harness's rows
   for `read`, `edit`, `grep`, … are registered the same way (`:4047-4229`). The
   generic row's summary is the call's own words (`toolRowModel`, `:275-297`),
   which is why `zoom {"id":0,"n":1}` appeared. An entry receives
   `{callId, toolName, phase, block, openFile, cwd, home, loadImage, useDisclosure, inspect}`
   (`:1840-1853`) and draws with the harness's exported `DisclosureRow`
   (`$H/dsh-client-ui-primitives/lib/index.js:3156`) and the clock icon from the
   same package, so it sits in the process list like the harness's own rows
   (`client/lookback-row.js`). The harness's own `ToolRow` is not exported, so
   the opened body is the plugin's small sheet on the harness's `--dsw-*` tokens.
3. **No compaction row: the keyed seat `conversation.chat.node`, key
   `compaction`.** The chat registers it at `$H/dsh-client-ui-chat/lib/client.js:6831`
   and draws `CompactionItem` (`:267-318`); the node's data carries the
   `compaction/summary` text (`compactSummary`, `:8966-8990`), which for this
   memory starts with a fixed note (`COMPACTION_NOTE_PREFIX`, `lib/identity.js`).
   The slot registry allows a second entry for the same key at another priority
   and renders the lowest ("register at a different priority to shadow it
   (lowest renders)", `$H/dsh-client-ui-slots/lib/index.js:168`, sort `:221`);
   `slots.entries(key)` (`$H/dsh-client-ui-renderer/lib/client.js:1517-1530`)
   lets the shadow find the harness's entry and render it for every node that is
   not this memory's (`client/compaction.js`). The shadow stands at priority -2,
   so it coexists with another plugin's shadow at -1.
4. **History: a right-sidebar tab type.** `ctx.sidebarRightTabs.register({id,
   kind, title, guide, keepMounted})` (`$H/dsh-client-ui-sidebar-right/lib/client.js:8690`;
   the package's README, "Extension seats") plus the keyed slots
   `sidebar.right.pane.tab` (body) and `sidebar.right.pane.tab.title` (chip),
   keyed by the type id. The `guide` entry is the door on the sidebar's start
   page (`EntryBox`, `:460-492`; the entry's icon is a component called with
   `{size}`). The harness's own Terminal tab is the template
   (`$H/dsh-client-ui-sidebar-terminal/lib/client.js:438-490`). The tab is opened
   from the composer by a client-owned slash command: `ctx.commandUi.register`
   (`$H/dsh-client-ui-commands/lib/client.js:816`), the same action shape as the
   composer's File command (`$H/dsh-client-ui-conversation/lib/client.js:18111-18125`),
   whose action calls `ctx.sidebarRight.openTab(kind)`
   (`$H/dsh-client-ui-sidebar-right/lib/client.js:6394`). The view reads the
   chat's folder and preset from `useSessions` (the files tab reads the folder
   the same way, `$H/dsh-client-ui-sidebar-files/lib/client.js:605`).
5. **The page's data: an authenticated fetch route on the connection.** A route
   registered straight on the web server is not authenticated
   (`$H/dsh-host-webserver/README.md`, "Known Limitations": no authentication or
   origin policy of its own), and `lib/routes.js` refuses a request with an
   `Origin` header, which a page always sends. The connection service has the
   seat for the page: `ctx.connection.fetch.register({path: '/api/<name>',
   methods, requestBody, fetch})` (`$H/dsh-client-connection/lib/index.js:581-583`,
   `:625-639`, path rule `:758-762`). Such a route is served by the `/api` route
   behind the Host/Origin check and the signed session cookie (`:586-591`,
   `:830-843`), and the shared handler tries exact fetch routes before the
   gateway (`:608-620`). The page calls it with
   `ctx.connection.rpc.call('/api', endpoint, payload, signal)`
   (`$H/dsh-client-connection/lib/client.js:1212-1233`), the carrier the
   harness's own Remote calls use, so the same route also works where a shell
   carries fetch itself. The five reads are served so as `/api/endless-ui.<name>`
   (`lib/browser-routes.js`); `bind` is not offered to a page.

## The chosen seam

**`EndlessCompactionEngine extends CompactionEngine`, mounted as**

```yaml
- id: endless
  name: cordis:group
  group: true
  isolate: { compaction: true }
  config:
    - { id: endless-memory, name: dsh-elephant-memory, config: { ... } }
```

**On `agent/pre-step` with `step === 1`** (registered with `prepend`, so
outermost): wait until every view line is a summary; let the rest of the chain
decide (`next()`); if a step will be sent, lay the surface out in one
synchronous run: the context block first (one-node replaces where needed), then
the bracket, replacing the rest of `[surface[1] .. surface.at(-1)]` with one
checkpoint `user/message` holding `<chat>…</chat>`. On a chat's first turn,
put the step's context messages first, then the view (when the memory holds
earlier chats) as a step message (section h), then the new message. Steps after
the first are untouched, so inside a turn the provider's prefix cache works as
for any conversation.

**Why not the fallback.** An `llm/stream` or `agent/request` interceptor cannot
work: "`agent/request` listeners cannot change request messages"
(`$H/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`),
and an `llm/stream` rewrite contradicts `$H/dsh-agent-loop/lib/invariant.js:26-27`,
leaves the log unable to reproduce the request, and breaks resume and fork.

**Costs of this seam, stated.**

1. The view (up to `viewBytes`) is logged once per turn, in the checkpoint
   message; the `compaction/summary` record carries one short line instead of
   a second copy. A thousand turns add roughly 128 MB before compression.
2. The harness Web UI would draw a "Context compacted" row on every turn; the
   browser half hides it for this memory's checkpoints only (section l,
   item 3).

**Offered upstream, if these costs matter:** a turn-start hook that may
substitute derived messages without logging them twice, or a way for a
compaction backend to mark context messages that a replace keeps in place.

## What the next harness bump must recheck

1. `CompactionEngine` is still `Service` named `compaction`;
   `compactCheckpointSource` still exported from `@deepseek-ai/dsh-compaction`.
2. The bracket the invariant accepts (`dsh-compaction/lib/invariant.js`), the
   `compaction/summary` payload declaration, and that `assertSystemHeadRewrite`
   still protects only node 0.
3. `agent/pre-step` still runs after `turn/start` and before the claimed
   messages are appended, with `step === 1` on a turn's first step
   (`dsh-agent-loop/lib/index.js`, `turn()` and `step()`).
4. `RuntimeContextProjection` behaviour (source kind `runtime-context`): still
   decided before the waterfall, still retaining any `runtime-context`
   `user/message` event, replace or not (`dsh-agent-loop/lib/index.js:298-350`).
   Then, for "Context nodes and the cache": the catalog owner still compares
   the newest visible catalog's `source.entries` (`dsh-tool-skill`,
   `catalogHistory`); the instructions owner still reads visibility from the
   surface (`dsh-agent-instructions`, `visibleBaselineSource`,
   `visibleInstructionChanges`); no new owner re-sends a context kind by
   visibility (grep every `"agent/pre-step"` listener and add its kind to
   `CONTEXT_KINDS` in `lib/context.js` if it does); Cordis still runs waterfall
   listeners outermost-first with `prepend` unshifting; a one-node
   `user/message` replace is still legal; the adapter still sends only
   content. Live check: step 1 of turn 3 onward reads from cache everything up
   to the end of the previous view's lines.
5. The `MessageSourceMap` kinds the history projection classifies.
6. `defineTool` shape and `exec.agent`.
7. `GenerateOptions` (with `tools` and `toolHistory`), `BlockAssembler`,
   `createUserMessage`, `createAssistantMessage` exports of `@deepseek-ai/dsh-llm`;
   `Session.deriveEventMessage`, `requestHeader().tools` and `toolHistory()`;
   the DeepSeek adapter still accepting reasoning effort `off`; `ctx.logger`
   still printing nothing at run time.
8. `dshHomePath` in `@deepseek-ai/dsh-home-paths`.
9. `presets/endless.patch.yml` against the new
   `dsh-web-app/presets/cordis.patch.yml` (Creator), row by row.
10. The peer range in `package.json` (`peerDependencies`), which
    `evaluatePluginCompatibility` (`dsh-app-boot/lib/index.js:286-313`) checks
    at install and at every start.
11. That profile-scoped imports of `@deepseek-ai/*` still resolve to the
    installation (`dsh-app-boot/lib/index.js:681-725`, `routeScoped` `:1408-1470`)
    and that profiles keep `autoInstallPeers: false` (`:563-568`).
12. `webServer.register` exact routes: exact still wins over the `/api` prefix,
    a duplicate still throws, and `webServer` is still reachable through
    `ctx.inject` from inside a preset's scope (`dsh-host-webserver`).
13. The Remote envelope schemas (`dsh-client-connection`, `clientRequestSchema`,
    `serverResponseSchema`), which a host's Remote client speaks.
14. `session/title` events and `data.title` (`dsh-session-title`).
15. `ctx.llm.resolveModelInfo` and its `context.contextWindow`
    (`dsh-llm`, `normalizeModelInfo`).
16. A step message with a plugin's own source kind (`endless-view`) is still
    accepted on append, and the history and title folds still skip it.
17. `SessionHeader.agentPreset` and `cwd` (the default key).
18. The browser half (section l): browser bundles still scanned only for
    profile-level entries (a preset's tree still not scanned; if it is, drop the
    `endless-client` row, section l item 1); bundle rows still resolve from the
    patch file's folder; `DisclosureRow` and the clock icon still exported by
    `dsh-client-ui-primitives`.
19. The keyed seats: `tool.call.toolview` (keyed by tool name, props as listed),
    `conversation.chat.node` key `compaction` (its node still carries
    `data.summary`), `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`
    keyed by the tab type id, `ctx.sidebarRightTabs.register` with a `guide`
    entry, `ctx.commandUi.register` with an action, `ctx.sidebarRight.openTab`,
    and `slots.entries(key)` with priority shadowing.
20. `ctx.connection.fetch.register` for an exact `/api/<name>` route, still
    served behind the Host/Origin check and the session cookie, and the client's
    `ctx.connection.rpc.call('/api', …)` still sending the Remote envelope.
21. No command of the harness named `history` (the slash command would then
    step aside).
