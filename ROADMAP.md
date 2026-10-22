# Roadmap

What flow-music-mcp still lacks, found while building and testing it. Most important first within each part. Finished work is in `.claude/tickets/` (FMM-01 Flow Music, FMM-02 Flow) and in `CLAUDE.md` (the UI maps, and what was verified live). Fix items on a ticket branch (`FMM-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, master 8e7d01e)

- **One MCP server for both Google sites** on `127.0.0.1:7462/mcp`, with 32 tools:
  - Flow Music (`music_*`): 9 tools.
  - Google Flow (`flow_*`): 15 tools for images, video, characters, edits, assets and downloads.
  - Local tools: 8, for narration (Gemini, Windows, Flow voices), assembly, transcription, captions, speech setup, key and techniques.
- **Chrome:** one Chrome profile (`~/.flow-music-mcp/chrome-profile`, CDP 9334) with a tab per site, signed in as the user's PRO account.
- **Settings:** in `.env` (see `.env.example`): `GEMINI_API_KEY`, `FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree` (set by the user), `FLOW_MUSIC_MCP_MAX_CREDITS=50`.
- **Speech:** whisper.cpp 1.9.3 and `ggml-base.en.bin` installed by the tool in `~/.flow-music-mcp/whisper` and `~/.flow-music-mcp/models`.
- **Credits:**
  - Flow: 1,010 left after FMM-02's tests (40 spent).
  - Flow Music: the user's Google AI Pro plan gives 10,000 credits a month; the cost per song has not been measured.
- **Verified live:**
  - Flow Music: instrumental songs (MP3, WAV) and downloads.
  - Flow images: single images, sets, variants, 1K/2K downloads, trash, a local reference image with upload rights agreed, and image edits.
  - Characters: create, list, edit.
  - Video: text-to-video, first+last frame, continue (exact mode), video edit, a Flow-voice narration.
  - Credit guard: a Veo 3.1 Quality clip quoted 100 was refused at the cap of 50.
  - Local tools: Gemini and Windows voices, assembly, transcription, captions.

## Flow Music

- **Vocal songs are not tried.** Only instrumentals were made. Next: a song with lyrics in the `Lyrics` box (and the empty-lyrics case, whether Flow Music writes its own).
- **Advanced settings are not tried:** `BPM`, `Length` (the accepted format is unknown), `Seed`, the Model menu and its options, and the M4A download. The driver code for them exists but has never run against the site.
- **The cost per song is unknown.** Compose shows no quote, and the sidebar diamond (read 2 before and after two songs) is not the balance. Find where Flow Music shows credits (account or billing page), add the balance to `music_status`, and record the cost of an instrumental and a vocal song.
- **Failure states are guessed.** A failed take and "out of credits" have never been seen; `songState` guesses from the row text. Capture the real DOM the first time either happens.
- **`music_download` for a song not on the current page** opens `/song/<id>`, a layout that was never mapped.
- **One generation at a time.** The user's plan allows several at once; the music queue runs them one by one with a 20-45 s pause. Option: a `concurrency` setting.
- **Not exposed:** Remix, stems ("Get stems", "Split stems"), the music video ("Download video"), and the Producer chat route.
- **Loops for visual novels.** Flow Music tracks play through; VN Studio wants loops. Options: loop-friendly prompts, or an ffmpeg tool that finds a loop point and crossfades it.

## Flow

- **Not run yet:**
  - Likeness mode of `flow_continue` (frame as an ingredient plus characters).
  - 720p and the Veo models (quotes seen: Omni 720p 8 s x2 = 24, Veo 3.1 Quality = 100).
  - The 4K image download.
  - A failed tile in the direct composer.
  - Re-asking the agent for a scene it really dropped.
  - Cancelling a running job.
- **Local frames through upload.** Uploads work since the user set upload rights (one local reference image, 2026-10-22). Still not run: a local `first_frame` / `last_frame`, and `chain_previous`, which uploads the previous clip's last frame. Unverified: that the uploaded tile is titled `fm-<job>-<label>`, which the waiter matches.
- **Video identity.** A settled video tile has no media id (its thumbnail is re-signed), so videos are found again by title, and titles repeat. Record a stable handle when the video finishes (the first thumbnail uuid or the video src).
- **High demand.** During a "Flow is currently experiencing high demand" banner, the agent's video edits failed 3 times (no charge). Detect the banner and say so in the error instead of retrying blindly.
- **The agent's "Confirm before generating: Never" is never used.** `flow_agent_images` keeps "Always" so the credit card can be answered against `max_credits`. Fine for images; revisit if agent video batches are wanted.
- **Not automated:** Flow's own Scenes (timeline, `Add to scene`), Library collections, Tools (mini-apps), Publish to YouTube, Share.
- **Credits** are read from the account panel, which only exists on the grid view; `flow_status` goes back to the grid first.

## Local tools

- `flow_assemble` with background music and with several `voice_lines` is not run; neither is the `dir` + `out` combination.
- `flow_set_key` has never run: the key came from `.env`.
- Captions and transcription in other languages need the 574 MB model (not downloaded), and are not tried. Check Croatian.
- Gemini TTS: check which languages work, Croatian in particular. Windows voices: only Microsoft David and Zira (en-US) are installed. Installing more is the user's choice, in Windows settings.

## Robustness

- ~~No automated tests.~~ Done in FMM-04: `yarn test` (vitest) covers the pure parts (`matchScenes`,
  `newestNanoBanana`, `capOf`, key parsing, file-type sniffing, caption alignment and layout, `slug`, queue pacing,
  song row text). Live tests stay manual because they can spend credits.
- ~~Jobs live in memory.~~ Done in FMM-05: both queues are saved to `~/.flow-music-mcp/jobs.json` (last 200 each); a job queued or running at a restart comes back failed, never resumed (verified live 2026-10-22).
- **When Google changes a UI:** map it first with `flow_inspect` / `music_inspect`, or the Claude in Chrome extension on the user's own browser (signed in to the same account), then update `CLAUDE.md` with the date and fix on a branch.
- **Chrome recovery.** FMM-05: a closed tab or Chrome quitting mid-job fails the job with a clear message and the next call reopens the tab (closed Flow tab verified live 2026-10-22). Not tried: killing Chrome itself mid-job (same reconnect path in `getBrowser`).
- **The repo name.** It now covers Flow too. A rename (for example `google-flow-mcp`) would touch the hub's `services.json`, `.mcp.json`, README and skill, and the `FLOW_MUSIC_MCP_*` names. Optional.

## Later

- **Studio web panel** (user, 2026-10-22: "tools now, panel later"): a local page like flow-mcp's (Cast, Frames, Shots, Voice, Restyle, Cut, Captions, Library) on the same core, as its own ticket.
- **VN Studio as a client.** VN Studio could use Flow images, Flow Music songs and the voices directly as providers (`art.provider: flow` and so on) instead of `vno_asset_replace` by hand. The VN Studio side is in the hub's ROADMAP; this repo may need a small HTTP API or nothing beyond MCP.
- **Screenplay → video.** The hub plans a Scriptorium screenplay writer. A screenplay would become Flow shots (`flow_generate` with scenes, `chain_previous`), narration, music and `flow_assemble`.
