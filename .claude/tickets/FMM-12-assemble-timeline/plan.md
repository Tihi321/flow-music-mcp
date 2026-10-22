# FMM-12: flow_assemble timeline (stills, trims, music cues, ducking)

Part of the hub ticket HUB-11 (`creative-hub/.claude/tickets/HUB-11-screenplay-to-video/plan.md`, section 2a) and of
`creative-hub/.claude/tickets/HUB-02-13-roadmap-tasks/plan.md`. Branch `FMM-11-12_hub-roadmap` (shared with FMM-11; the hub plan's
`FMM-12_assemble-timeline` branch name is not used). All open questions took the recommendation. No credits: local ffmpeg only.

## Tasks

1. `flow_assemble` `clips` items: a path, `{file, from?, to?}` (trimmed video) or `{image, seconds, zoom?}` (a silent still, optional slow zoom-in).
2. `music_cues: [{file, at, until?, volume?, fade_in?, fade_out?}]` (defaults: to the film's end, 1.5 s in, 2 s out); replaces `music`.
3. `duck: true` (default false): `sidechaincompress` keyed on the voice; nothing happens without voice or music.
4. Result `timeline: [{index, file, at, seconds}]` and the placed `music_cues`.
5. Pure module `src/flow/timeline-pure.ts` (graph builder, clip-time math) with vitest tests (`test/timeline-pure.test.ts`).
6. Live (free): 3 stills + a trimmed video + 2 cues + 4 voice lines with `out`; ffprobe and level checks per cue.
7. Docs: README, CLAUDE.md, ROADMAP, changelog.

## Done when

`yarn build` and `yarn test` green; the live assembly gives a playable MP4 with cues at the right times.
