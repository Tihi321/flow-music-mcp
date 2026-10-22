# FMM-10 changelog

## 2026-10-22: local tools verified; Croatian captions, language note, clearer Gemini rate-limit error

Branch `FMM-10_local-tools`, stacked on `FMM-09_flow-live-checks`, repo `flow-music-mcp`.

### Files

- `src/flow/captions.ts`: `hr` (Hrvatski) in `CAPTION_LANGUAGES`.
- `src/flow/language-note.ts` (new, pure): `languageNote(requested, detected)`.
- `src/flow/local-tools.ts`: `flow_transcribe` adds a `note` when auto-detection returns a Cyrillic-script language; `language` descriptions of `flow_transcribe` / `flow_captions` advise passing it for close languages; `flow_narrate` lists the checked Gemini languages and the free-tier limit.
- `src/flow/gemini.ts`: a 429 says the free tier allows a few requests per minute and to wait about a minute (Google's text kept).
- `test/language-note.test.ts` (new): 117 tests in total.
- `CLAUDE.md`, `ROADMAP.md`: FMM-10 results.

### Verification

- `yarn build` clean; `yarn test` 9 files / 117 passed.
- Live (free): flow_assemble with music + voice lines and with dir + out; flow_set_key rejections; Gemini en/hr/de/es; multilingual whisper (574 MB model downloaded with the user's OK); Croatian captions; the new transcription note.
- Not run: saving a real key through flow_set_key (the key comes from `.env`).

### Commit status

Committed and pushed on `FMM-10_local-tools` (PR to open by hand).
