# Roadmap

What flow-music-mcp still lacks, found while building and testing it. Most important first within each part. Finished work is in `.claude/tickets/` (FMM-01 Flow Music, FMM-02 Flow) and in `CLAUDE.md` (the UI maps, and what was verified live). Fix items on a ticket branch (`FMM-NN_<what>`) cut from `master`.

## Where it stands (2026-10-22, master 8e7d01e)

- **One MCP server for both Google sites** on `127.0.0.1:7462/mcp`, with 35 tools:
  - Flow Music (`music_*`): 12 tools (FMM-07 added `music_remix`, `music_video`, `music_loop`).
  - Google Flow (`flow_*`): 15 tools for images, video, characters, edits, assets and downloads.
  - Local tools: 8, for narration (Gemini, Windows, Flow voices), assembly, transcription, captions, speech setup, key and techniques.
- **Chrome:** one Chrome profile (`~/.flow-music-mcp/chrome-profile`, CDP 9334) with a tab per site, signed in as the user's PRO account.
- **Settings:** in `.env` (see `.env.example`): `GEMINI_API_KEY`, `FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree` (set by the user), `FLOW_MUSIC_MCP_MAX_CREDITS=50`.
- **Speech:** whisper.cpp 1.9.3 and `ggml-base.en.bin` installed by the tool in `~/.flow-music-mcp/whisper` and `~/.flow-music-mcp/models`.
- **Credits:**
  - Flow: 1,010 left after FMM-02's tests (40 spent).
  - Flow Music: the user's Google AI Pro plan gives 10,000 credits a month; one song costs 5 credits (FMM-06: three songs of 1:32-2:59, vocal or instrumental).
- **Verified live:**
  - Flow Music: instrumental songs (MP3, WAV) and downloads.
  - Flow images: single images, sets, variants, 1K/2K downloads, trash, a local reference image with upload rights agreed, and image edits.
  - Characters: create, list, edit.
  - Video: text-to-video, first+last frame, continue (exact mode), video edit, a Flow-voice narration.
  - Credit guard: a Veo 3.1 Quality clip quoted 100 was refused at the cap of 50.
  - Local tools: Gemini and Windows voices, assembly, transcription, captions.

## Flow Music

- ~~Vocal songs are not tried.~~ FMM-06: a song with lyrics sings them; with no lyrics Flow Music writes its own.
- ~~Advanced settings are not tried.~~ FMM-06: BPM, Length (m:ss, 1:00-3:00, a target: 1:30 gave 1:39), Seed and the Model menu (Lyria 3.5, Lyria 3 Pro) work; M4A downloads. Lyria 3 Pro was not run.
- ~~The cost per song is unknown.~~ FMM-06: 5 credits a song; `music_status` shows the balance (sidebar Settings menu) and jobs report `credits_spent`.
- **Failure states are guessed.** A failed take and "out of credits" have never been seen; `songState` guesses from the row text. Since FMM-06 a failed or timed-out job saves a page dump to `~/.flow-music-mcp/debug/` and names it in the error; read it the first time one happens.
- ~~`music_download` for a song not on the current page~~: FMM-06 mapped `/song/<id>` and downloads from it (verified).
- ~~**One generation at a time.**~~ Left out on purpose (user's decision, FMM-07): one song at a time at human pace, one tab per site. The plan allows several at once; a `concurrency` setting would be the way if that ever changes.
- ~~**Not exposed:** Remix, the music video~~ FMM-07 exposes `music_remix` (Variation, Extend) and `music_video` (both verified live; remix 5 credits, the simple video free). Still not exposed: Remix Cover, Replace, Trim, Start session, Use prompt; stems ("Get stems" fetched `/__api/stems/clip/<id>` and produced nothing; it probably needs "Split stems" first, which was never clicked); and the Producer chat route (the Compose panel is used instead, on purpose). `music_video` templates other than `simple` have unknown cost.
- ~~**Loops for visual novels.**~~ FMM-07: `loop_friendly` on `music_generate` (wording hint) and `music_loop` (ffmpeg: band-level matching, crossfade, seam check). Open: judge by ear whether the picked points sound musical (no beat or bar detection yet; a track that never repeats gets a poor `score`).

## Flow

- **Not run yet:**
  - Likeness mode of `flow_continue` (frame as an ingredient plus characters).
  - 720p and the Veo models (quotes seen: Omni 720p 8 s x2 = 24, Veo 3.1 Quality = 100).
  - The 4K image download.
  - FMM-08 (implemented and unit-tested): a failed tile in the direct composer (Retry only for tiles new since Start, counted once; not seen live), re-asking the agent for a dropped scene (the "what is left, another round?" rule is a tested pure function; not seen live), cancelling a running job (verified live 2026-10-22 on free images: cancelled while queued -> `cancelled`; cancelled just after it started -> "cancelled before starting (nothing spent)". Not caught: a cancel after Start, since a free image finishes in seconds).
- **Local frames through upload.** Uploads work since the user set upload rights (one local reference image, 2026-10-22). Still not run: a local `first_frame` / `last_frame`, and `chain_previous`, which uploads the previous clip's last frame. Unverified: that the uploaded tile is titled `fm-<job>-<label>`, which the waiter matches.
- **Video identity.** FMM-08: a video is now also named `asb:<token>` (the `/asb/<token>` part of its thumbnail; `flow_assets` shows it, `flow_download`, `flow_edit`, `flow_continue` and `flow_trash` accept it; job files carry `thumb`). Verified live 2026-10-22: `flow_assets` lists all 5 videos of fmm-02-test (two share a title and used to collapse into one; fixed with `tileKey`), `flow_download` by `asb:` fetched the right one of the two same-titled clips, and a stale token gives a clear "run flow_assets again" error. Tokens survive reloads, but one of five changed within an hour: re-list before use.
- **High demand.** FMM-08: errors from the waiters start with "Flow reports high demand: ..." when the banner is on the page, the agent wait stops at once on "Something went wrong" instead of waiting for the timeout, and no re-ask follows. Unit-tested (`flowTrouble`); not yet verified live, because it needs the banner to be up.
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
