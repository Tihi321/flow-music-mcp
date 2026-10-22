# FMM-08: Flow robustness: video identity, high demand, cancel, failed tiles, re-ask

Part of `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md`. Branch `FMM-08_flow-robustness`, stacked on
`FMM-07_music-extras`. Free except where marked.

## Mapped live 2026-10-22 (project fmm-02-test, read only, .claude/temp/flowtiles.mjs)

- A settled video tile (`flow-grid-tile-container[aria-label] > ... flow-video-tile`) has NO uuid in any attribute.
  Its thumbnail is `img[alt="Generated video thumbnail"][src="https://flow.google.com/asb/<token>"]`; on a real pointer
  hover the img is replaced by `<video src="https://flow.google.com/asb/<token><more>">` (same prefix, longer).
- The `/asb/<token>` thumbnail URL was the SAME for each video tile before and after a page reload (5 tiles compared),
  so the token is a usable handle at least within a session; whether it lasts days is unknown.

## Tasks

1. **Video identity.** `TILE_JS` / `RawTile` (`src/flow/driver.ts` ~257-279) also return `thumb`: the `/asb/<token>`
   part of the thumbnail src (or of the hover video's src, cut to the thumbnail token length is NOT safe: prefer the
   img; when only a video is present, keep the full asb path and compare by prefix). `waitForNewMedia`
   (`src/flow/direct.ts` ~310-347) and the continue/edit paths store on `FlowFile` (`src/flow/queue.ts`) both the uuid
   id seen at finish time (if any) and `thumb`. `tileById` / `tileResolver` (`driver.ts` ~281, ~509) accept an id of the
   form `asb:<token>` and match a tile whose img src (or video src) contains that token, before falling back to title.
   `flow_assets` shows video tiles with `media_id: "asb:<token>"` instead of hiding `title:` ids (`src/flow/tools.ts`
   ~430), and `flow_download` / `flow_edit` / `flow_continue` accept it. Unit-test the token extraction and matching.
2. **High demand / agent errors.** `flowNotice(page)` in `driver.ts` (like `pageNotice` in `src/music.ts`): text of
   dialogs, `role=alert`, snackbars/toasts, and any banner containing "experiencing high demand". Call it in
   `waitForNewMedia` when a tile fails or times out, in the `waitForAgent` loop (`src/flow/agent.ts` ~258) — also
   check the agent's latest reply for "Something went wrong" / "high demand" and stop with that text instead of
   waiting to the timeout — and in the video-edit poll (`src/flow/video.ts` ~201-212). Errors start with
   "Flow reports high demand: ..." when the banner is present, and say credits are refunded for failed requests only
   when Flow says so. Pure text classification (`flowTrouble(text)`) unit-tested.
3. **Cancel.** `runScene` (`direct.ts` ~351) and `runContinue` (`video.ts` ~58) and `runVideoEdit` check `cancelled()`
   right before pressing Start/Generate and throw "cancelled before starting (nothing spent)". After Start, a cancel
   makes the waiter stop with "cancelled; the generation already started in Flow and will finish and be charged there".
   In `src/jobs.ts` / `src/flow/queue.ts`: a job whose runner returns files after a cancel request ends `done` with a note
   "finished before the cancel took effect", not `cancelled`. Unit-test the status rule.
4. **Failed tiles in the direct composer.** `retryErrorTile` (`direct.ts` ~296) only retries error tiles that are new
   since the job's start (pass the set of ids/labels known before Start; error tiles have no media id, so compare by
   position above the first known tile, as `scanNew` does); `failures` counts distinct error tiles once. The video-edit
   path checks for a `flow-error-tile` before downloading (the comment at `video.ts` ~214 says so; the code does not).
5. **Re-ask for dropped scenes.** In `runImages` (`agent.ts` ~356-462) pull "which scenes are still to do, and is
   another round worth it" into a pure function; unit-test it (all done, one dropped, a round that made nothing).
6. Docs: CLAUDE.md (mapping above + new behaviour, dated), ROADMAP: tick "Video identity", "High demand", "Cancelling a
   running job", "A failed tile in the direct composer" (say what was verified live), "Re-asking" (unit-tested only).

## Verification

- `yarn build`, `yarn test`.
- Free live: `flow_assets` lists the video tiles with `asb:` ids; `flow_download` of one video by its `asb:` id
  (original 360p, free); a free image job (`flow_generate` image) cancelled while running: it ends with the right status
  and message; a free image job cancelled while queued (before Start) never presses Start.
- High demand and failed tiles: only if they happen; otherwise unit tests and a note.

## Status (implementation, tasks 1-6; live checks NOT done)

- `yarn build` clean; `yarn test` 104 passed (8 files). New: `test/flow-pure.test.ts`, cancel tests in `test/jobs.test.ts`.
- 1 Video identity: `src/flow/pure.ts` (`asbToken`, `parseAsbHandle`, `tileMatchesHandle`); `TILE_JS`/`Tile` get `thumb`; `tileById`/`tileResolver(page,id,title,thumb)`/`tileThumb`; `FlowFile.thumb`; `flow_assets` shows `asb:` ids; `resolveVideo` accepts them (so flow_edit/continue), flow_download/trash via `findTile`.
- 2 Trouble: `flowTrouble`/`troubleMessage` (pure), `flowNotice`/`troubleText` (driver), used in `waitForNewMedia`, the video-edit poll and `waitForAgent` (new `WaitResult.trouble`; `runImages` stops re-asking when trouble and nothing produced).
- 3 Cancel: checks before Start in `runScene`, `runContinue`, `runVideoEdit`; messages in pure.ts; `statusAfterRun` + hooks `madeSomething`/`finishedAfterCancel` in `src/jobs.ts`, Flow overrides in `src/flow/queue.ts`. The cancelled callback plumbing already existed in tools.ts (no change needed).
- 4 Failed tiles: `newErrorIndexes` (pure, also used by `scanNew`), `retryErrorTile(page, before)`, failure count idempotent; video edit now goes Back to the grid, compares failed-tile count with the count before, throws if it grew, then reopens the edit view to download.
- 5 Re-ask: `sceneRound` (pure) used by `runImages`.
- 6 Docs: CLAUDE.md section, ROADMAP lines (phrased "not yet verified live").
- Deviations: `statusAfterRun` lives in jobs.ts (not pure.ts) to keep the base queue free of Flow imports. `flowNotice` uses only role-based selectors (dialog, alertdialog, alert, status) plus the banner text, no toast class names. The `thumb` of a freshly finished video is read after the download (the thumbnail is only re-signed to /asb/ a little after it lands); the edited video's new token is not recorded by `flow_edit` (it keeps `media_id` = the source handle).
- Check live: flow_assets lists video tiles with `asb:` ids; flow_download of one by `asb:` id (original, free) incl. after hovering/reload; a free image `flow_generate` cancelled while running (done+note if it finished, else cancelled with the "already started" message) and one cancelled while queued; confirm the error text when the banner is up if it happens; that `[role=status]` regions are not noisy (a persistent non-trouble status is ignored by flowTrouble, so harmless).

## Status (orchestrator, live verification 2026-10-22, free)

- First live check found same-titled videos collapsing in `scanGrid` (id `title:<title>`): fixed with `tileKey`.
- `flow_assets` (video): 5 tiles with `asb:` ids. `flow_download` by `asb:` for both "Paper boat drifting across pond"
  clips: two different files (md5 differ); "Fox transitions to frog": 640x360 h264+aac 4.0 s, twice.
- Tokens: same across a reload; one of five changed within ~1 h (ZJHu0l -> Cickh). A stale token errors with "run
  flow_assets again".
- Cancel: queued job 9e3c419f -> cancelled; job 5202a10c cancelled at "opening the project" -> "cancelled before
  starting (nothing spent)". A cancel after Start was not caught (a free image finishes in seconds).
- Not seen: high demand, a failed tile, a dropped scene.
