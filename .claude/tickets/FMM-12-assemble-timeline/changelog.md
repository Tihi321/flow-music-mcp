# FMM-12 changelog

## 2026-10-22: flow_assemble timeline: stills, clip trims, music cues, ducking

Branch `FMM-11-12_hub-roadmap` (shared with FMM-11), repo `flow-music-mcp`. Part of hub ticket HUB-11 (phase 2a).

### Files

- `src/flow/timeline-pure.ts` (new, pure): clip specs, `trimmedSeconds`, `timelineOf`, `planCue`, `cueFilter`, `buildGraph` (inputs clips, cues, voice; `[v]` and `[a]` outputs; ducking).
- `src/flow/assemble.ts`: `assemble()` takes `ClipSpec[]`, `music_cues`, `duck`; probes stills and videos; sizes the film to the biggest clip (even numbers); returns `timeline` and `music_cues`. A single `music` bed is now a cue with no fades.
- `src/flow/local-tools.ts`: schema and description of `flow_assemble` (`clips` union, `music_cues`, `duck`).
- `test/timeline-pure.test.ts` (new): 17 tests.
- `README.md`, `CLAUDE.md`, `ROADMAP.md`: docs.

### Behaviour

- Plain path clips, `dir` scans and `music` + `voice_lines` work as before (a `music` bed is the same graph with no fades; the clips' graph now trims explicitly to the probed length).
- A still is silent; `hold_last_frame` also works on a last still.
- Bad windows fail with a clear message (`from` past the end, `to` before `from`, cue `at` past the film, `until` before `at`).
- Ducking pads the voice key with `apad` so the music returns after the voice ends.

### Verification

- `yarn build` clean; `yarn test` 11 files / 146 passed (129 before, +17).
- Live (free, synthetic media in `.claude/temp/asm/`, not committed): 3 stills (one with zoom) + a video trimmed to 1-4 s + 2 cues + 4 Windows-voice lines through the real tool with `out`: 11.0 s, h264 640x360 + aac; timeline starts 0, 3, 5, 8; cue 1 (440 Hz) fades in and is silent from its 4 s end, cue 2 (660 Hz) starts at 6 s with its fades; ducking lowers the bed about 4 dB under a voice line and it is back at full level after it; `dir` + `out` with `music` made a 12 s film from two clips.
- Not run: real Flow clips, a listen by ear, a cue made from a file shorter than its window on a long film (the `-stream_loop` path is the old one), `zoom` on large stills for speed.

### Commit status

Committed on `FMM-11-12_hub-roadmap`; not pushed.
