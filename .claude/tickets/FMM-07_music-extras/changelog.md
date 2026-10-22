# FMM-07 changelog

## 2026-10-22: music_loop, music_video, music_remix (variation, extend), loop_friendly

Branch `FMM-07_music-extras`, stacked on `FMM-06_music-vocals-advanced`, repo `flow-music-mcp`.

### Files

- `src/loop-analysis.ts` (new, pure): band-level frames, steady range (skips fade-in/out), loop point search, end refinement, seam metrics.
- `src/loop.ts` (new): ffmpeg decode, loop body plus the end crossfaded into the start, written in the input's format, seam re-checked on the written file.
- `src/music.ts`: `collectTakes` (shared wait/download/credits tail of `generate`), `remix()` (song page > Remix > Variation | Extend, instruction, Generate), `downloadVideo()` (Download video > template card > MP4 download), `RemixParams` / `MusicParams`.
- `src/queue.ts`: music jobs take `MusicParams` (compose or remix).
- `src/util.ts`: `loopFriendlySound`, `LOOP_WORDING`, `videoTemplateCard`, `remixItemPattern`, `songIdOf`.
- `src/mcp/tools.ts`: tools `music_remix` (job), `music_video` (direct, up to 15 min), `music_loop` (local); `loop_friendly` on `music_generate`; `song_id` takes an id or a song link.
- `test/loop.test.ts` (new), `test/music-params.test.ts`: 90 tests in total.
- `CLAUDE.md`, `README.md`, `ROADMAP.md`: FMM-07 map, verified results, tool table, roadmap items (concurrency left out by the user's decision).

### Deviations

- `music_video` holds the download lock for the whole render (the download starts by itself when the render is done), so Flow downloads wait behind it.
- Stems not built: Get stems produced nothing without "Split stems", which was not approved.

### Verification

- `yarn build` clean, `yarn test` 7 files / 90 passed.
- Live through MCP: `music_loop` (seam clean), `music_video` simple twice (0 credits), `music_remix` variation and extend (5 credits each).
- Not run: video templates other than simple; Remix Cover/Replace/Trim; stems; an ear check of the loop.

### Follow-ups

- A long direct `music_video` call (first render 1-3+ min) may hit an MCP client's tool timeout; make it a job if that happens.

### Commit status

Committed and pushed on `FMM-07_music-extras` (PR to open by hand).
