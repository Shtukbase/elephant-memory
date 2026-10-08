# Trying Elephant Memory in an isolated harness

A recipe for trying the plugin against a live harness without touching your own
harness home. Everything lives under one trial folder you choose. The package's
tests use fakes of the harness and never run this; [`SEAMS.md`](SEAMS.md) lists
what only a real harness can confirm. This recipe was last run on 2026-10-08
with a clean `@deepseek-ai/dsh@0.2.0-rc.2` from npm.

## 0. Before anything

1. **A separate home.** Every command sets `DSH_HOME` to the trial home below.
   Never run the trial with your daily harness's home.
2. **A free port.** Pick one nothing else listens on (3487 below):
   `lsof -nP -iTCP:3487 -sTCP:LISTEN` must print nothing.
3. **Node 22 or newer**, `pnpm` on `PATH` (`dsh plugin` runs it), and the
   harness CLI `dsh` at **0.2.x**.
4. **A model key** for a live conversation. The mode list and the History tab
   work without one.
5. **Know what the agent can reach.** The harness's `workspace-write` sandbox
   lets the agent's shell tools read files anywhere your user can, not only in
   the workspace. In a trial run an agent in another mode listed the home folder
   while looking for "notes". Keep keys and private files out of the trial
   folder, and stop a turn that wanders.

## 1. Names used below

```sh
export TRIAL="$HOME/elephant-trial"          # everything lives here
export DSH_HOME="$TRIAL/home"
export DSH_TELEMETRY_DISABLED=1              # no telemetry from the trial
PLUGIN=dsh-elephant-memory                   # or a folder holding this package, or a .tgz from npm pack
PORT=3487
mkdir -p "$DSH_HOME" "$TRIAL/documents"
```

## 2. Install, the README's way

```sh
cd "$TRIAL"
env -u DEEPSEEK_API_KEY dsh plugin --profile web add "$PLUGIN"
```

The first line of output says the profile was created
(`dsh: initialized profile web at …`). Because the package declares a bundle,
`add` also lists it in the profile's `dsh.profile.bundles`, which inserts the
**Endless** mode and the plugin's browser half.

A package added from a folder is linked: after editing `lib/` or rebuilding
`lib/client.js` (`node scripts/build-client.js`), restart the harness. A `.tgz`
is copied, and adding a changed `.tgz` again from the same path and version
keeps the old copy; give the new file another name and add that.

## 3. The profile's own layer

`$DSH_HOME/profiles/web/cordis.patch.yml` starts as `[]`. Replace it with:

```sh
cat > "$DSH_HOME/profiles/web/cordis.patch.yml" <<EOF
# Keep the page's default workspace inside the trial.
- id: workspace-controller
  config:
    documentsDirectory: $TRIAL/documents
# New sessions start in the Endless mode.
- id: agent-preset-registry
  config:
    default: endless
# Session logs as plain text, so they can be read with jq or node.
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
EOF
```

Without the first row the page creates its default workspace in your real
documents folder (`~/Documents/deepseek-harness/default-workspace`).

**The model.** The base composition's default is `deepseek-official` /
`deepseek-flash`; with a DeepSeek key nothing more is needed. To use an
OpenAI-compatible gateway instead, add the `llm-pi-ai` and
`agent-default-model` rows from the README's
[Set up a model](README.md#set-up-a-model) to the same list.

## 4. The key, the harness's own way

The harness reads `$DSH_HOME/.credentials.yaml` (`version: 1`, `refs:`). Write
it so the key is not printed, with mode 0600; or leave it out and enter a
DeepSeek key in the page's own "Add an API key" dialog:

```sh
( umask 077; printf 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "%s"\n' "$YOUR_KEY" > "$DSH_HOME/.credentials.yaml" )
```

For a gateway, name the ref after its `apiKeyEnv` (for example
`OPENCODE_GO_API_KEY`). The launch environment would win over the file, so every
launch below runs with `env -u` for that variable.

## 5. Start it, and stop only that process

```sh
cd "$TRIAL"
env -u DEEPSEEK_API_KEY dsh web --no-open --port "$PORT" > "$DSH_HOME/run.log" 2>&1 &
echo $! > "$DSH_HOME/run.pid"
```

Wait for the `dsh web:` line in `$DSH_HOME/run.log`; it is the page's address
with a one-time token (do not paste it anywhere). Open it in a browser tab. The
first visit shows a preview notice; *Continue* dismisses it.

Stop the harness later with `kill "$(cat "$DSH_HOME/run.pid")"`, then check the
port is free again. Never stop any other process.

## 6. A short conversation

In a new session (the mode picker above the message box shows **Endless**):

1. "Remember this rule for our work here: release notes list only what ships.
   Confirm in one short sentence."
2. Paste a paragraph of 600 or more characters with a few exact details in it
   (a code, a room name, a number), and ask for a one-sentence reply.

Then start a **new** session in the same workspace and ask:

3. "What rule did I give you about release notes, and in which chat? Also quote,
   word for word, the sentence I wrote about <one of the details>."

Expected: the answer names the rule and the first chat's title, and quotes the
sentence exactly after a `zoom` call, without the person repeating anything.
Both sessions are unbound (no host called `endless.bind`), so both use the
default key (mode `endless`, the workspace folder) and share one memory.

### 6a. What the page shows

1. **The look-back row.** The zoom call reads *Looked back · «what» · in
   «chat»*, never `zoom {"id":2,"n":1}`; opened, it shows the message without
   `2+0|`. Rows sit inside the folded "Called tools" group of a finished turn.
2. **No "Context compacted" row** in an Endless chat, on any turn.
3. **History.** Open the right sidebar (the icon at the top right): its start
   page lists **History**, with a clock icon, beside Workspace files and New
   terminal. Or type `/history` in the message box. *Conversation* shows the
   turns by day, with *Show earlier* paging back; the search field finds words
   anywhere in the memory and highlights them; *Remembers* lists the summary
   lines, each opening down to the exact message.

## 7. What to look at

**The plugin is mounted.** `dsh --profile web --dump-config` lists the rows
`endless-client` and `preset-endless` under `# == dsh-elephant-memory`. In
`run.log`, no `failed to import` or `broken` line names the package.

**Files appear** under `$DSH_HOME/endless/memories/<memoryId>/`, where
`<memoryId>` is the first 16 hex digits of `sha256("endless\n" + <workspace>)`
for unbound chats. The workspace is the session's folder; with the layer above
it is `$TRIAL/documents/deepseek-harness/default-workspace`.

```sh
ls -R "$DSH_HOME/endless"
cat "$DSH_HOME"/endless/memories/*/key.json
```

- `key.json`: `{"agent":"endless","project":"<workspace>"}`;
- `lock`: `{"pid": …}` of the running harness;
- `order-turn-v1.jsonl`: one line per finished turn of either chat, in the
  order the turns finished;
- `tree-turn-v1/YYYY-MM-DD.jsonl`: one line per summary line,
  `{"l":0,"i":3,"text":"in «…», you: …","size":…,"src":…}`; short messages
  appear word for word, longer ones as summaries;
- `view-turn-v1.json` and `compaction-view-turn-v1.json`: the two views;
- `usage.jsonl`: one line per summary-writer call.

**The session log** is `$DSH_HOME/sessions/--<cwd>--/<session>/session.v4.jsonl`.
From a chat's second turn on, the turn reads, in order: `turn/start`, perhaps
one-node `user/message` replaces whose `source.kind` is `skill-catalog`,
`runtime-context` or `agent-instructions` (a context message moving in front of
the view; none in a steady turn), `compaction/start`, `compaction/summary`, a
`user/message` with `surfaceOp.op` `replace` and `source.kind`
`compact-checkpoint` whose text starts with `<chat>`, `compaction/end`, the new
`user/message`, then the reply. A new chat's first turn carries the earlier
chats' view as a `user/message` with `source.kind` `endless-view` instead.

This prints, for the first step of every turn, what the request held and its
cache numbers:

```sh
LOG=$(find "$DSH_HOME/sessions" -name 'session.v*.jsonl' | head -1)
node --input-type=module - "$LOG" <<'EOF'
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const events = rows.filter((r) => typeof r.type === 'string' && r.type !== 'session');
const bySeq = new Map(events.map((e) => [e.seq, e]));
const nodes = [];
const describe = (e) => {
  const m = e.type === 'user/message' ? e.data : e.data?.message;
  const text = (m?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return `${e.type} ${m?.source?.kind ?? ''} ${text.length} chars: ${text.slice(0, 70).replace(/\n/g, ' ')}`;
};
for (const e of events) {
  if (e.surfaceOp === 'append') nodes.push(e.seq);
  else if (e.surfaceOp?.op === 'replace') {
    const a = nodes.indexOf(e.surfaceOp.startSeq), b = nodes.indexOf(e.surfaceOp.endSeq);
    nodes.splice(a, b - a + 1, e.seq);
  }
  if (e.type === 'assistant/message') {
    const u = e.data.usage ?? {};
    console.log(`turn ${e.data.turn} step ${e.data.step}: miss ${u.inputTokens}, cache read ${u.cacheReadTokens ?? 0}, output ${u.outputTokens}`);
    if (e.data.step === 1) for (const s of nodes.slice(0, -1)) console.log(`    ${describe(bySeq.get(s))}`);
  }
}
EOF
```

Before the reply, the surface must be: the context messages in this order, at
most one `skill-catalog`, at most one `runtime-context`, then any
`agent-instructions`; from turn 2 on, ONE `compact-checkpoint` (the view), or
on a new chat's first turn ONE `endless-view`; then the new message.

**Cache hits per step.** The harness stores the provider's cache hits on every
`assistant/message` as `usage.cacheReadTokens` and the rest of the input as
`usage.inputTokens`; the script above prints both. Good numbers: from a chat's
second turn on, step 1 reads nearly the whole request from the cache (97-98% in
the 2026-10-08 trial), and so does every later step of a turn. A turn misses
once, from the changed point on, when a context message changes, when the
plugin's own system prompt changes (a new version), or right after a batch of
merges (the view passed `viewBytes` and was merged down to `viewFloorBytes`).

**The summary writer's calls** do not appear in the session log. Each call logs
one line to standard error, which `run.log` captures:
`[ENDLESS_WRITER_USAGE] {"memoryId":"…","provider":"…","model":"…","cacheRead":…,"miss":…,"output":…}`.
A failing line logs `[ENDLESS_WRITER] line l:i failed, retrying every 10 s: …`,
and a trimmed one `[ENDLESS_WRITER] line l:i fit in no try and was trimmed …`.
With effort `off`, a call writes one or two hundred output tokens; thousands
mean thinking is on (see the README's [Set up a model](README.md#set-up-a-model)).
A refused turn logs `[ENDLESS_TURN] … turn refused`. A model below 65,536
tokens of context logs `[ENDLESS_GUARD] … runs without endless memory` once per
chat.

**The seam methods.** From this computer, with no browser involved (they answer
only callers on this computer without an `Origin` header):

```sh
MEM=$(basename "$(ls -d "$DSH_HOME"/endless/memories/*/ | head -1)")
call() { curl -s -X POST "http://127.0.0.1:$PORT/api/$1" -H 'content-type: application/json' \
  -d "{\"type\":\"client-request\",\"rpcId\":\"$1\",\"method\":\"$1\",\"payload\":{\"args\":$2}}"; echo; }
call endless.memories '{}'
call endless.view "{\"memoryId\":\"$MEM\"}" | cut -c1-400
call endless.history "{\"memoryId\":\"$MEM\",\"limit\":2}" | cut -c1-400
call endless.search "{\"memoryId\":\"$MEM\",\"query\":\"release notes\"}"
```

Each answers `{"type":"server-response","rpcId":…,"result":{"ok":true,"value":…}}`.

**The page's routes.** `POST /api/endless-ui.<name>` answers only a browser
holding the harness's session cookie; a call without it is refused (401):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/api/endless-ui.memories" \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"x","method":"endless-ui.memories","payload":{"args":{}}}'
```

## 8. What would count as failure

1. The Endless mode is missing from the mode picker.
2. A turn after a chat's first carries the previous turns' messages instead of
   one checkpoint, or a `skill-catalog` or `runtime-context` message whose
   content did not change follows the new message.
3. No `tree-*` files appear, or lines stay "(not summarized yet: zoom it)".
4. The second chat's first turn carries no `endless-view` message, or its answer
   does not know the rule from the first chat.
5. Two `memories/*` folders for one workspace, one per way the mode was chosen.
6. A turn is refused with `[ENDLESS_TURN]` in `run.log` while the provider is
   reachable.
7. Any file changes outside `$TRIAL`.
8. A look-back call drawn as `zoom {"id":…}`, a "Context compacted" row in an
   Endless chat, or no **History** entry on the sidebar's start page.

Report each with the copied log lines, never a summary of them.
