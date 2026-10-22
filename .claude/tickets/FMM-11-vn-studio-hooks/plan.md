# FMM-11: flow_narrate format and long text, voice cultures and genders for VN Studio

Part of the hub ticket HUB-07 (`creative-hub/.claude/tickets/HUB-07-flow-vn-provider/plan.md`, Phase 2: voices, the
flow-music-mcp part) and of `creative-hub/.claude/tickets/HUB-02-13-roadmap-tasks/plan.md`. Branch
`FMM-11-12_hub-roadmap` (one branch for FMM-11 and FMM-12; the hub plan's `FMM-11_vn-studio-hooks` name is not used).
Decisions accepted by the user: open question 8 (default Gemini TTS model `gemini-3.8-flash-tts`) and 9 (`format` on
`flow_narrate`).

## Tasks

1. `src/flow/local-tools.ts`: `flow_narrate` gains `format` (`mp3 | wav | ogg | m4a`, default `m4a`, so nothing changes);
   `text` up to 4000 characters for `gemini` and `windows`, 400 stays for `flow`.
2. `src/flow/voices.ts`: `windowsVoices()` lists every installed voice with `culture` (and `gender`); `flow_voices` returns it.
3. `src/flow/gemini.ts`: `GEMINI_VOICES` gain `gender`; default model `gemini-3.8-flash-tts`, still overridable by
   `FLOW_MUSIC_MCP_GEMINI_TTS`; `flow_voices` reports `gemini_model`; a 429 says "rate limited".
4. Pure helpers in `src/flow/voice-pure.ts` (new) so tests can load them: format mapping, text limits, voice table, voice
   list parsing, error text.
5. Tests (vitest, `test/voice-pure.test.ts`); docs README, CLAUDE.md, ROADMAP, `.env.example`.

## Done when

`yarn build`, `yarn test` green. Live (free): one Gemini line in English and one in Croatian as mp3 with the new default model;
Windows voice in each format. No lint script exists in this repo.
