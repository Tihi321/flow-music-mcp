# FMM-02 changelog

## 2026-10-22: upload rights setting and a default credit cap for paid calls

Summary: two settings the user writes in `.env`. `FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree` lets the tool answer Flow's "Rights to use this image" with I agree for files the user gives it (anything else: cancel, nothing uploaded). `FLOW_MUSIC_MCP_MAX_CREDITS` (default 50) caps a paid call that passes no `max_credits` (user: videos are few, so a generous default is fine; images are free).

### Files changed
- `src/flow/direct.ts`: `uploadRightsAgreed()` (only the exact value "agree"); `uploadAsset` clicks I agree when it is set, otherwise cancels with instructions.
- `src/flow/limits.ts` (new): `defaultMaxCredits()` (unset, empty or invalid → 50; 0 means no paid work), `capOf()`.
- `src/flow/tools.ts`: video scenes, `flow_continue` and video `flow_edit` use `capOf(max_credits)` instead of requiring it; images keep 0; `flow_status` reports `max_credits_default` and `upload_rights`; playbook text.
- `src/flow/local-tools.ts`: `flow_narrate` engine flow uses `capOf`.
- `.env.example`, `README.md`: both settings.

### Verification
- `yarn build` clean. `defaultMaxCredits()` for unset/""/"30"/"abc"/"0": 50/50/30/50/0; an explicit call value (12) wins.
- Live, nothing spent (balance 1,010 before and after): `flow_status` shows `max_credits_default: 50`, `upload_rights: ask`; a local reference image without the setting was cancelled at the rights dialog with the instructions; a Veo 3.1 Quality video with no max_credits was quoted 100 and refused at the default 50 before starting.
- Found and fixed while testing: an empty value parsed as 0 (refused every video).

### Not run
- The agree path: clicking I agree is the user's declaration, so it is tested only after the user writes the setting.

### Commit status
Committed and pushed with this entry.

## 2026-10-22: phases 5-7, characters, edits, video, Flow voices; hub switched to flow-music-mcp

Summary: flow-music-mcp now has 32 tools, all 20 of flow-mcp's plus `flow_inspect`, `flow_set_key` and `flow_speech_setup`, rebuilt for Flow's redesign. Single shots and videos go through Flow's direct composer (exact prompt, live credit quote checked against `max_credits` before Start); image sets go through the agent. The hub no longer uses flow-mcp.

**Repositories:** flow-music-mcp `FMM-02_flow-tools`; creative-hub `FMM-02_hub-flow-in-one-mcp` (ef2ea6b, from origin/master). Phases 5-6 by implementer A; it stopped before sending a final report, so the orchestrator reviewed its uncommitted work and its CLAUDE.md notes and re-ran the checks below.

### Files changed (flow-music-mcp)
- `src/flow/direct.ts` (new): the direct composer (agent panel closed, Agent pill off): Image/Video, Frames/Ingredients, aspect, model family, 360p/720p and 4-10 s (Omni), x1-x4, live quote read before Start; Start/End frame pickers; ingredient picker by title.
- `src/flow/video.ts` (new): video generation, video tiles (pending → thumbnail; settled tiles have no media id, so they are re-found by title), video download (270p GIF / 360p original / 720p upscaled), `flow_continue` (Save frame → Animate as the start frame), video `flow_edit` in the edit view (no quote: cost measured from the balance).
- `src/flow/characters.ts` (new): create from a description or project media, name, stock voice, personality, portrait download, list, edit.
- `src/flow/chain.ts` (new): last frame of a clip (ffmpeg), for chain_from / reference_from.
- `src/flow/tools.ts`: `flow_generate` takes type video|image, duration, resolution, model, aspect_ratio, variants, first_frame / last_frame, reference_images, chain_from / reference_from, retries, download_quality, max_credits; new `flow_continue`, `flow_edit`, `flow_characters`, `flow_character`, `flow_character_edit`.
- `src/flow/driver.ts`, `queue.ts`: video tile ids and resolvers, cancelling the rights dialog, onboarding card, job params.
- `src/flow/local-tools.ts`: `flow_narrate` engine `flow` (a 360p take with a Flow voice; audio extracted).
- `src/mcp/server.ts`: instructions. `CLAUDE.md`: "Direct composer, video, characters, edits" map.

### Deviations
- `flow_edit` for video uses the edit view, not the agent: the agent's video edit failed 3 times during a "high demand" banner (nothing charged).
- Local-file uploads stop at Flow's rights dialog (cancelled on purpose); `asset:<media_id>` references work. Decision for the user (plan "Open").

### Verification
- `yarn build` clean. `hub.ps1 check flow-music-mcp`: 32 tools. `flow_status`: PRO, 1,010 credits (1,050 before phases 5-6).
- Paid, per implementer A's notes (balance checked): mapping text-to-video 4, `flow_generate` text-to-video 4, first+last frame 4, `flow_continue` 4, video edit by hand 10 and through `flow_edit` 10, `flow_narrate` engine flow 4 = 40. A quote of 4 against max_credits 1 was refused with nothing spent.
- Files (ffprobe): vid-t2v-01, vid-frames-01, continue-01, vedit-01, narration-flow-take-01, dl-video: all h264 640x360 + aac, about 4 s. Frames checked by the orchestrator: text-to-video paper boat, and the edit adds falling snow. The Flow-voice narration was transcribed back exactly by whisper (per A).
- Free: character "Kai" created with voice and personality, `flow_characters` lists Kai and Mara (re-checked), character edit (green hat, viewed by A), image edit (a seagull added), previous-scene reference images, agent image batch after the changes (regression).

### Not run
- Local-file first/last frames and references, chain_previous (rights dialog); likeness mode of `flow_continue`; 720p / Veo models; 4K image download; a failed direct-composer tile.

### Commit status
Committed on `FMM-02_flow-tools` (this entry's commit), not pushed. Hub branch committed (ef2ea6b), not pushed.

## 2026-10-22: phases 1-4, Flow image tools and local tools in flow-music-mcp

Summary: flow-music-mcp now serves 27 tools: 9 Flow Music, 10 Flow (images through Flow's agent, assets, downloads, trash), and 8 local ones (voices, narration, key, assembly, transcription, captions, speech setup, techniques). One Chrome profile serves both sites. Keys and settings can come from `.env`. Video, characters, edits and the hub are still to do (phases 5-7).

**Repository:** flow-music-mcp. **Branch:** `FMM-02_flow-tools`, from `origin/master` d80492f. Work by two implementers (A: Flow browser side; B: local tools) plus the orchestrator (wiring, whisper install, .env, shared download lock).

### Files changed
- `src/chrome.ts`: `getPage("flow"|"music")` (Flow with `hl=en`), `getMusicPage` delegates; `withSitePage(site, fn)`, one lock per site; `withDownloadLock(fn)`, one download at a time across both sites.
- `src/env.ts` (new): loads `<repo>/.env`, then `~/.flow-music-mcp/.env` (`process.loadEnvFile`; a real env var wins). `src/index.ts` imports it first.
- `.env.example` (new), `.gitignore` (`.env`).
- `src/mcp/tools.ts`: `buildTools()` = music + `buildFlowTools()` + `buildLocalFlowTools()`. `src/mcp/server.ts`: instructions cover both sites and the credit rules.
- `src/music.ts`: song downloads go through `withDownloadLock`.
- `src/flow/driver.ts` (new): overlays, cookie notice, projects (open/create), grid scan by media id, stored prompt, download (More options → Download on hover → 1K/2K/4K, own download dir, type by magic bytes), trash, inspect.
- `src/flow/agent.ts` (new): agent settings read/set/restore, sessions, prompt, wait with the credit guard (approve only when the quoted "costing N credits" ≤ max_credits, otherwise Reject), `matchScenes`, `runImages` with up to 2 re-ask rounds.
- `src/flow/queue.ts` (new): Flow job queue, 25-70 s pacing.
- `src/flow/tools.ts` (new): `flow_status`, `flow_generate` (images; video refused until phase 6), `flow_agent_images`, `flow_wait`, `flow_cancel`, `flow_retry`, `flow_assets`, `flow_download`, `flow_trash`, `flow_inspect`.
- `src/flow/keys.ts` (new): Gemini key from `GEMINI_API_KEY` (env or .env) → `~/.flow-music-mcp/gemini-key` → `~/.flow-mcp/gemini-key`; `setGeminiKey` checks with Google before writing; only last 4 characters are ever returned.
- `src/flow/gemini.ts`, `voices.ts` (new): Gemini TTS (30 voices); Windows System.Speech voices with ffmpeg loudnorm.
- `src/flow/assemble.ts`, `captions.ts`, `techniques.ts`, `platform.ts` (ported from flow-mcp, headers name the source): ffmpeg assembly with voice-over and music; whisper.cpp transcription and burned-in captions (headless Chrome lettering); presets; Windows helpers. captions.ts installs its own whisper.cpp (`whisper-bin-x64.zip` of the newest stable ggml-org release) into `~/.flow-music-mcp/whisper` on first use, and models into `~/.flow-music-mcp/models`; Chrome paths fixed (backslash escapes).
- `src/flow/local-tools.ts` (new): `flow_voices`, `flow_narrate` (gemini | windows; flow → phase 6), `flow_set_key`, `flow_assemble`, `flow_transcribe`, `flow_captions`, `flow_speech_setup`, `flow_techniques`.
- `CLAUDE.md`: "Flow UI map (2026-10-22)" section; file list. `README.md`: "Keys and settings".

### Deviations
- Agent confirm stays on Always for image runs (free images never asked; keeps the credit guard). No references or first/last frames yet (phase 6).
- The user decided mid-way: whisper from VibeFlow first, then "own download, do not depend on VibeFlow" (done); a `.env` for keys (done); the Studio panel later (not in this ticket).
- Finding: the direct composer still exists; phase 6 uses it for `flow_generate` (see plan).

### Verification
- `yarn build` clean. `hub.ps1 check flow-music-mcp`: "OK, flow-music-mcp 0.1.0, 27 tools".
- Live, free (credits 1,050 before and after): flow_status (PRO, 1,050); flow_generate x1 (49 s), 3-scene flow_agent_images (64 s, scene order right, batch-03 viewed), variants 2 at 9:16 with Nano Banana 2 Lite, two sequential jobs; flow_assets (7 tiles); flow_download 1K (1376x768, identical to the batch file) and 2K (2752x1536); flow_trash (7 → 6); agent settings restored after a run; credit guard rejected a video request with max_credits 0 (nothing made).
- Local: flow_voices (30 Gemini voices, key found, 2 Windows voices); flow_narrate gemini (aac 3.3 s) and windows (aac 3.6 s); flow_assemble (h264 1280x720 + aac, 3.9 s); flow_techniques; flow_speech_setup from nothing installed → install (48 s, whisper.cpp 1.9.3 + base.en) → flow_transcribe and flow_captions (3 captions + .srt; lettering checked on a frame in an earlier run).
- `.env`: fake keys in a temp home: the .env key is found (last 4 only); a real env var wins.
- A Flow 2K download and a Flow Music MP3 download started at the same time: both files correct (2752x1536 JPEG; MP3 2:58).
- music_status still works.

### Not run
- Re-ask rounds for a scene the agent really drops; a failed tile; cancelling a running job; 4K download; video tiles, video download and the approve path; flow_set_key; assembly with music or several voice lines.

### Commit status
Committed on `FMM-02_flow-tools` (this entry's commit), not pushed.
