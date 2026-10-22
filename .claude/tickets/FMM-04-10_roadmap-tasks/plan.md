# ROADMAP → tickets: implement feature by feature

## Context

`ROADMAP.md` (FMM-03) lists what flow-music-mcp still lacks or has never verified live. The user wants it turned into
tasks and implemented feature by feature. Agreed scope (2026-10-22):

- In: the Flow Music, Flow, Local tools and Robustness sections.
- Out: the repo rename and the "Later" section (Studio panel, VN Studio, screenplay → video).
- One ticket per theme: its own `FMM-NN_<what>` branch cut from `master`, its own PR, and `.claude/tickets/FMM-NN_<what>/`
  holding `plan.md` (this ticket's part of the plan) and `changelog.md`, like FMM-02.
- Credits: **ask before every paid run** (each Flow Music song, each Flow video or video edit). Free paths are built
  and verified without asking. Paid steps nobody approves stay "not verified" in ROADMAP/CLAUDE.md.
- Implementation goes through the global `implement` skill, one ticket at a time, in the order below.
- On approval this whole plan is saved as `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md` (the umbrella task list,
  ticked as tickets finish); each ticket folder gets its own section as `plan.md`.

Rules from CLAUDE.md that apply to every ticket: never guess selectors (map with `music_inspect` / `flow_inspect` or
Claude in Chrome on the user's browser first), never enter credentials, human pace, never two CDP clients on one
Chrome, update the UI maps with the date and what was verified, and tick items off in `ROADMAP.md`.

## Ticket order

Tests first, because the later tickets refactor the code those tests cover.

### FMM-04_unit-tests (no browser, no credits)

- Add `vitest` (devDependency) and `"test": "vitest run"`; tests in `test/*.test.ts`.
- Move pure helpers into modules that load nothing at import time (no playwright, no env):
  - one `slug(text, fallback)` in `src/util.ts`, replacing the copies at `src/mcp/tools.ts:45` and `src/flow/tools.ts:38`;
  - `extensionOfBytes(buf)` behind both `extensionOf`s (`src/music.ts:297`, `src/flow/driver.ts:410`);
  - `nextDelay(lastFinished, now, min, max, rand)` replacing the inline pacing in `src/queue.ts:82` and
    `src/flow/queue.ts:157`;
  - `classifySongText(text)` taken out of `songState` / `rendering` (`src/music.ts:177-190`);
  - key parsing: `plausible` (`src/flow/keys.ts:14`) and the inline format check of `setGeminiKey` (`:42`) move to a
    module that does not `import "../env.js"` (that import loads the real `.env` and its `GEMINI_API_KEY` at load time);
  - export the caption helpers `paginate`, `layout`, `wordsFromTokens`, `segmentWords`, `namesIn`
    (`src/flow/captions.ts:350-627`); importing them pulls in playwright-core, which is fine (nothing launches).
- Tests: `matchScenes` (`src/flow/agent.ts:309`), `newestNanoBanana` (`:95`), `capOf` / `defaultMaxCredits`
  (`src/flow/limits.ts`, set/unset the env var per test), key parsing, `extensionOfBytes`, `alignText` (`captions.ts:481`)
  and the layout helpers, `slug`, `nextDelay`, `classifySongText`, `inEnglish` (`src/chrome.ts:74`), `psQuote`
  (`src/flow/platform.ts:13`).
- Done when `yarn build` and `yarn test` pass. README gets a "Tests" line.

### FMM-05_jobs-and-recovery (no credits)

- A generic `JobQueue<P, R>` (new `src/jobs.ts`) that both `src/queue.ts` and `src/flow/queue.ts` extend: shared
  ids, `wait`, the `work` loop with `nextDelay`, plus what Flow adds (`attempts`, `cancelRequested`, `busy`).
- Persist each queue to `~/.flow-music-mcp/jobs.json` (one key per queue, `HOME_DIR` from `src/chrome.ts:14`), written
  on add, cancel, retry, start and finish, and where `flow_retry` edits `failed_scenes` (`src/flow/tools.ts:405`). On
  load a job left `queued` or `running` becomes `failed` ("server restarted; files already saved are kept"): never
  resume on its own, it could spend credits again; `music_retry` / `flow_retry` re-queue it. `chain_from` /
  `reference_from` and `flow_wait` then work across restarts.
- Chrome recovery: when the page or browser closes mid-job, fail with a clear message ("the Flow Music window was
  closed") instead of a Playwright stack; the next call already relaunches (`getBrowser`, `getPage` in
  `src/chrome.ts`). Test by closing the tab during a free Flow image job and by killing Chrome between calls.
- Use `withSitePage("music")` for music tools instead of the second chain in `src/music.ts:38-43`, and let
  `music_status` skip page work while a music job runs (as `flow_status` does, `src/flow/tools.ts:232`).

### FMM-06_music-vocals-advanced (paid: ask per song)

Mapping is free; generating is not.
1. Map the Advanced section and the Model menu live (`music_inspect`); fix `fillCompose` / `chooseModel`
   (`src/music.ts:120-159`) to what is really there; record the `Length` format.
2. Find the credit balance (account / billing page); add it to `music_status`.
3. Allow vocal songs with no lyrics (relax the `.refine` at `src/mcp/tools.ts:132`, describe the behaviour).
4. Map `/song/<id>` and fix the `downloadSong` fallback (`src/music.ts:362-372`); verify an M4A download (free).
5. Paid, each one asked for: one vocal song with lyrics, one with empty lyrics, one with BPM/Length/Seed. Read the
   balance before and after each to record the cost per song.
6. Failure states: when a take fails or credits run out, save a `music_inspect` dump into the job error so the DOM is
   captured the first time it happens; `classifySongText` gets the real text once seen.

### FMM-07_music-extras (mostly free)

- `music_loop` (local, ffmpeg): find a loop point in a song (onset/RMS match near the end) and write a crossfaded
  loop file; option `loop_friendly` in `music_generate` adds loop wording to the Sound prompt.
- Downloads from the More options menu, mapped live first: stems ("Get stems", zip) and the music video
  ("Download video", mp4; add an `.mp4` case to `extensionOfBytes`). Free if they cost nothing; ask if they do.
- Remix (`music_remix`: a song id plus new sound/lyrics) — paid, ask before the one test run.
- Concurrency: `FLOW_MUSIC_MCP_MUSIC_CONCURRENCY` (default 1). Needs one tab per running job (`getPage` returns one
  tab per site today). Built only if FMM-05's queue makes it small; otherwise moved back to ROADMAP with the reason.
- The Producer chat route stays out (not needed by any client); ROADMAP says so.

### FMM-08_flow-robustness (free except where marked)

- Video identity: `TILE_JS` / `RawTile` (`src/flow/driver.ts:257-270`) also return the thumbnail or `video[src]`;
  `waitForNewMedia` (`direct.ts:328`) keeps the first `flow-content.google/image/<uuid>` it sees as the handle on
  `FlowFile` (`src/flow/queue.ts:51`); `tileById` / `tileResolver` (`driver.ts:281`, `:509`) try it before the title.
  Check live on an existing video tile (free) whether anything stable survives the re-sign (for example a uuid in the
  `video` src on hover); if nothing does, record that in CLAUDE.md and keep title + creation order.
- High demand: a `flowNotice(page)` in `src/flow/driver.ts` (like `pageNotice`, `src/music.ts:163`, plus the banner
  text) called in `waitForNewMedia` (`src/flow/direct.ts:336-344`), the `waitForAgent` loop (`src/flow/agent.ts:258`,
  also checking the agent's reply for "Something went wrong") and the video-edit poll (`src/flow/video.ts:201-212`).
  The error says "Flow reports high demand" and the job stops instead of retrying blindly.
- Cancel: `runScene` (`direct.ts:351`) and `runContinue` (`video.ts:58`) check `cancelled()` right before pressing
  Start, so a cancel never starts a paid generation. Once a direct/edit generation has started, the error says it
  will still finish and be charged in Flow. A job that finishes with files after a cancel request ends `done` with a
  note, not `cancelled` (`src/flow/queue.ts:175-179`). Verified live on a free image job.
- Failed tile in the direct composer: `retryErrorTile` (`direct.ts:296`) only retries error tiles that are new for
  this job (not old ones in the grid), `failures` stops re-counting the same tiles, and the video-edit path checks
  for an error tile before downloading (the comment at `video.ts:214` promises it, the code does not do it).
- Re-ask for a dropped scene (`runImages`, `src/flow/agent.ts:356-462`, 3 rounds): pull the "which scenes are
  still to do" step into a pure function and unit-test it; live only if the agent drops one on its own.

### FMM-09_flow-live-checks (paid: ask per run)

- Local `first_frame` / `last_frame` upload, and `chain_previous` (uploads the previous clip's last frame); confirm the
  uploaded tile's title (`fm-<job>-<label>`) or fix the waiter to match by what Flow really names it.
- 4K image download: check whether it costs credits first (balance before/after on one image; ask if a quote shows).
- Veo settings (free mapping: open the settings popover and read quotes, press nothing): which resolution/duration
  radios exist per Veo model. Today `pickRadio` (`src/flow/direct.ts:100`) throws "no option" for them under Veo; skip
  or map them so `flow_generate` with a Veo model works.
- Likeness mode of `flow_continue`, a 720p clip, one Veo 3.1 Lite/Fast clip: each one asked for with its quote.
- "Confirm before generating: Never": write down in ROADMAP why it stays unused unless agent video batches are wanted.

### FMM-10_local-tools (free; one large download to ask about)

- Run `flow_assemble` with a music bed, several `voice_lines`, and `dir` + `out`; fix what breaks.
- Run `flow_set_key` with a throwaway value against a temp home (never overwrite the real key without asking).
- Multilingual whisper: ask before downloading the 574 MB model; then check Croatian transcription and captions.
- Gemini TTS: try Croatian and a few other languages; list what works in the tool description.

## Per-ticket workflow

1. Branch `FMM-NN_<what>` from up-to-date `master`; write `.claude/tickets/FMM-NN_<what>/plan.md` from its section here.
2. Run the `implement` skill with that plan.
3. Build (`yarn build`), run tests (`yarn test` from FMM-04 on), restart the server and run the free live checks.
4. Ask before every paid run; record credits before/after.
5. Update `CLAUDE.md` (UI map, "Verified live" with the date) and `ROADMAP.md` (tick off or move items), write
   `changelog.md`, commit, push, open a PR. If the PR is not merged yet, the next ticket branches from it (stacked,
   noted in its PR), so work does not wait on review.

## Verification

- FMM-04: `yarn test` green, `yarn build` green.
- FMM-05: restart the server mid-queue and see the job ids come back via `music_jobs` / `flow_jobs`; close the Flow tab
  during a free image job and get a clear error; the next call works.
- FMM-06/07/09: each feature run once through its MCP tool on `127.0.0.1:7462`, files checked with ffprobe; costs read
  from the balance before and after.
- FMM-08: high-demand and cancel paths checked against live pages where they can be provoked for free (cancel on a
  free image job); others by unit tests and a note in ROADMAP.
- FMM-10: each local tool run with real inputs, output checked by ear/ffprobe/whisper.
