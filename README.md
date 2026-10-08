<img src="assets/elephant.png" width="128" alt="Elephant Memory">

# Elephant Memory

**Your DeepSeek agent never forgets.**

![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![DeepSeek harness 0.2.x](https://img.shields.io/badge/DeepSeek%20harness-0.2.x-4D6BFE)

Elephant Memory is a plugin for the [DeepSeek harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`). Every chat you have in a folder becomes one long memory: each new turn
starts with a short, fixed-size summary of everything said before, and the agent
can open any summary line down to the exact words.

It is an independent implementation of Victor Taelin's
[UniiChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
(first published as OptChat). Source, issues and releases:
<https://github.com/Shtukbase/elephant-memory>.

## Install

You need Node 22 or newer, `pnpm` on your `PATH` (the harness's plugin command
runs it), and the harness CLI at version **0.2.x** (`npm install -g @deepseek-ai/dsh`).

1. **Add the plugin to a profile.** The web profile is the one `dsh web` starts;
   the command creates it if it does not exist yet:

   ```sh
   dsh plugin --profile web add dsh-elephant-memory
   ```

   `add` also takes a folder that holds this package or a `.tgz` made by
   `npm pack`. Because the package ships a bundle patch, `add` also turns that
   patch on. The harness checks the package's `peerDependencies` at install and
   at every start, and refuses a harness outside 0.2.x.

2. **Start, or restart, the harness:** `dsh web`. It prints the address of its
   page; open it in a browser.

## Choose the Endless preset

A preset is what the harness calls a mode. The plugin adds one, **endless**,
shown as *Endless* in the mode list of a new conversation. It is the harness's
Creator mode with this memory in place of the usual compaction (compaction is
how the harness shortens a long history; this memory replaces it).

1. Start a new session. Above the message box, next to the workspace, open the
   mode picker (it shows *Standard mode*) and pick **Endless** before the first
   message. A session's mode cannot change after its first message, and every
   new session starts in the default mode again.
2. Work as usual. When a turn ends, it is kept word for word and summarized in
   the background. Every later turn starts from the summary.

To make Endless the default for new sessions, edit
`$DSH_HOME/profiles/web/cordis.patch.yml` (`$DSH_HOME` is the harness's home
folder, `~/.dsh` unless you set it). The file starts as an empty list, `[]`;
replace that with this list, or add the item to the list already there:

```yaml
- id: agent-preset-registry
  config:
    default: endless
```

## Set up a model

The memory uses the chat's own model: whichever model and provider the session
runs also write its summaries. When you switch provider or model in the
composer, the summaries follow at the next turn: the writer uses the route that
turn's own request uses, not the one the chat was created on. The model's context window must be at least
65,536 tokens.

1. **DeepSeek's official API** works out of the box: give the harness your key
   in its page's "Add an API key" dialog, or set `DEEPSEEK_API_KEY` before
   `dsh web`.
2. **An OpenAI-compatible gateway** goes through the harness's `dsh-llm-pi-ai`
   adapter. This example declares OpenCode Go's endpoint (it requires an
   `x-opencode-session` header) and makes it the default model. Add the items
   to the same `cordis.patch.yml` list:

   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         opencode-go:
           displayName: OpenCode Go
           apiKeyEnv: OPENCODE_GO_API_KEY
           api: openai-completions
           baseURL: https://opencode.ai/zen/go/v1
           headers:
             x-opencode-session: my-machine
           compat:
             thinkingFormat: deepseek
           models:
             - id: deepseek-flash
               name: DeepSeek Flash
               contextWindow: 1000000
               reasoningEfforts:
                 off:
                 high: high
   - id: agent-default-model
     config:
       provider: opencode-go
       model: deepseek-flash
   ```

   `apiKeyEnv` names a credential, never the key itself: set it in the
   environment, or in `$DSH_HOME/.credentials.yaml` (`version: 1`, then
   `refs:` with `OPENCODE_GO_API_KEY: "<your key>"`, file mode 0600). The empty
   `off:` level lets the summary writer turn thinking off (deviation 13). A
   declared model without it still works: the writer reads the efforts the
   model declares and asks for the lowest one, or for none when the model
   declares no reasoning at all, and logs that once. Such a model may think on
   every summary, which costs output tokens.

## How memory is keyed

A memory belongs to **one mode in one workspace folder**. Every Endless chat in
the same workspace reads and writes the same memory, so a new chat there already
knows the earlier ones and can say which chat something was said in. A chat in
another workspace has a memory of its own. The workspace is the folder shown
next to the mode picker; the web page's first one, *Default workspace*, is
`~/Documents/deepseek-harness/default-workspace`.

The memory is plain files under `$DSH_HOME/endless/`. To forget a memory, delete
its folder there (see [Where the files are](#where-the-files-are)).

A program that drives the harness (a "host") can bind a chat to its own key,
an agent and a project, before the chat's first turn; see
[For hosts](#for-hosts).

## History

Open the right sidebar and pick **History** on its start page, or type
**/history** in the composer. History shows the memory of the current chat's
folder, and a picker offers any other memory.

1. **Conversation** is every turn of every chat, grouped by day. The search box
   finds raw words anywhere in the memory and highlights them.
2. **Remembers** is the list of summary lines the agent starts its next turn
   with. Each line opens into the two lines it was made from, down to the exact
   message.

## Looking back

The agent has three tools for its memory:

1. `zoom(id, n)` opens one summary line into the two lines it was made from;
   `zoom(id, 1)` gives one message whole.
2. `date(id)` gives the date and time of a message.
3. `recall_search(query)` searches every message ever written, word for word,
   for a phrase (any case) or a `/regular expression/`. It returns up to 20 hits.

In the transcript each call shows as one row, *Looked back · «what» · date ·
in «chat»*, which opens to the answer. A memory turn is not marked "Context
compacted", because nothing was lost; a real `/compact` in an ordinary chat is
still marked as usual.

## Cost and cache

These numbers come from one measured run: 201 scripted turns on 2026-10-08,
model `deepseek-flash` on DeepSeek's official API, harness 0.2.0-rc.2. Prices
were DeepSeek's at the time: $0.028 per million cached input tokens, $0.28 per
million other input tokens, $0.42 per million output tokens.

| Measure | Result |
|---|---|
| Share of each turn's input read from the provider's cache | median **98.4%** (196 ordinary turns, lowest 95.3%) |
| The one turn right after each merge batch (two in the run) | about **35%** read from cache |
| Wait before a turn starts (summaries still being written) | median 5.1 s, 90% under 7.5 s |
| Cost of the agent's turns | $0.74 |
| Cost of writing summaries (3,133 calls) | $2.08 |
| Exact-quote recall questions | 7 of 7 answered word for word |

The summary writer was 74% of the bill. Since that run the writer takes at most
three tries per line instead of five and accepts a line up to 1.25 times the
limit (deviation 12 below), and a retry asks for 0.75 of the limit (deviation 16
below), which should cut its calls; those changes have not been measured over a
long run yet.

A short live check on the same day used this package as published, installed
from its `.tgz` into a clean harness 0.2.0-rc.2, with `deepseek-flash` through
OpenCode Go: four Endless chats, six turns. A rule given in the first chat was
recalled, with the chat's name, in the second chat's first turn. After the very
first turn, every turn start read 96.9% to 98.3% of its input from the cache,
except one turn right after the plugin's system prompt was changed. The summary
writer made 22 calls, read 94.4% of their input from the cache, wrote about 145
tokens per call, and trimmed 3 lines.

## Configuration

To change a setting, copy the `preset-endless` row from
[`presets/endless.patch.yml`](presets/endless.patch.yml) into your profile's
`cordis.patch.yml` without its `- insert:` line, and edit the `endless-memory`
row. A patch replaces a row's whole `config`, so keep every key.

| Key | Default | Meaning |
|---|---|---|
| `agentName` | `Assistant` | The name the summary lines give the agent's replies in a chat nobody bound. A bound chat uses the display name its host gave, or a name read from the agent's address (`team/agents/release-captain` gives "Release Captain"). No colon, no line break. |
| `you` | `you` | The word the summary lines use for the person. |
| `viewBytes` | `128000` | The summary's ceiling in bytes: once it passes this, one batch of merges brings it down to `viewFloorBytes`. |
| `viewFloorBytes` | half of `viewBytes` | The floor the batch merges down to (64,000 by default). |
| `lineBytes` | `512` | The target size of one summary line, in bytes. |
| `granularity` | `turn` | `turn` keeps one trace message per turn; `step` keeps every tool call and result as its own message (deviation 1). |
| `writer.model` | `''` | Another model **of the chat's own provider** for writing summaries; empty means the chat's model. A `writer.provider` key is refused. |
| `writer.reasoningEffort` | `'off'` | Reasoning effort for summary calls (deviation 13). Empty means `off`. A level the chat's model does not declare falls back to `off`, else the lowest it declares, else none, logged once. |
| `recallSearch` | `true` | Offer the `recall_search` tool. |
| `root` | `''` | The folder that holds the memories; empty means `$DSH_HOME/endless`. |
| `contextKinds` | `[]` | Message kinds of a host's own standing context, kept in front of the summary like the harness's own context messages. |

To give another preset this memory, put this group in its `plugins` list **in
place of** its `compaction` group (a preset has one compaction service):

```yaml
- id: endless
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: endless-memory
      name: dsh-elephant-memory
      config:
        agentName: Assistant
```

## Limitations

1. **Small models.** Below a 65,536-token context window a turn runs as an
   ordinary chat, and the log says so once. DeepSeek's official models are far
   above it.
2. **It spends tokens.** Summaries are written in the background by the chat's
   own model on the chat's own provider, never another one. Every writer call is
   logged and totalled in the memory's `usage.jsonl`.
3. **One cache miss per batch.** The first turn after a merge batch misses the
   cache from the first merged line on. That is the cost of the design.
4. **A turn can be refused.** If summary lines are still missing after 180 s,
   the turn ends with one sentence in the chat's refusal line: "The memory of
   earlier messages is not ready yet, so this message will be sent with your
   next one." Its messages wait in the chat's queue and go with your next
   message; the chat stays usable. This happens the same way when the writer is
   slow and when it fails at once on every try. Nothing is sent without the
   summary, and nothing goes to another provider. Why it was refused is in the
   log (`[ENDLESS_TURN]`, and the writer's `[ENDLESS_WRITER]` lines).
5. **Everything is kept.** The memory holds every word of every turn, including
   anything you pasted or a tool printed, as plain files on your disk, and the
   summaries are written by your chat's provider. There is no "forget this" yet:
   delete a memory's folder to forget it.
6. **Some tool output is clipped.** A tool result keeps its first and last
   15,000 characters, and a turn's whole tool trace its first and last 30,000
   (deviation 1). Your messages and the agent's final replies are never cut.
7. **One process per memory.** A second harness process on the same home is
   refused while the first one holds the memory.
8. **English only.** The look-back row and History are drawn in English.
9. **Tested with one harness and its web UI.** Written and run against
   `@deepseek-ai/dsh` 0.2.0-rc.2 and the web UI that `dsh web` serves. The memory
   itself works in any profile, but the row, the quiet compaction and History are
   drawn only by the web UI. DSH Desktop loads the same browser bundle but has not
   been tried. Another harness version may need the checks in [`SEAMS.md`](SEAMS.md).
10. **Providers.** Run on DeepSeek's official API (the 201-turn run) and on
    OpenCode Go's OpenAI-compatible endpoint through `dsh-llm-pi-ai` (the short
    live check). The writer asks for reasoning effort `off` where the model
    declares it, else for the lowest effort the model declares, else for none
    (deviation 13). To keep summaries cheap on another provider, declare an
    `off` level (see [Set up a model](#set-up-a-model)).
11. **The agent decides when to look back.** The prompt tells it that a summary
    line is never anyone's exact words and to open the message before quoting,
    and in the live check it did. Before that sentence was added, the same model
    once quoted a summary line as the person's own words.
12. **Two rows.** The harness serves a plugin's browser bundle only for a plugin
    mounted at the top of the profile, so the patch also adds the row
    `endless-client`. If a later harness reads bundles inside presets and refuses
    the package twice, set `disabled: true` on that row.
13. **`/history` is a plain name.** If the harness ever ships its own `/history`,
    this command steps aside and the sidebar entry stays.
14. **Helper agents** get no memory of their own; their look-back tools read the
    memory of the chat that started them.

## How it works

The design and every constant come from Taelin's specification; this is a short
tour.

1. **The log.** The harness's own session logs are the history. When a turn
   ends, its messages are appended to the memory's order of turns, whole, and
   numbered.
2. **The tree.** In the background, each message becomes a summary line of about
   512 bytes. Two neighbouring lines are merged into one, then two of those, and
   so on: a binary tree. A message short enough to fit is its own line, word for
   word.
3. **The view.** A list of lines that covers the whole history, recent messages
   one per line and older ones many per line. It grows by one line per message.
   Once it passes 128 KB, one batch merges the most overdue pairs until it is
   back to 64 KB. A pair's "overdue" score is how long ago it ended, measured in
   its own size: `(T - last) / 2^l`. This reproduces the merge order of Taelin's
   rollback list.
4. **Each turn starts fresh.** Before a turn's first step, the conversation so
   far is replaced by one message holding the view, so the request is the system
   prompt, the tools, the view and the new message. The view changes only at its
   end between batches, so almost all of every request is read from the
   provider's prefix cache.
5. **Summaries in order.** Up to 8 summary calls run at once. A message's line
   starts once fewer than 8 lines before it are unwritten; a merge starts once
   both halves exist. Each call sends the chat's own system prompt and tools,
   then a smaller view (16-32 KB) for context, then the task with a ruler of
   512 dashes, because models cannot count bytes. A chat's first turn has no
   system prompt yet while it waits (the harness writes it after the wait), so
   its calls send those of another chat of the same memory. Only a memory with
   no other open chat, such as the first chat after a restart, sends the
   plugin's own section and no tools for those first calls; that is the same on
   every provider.

How it attaches to the harness, with file and line references, is in
[`SEAMS.md`](SEAMS.md). [`TRY.md`](TRY.md) is a recipe for trying it in an
isolated harness home.

**Thank you, Victor.** The log, the tree, the build order, the merge rule, the
prompts and the constants are from Taelin's specification as rewritten on
2026-10-08. This package is one implementation of that idea.

### Deviations from the specification

Each one has a reason the specification does not already answer.

1. **Granularity `turn` (default).** The specification keeps every tool call and
   result as its own message (`step` here, still available). `turn` keeps, per
   turn, each message of the person, one trace message with the turn's tool
   calls and results, and the final reply. Why: far fewer summary calls, and more
   turns at one line each in the same view. Cost: a trace keeps the first and
   last 30,000 characters of a very long turn (each result already clipped to
   30,000), so the middle of a turn with several huge tool outputs is cut. In
   `step` mode a tool call is one message however long it is.
2. **`recall_search`.** A raw search over the whole history. Why: an item a
   summary dropped can still be found. A `/pattern/` search stops after 2 s,
   because a pattern can take exponential time.
3. **The view is its own message.** The specification sends the view and the new
   message as one user message. Here the view is a message placed before the new
   one, because the harness builds every request from its session log. The
   harness's context messages (skill list, sandbox facts, workspace
   instructions) stay in front of the view, so they are read from the cache too.
4. **Plain tags.** Lines tag items "you:", the agent's name, "did:", "result:",
   "colleague:" and "note:" instead of user, unii, tool, echo, work and note.
5. **No second log, and a lock file.** The history is the harness's session
   logs; the plugin keeps only the order of finished turns and the tree. One
   writing process per memory is guaranteed by a lock file.
6. **No `spawn` or `tell`.** Delegation uses the harness's own tools, and
   `zoom("Name")` is not offered.
7. **A refused turn re-queues its messages and ends as a failure.** The harness
   drops a refused step's messages otherwise. The turn ends as a failure with
   one plain sentence rather than as a rejected step, because the web UI draws
   a rejected step as a finished turn with nothing said and keeps the person's
   message drawn as still starting. The re-queued messages carry no submission
   id, so the web UI settles its pending copy; they are delivered with the next
   message, and nothing starts a turn by itself.
8. **No cache marks.** DeepSeek caches by prefix without marks. Providers that
   need explicit marks (Anthropic) get none from this version.
9. **The view is logged once per turn**, inside the harness's session log. That
   is the price of the harness seam ([`SEAMS.md`](SEAMS.md)).
10. **Many chats, one memory.** The specification has one conversation. Here
    every chat in a folder joins one memory, a whole turn at a time, and each
    turn's first message is marked with its chat's title ("in «title»").
11. **The writer's prompt and the "Compaction:" marker.** The summary
    instructions live in the plugin's system prompt section, which turns and
    summary calls share, as the specification asks. A 201-turn run once answered
    a person's short message as if it were a summary task, so the section says a
    call is a summary task **only** when its last message starts with
    "Compaction:". Both tasks add a sentence to write in the language of the
    messages and one to keep the person's rules (deviation 18). The merge task
    adds another: use only facts present in the lines and their messages,
    because an earlier prompt's sample line leaked invented facts into real
    memories.
12. **Three tries, then a trim; a 1.25× tolerance.** The specification allows
    five tries. In the 201-turn run the writer averaged 2.65 calls per line,
    mostly "Too long" retries, and 325 of 1,182 lines were still over 512 bytes
    after five. Here a line up to 1.25 times the limit (640 bytes at 512) is
    accepted with no retry and no cut. A line gets three tries; if none fits 1.25
    times the limit, the shortest is cut at a word boundary and ends in "…", and
    the log counts it. A retry asks for less than the limit (deviation 16). The
    view's budgets are in bytes, so longer lines only mean fewer of them.
13. **Writer reasoning effort `off`.** The specification uses a cheap model at
    high effort. On DeepSeek, effort "high" (the adapter's default) produced a
    median 8,800 output tokens per 512-byte line and turns waiting two minutes, so
    the writer asks for `off` unless `writer.reasoningEffort` says otherwise.
    It asks only for an effort the chat's model declares (the harness's model
    catalog, `resolveModelInfo`): where the wanted one is not declared it takes
    `off`, else the lowest declared, else names none, and logs that once per
    model. Before this, a route whose model declared no `off` refused every
    summary before it left, and the memory stopped at the first long message.
14. **The language guard.** In the 201-turn run 6% of the lines were written in
    Chinese from sources with no Chinese text. A try that uses a Chinese,
    Japanese or Korean script its sources do not use is rejected with "Wrong
    language" feedback; with no valid try, the line fails and is tried again.
15. **Retries every 10 s.** The specification retries a failed call at the next
    message. Here a failed line is tried again every 10 s, because the next turn
    waits for it. A turn waits at most 180 s.
16. **A "Too long" retry asks for 0.75 of the limit.** The specification's retry
    cuts the line at the limit. In a 235-turn run on `deepseek-flash`, 66% of the
    new summary lines were over 512 bytes on their first try, and 29% fit in no
    try even at 640 bytes, so they were cut with "…": retries aimed at 512 did
    not shrink enough. Here a try past 640 bytes gets the same message with the
    limit and the cut mark moved to 384 bytes, 0.75 of 512 (`RETRY_TARGET` in
    [`lib/config.js`](lib/config.js)); the first try still gets the full limit
    and its ruler. Why 0.75: a model overshoots a stated length by up to about a
    quarter (the 90th percentile was 610 bytes at 512 in the 201-turn run), and
    aiming at 384 lets a retry overshoot by up to 1.67 times and still land under
    640. A smaller factor would cost more of every retried line (0.5 halves it).
    The factor comes from those numbers and has not been measured over a long run
    yet. The message calls 384 "the limit", which is how the model is steered
    below the real one.
17. **Heads are stripped from every line of a try.** A summary call shows each
    line as `id+n|text`, and a model sometimes copies the head. The specification
    does not say what to do. Here every try loses a head at the start of each of
    its lines before it is measured or stored. The first version stripped only
    the start of the reply, and a merge reply that copied both of its input lines
    stored `625+1|` on its second line (1 of 214 new lines in the 235-turn run).
    A head in the middle of a line is left alone, because it cannot be told from
    the line's own words.
18. **Both tasks ask to keep what the person states.** Each task adds: "Keep every
    rule, instruction, decision or preference the person states, word for word
    where short, before any other detail." The shared instructions already rank the
    person's own words first ([`lib/system-section.js`](lib/system-section.js)),
    but the task, which comes last in the conversation, says nothing of it. A
    real run (round 5 of the live walk, 2026-10-08) compressed a long first
    message, a rule ("release notes list only what ships") followed by a
    ten-item checklist, into a line that held the checklist and dropped the
    rule; the rule survived only in the agent's own memory-write line. The
    sentence sits after the language sentence and before the input
    ([`lib/prompts.js`](lib/prompts.js), `KEEP`). It asks and does not guarantee:
    the line limit still applies, so a very long rule can be shortened.
19. **The writer reads look-backs in words.** The order file keeps a turn's trace
    as the harness gave it, and for the memory's own look-back tools that is
    machine form: `did: zoom {"id":0,"n":1}`, a line head `0+0|`, a search's
    `id|kind|date|snippet` hits. A writer told to tag items in plain words copied
    it into real summary lines ("Looked back id 0 n 1", "message 0", "(1, 7, 8)";
    round 5 of the live walk). The writer, and a short trace's own line in the
    view, now read `did: looked back at «subject» in «chat»` (a date as `did:
    looked back at when a message was written: …`; nothing found as `… and found
    nothing`), made by [`lib/look-back-words.js`](lib/look-back-words.js) from
    the stored trace, which is not changed: `zoom(id, 1)` still gives it whole,
    `recall_search` still searches it, and the History view still reads it.
    Every tool call, these too, keeps the one tag `did:`. Granularity `turn` only:
    a `step` entry holds a call without its answer. Other tools' own answers are
    not touched, so an id the harness's own tool prints (`undo-1` from the
    harness's `memory_add`) can still reach a line.

## For hosts

A program on the same computer can read and bind memories through six methods,
served by the harness's web server as `POST /api/endless.<name>` in the
harness's Remote envelope: `{type: 'client-request', rpcId, method, payload:
{args}}` answered by `{type: 'server-response', rpcId, result}`. Only callers on
this computer are answered, and a request with an `Origin` header (which every
browser page sends) is refused. Times are ISO 8601.

| Method | Arguments | Answer |
|---|---|---|
| `endless.bind` | `sessionId, agent, project, agentName?` | `{memoryId}` |
| `endless.memories` | `agent?` | `{memories: [{memoryId, agent, project, turns, firstAt, lastAt, writerUsage}]}` |
| `endless.view` | `memoryId` | `{lines: [{id, n, text, from, to}]}`; `text` is null while a line is not written |
| `endless.zoom` | `memoryId, id, n` | `{lines}` (the two halves), or for `n = 1` `{message: {id, kind, text, at, sessionId, sessionTitle}}` |
| `endless.history` | `memoryId, before?, limit? ≤ 200` | `{turns: [{at, sessionId, sessionTitle, entries: [{id, kind, text}]}], next?}`; pages backwards, oldest first inside a page, and a page stops before 2 MB of text |
| `endless.search` | `memoryId, query, limit? ≤ 50` | `{hits: [{id, at, sessionTitle, kind, snippet}]}`, newest first, raw words, any case |

`kind` is `user`, `trace`, `reply` or `work`. `writerUsage` is `{calls,
cacheRead, miss, output}`. A refusal is `{ok: false, error: {code, message}}`
with the code `endless/bad-request`, `endless/unknown-memory`, `endless/no-line`
or `endless/already-bound` (the chat's turns are already in another memory).

The harness's own page reads the five read methods (not `bind`) through
`POST /api/endless-ui.<name>`, behind the harness's own Host and Origin check
and its signed browser cookie.

## Where the files are

`<root>` is `$DSH_HOME/endless` unless `root` says otherwise. `memoryId` is the
first 16 hex digits of `sha256(agent + "\n" + project)`; for a chat nobody bound,
`agent` is the id of the mode it runs (`endless`) and `project` its workspace
folder.

| What | Where |
|---|---|
| The memory's key | `<root>/memories/<memoryId>/key.json` |
| Finished turns, in order | `<root>/memories/<memoryId>/order-turn-v1.jsonl` |
| Summary lines | `<root>/memories/<memoryId>/tree-turn-v1/YYYY-MM-DD.jsonl` |
| The view and the writer's view | `view-turn-v1.json`, `compaction-view-turn-v1.json` in the same folder |
| Writer spend | `usage.jsonl` in the same folder, one line per call |
| One-writer lock | `lock` in the same folder |
| A bound chat | `<root>/sessions/<session>.json` |

Every line is written with one write and `fsync`. A torn last line is skipped
at load. Nothing is edited or deleted. The view is saved after every change and
loaded at start, never rebuilt while its file is usable, because a rebuilt view
would differ and lose the cache. With `granularity: step` the file names say
`step` instead of `turn`.

## Contributing

Issues and pull requests are welcome at
<https://github.com/Shtukbase/elephant-memory>.

The package has no dependencies of its own. Its tests import the harness's
packages, which are peers, so install them first:

```sh
npm install --no-save @deepseek-ai/dsh-compaction@0.2.0-rc.2 @deepseek-ai/dsh-home-paths@0.2.0-rc.2 \
  @deepseek-ai/dsh-llm@0.2.0-rc.2 @deepseek-ai/dsh-tools@0.2.0-rc.2 @deepseek-ai/schemastery@^3.18.4
node scripts/build-client.js --check
node --test --test-timeout=20000 --test-force-exit test/*.test.js
```

The browser half is built: `client/` holds its sources, and
`node scripts/build-client.js` writes `lib/client.js` (it also runs on
`npm pack`). Commit both. The tests run the real `lib/client.js` against a fake
of the harness's client, and the engine against a fake of the harness's session
and context owners. A real harness is needed to see anything drawn; see
[`TRY.md`](TRY.md). When the harness changes version, walk the recheck list at
the end of [`SEAMS.md`](SEAMS.md).

## License

MIT. See [`LICENSE`](LICENSE).
