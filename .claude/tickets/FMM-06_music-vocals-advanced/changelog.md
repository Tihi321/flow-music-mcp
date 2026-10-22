# FMM-06 changelog

## 2026-10-22: vocal songs, Advanced settings, credits and the song page work (verified with three paid songs)

Branch `FMM-06_music-vocals-advanced`, stacked on `FMM-05_jobs-and-recovery`, repo `flow-music-mcp`.

### Files

- `src/music.ts`: BPM/Length/Seed found as the first input after their `<label>` (labels are not tied to inputs), filled, Tab, read back (a value Flow Music drops fails clearly); Model menu matched by `^<model>(\s|$)`; `readCredits(page, { fresh })` reads the "N credits" item of the sidebar Settings menu (reload first when fresh, Escape always); `generate` returns `credits_after` / `credits_spent`; a failed or timed-out take writes an `inspect` dump to `~/.flow-music-mcp/debug/` and names it in the error; downloads take a menu spot (row or song page), and `downloadSong` uses the song page's unnamed menu button after Share when the song is not listed.
- `src/util.ts`: `parseCredits`, `lengthSeconds`, `lengthValid`, `escapeRegExp`, `modelItemPattern`.
- `src/queue.ts`: music `Job` carries `credits_after`, `credits_spent`.
- `src/mcp/tools.ts`: `music_generate` allows a vocal song with no lyrics, validates `length` (1:00-3:00), names the two models; `jobView` shows credits; `music_status` shows `credits` (fresh read, only when idle).
- `test/music-params.test.ts` (new, 8 tests in the file; 77 in total).
- `CLAUDE.md`: FMM-06 mapping and "Verified live" sections; `README.md`: `music_generate` row; `ROADMAP.md`: five Flow Music items ticked.

### Deviations

- The credit read after a song reloads the page: the menu's balance is stale until a page load (found on the first paid song, which therefore reported 0; fixed before the other two).
- The debug dump name is a timestamp (generate does not know the job id); only the two "No take finished" errors write it.

### Verification

- `yarn build` clean; `yarn test` 6 files, 77 passed.
- Free live: `music_status` credits; `music_download` from the song page, M4A and MP3 (ffprobe: AAC / MP3, 48 kHz stereo, 3:01).
- Paid live (user approved): three songs, 5 credits each, 13,190 -> 13,175. Lyrics sung (whisper), own lyrics with none given, Advanced values reach the song (", 100 bpm", "[End - 1:30]"), WAV 48 kHz.
- Not run: Lyria 3 Pro; a failed take; out of credits.

### Commit status

Committed and pushed on `FMM-06_music-vocals-advanced` (PR to open by hand; no `gh` CLI here).
