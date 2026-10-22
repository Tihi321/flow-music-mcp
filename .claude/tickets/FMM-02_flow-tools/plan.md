# FMM-02: Google Flow tools in flow-music-mcp

## Goal

One MCP server for both Google sites. flow-music-mcp gets every capability of flow-mcp (`github.com/GTAI-1/flow-mcp`, forked as `Tihi321/flow-mcp`), rewritten for Flow's redesigned, agent-only UI. The hub stops using flow-mcp.

Why a rewrite, not a fix in the fork: Flow was redesigned (seen 2026-10-22), and flow-mcp's driver (`src/flow.ts`, 1,748 lines) is built around the old direct composer. It fails at its first step: `getByRole('button', { name: 'Agent', exact: true })` times out because the Agent switch no longer exists. Its non-browser parts (Gemini TTS, ffmpeg assembly, whisper captions, technique presets) still work and are ported.

Branch: `FMM-02_flow-tools` in `C:\projects\Personal\flow-music-mcp`, cut from `master` at d80492f.

## What is known about the new Flow UI (2026-10-22, PRO plan, `tihomir.selak.dev@gmail.com`)

Mapped read-only, plus one free image, through flow-mcp's Chrome (CDP 9333). Scripts: `creative-hub/.claude/temp/flow-run.mjs` + `step-*.mjs`.

- **Everything goes through the agent.** The project page has a right-hand session panel ("Untitled session", `Open session history`, `Start new session`, `Close`). Prompt box: `.ProseMirror` "What do you want to create?" (`flow-creative-agent-prompt-box`), buttons `Add ingredients to the prompt box`, `Agent instructions` (aria-pressed toggle), `Settings`, `Start generation` (disabled when empty; becomes `Stop` while working).
- **Agent settings** (composer `Settings`, per project): "Confirm before generating": Always / Never; image default aspect (16:9, 4:3, 1:1, 3:4, 9:16), x1-x4, model menu ("Nano Banana 2.1"); video default aspect (16:9, 9:16), x1-x4, model menu ("Omni 1.1 Flash"); `Save`. There is no other Image/Video switch.
- **One image** ("Generate exactly one image: ...") with confirm = Always: no confirmation asked; "Analyzing Image Request" → "I'm going to generate one image ... Nano Banana 2.1" → done in about 25 s. The chat shows the image (`Open image in editor`) and `Show thinking`, then feedback buttons.
- **Grid tiles unchanged in structure:** `flow-grid-tile-container[role=group][aria-label=<title>]` → `flow-tile-container` → `flow-image-tile` → `img[data-media-id=<uuid>]` (src is a signed `flow.google.com/asb/...` URL). Hover shows `Favorite`, `Reuse prompt`, `More options`. The agent names tiles itself ("Elephant standing in living room").
- **Tile menu** (`More options`): Favorite, Reuse prompt, Animate, Add to prompt, Download (aria-haspopup=menu, opens on hover), Copy, Rename, Share, Set project cover, Flag output, Move to trash. Image download submenu: `1K Original size`, `2K Upscaled`, `4K Upscaled`. Menu item names now include their icon word ("download Download"), so exact-name lookups fail: match with `hasText` / a regex ending in the label.
- **Left nav:** All media, Images (appears once there are images), Characters, Scenes, Library (+), Tools (a community mini-app builder at `/project/<id>/tools`, not generation), Trash, Collapse.
- **Top bar:** `Add media menu` (+), `Product help`, `Settings`, `More options`, account (PRO). flow-mcp's Studio showed "1,050 credits".
- The flow-music-mcp Chrome profile (CDP 9334) is already signed in to Flow with the same account, so one profile serves both sites (a tab each).

Still to map (phase 1): the ingredients picker and upload, frames (first/last frame) and references through the agent, video tiles and their download sizes, the edit views (`Open image in editor`, `Edit a video with Omni`), Characters (create, voice, edit), Scenes, Library, the credits readout, how the agent asks for confirmation before a paid video, a failed tile, and what the agent does with a numbered multi-scene request.

## Design

- **One process, one Chrome, two tabs.** `chrome.ts` gets `getPage(site: "flow" | "music")`. Each site has its own page lock and its own job queue (a Flow video and a Flow Music song may run at the same time; two Flow jobs may not).
- **Files:** `src/flow/driver.ts` (UI), `src/flow/agent.ts` (prompt, settings, confirm handling, tile matching), `src/flow/tools.ts` (MCP tools), and ports in `src/flow/gemini.ts`, `assemble.ts`, `captions.ts`, `techniques.ts`. Music stays in `src/music.ts`. `src/mcp/tools.ts` merges both tool lists.
- **Agent-driven generation:**
  - Before a run, set Agent settings for the request (confirm Never only for free images, or when the caller passed `max_credits`; aspect, count, model) and restore them afterwards, as flow-mcp's `runAgentBatch` did.
  - Write an exact prompt ("Generate exactly N images/videos, one per numbered scene ... do not change the wording").
  - Collect new tiles by media id (never by title: the agent reuses titles), and match them to scenes by the stored prompt (`Reuse prompt`) with flow-mcp's word-overlap `matchScenes`.
  - Re-ask the agent for scenes still missing, then download.
- **Credits guard:** paid work (video, Flow voices, video edits) needs `max_credits`. When the agent asks to confirm, read its quoted cost and refuse if it is above `max_credits`. Images stay free.
- **Pacing:** keep flow-mcp's 25-70 s pause between Flow generations; no bot-detection evasion; never enter credentials.
- **Attribution:** ported files keep a header naming flow-mcp. Its `package.json` says ISC but the repo has no LICENSE file; the README notes the source.

## Tools (same names as flow-mcp, so the skill and habits carry over)

| Tool | Notes for the new UI | Credits |
|---|---|---|
| `flow_status` | signed in, plan, credits, Chrome, queues, the playbook | 0 |
| `flow_generate` | scenes → images or videos through the agent; aspect, count, model, references, first/last frame, chain_previous, techniques | images 0, video yes |
| `flow_wait`, `flow_cancel`, `flow_retry` | shared job queue (Flow) | |
| `flow_assets`, `flow_download`, `flow_trash` | grid listing by media id, sizes per kind, Move to trash | 0 |
| `flow_agent_images` | many images in one agent request | 0 |
| `flow_edit` | image edit (free) and video edit (Omni, paid) | video yes |
| `flow_continue` | continue a clip (Animate / extend), keeping a character | yes |
| `flow_character`, `flow_character_edit`, `flow_characters` | Characters page | 0 (portraits) |
| `flow_techniques` | presets (ported as is) | 0 |
| `flow_narrate`, `flow_voices` | engines: `gemini` (AI Studio TTS, key file), `windows` (System.Speech, replaces flow-mcp's `mac`), `flow` (a cheap video take with a voice, paid) | gemini/windows 0 |
| `flow_assemble`, `flow_transcribe`, `flow_captions` | ffmpeg 9.0.2 (installed), whisper.cpp (check `whisper-cli`) | 0 |

flow-mcp's Studio web panel (port 8787) is not part of this plan; see "Open".

## Status (2026-10-22)

- [x] Phase 1: UI mapped (CLAUDE.md "Flow UI map"), project `fmm-02-test` (f942b8e4-1579-482d-9b66-59f5d75c2189). Not mapped: video tiles and video download sizes (no videos exist yet).
- [x] Phase 2: core image tools, verified live (free; credits stayed 1,050).
- [x] Phase 3: voices (gemini, windows) and keys (.env, key files, flow_set_key), verified (flow_set_key itself not run, on purpose).
- [x] Phase 4: assemble, transcribe, captions (own whisper.cpp, flow_speech_setup), techniques, verified.
- [x] Phase 5: characters (create, list, edit) and image edits, verified live (free).
- [x] Phase 6: direct composer with the live quote, video (text-to-video, first+last frame, continue, video edit), Flow-voice narration, previous-scene references, video download; verified live. 40 of the 60-credit test cap spent (balance 1,050 -> 1,010, re-checked by the orchestrator). Open: local-file uploads (first_frame / last_frame / reference_images from a file, chain_previous) stop at Flow's "Rights to use this image" dialog, which the driver cancels: that declaration is the user's (see Open below); `asset:<media_id>` references work.
- [x] Phase 7: hub (creative-hub branch `FMM-02_hub-flow-in-one-mcp`): flow-mcp removed from .mcp.json and services.json, README, skill, ROADMAP.

**Finding that changes phase 6 (implementer A):** Flow still has the old direct composer: `Close` in the agent panel collapses to a bottom composer whose `Agent` pill, when off, shows `Settings trigger`, Image/Video, `Select model family`, x1-x4 and a live quote ("Generating will use 0 credits"). Decision (orchestrator, following flow-mcp's own split): `flow_generate` moves to the direct composer in phase 6 (exact prompt, the quote checked against `max_credits` BEFORE anything is spent, Frames mode for first/last frame); `flow_agent_images` stays on the agent. Map the direct composer before coding.

## Phases

1. **Map the rest of the UI (free).** Every "Still to map" item above, written into `CLAUDE.md` with the date. No paid generation in this phase.
2. **Core:** two tabs and locks, `flow_status`, `flow_generate` for images (x1 and a 3-scene batch), `flow_wait`, `flow_assets`, `flow_download` (1K and 2K), `flow_trash`. Verify live with free images.
3. **Voice:** `flow_voices`, `flow_narrate` with `gemini` (the key the user saved is in `~/.flow-mcp/gemini-key`; read it from there or `~/.flow-music-mcp/gemini-key`, and never print it) and `windows`. Verify both produce audio.
4. **Local post:** `flow_assemble`, `flow_transcribe`, `flow_captions`, `flow_techniques`. Verify on the phase 2-3 outputs (stills → a slideshow with narration).
5. **Characters and edits:** `flow_character*`, image `flow_edit`. Verify free.
6. **Video (paid, smallest settings):** `flow_generate` video x1 at the cheapest model, `flow_continue`, video `flow_edit`, `flow_narrate` engine `flow`. The user approved testing (2026-10-22); keep it to a few takes and record each cost.
7. **Hub:** remove `flow-mcp` from `.mcp.json` and `services.json`, update README, the skill (Flow and Flow Music both through flow-music-mcp) and ROADMAP; mark the fork as retired.

Each phase ends with `yarn build`, an MCP call through `hub.ps1 call flow-music-mcp ...`, the changelog entry in this folder, and a commit.

## Risks

- The agent is not deterministic: it may reword prompts, add images, or ask questions. Mitigations: exact prompts, confirm Never only inside a run, matching by stored prompt, re-asking for missing scenes.
- Agent settings are per project and persist: always restore them, also on errors.
- The UI will change again: `music_inspect`-style `flow_inspect` tool, and every selector documented in `CLAUDE.md`.

## Environment (checked 2026-10-22)

- Branch `FMM-02_flow-tools`, from `origin/master` d80492f.
- ffmpeg/ffprobe 9.0.2 on PATH (winget Gyan.FFmpeg).
- **Whisper (user, 2026-10-22): flow-music-mcp owns its speech engine and models.** It must not borrow VibeFlow's (`vibe-whisper-flow`, which has no MCP and may change or drop its whisper copy at any time).
  - Engine: `whisper-bin-x64.zip` of the newest stable `ggml-org/whisper.cpp` release (the asset VibeFlow's `whisper_setup.py` uses), installed by itself on first use into `~/.flow-music-mcp/whisper` (whisper-cli.exe + DLLs + version.txt).
  - Models: downloaded into `~/.flow-music-mcp/models` on first use, as before (base.en 148 MB, large-v3-turbo-q5_0 574 MB, base-q5_1 60 MB).
  - `flow_speech_setup {install, all_languages}` shows the status or installs everything up front. Optional overrides: `FLOW_MUSIC_MCP_WHISPER`, `FLOW_MUSIC_MCP_WHISPER_MODEL`, `FLOW_MUSIC_MCP_WHISPER_MODELS` (extra model folders). The hub sets none of them.
  - Verified on a machine state with nothing installed: status said not ready; `install: true` took 48 s (release tag b4938 = whisper.cpp 1.9.3, ~15 MB, plus ggml-base.en.bin); then `flow_transcribe` ("Flow tools are working from the local server.", base.en) and `flow_captions` (3 captions + .srt). Earlier, with VibeFlow's binary, the lettering was checked on a frame.
- Windows voices (System.Speech): Microsoft David Desktop, Microsoft Zira Desktop (en-US).
- **.env (user, 2026-10-22: a way to add keys by hand, without a model):** `src/env.ts` loads `<repo>/.env`, then `~/.flow-music-mcp/.env`, with Node's `process.loadEnvFile` (a real environment variable wins, then the first file). `.env.example` lists every setting; `.env` is in `.gitignore`. keys.ts imports env.ts; **index.ts must import "./env.js" first** (added after implementer A finishes, since A owns index.ts). Verified with fake keys in a temp home: the .env key is found (last4 only), and a real env var wins.
- **API keys (user asked where they go):** Gemini key lookup order: env `GEMINI_API_KEY` → `~/.flow-music-mcp/gemini-key` → `~/.flow-mcp/gemini-key` (already holds the user's key). Tool `flow_set_key {key}` writes `~/.flow-music-mcp/gemini-key`. Never print, log or return a key (at most its last 4 characters).

## Upload rights and credit cap (user, 2026-10-22)

- Upload rights: `FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree`, written by the user in `.env`, makes the driver click I agree for files the user gives; otherwise it cancels. The agree path is tested once the user has set it.
- Credit cap: `FLOW_MUSIC_MCP_MAX_CREDITS` (default 50) for paid calls without `max_credits`; the live quote is still checked before Start. Images free.

## Decisions (user, 2026-10-22)

- Studio web panel: tools now, panel later. Phase 7 adds a "Studio panel" item to the hub ROADMAP under flow-music-mcp as its own future ticket.
- Approved to implement now, phase by phase, with live tests (free first, a few cheap paid videos in phase 6).
