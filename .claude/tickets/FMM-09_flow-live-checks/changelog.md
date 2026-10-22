# FMM-09 changelog

## 2026-10-22: Flow live checks (33 credits) and three fixes they found

Branch `FMM-09_flow-live-checks`, stacked on `FMM-08_flow-robustness`, repo `flow-music-mcp`.

### Files

- `src/flow/pure.ts`: `isVeoModel`, `modelOptions`, `VEO_IGNORED_NOTE`; `SnapTile`, `tileMatch`, `locateNew`, `mergeView` (new-tile detection by aligning the grid before/after by position).
- `src/flow/direct.ts`: `applySettings` returns `{ quote, ignored? }` and skips resolution/duration under Veo; new-tile detection and Retry use the snapshot list.
- `src/flow/driver.ts`: `listProjects` waits for the first project card; `openProject` lists again before giving up; `topIds` returns a snapshot list; `scanNew` uses `locateNew`; `tileResolver` refuses a tile whose title differs from the expected one.
- `src/flow/video.ts`, `src/flow/agent.ts`: snapshot-based new-tile detection; `runContinue` takes the new `applySettings` result.
- `src/flow/tools.ts`: `flow_generate` description with the measured quotes.
- `test/flow-pure.test.ts`: 115 tests in total.
- `CLAUDE.md`, `ROADMAP.md`: FMM-09 results, the "Confirm: Never" decision.

### Deviations

- Two bugs found live and fixed here: the project list race, and a wrong-tile download caused by FMM-08's key change (a video's key flips uuid -> asb after it finishes). The chained second clip was made correctly but first downloaded wrong; the right one was fetched afterwards by its asb id.
- 4K image download not done.

### Verification

- `yarn build` clean; `yarn test` 8 files / 115 passed.
- Live (user approved, 33 credits, balance 1,010 -> 977 matching the quotes): local first frame, chain_previous, Omni 720p, Veo 3.1 Lite, likeness continue; frames and files checked with ffprobe/ffmpeg and by eye.
- Not run: local `last_frame`, 4K download.

### Commit status

Committed and pushed on `FMM-09_flow-live-checks` (PR to open by hand).
