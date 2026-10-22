# FMM-08 changelog

## 2026-10-22: Flow video handles, trouble messages, cancel, failed tiles, re-ask rule

Branch `FMM-08_flow-robustness`, stacked on `FMM-07_music-extras`, repo `flow-music-mcp`.

### Files

- `src/flow/pure.ts` (new, pure): `asbToken`, `parseAsbHandle`, `tileMatchesHandle`, `tileKey`, `flowTrouble`, `troubleMessage`, cancel messages, `newErrorIndexes`, `sceneRound`.
- `src/flow/driver.ts`: tiles carry `thumb`; `asb:` handles resolve tiles; `tileResolver` tries id, asb, then title; `scanGrid` / `scanNew` / `topIds` key by `tileKey` (two videos with one title stay two); `flowNotice`, `troubleText`; a stale `asb:` handle gives a clear error.
- `src/flow/direct.ts`: cancel checked before Start; Retry only for failed tiles new since Start, counted once; high-demand text in errors; video files record `thumb`.
- `src/flow/video.ts`: `asb:` handles for edit/continue; cancel before Start; trouble text in the edit poll; a new error tile stops the edit download.
- `src/flow/agent.ts`: the agent wait stops on "Something went wrong"/high demand; `runImages` uses `sceneRound` and does not re-ask after trouble with nothing made.
- `src/jobs.ts`: `statusAfterRun`, hooks `madeSomething` / `finishedAfterCancel` (a cancelled job that made files ends `done` with a note). `src/flow/queue.ts`: Flow overrides; `FlowFile.thumb`.
- `src/flow/tools.ts`: `flow_assets` shows `asb:<token>` for videos; descriptions of `flow_assets`, `flow_download`, `flow_cancel`.
- `test/flow-pure.test.ts` (new), `test/jobs.test.ts`: 105 tests in total.
- `CLAUDE.md`, `ROADMAP.md`: FMM-08 section with live results.

### Deviations

- Found live and fixed: same-titled videos collapsed in `scanGrid` (keyed by `title:` id).
- `asb:` tokens can change after a while (seen once in ~1 h): documented, stale-handle error added, title fallback kept.

### Verification

- `yarn build` clean; `yarn test` 8 files / 105 passed.
- Live (free): asb listing and downloads, stale token error, cancel queued and cancel before Start. See plan Status.
- Not run/seen: high-demand banner, failed tiles, a cancel after Start, a dropped scene.

### Commit status

Committed and pushed on `FMM-08_flow-robustness` (PR to open by hand).
