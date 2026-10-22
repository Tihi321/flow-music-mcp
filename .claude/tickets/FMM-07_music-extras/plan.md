# FMM-07: Flow Music extras: loops, music video, remix (variation, extend)

Part of `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md`. Branch `FMM-07_music-extras`, stacked on
`FMM-06_music-vocals-advanced`. User decisions (2026-10-22): may click Get stems, Download video, Remix Variation and
Remix Extend on test songs; music concurrency stays OUT (one song at a time, human pace).

## Mapped live 2026-10-22 (song "FMM Test Vocal Lyrics" 7be13b39-82da-4980-9842-f42cd6fd888f; scripts .claude/temp/*.mjs)

- Song menu (row "More options for <title>" or the song page's unnamed button after Share): Remix submenu = Start session,
  Cover, Replace, Extend, Use prompt, Variation, Trim. Download submenu = Download video, Get stems, M4A, MP3, WAV.
  Add to submenu = Playlist >, Queue. Submenus open by keyboard (focus item, ArrowRight); items are activated with Enter.
- **Download video**: opens a `dialog` "Pick a template to create your video" with four cards (`div.cursor-pointer` with
  text, no role): "Music video" (badge NEW), "Modern", "Player", "Simple"; `Close dialog` button. Clicking "Simple" posts
  `POST /__api/video/clip`; the first render took more than 3 minutes (no UI shown while it runs; leaving the page
  stops it), a second request returned a `video_url` at once and Chrome began a blob download named "<title>.mp4".
  Simple cost 0 credits. "Music video", "Modern", "Player" were not tried (cost unknown).
- **Get stems**: `GET /__api/stems/clip/<id>`, then nothing (no dialog, no file). Balance 13,175 -> 13,174 around it.
  Probably needs "Split stems" first (not clicked: not approved). Not implemented in this ticket.
- **Remix > Variation**: renders at once (5 credits) in a new session `/session/<uuid>?t=true`: `Creating "<title>
  (Remix)"...`, same Sound and Lyrics, a new Seed (e.g. 255691), then one take `/song/<id>` "<title> (Remix)" (~45 s).
- **Remix > Extend**: opens an edit mode in a new `/session?t=true` (no render yet): `Copy playhead timestamp`,
  `Copy duration timestamp` (1:31), `Close edit mode`, `combobox` with options COVER ("Generate a cover of this song"),
  EXTEND ("Generate more once it ends"), REPLACE ("Replace parts of the audio"); a `Settings` button opening a dialog
  "Extend from / Start time for the extension" + "Extend until / End time" (two inputs, values 1:01 and 2:01 by default
  for a 1:31 song); textbox `Instruction`; `Edit Lyrics`; `Generate`. Generate rendered "<title> (Extended)" in ~40 s
  in session `/session/<uuid>?t=true` with the usual "NN% Generating <title> (Extended)" row; the song page says
  "EXTENDED FROM (1:01–2:02)" and "INSTRUCTION ...". 5 credits.

## Tasks

1. **`music_loop`** (local, no browser, `src/loop.ts` + tool in `src/mcp/tools.ts`): input an audio file, optional
   `min_seconds` (default 20), `crossfade_ms` (default 1500 or so), `out`. Decode with ffmpeg to mono 22.05 kHz PCM,
   compute a short-frame RMS (or spectral) envelope, skip a fade-in/intro and the fade-out tail (detect the final fade
   by energy), and pick start/end points (beat-ish frames, at least `min_seconds` apart) whose surrounding windows match
   best. Write a loop file whose end crossfades into its start so it repeats seamlessly (ffmpeg `atrim`/`afade`/`amix`
   or `acrossfade`), same format as the input (WAV/MP3/M4A by extension). Return the loop points, score and file.
   Pure parts (envelope matching, point search) unit-tested on synthetic signals. ffmpeg path from env like the
   other local tools (`FLOW_MUSIC_MCP_FFMPEG`).
2. **`loop_friendly`** option on `music_generate`: appends a short loop wording to the Sound description ("seamless loop,
   steady energy throughout, no intro, no fade-out, ends where it began"). Documented as a hint only.
3. **`music_video`** (song id, `template`: "simple" (default) | "player" | "modern" | "music_video", `out`, `name`,
   background job like `music_generate`? No: a direct tool with a long timeout, max 15 min): song menu > Download >
   Download video (keyboard path), click the template card by text, wait for Chrome's download (use the existing
   download-folder logic, `useOwnDownloadDir` / new-file wait, `.mp4` via `extensionOfBytes` (`ftyp` already maps to
   `.m4a` for audio: add an mp4 case for this tool, e.g. by the template or by checking the `ftyp` brand). Stay on the
   page while rendering. Description: Simple costs nothing (verified); the other templates' cost is unknown, ask the
   user first. Uses the music page lock.
4. **`music_remix`** (paid, a job on the music queue like `music_generate`): `song_id`, `mode`: "variation" | "extend",
   `instruction` (extend only), `format`, `out`, `name`, `wait`. Opens the song page, Remix > Variation or Extend; for
   extend fills `Instruction` and presses `Generate` (leave the default from/until); then waits for the new take in the
   session and downloads it, reusing `generate`'s wait/finish/download code (refactor it into a shared
   `waitForTakes(page, before, ...)`). Reads credits before/after (fresh). Cover/Replace/Trim are mapped but not exposed.
5. Docs: CLAUDE.md (the map above, dated), README tool table, ROADMAP: tick "Loops", "Not exposed" (what is exposed now,
   what is not and why: stems need Split stems, Producer chat out), "One generation at a time" (left out by the user's
   decision: human pace, a tab per job).
6. Unit tests for the loop analysis and any new pure helpers.

## Verification

- `yarn build`, `yarn test`.
- Free: `music_loop` on .claude/temp/dl/fmm06-advanced.wav and fmm06-vocal-auto.mp3: listen points, check the loop file
  repeats cleanly (concatenate it 3x with ffmpeg and check for no click: RMS of the seam window close to its neighbours).
- Free: `music_video` template simple on 7be13b39 (already rendered) and on another test song (fresh render; 0 credits
  expected; balance before/after).
- Paid (approved: Variation and Extend): one `music_remix` variation and one extend through the tool, 5 credits each.

## Status (implementation agent, 2026-10-22)

Tasks 1-6 are coded. `yarn build` clean, `yarn test` 90 passed (7 files, 86 before the helper tests). Nothing was run against Chrome: `music_remix`, `music_video` and the `loop_friendly` option are UNVERIFIED live.

- Task 1 `music_loop`: `src/loop-analysis.ts` (pure: FFT band levels in dB per 2048-sample frame at 22.05 kHz, `steadyRange` skips fade-in/out at 50% of median RMS, `findLoop` scores every (start, end) pair by mean abs dB difference over +-1.5 s around both points plus 0.01 dB per second beyond `min_seconds` so the shorter of equal seams wins, `refineEnd` cross-correlates the end within one frame, `seamMetrics`), `src/loop.ts` (ffmpeg decode, cut `audio[s..e-cf]` + `acrossfade(audio[e-cf..e], audio[s-cf..s])`, same extension as input, re-decodes the output for seam checks), tool in `src/mcp/tools.ts`. Output named `<input>-loop.<ext>` in `out` (default output dir); the tool takes `out` as a folder like the other tools.
  - Sample runs (min 20 s, crossfade 1500 ms, scripts in .claude/temp/loop): fmm06-advanced.wav loop 25.542-82.013 s (56.5 s), score 0.717, distance 3.4 dB, seam jump 0.52 dB (typical 10.5 dB), click ratio 0.04, clean. fmm06-vocal-auto.mp3 loop 128.174-151.032 s (22.9 s), score 0.72, distance 3.36 dB, seam jump 1.12 dB (typical 5.0), click ratio 0.13, clean. Runs take about 1-2 s. Not listened to.
- Task 2: `loop_friendly` on `music_generate` (`loopFriendlySound` in util.ts, added once).
- Task 3 `music_video`: `downloadVideo` in `src/music.ts`; direct tool, `timeout_minutes` 1-15 (default 15). Holds `withDownloadLock` for the whole render (so other Flow/Music downloads wait up to that long).
- Task 4 `music_remix`: job params became `MusicParams = ComposeParams | RemixParams` (`remix: {song_id, mode, instruction?}`), same queue/runner/jobView (`"remix" in params` picks `remix` or `generate`). `generate`'s wait/classify/download/credits tail moved into `collectTakes` (second-press logic stays in `generate`; `started()` extracted unchanged). `before` ids are taken after the new session loaded and include the source id.
- Task 5: CLAUDE.md (dated FMM-07 map, tools built, not verified), README table, ROADMAP (tool counts 12/35, three items ticked or struck).
- Task 6: `test/loop.test.ts` (synthetic 4 s repeating pattern with fades: steady range, loop length multiple of 4 s, repeating beats non-repeating, shorter wins ties, too-short error, seam metrics), `test/music-params.test.ts` (loop wording, template card patterns, remix item patterns, song id parsing).

Deviations: none from scope. Extra: `songIdOf` accepts a /song/<id> link for remix and video. Open: MCP HTTP/client timeouts for a `music_video` call longer than a minute were not checked; whether the Extend editor needs the Instruction box filled; the card text of "Music video" (pattern allows NEW before or after, whole-text match, error lists the cards if none match).

## Status (orchestrator, live verification 2026-10-22)

- `music_loop` (MCP) on fmm06-advanced.wav: 25.542-82.013 s, seam clean (0.52 dB vs 10.45 dB). Not judged by ear.
- `music_video` simple: 7be13b39 (already rendered) -> 720x1280 h264+aac 1:34; b32aceda fresh render in 1:40 -> 1:42.
  0 credits (13,164 before and after).
- `music_remix` variation (job c91f1eed, 1:30 "(Remix)") and extend with an instruction (job 35c2c08f, 2:09 from 1:39,
  "(Extended)"): 5 credits each, `credits_spent` right. Balance 13,154.
- Also spent while mapping (approved): Variation 5 and Extend 5 by hand; Get stems possibly 1.
