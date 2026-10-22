# FMM-02 changelog

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
