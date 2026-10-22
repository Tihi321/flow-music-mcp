# FMM-09: Flow live checks: local frames, chain_previous, Veo, 720p, likeness, 4K

User OK 2026-10-22 for all paid runs below (local first frame, chain_previous, likeness continue, 720p + Veo Lite).
Part of `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md`. Branch `FMM-09_flow-live-checks`, stacked on
`FMM-08_flow-robustness`. Paid: ask the user per run (with the quote).

## Mapped live 2026-10-22 (free, direct composer settings popover, nothing started; .claude/temp/veo.mjs)

- Video, Ingredients, 16:9, x1 quotes: **Veo 3.1 - Lite 10**, **Veo 3.1 - Fast 20**, **Veo 3.1 - Quality 100**,
  **Omni 1.1 Flash 360p 4 s 4**, Omni 720p 4 s 7.
- Under any Veo model the popover has NO resolution radios and NO duration radios (only Image/Video, Frames/
  Ingredients, 16:9/9:16, x1-x4). Omni shows `360p info`, `720p`, `4s 6s 8s 10s`.
- So `applySettings` (`src/flow/direct.ts` ~131) throws "Flow has no "720p" option" when a Veo scene passes
  `resolution`/`duration`; the schema already says those are Omni-only.

## Tasks

1. Veo: in `applySettings`, when the chosen model is a Veo model, skip `resolution`/`duration` with a note instead of
   failing (or reject them up front in the tool with a clear message: pick one and document it). Tool description
   lists the measured quotes. Unit-test the decision if it is a pure helper.
2. Local `first_frame` / `last_frame` upload (upload rights are agreed in .env): one Omni 360p 4 s clip with a local
   first frame (an image from .claude/temp or a downloaded Flow image). Check the uploaded tile's real title; if it is
   not `fm-<job>-<label>`, fix `waitForUpload` (`direct.ts` ~154) and `attachAsset` to match what Flow names it.
   Paid: 4 credits.
3. `chain_previous`: a 2-scene video `flow_generate` where scene 2 chains from scene 1 (two Omni 360p 4 s clips).
   Paid: 8 credits.
4. Likeness mode of `flow_continue` with a character (Kai) on an existing clip. Paid: ~4.
5. One Omni 720p clip (7) and one Veo 3.1 - Lite clip (10). Paid: 17.
6. 4K image download: open an image tile's Download submenu and see whether "4K Upscaled" shows a cost; download it
   only if free (balance before/after), else ask.
7. ROADMAP: write why "Confirm before generating: Never" stays unused (the credit card is how `max_credits` is
   enforced for agent runs; only worth it for agent video batches). Tick the verified items; CLAUDE.md "Verified live".

## Verification

Each run through the MCP tools on 127.0.0.1:7462; files checked with ffprobe; balance before/after each paid run.

## Status (task 1)

Done, not yet verified live. `applySettings` (src/flow/direct.ts) now reads the model shown in the composer and asks the pure helper `modelOptions` (src/flow/pure.ts, with `isVeoModel`, `VEO_IGNORED_NOTE`) which of resolution/duration apply; under Veo they are skipped and the run note says "Veo 3.1 clips are fixed at 8 s; resolution/duration are Omni-only, ignored". It now returns `{ quote, ignored? }`; callers updated: flow_generate (note added to the job note list) and runContinue in video.ts. flow_narrate goes through the same path (no model named, so the model last used in the composer decides). flow_generate description has the measured quotes. Tests: test/flow-pure.test.ts (+3). `yarn build` clean, `yarn test` 108 passed.
- Also: `listProjects` (driver.ts) now waits up to 10 s for the first `.project-card` (timeout = no projects) before reading; `openProject` re-lists once after 2.5 s when a named project is not found, before throwing or creating. build clean, 108 tests pass.
- Wrong-tile download fix: "new since Start" is now positional (`locateNew`, `mergeView`, `SnapTile` in pure.ts): the snapshot is aligned with the current grid by position and score (same uuid/token 2, same title 1), so a video key flipping uuid -> asb or a new tile sharing an old title cannot make an old tile new; a tile replaced in place (new uuid, same slot) still counts as new. `topIds` returns a snapshot list; scanNew/waitForNewMedia/retryErrorTile/agent collectFresh/video continue use it. `tileResolver` throws when the tile found has a different title than the one captured. build clean, 115 tests pass (7 new). Not run live.

## Status (orchestrator, live 2026-10-22; user approved all paid runs; Flow 1,010 -> 977)

- [x] 1 Veo: resolution/duration skipped with a note; Veo 3.1 Lite clip ran (8 s 720p, 10 credits).
- [x] 2 Local first frame (job e92269c6, 4): upload tile `fm-e92269c6-start.jpeg`; first frame = local image.
- [x] 3 chain_previous (jobs 7c79e038 + c542b511, 8): chained correctly, BUT the first run downloaded the wrong tile for
      the second clip (an older clip whose key flipped uuid -> asb). Fixed (`locateNew`, title check on download); the
      right clip fetched by asb. A first attempt failed with "Projects: none" right after a restart (fixed, nothing spent).
- [x] 5 Omni 720p 4 s (7) and Veo Lite (10) back to back after the fix: both right files.
- [x] 4 Likeness continue with Kai (job 63adfad9, 4).
- [ ] 6 4K download: not run (submenu not reached from a script; cost unknown).
- [x] 7 ROADMAP: "Confirm before generating: Never" decision written.
