# FMM-11 changelog

## 2026-10-22: flow_narrate format and long text, voice cultures and genders for VN Studio

Branch `FMM-11-12_hub-roadmap` (shared with FMM-12), repo `flow-music-mcp`. Part of hub ticket HUB-07.

### Files

- `src/flow/voice-pure.ts` (new, pure): `AUDIO_FORMATS`, `formatArgs`, `formatOf`, `TEXT_MAX` / `textLimitError`, `GEMINI_VOICES` (now with `gender`), `DEFAULT_GEMINI_TTS`, `parseWindowsVoices`, `geminiRateLimited`.
- `src/flow/gemini.ts`: default model `gemini-3.8-flash-tts` (env `FLOW_MUSIC_MCP_GEMINI_TTS` still wins), exports `GEMINI_MODEL`, ffmpeg encoder follows the target's extension, 429 text starts "Gemini TTS rate limited".
- `src/flow/voices.ts`: `windowsVoices()` returns all installed voices with `culture` and `gender`; the encoder follows the target's extension.
- `src/flow/local-tools.ts`: `flow_narrate` `format` (default `m4a`), `text` max 4000 with a per-engine check (flow 400), result carries `format`; `flow_voices` returns `gemini_model`, Gemini genders and Windows cultures.
- `test/voice-pure.test.ts` (new): 12 tests.
- `README.md`, `CLAUDE.md`, `ROADMAP.md`, `.env.example`: docs.

### Behaviour

- A call without `format` makes the same `.m4a` as before (no encoder args added).
- Over-long text now fails with `Text is N characters; engine "flow" takes at most 400.` (zod limit is 4000).
- Windows voice entries gained `culture` (e.g. `en-US`) and `gender`; the list is no longer limited to `en-*`.
- Gemini voices are `{name, description, gender}`; the default TTS model changed from `gemini-2.5-flash-preview-tts`.

### Verification

- `yarn build` clean; `yarn test` 10 files / 129 passed (117 before, +12).
- Live (free, 2026-10-22), script run against the worktree's `dist` with the key loaded only into the process env: `gemini-3.8-flash-tts` made an English line (4.5 s) and a Croatian line (4.9 s) as mp3 (48 kHz); `windowsVoices()` returned Microsoft David and Zira (en-US, male/female); a Windows voice wrote wav (pcm_s16le), ogg (vorbis), m4a (aac) and mp3, checked with ffprobe. Files are in `.claude/temp/voices/` (not committed).
- Not run: listening to the Croatian line by ear; a Windows voice of another culture (none installed); a 4000-character Gemini call; a 429 against the new text (unit-tested only); the MCP tool call itself over HTTP (the server was not started on 7462); `engine: flow` (spends credits).
- No lint script exists in this repo.

### Commit status

Committed on `FMM-11-12_hub-roadmap`; not pushed.
