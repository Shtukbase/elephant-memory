# Changelog

Source, registry and this file carry the same version on every release.

## 0.3.0 - 2026-10-11

1. Ranked recall (`recall`) and automatic source passages complement the
   existing summary, raw search and zoom tools. Query expansion is bounded
   (six-second deadline) and keeps the original query on failure.
2. The Endless preset enables a bounded decision journal with durable
   progress, restart recovery and source-change invalidation.
3. Summary lines keep the date of each decision, and a merge keeps the dates
   of both its lines, or the latest, marked.
4. Before acting on a remembered decision or fact about files, the agent checks
   `git log` and `git status`; the repository wins over memory.
5. Ordinary coding tools remain available; the plugin sets no effort or call cap.
6. Manual recall has readable transcript rows with opening, closing and reload
   coverage.
7. The supported harness floor is 0.2.1-alpha.1.

## 0.2.0 - 2026-10-09

1. One summary call writes up to six summary lines that are ready at the same
   time (`writer.batch`, default 6). Each line aims at 0.75 of the limit and is
   judged alone. A line that does not fit is asked again in the same
   conversation. Over 235 scripted turns on `deepseek-flash` the writer made
   29% fewer calls and trimmed fewer lines, and a turn with its summaries cost
   16% less, with the same recall. Set `writer.batch: 1` for one line per call.

## 0.1.1 - 2026-10-08

1. A turn stopped with Esc is saved to memory: the person's message, what the
   agent already said, its tool uses with their results so far, and a closing
   note, "stopped by the person". Before, a turn stopped while it waited for
   the memory lost the person's message and was not saved at all, and a turn
   stopped later was saved without saying it had been stopped.
2. A turn cut off because the harness stopped running keeps the person's
   message the same way, and ends with the note "interrupted".

## 0.1.0 - 2026-10-08

1. First release.
