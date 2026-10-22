# FMM-06: Flow Music vocals, Advanced settings, credits, song page

Part of `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md` (third ticket). Branch `FMM-06_music-vocals-advanced`,
stacked on `FMM-05_jobs-and-recovery`. Paid steps need the user's OK per song.

## Mapped live 2026-10-22 (free, tool Chrome CDP 9334, scripts in .claude/temp/map-*.mjs; nothing generated)

- **Advanced** (`switch "Toggle advanced sound mode"`) shows a box with `<label>BPM</label><input placeholder="Auto"
  maxlength=3>`, `Length` (input, placeholder Auto), `Seed` (input inside a div with a dice button), `Model` (label) +
  `button[aria-haspopup=menu]` "Lyria 3.5". The labels are NOT tied to the inputs (no `for`, no wrapping), so
  `getByLabel("BPM")` finds nothing: locate with `page.locator("label", { hasText: /^BPM$/ }).locator("xpath=following::input[1]")`
  (same for Length, Seed) and the Model button with `xpath=following::button[1]` after the `Model` label.
- **Length** is normalised on blur (Tab): `m:ss`; "2:30" stays, "2" -> "2:00" (a bare number is minutes), "150",
  "9:99", "12:00" -> "3:00" (max 3:00), "0:05"/"0:10"/"0:30" -> "1:00" (min 1:00, a "Min 1:00" hint shows), "90s" -> "".
- **BPM** box takes any 1-3 digits (20 and 999 stay; the field does not clamp; letters are dropped). **Seed**: digits
  only ("-5" -> "5"), long numbers stay. Clearing a box (fill "" + Tab) returns it to Auto.
- **Model menu** (radix): `menuitem` "Lyria 3.5 Top performing, flagship model", "Lyria 3 Pro Legacy model". Names
  start with the model name, so match `^<model>\b` (a plain substring "Lyria 3" would also match "Lyria 3.5").
- **Credits**: sidebar `button "Settings menu"` ("Tihi321 PLUS") opens a menu: Theme, Account settings, Customize
  Producer, `menuitem "13190 credits"`, Invite friends, Submit to Featured, Updates, Try Google Flow, Discord, Pricing,
  Learn more, Log out (never click). Escape closes it. The sidebar diamond button read "3" (not credits).
- **Song page `/song/<id>`**: no self-link and no "More options for <title>". `main` shows the title (`div role=textbox`),
  "SOUND" text, the lyrics, and buttons `Remix`, `Share`, then an unnamed `button[aria-haspopup=menu]` whose menu is
  Remix, Details, Download (submenu Download video, Get stems, M4A, MP3, WAV), Share..., Add to..., Split stems, Report.
  The keyboard path (focus Download, ArrowRight) opens the submenu there too.
- **Empty lyrics**: in a session with instrumental off and an empty `Lyrics` box (placeholder text "Add lyrics..."),
  `Generate` is enabled once the Sound description has text. What Flow Music then sings is the paid check.

## Tasks

1. `src/music.ts` `fillCompose`: BPM/Length/Seed through the label locator above, `fill` then `Tab` so the value is
   normalised, then read the value back and fail clearly if Flow Music rejected it (empty after a non-empty value).
   `chooseModel`: open the button after the `Model` label, match the menuitem by `^<model>` (escape regex chars),
   list the offered names (first line / before the description) in the error. Keep Advanced off when none is given.
2. `src/mcp/tools.ts` `music_generate` schema: `length` described as "m:ss between 1:00 and 3:00 (a bare number is
   minutes)" and validated with a regex/zod refine (1:00-3:00); `model` described with the two names; `bpm` stays
   30-300. Allow a vocal song with no lyrics: drop the refine that requires lyrics when `instrumental` is false, and
   describe it ("leave lyrics out to let Flow Music write them"; verified only after the paid run).
3. Credits: `readCredits(page)` in `src/music.ts`: open `Settings menu`, read `/^([\d,.]+)\s+credits$/` from the
   menuitem, Escape. `music_status` returns `credits` (skipped while busy, like signed_in). `generate` reads the
   balance before and after and stores `credits_spent` on the job (`Job` in `src/queue.ts`, shown by `jobView`) —
   best effort: a failed read never fails the job.
4. `downloadSong` fallback (`src/music.ts`): on `/song/<id>` use the unnamed `button[aria-haspopup=menu]` after
   `main`'s `Share` button; reuse the existing keyboard Download path (`downloadFromRowNow`), refactored so it takes the
   menu button instead of the row.
5. Failure capture: when `generate` ends in "failed" or "No take finished", add `pageNotice` plus the row's text to the
   error (already partly there) and save an `inspect` dump to `HOME_DIR/debug/music-<job>-<time>.json`, its path in
   the error.
6. Unit tests for the new pure parts (length validation, credits text parsing, model-name matching).
7. Docs: CLAUDE.md UI map (the findings above, dated), README tool table if params changed.

## Verification

- Free: `yarn build`, `yarn test`; `music_status` shows credits; `music_download` of an older song not in the session
  (b1ab6ea7-608c-4a14-86af-baeb8f78d3db "Redline Regret") as M4A and MP3 via the song page; ffprobe both.
- Paid, each asked first: (a) vocal song with lyrics, (b) vocal song with no lyrics, (c) instrumental with BPM 100,
  Length 1:30, Seed 42, model Lyria 3.5. Credits read before/after each -> cost per song in CLAUDE.md and ROADMAP.

## Status (implementation agent, tasks 1-7; no browser touched)

Done, `yarn build` clean, `yarn test` 77 passed (6 files; new `test/music-params.test.ts`). Nothing run live.

- Task 1 `src/music.ts`: `afterLabel` locator, `fillDynamics` (fill, Tab, read back, throws naming field+value when empty; Length also checked with `lengthValid` first), `chooseModel` rewritten (menuitem `^<model>(\s|$)`, skips opening if the button text already matches, error lists all menuitem texts).
- Task 2 `src/mcp/tools.ts`: `length` refine (1:00-3:00), `model` description, lyrics refine removed, descriptions updated. bpm unchanged (30-300).
- Task 3: `readCredits` (Escape in finally, never clicks anything but `Settings menu`); `generate` reads before (after openCompose, before fillCompose) and after (after downloads); `GenerateResult` carries `credits_after`/`credits_spent`; `Job` + `jobView` show them; `music_status` adds `credits` when signed in and not busy.
- Task 4: `MenuSpot` (area + button), `rowMenu`, `songPageMenu`; `downloadFromRow(page, format, stem, spot)`; `downloadSong` uses the song page when the row is absent (title read from `main [role=textbox]`).
- Task 5: `failWithDump` (pageNotice + inspect JSON in `HOME_DIR/debug/music-<timestamp>.json`, path in the error) used for "No take finished" (both cases; the second also lists row text).
- Task 6: tests for lengthValid/lengthSeconds, parseCredits, modelItemPattern/escapeRegExp (pure helpers in `src/util.ts`).
- Task 7: CLAUDE.md (new "Mapped live" section, "Not verified yet" trimmed), README tool-table row.

Deviations / notes: dump file name is timestamp-only (generate has no job id). The "started nothing"/"button disabled" errors in generate were left as they were (no dump). `music_status` does a second `withSitePage` call for credits (the first returns just `signed_in`). Follow-up fix: the menu balance is stale until a page load (13190 stayed after a song; 13185 after navigating; the vocal song cost 5), so `readCredits(page, { fresh })` reloads and waits for `Settings menu` first; the after-read in `generate` and `music_status` use `fresh: true`, the before-read does not (openCompose just navigated). CLAUDE.md notes it and the 5-credit cost. Untested live: the `Settings menu` open/Escape on a fresh `/session`, whether `following::input[1]` after `label` hits the right box when Advanced is on, the song-page Share locator.

## Status (orchestrator, live verification 2026-10-22)

- Free: `music_status` credits 13190; `music_download` of b1ab6ea7 (not in the list) via `/song/<id>`: M4A and MP3 OK.
- Paid, approved by the user (all three): (a) vocal with lyrics 60d8c9e6, 1:32, lyrics heard by whisper; (b) vocal no lyrics
  864ea188, 2:59, own lyrics; (c) Advanced instrumental 248fc008, BPM 100 / Length 1:30 / Seed 42 / Lyria 3.5, WAV, 1:39.
  5 credits each (13,190 -> 13,175). Found during (a): the menu balance is stale until a reload; fixed (`fresh` read),
  then (b) and (c) measured `credits_spent` 5 correctly.
- Song page of (c): Sound text gets ", 100 bpm", lyrics "[Instrumental] [End - 1:30]". Seed/model not visible.
- Not run: Lyria 3 Pro; a failed take / out of credits (never happened).
