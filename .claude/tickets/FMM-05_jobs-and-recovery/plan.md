# FMM-05: Jobs that survive a restart, and Chrome recovery

Part of the roadmap task list `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md` (second ticket). No credits.
Branch `FMM-05_jobs-and-recovery`, stacked on `FMM-04_unit-tests` (uses its `nextDelay` and vitest).

## Why

ROADMAP "Robustness": jobs live in memory, so a restart forgets job ids (the files stay); a closed Flow/Music window or
a Chrome crash mid-job is not handled. Also: `music_status` waits behind a running song (up to 15 min).

## Tasks

1. **One generic queue.** New `src/jobs.ts` with `BaseJobQueue<J extends BaseJob, P>` holding what `src/queue.ts`
   (`JobQueue`, music) and `src/flow/queue.ts` (`FlowJobQueue`) share today: the map, 8-char ids, `get`, `list`,
   `wait`, `retry`, `cancel` of a queued job, `busy`, `pausedReason`, and the `work` loop with `nextDelay` pacing (each
   queue keeps its own env vars and defaults: music 20-45 s, Flow 25-70 s). The subclasses keep their job shapes and
   how a runner's result is applied (music: `session`, `songs`; Flow: `files`, `failed_scenes`, `attempts`,
   `cancelRequested`, credits ...). Exported names and the MCP tools' outputs stay the same.
2. **Persistence.** Each queue saves its jobs to `HOME_DIR/jobs.json` (`HOME_DIR` from `src/chrome.ts:14`; one key per
   queue: `music`, `flow`), written atomically (temp file + rename) on add, cancel, retry, start, finish, and after
   `flow_retry` edits `failed_scenes` (`src/flow/tools.ts:~405`; add a `save()`/`update()` the tool calls). Keep the
   last 200 jobs per queue. On load, a job that is `queued` or `running` becomes `failed` with error "The server
   restarted before this job finished; files already saved are kept. Use *_retry to run it again." and
   `cancelRequested` cleared. Never resume on its own (it could spend credits again). A missing or corrupt file starts
   empty (a corrupt one is renamed to `jobs.json.bad`). The path is injectable so tests use a temp dir.
   Check what depends on in-memory jobs (`chain_from` / `reference_from` at `src/flow/tools.ts:~145-150`, the
   "Not a job of this server process" messages in `flow_wait` / `music_wait`) and fix the wording.
3. **Chrome recovery.** When the page, context or browser closes during a job (Playwright errors like "Target page,
   context or browser has been closed", "Browser has been disconnected"), the job fails with a clear message: "The
   <Flow|Flow Music> window was closed (or Chrome quit) while the job ran. It reopens on the next call; check the site
   before retrying, the generation may have finished there." Put the mapping in one helper (`src/chrome.ts`) used by
   both runners. `getBrowser` drops a disconnected `browser` so the next call relaunches (check it already does).
4. **One page lock for music.** Music tools use `withSitePage("music", ...)` (`src/chrome.ts:118`) instead of the
   second chain `withPage` in `src/music.ts:~38-43`; remove the stale comment in chrome.ts. `music_status`
   (`src/mcp/tools.ts:~96-113`) skips page work while a music job runs, as `flow_status` does
   (`src/flow/tools.ts:~231`), and says so.
5. **Tests** (vitest): the base queue's pacing order, cancel/retry transitions, persistence round trip, the restart
   rule (queued/running -> failed), corrupt file handling, cap of 200, the closed-window error mapping.
6. Docs: README / CLAUDE.md lines for `jobs.json`; ROADMAP: tick "Jobs live in memory" and "Chrome recovery" (say
   what was verified live).

## Verification

- `yarn build`, `yarn test`.
- Live, free: start the server, queue a free Flow image job (`flow_generate`, image), restart the server mid-job, and
  check `flow_jobs` shows it failed with the restart message and older finished jobs are still listed. Close the Flow
  tab during a free image job: clear error; the next `flow_status` reopens the tab. Ask the user before killing Chrome
  (it is their signed-in window).

## Status (implementation agent, tasks 1-5 and the README/CLAUDE.md lines of task 6)

Done, not committed. `yarn build` clean; `yarn test` 5 files, 69 tests passed (the new `test/jobs.test.ts` adds 13). No live verification, no Chrome, no ROADMAP.md or changelog.md edits.

- `src/jobs.ts` (new): `BaseJobQueue<J, P, R>` with map, 8-char ids, get/list/wait/retry/cancel/busy/pausedReason, work loop with `nextDelay`, persistence. Hooks for subclasses: `create`, `apply`, `started`, `cancelsRunning`. Options: `key`, `file`, `pauseMinMs/MaxMs`, injectable `rand/now/sleep`. No playwright/env imports.
- Persistence: `save()` (public) re-reads the file, replaces only its own key, writes `<file>.<pid>.tmp` then renames. Saved on add, cancel, retry, start, finish; `flow_retry` calls `queue.save()` after clearing `failed_scenes`. Cap 200 (oldest finished first, then oldest unfinished). Load: queued/running -> failed with the plan's message, `cancelRequested` and `progress` cleared; corrupt file -> `jobs.json.bad`. Save errors are logged, not thrown.
- `src/queue.ts`, `src/flow/queue.ts`: now thin subclasses (constructors take an optional file path, default `HOME_DIR/jobs.json`; pacing env vars read where they were). `JobStatus`, `Job`, `FlowJob`, `JobRunner` exports kept. Music `cancel` on a running job still does nothing; Flow sets `cancelRequested`.
- `src/chrome.ts`: `closedWindowError(site, err)` (regex for "...has been closed", "Target closed", "Browser has been disconnected"; other errors returned as is); `getBrowser` sets `browser = null` when not connected before reconnecting/relaunching (it already reconnected, now explicit); stale `withPage` comment removed.
- `src/mcp/tools.ts`, `src/flow/tools.ts`: both runners `.catch` through `closedWindowError`. Music tools use `withSitePage("music", ...)`; `withPage` removed from `src/music.ts` (and its `getMusicPage` import; `login.ts` still uses `getMusicPage`). `music_status` skips `signedIn` while `queue.busy` and adds a `note`. "Not a job of this server process" replaced by "Unknown job id (jobs are kept for the last 200 per server, so it may be older or from another install). Check ...". `music_jobs` description updated.
- `chain_from`/`reference_from` look the earlier job up in the queue, which now includes persisted jobs, so they work across a restart when that job finished (files are in the saved job); a job failed by the restart rule has no files, so the existing "produced no video/image" error applies.
- `test/jobs.test.ts`: pacing order and sleeps, cancel/retry, round trip, restart rule, other-key preservation, corrupt file, no-path queue, 200 cap, closed-window mapping. Temp dirs under `.claude/temp/jobs-test-*`, removed after each test.
- Docs: README (jobs.json paragraph), CLAUDE.md (file list line).

Deviations / notes:
- The 200 cap also drops unfinished jobs if there are more than 200 of them (practically never).
- A closed window during a job that has `cancelRequested` ends as cancelled, as before.
- Files are mixed LF/CRLF in this checkout (autocrlf); edited files kept their endings, `src/jobs.ts` is CRLF like most of src.
- Scratch scripts of mine are in `.claude/temp/` (e2.py, e3.py, e4.py, edit-flowqueue.py).

## Status (orchestrator, live verification 2026-10-22)

- Restart mid-job: free image job `016f1c4a` (project fmm-02-test) running, server killed, restarted: `flow_wait` shows
  it `failed` with the restart message. (There is no `flow_jobs` tool; `flow_wait` / `flow_status` list jobs.)
- Closed tab mid-job: `flow_retry` of that job, then the Flow tab closed through CDP's `/json/close`: the job failed
  with "The Flow window was closed (or Chrome quit) while the job ran ...". The next `flow_status` reopened the tab,
  signed in, credits 1,010 (unchanged).
- `music_status` works through `withSitePage("music")`. Its busy note was not seen (needs a running, paid song).
- Not run: killing Chrome mid-job (asks the user first; not asked, same reconnect path).
