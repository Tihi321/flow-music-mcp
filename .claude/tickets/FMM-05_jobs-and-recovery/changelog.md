# FMM-05 changelog

## 2026-10-22: jobs survive a restart; a closed window gives a clear error

Branch `FMM-05_jobs-and-recovery`, stacked on `FMM-04_unit-tests`, repo `flow-music-mcp`.

### Files

- `src/jobs.ts` (new): `BaseJobQueue` shared by both sites: ids, get/list/wait/cancel/retry/busy, the paced work loop (`nextDelay`), and persistence to one JSON file under a key per queue (atomic temp-file + rename, re-reads the file so the other queue's key is kept, last 200 jobs, corrupt file moved to `jobs.json.bad`). On load a queued/running job becomes failed with "The server restarted before this job finished; ..."; it is never resumed on its own.
- `src/queue.ts` (music) and `src/flow/queue.ts` (Flow): thin subclasses; same exports, same pacing env vars and defaults; they save to `~/.flow-music-mcp/jobs.json` (`music`, `flow`).
- `src/chrome.ts`: `closedWindowError(site, err)` turns Playwright's closed page/context/browser errors into "The <Flow|Flow Music> window was closed (or Chrome quit) while the job ran. ..."; `getBrowser` drops a disconnected browser before reconnecting.
- `src/mcp/tools.ts`: music tools use `withSitePage("music")`; the runner maps closed-window errors; `music_status` skips the page while a song is being made (with a note); `music_wait`'s unknown-id note and `music_jobs`' description mention persistence.
- `src/flow/tools.ts`: the runner maps closed-window errors; `flow_wait`'s unknown-id note; `flow_retry` saves after clearing `failed_scenes`.
- `src/music.ts`: its own `withPage` chain removed (one lock per site now).
- `test/jobs.test.ts` (new, 13 tests): pacing, cancel/retry, round trip, restart rule, other key kept, corrupt file, cap, error mapping.
- `README.md`, `CLAUDE.md`: `jobs.json` lines. `ROADMAP.md`: "Jobs live in memory" and "Chrome recovery" updated.

### Deviations

- `chain_from` / `reference_from` needed no change: they read the queue, which now holds persisted jobs.
- The plan named `flow_jobs`; no such tool exists. `flow_wait` and `flow_status` list Flow jobs.

### Verification

- `yarn build` clean; `yarn test` 5 files, 69 passed.
- Live (free, project fmm-02-test, credits 1,010 before and after):
  - Server killed while image job `016f1c4a` ran; after the restart `flow_wait` showed it failed with the restart message.
  - `flow_retry` of it, then the Flow tab closed through CDP `/json/close`: failed with the closed-window message; the next `flow_status` reopened the tab, signed in.
  - `music_status` through the new lock: signed in.
- Not run: killing Chrome mid-job (needs the user's OK); `music_status`'s busy note (needs a paid song running).

### Follow-ups

- The two test attempts may have left free test images in fmm-02-test.

### Commit status

Committed and pushed on `FMM-05_jobs-and-recovery` (PR to open by hand; no `gh` CLI here).
