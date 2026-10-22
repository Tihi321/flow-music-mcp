# FMM-10: Local tools: assembly with music and voice lines, key setup, other languages

Part of `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md` (last ticket). Branch `FMM-10_local-tools`, stacked on
`FMM-09_flow-live-checks`. Free, except one large download the user must OK.

## Tasks

1. `flow_assemble` (`src/flow/local-tools.ts`, `src/flow/assemble.ts`): run it with (a) a music bed (a Flow Music song
   from FMM-06, e.g. .claude/temp/dl/fmm06-advanced.wav) under 2+ clips, (b) several `voice_lines` (Gemini or Windows
   voices), (c) `dir` + `out` together. Check with ffprobe (streams, duration), volumedetect (music ducked under voice,
   no clipping) and whisper (the lines are heard in order). Fix what breaks; add unit tests for any pure helper touched.
2. `flow_set_key`: run the rejection paths only (malformed key, placeholder text, a well-formed but invalid key: the
   model-list check must refuse it and the existing key file must stay untouched — compare its mtime/hash before and
   after). Never write a real key from the tests. Note the result in ROADMAP.
3. Gemini TTS languages: `flow_narrate` engine gemini with short Croatian, German and Spanish lines; whisper (base
   multilingual if present, else listen-check by duration/energy only) to confirm the language; note in the tool
   description which languages were checked.
4. Multilingual whisper: ASK the user before downloading `ggml-large-v3-turbo-q5_0.bin` (574 MB, via
   `flow_speech_setup`). If yes: transcribe and caption the Croatian line; add `hr` to `CAPTION_LANGUAGES`
   (`src/flow/captions.ts` ~112) if captions work. If no: leave as is and say so in ROADMAP.
5. ROADMAP "Local tools": tick what was verified, keep what was not with the reason.

## Verification

Every tool run through MCP on 127.0.0.1:7462 with real inputs; outputs checked with ffprobe/volumedetect/whisper.

## Status (2026-10-22, live findings pass)

- Done: `hr` ("Hrvatski") added to CAPTION_LANGUAGES; language descriptions of flow_transcribe/flow_captions warn about close languages; flow_transcribe adds a `note` when auto picks a Cyrillic language (pure helper `src/flow/language-note.ts`, test `test/language-note.test.ts`); Gemini 429 now says free tier allows few requests per minute, wait ~1 min (Google's text kept); flow_narrate description lists checked languages (en, hr, de, es).
- Verification: `yarn build` clean; `yarn test` 9 files, 117 tests passed. Not rerun live.

## Status (orchestrator, live 2026-10-22, free)

- [x] 1 flow_assemble: (a)+(b) music + 2 voice lines (assembled-a.mp4, 8.0 s, whisper heard both in order, gap level
      matches the music bed), (c) dir + out (assembled-c.mp4, 12.0 s). Nothing broke.
- [x] 2 flow_set_key: 3 rejection paths, no key file written (none existed before or after).
- [x] 3 Gemini TTS: en, hr, de, es spoken correctly (checked with the multilingual model); 429 on the 5th call in a
      minute, fine a minute later.
- [x] 4 Multilingual whisper downloaded (user OK): de/es exact; hr needs `language: "hr"` (auto -> "uk", Cyrillic);
      Croatian captions OK. `hr` added to CAPTION_LANGUAGES, a note on auto -> Cyrillic.
- [x] 5 ROADMAP updated.
