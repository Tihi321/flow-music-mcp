# FMM-04 changelog

## 2026-10-22: unit tests for the pure parts (56 tests, green)

Branch `FMM-04_unit-tests` (from `origin/master` b062c33), repo `flow-music-mcp`.

### Files

- `package.json`, `yarn.lock`: devDependencies `vitest` 5.0.5 and `vite` (vitest 5 needs it installed explicitly); script `test` = `vitest run`.
- `src/util.ts` (new, no imports): `slug(text, fallback)`, `audioExtensionOfBytes`, `mediaExtensionOfBytes`, `nextDelay`, `classifySongText`, `renderingNote`.
- `src/flow/key-format.ts` (new, no imports): `plausible` and `looksLikeKey` (the old inline check of `setGeminiKey`), so key parsing loads without `.env`.
- `src/flow/keys.ts`: uses `key-format.ts`; same behaviour.
- `src/mcp/tools.ts`, `src/flow/tools.ts`: the private `slug` copies call the shared one ("song" / "image" fallbacks).
- `src/music.ts`, `src/flow/driver.ts`: `extensionOf` wrappers keep their signatures and call the byte sniffers; `songState` / `rendering` call `classifySongText` / `renderingNote`.
- `src/queue.ts`, `src/flow/queue.ts`: pacing calls `nextDelay`; loops otherwise unchanged.
- `src/flow/captions.ts`: exports `wordsFromTokens`, `segmentWords`, `paginate`, `layout`, `namesIn`.
- `test/util.test.ts`, `test/keys-limits.test.ts`, `test/agent.test.ts`, `test/captions.test.ts`: 56 tests, including `matchScenes` with stored prompts lacking "Scene N:" in finish order 3, 1, 2.
- `README.md`: "Tests" section. `ROADMAP.md`: "No automated tests" ticked off.

### Deviations

- Two byte sniffers (audio: `undefined` when unknown; media: `.bin`) instead of one, to keep both callers' results identical.
- `renderingNote` added beside `classifySongText` (the other regex half of `music.ts`).

### Verification

- `yarn build`: clean. `yarn test`: 4 files, 56 passed.
- `dist/` holds no test files.
- `node dist/index.js` started and listened on 127.0.0.1:7462, then stopped. The tool count was not re-checked through MCP (registration code untouched).
- Tests touch no network, browser or `.env`; `chrome.ts`, `agent.ts`, `captions.ts` load the playwright-core module without launching anything.

### Bugs found

None. (`alignText` overlaps a zero-length gap by its 0.05 s minimum step, by design.)

### Commit status

Committed and pushed on `FMM-04_unit-tests`. PR not opened from here (no `gh` CLI): https://github.com/Tihi321/flow-music-mcp/compare/master...FMM-04_unit-tests
