# FMM-04: Unit tests for the pure parts

Part of the roadmap task list `.claude/tickets/FMM-04-10_roadmap-tasks/plan.md` (first ticket). No browser, no credits.
Branch `FMM-04_unit-tests`, cut from `origin/master` (b062c33) on 2026-10-22.

## Why

ROADMAP "Robustness": there are no automated tests. Later tickets (FMM-05 queue refactor, FMM-08 Flow fixes) change
code these tests cover, so they come first. Live tests stay manual because they can spend credits.

## Tasks

1. Add `vitest` as a devDependency (yarn 4) and the script `"test": "vitest run"`. Tests live in `test/*.test.ts`;
   `tsconfig.json` keeps building only `src/` (check its `include`/`rootDir`; tests must not land in `dist/`).
2. Pull pure helpers into modules that load nothing at import time (no playwright, no env):
   - `src/util.ts`: one `slug(text, fallback)` replacing the private copies at `src/mcp/tools.ts:45` (fallback "song")
     and `src/flow/tools.ts:38` (fallback "image"). Same behaviour as today.
   - `extensionOfBytes(buf: Buffer)` behind both `extensionOf`s (`src/music.ts:297` audio, `src/flow/driver.ts:410`
     images/video). Either one shared function covering all magic numbers both know, or two, but the file-reading
     wrappers keep their current signatures and results.
   - `nextDelay(lastFinished, now, minMs, maxMs, rand)` replacing the inline pacing in `src/queue.ts:~81-88` and
     `src/flow/queue.ts:~156-163`. Same behaviour.
   - `classifySongText(text)` taken out of `songState` / `rendering` (`src/music.ts:177-190`): the regexes that map row
     text to busy/failed/ready. `songState` keeps its DOM part and calls it.
   - Key parsing: `plausible` (`src/flow/keys.ts:14`) and the inline format check of `setGeminiKey` (`:42`) move to a
     module that does NOT `import "../env.js"` (that import loads the real `.env` with `GEMINI_API_KEY` at load).
   - Export the caption helpers `paginate`, `layout`, `wordsFromTokens`, `segmentWords`, `namesIn`
     (`src/flow/captions.ts:350-627`) so tests can import them.
3. Tests:
   - `matchScenes` and `newestNanoBanana` (`src/flow/agent.ts:309`, `:95`): include the case from CLAUDE.md where the
     stored prompt is the scene text without "Scene N:" and tiles arrive in finish order (3, 1, 2).
   - `capOf` / `defaultMaxCredits` (`src/flow/limits.ts`): set/unset `FLOW_MUSIC_MCP_MAX_CREDITS` per test.
   - key parsing, `extensionOfBytes` (MP3 ID3 and frame sync, WAV RIFF, M4A ftyp, ZIP, JPEG, PNG, WebP, MP4, unknown),
     `alignText` (`captions.ts:481`) and the layout helpers, `slug`, `nextDelay`, `classifySongText`,
     `inEnglish` (`src/chrome.ts:74`), `psQuote` (`src/flow/platform.ts:13`).
   - Tests describe current behaviour; when one exposes a real bug, fix it and say so in the changelog.
4. README: a short "Tests" line (`yarn test`; live tests are manual because they spend credits).
5. ROADMAP: tick off "No automated tests" (say what is covered). Write `changelog.md` in this folder.

## Done when

`yarn build` and `yarn test` pass, `dist/` has no test files, and the server still starts (`node dist/index.js`,
then stop it) with the same 32 tools.

## Status (implementation agent, tasks 1-4 done 2026-10-22; task 5 left to the orchestrator)

- [x] 1. vitest 5.0.5 added with `yarn add -D vitest`; it needs `vite` as an explicit devDependency here (peer dependency; without it startup fails with "Cannot find package 'vite'"), so `yarn add -D vite` too. Script `"test": "vitest run"`. No vitest config: the default picks `test/*.test.ts` and the `.js` import suffixes resolve. tsconfig untouched (`include: src`, `rootDir: src`); `dist/` has no test files (checked).
- [x] 2. Extracted, behaviour unchanged:
  - `src/util.ts` (no imports): `slug(text, fallback)` (mcp/tools.ts and flow/tools.ts keep a one-line local `slug` calling it), `audioExtensionOfBytes` and `mediaExtensionOfBytes` (two functions, not one shared, so results stay identical: audio gives undefined for unknown, media gives ".bin"; the `extensionOf` wrappers in music.ts and flow/driver.ts keep their signatures), `nextDelay` (both queues), `classifySongText` and `renderingNote` (music.ts `songState` / `rendering`).
  - `src/flow/key-format.ts` (no imports): `plausible`, `looksLikeKey` (the inline check of `setGeminiKey`), sharing one placeholder test. `keys.ts` imports them; only `keys.ts` and `index.ts` import `env.js`.
  - `src/flow/captions.ts`: `wordsFromTokens`, `segmentWords`, `paginate`, `layout`, `namesIn` now exported.
- [x] 3. Tests (56 in 4 files): `test/util.test.ts` (slug, both byte sniffers, nextDelay, classifySongText, renderingNote, `inEnglish`, `psQuote`), `test/keys-limits.test.ts` (key format; `capOf`/`defaultMaxCredits` with the env var set/unset and restored), `test/agent.test.ts` (`newestNanoBanana`, `matchScenes` incl. finish order 3,1,2 with prompts lacking "Scene N:"), `test/captions.test.ts` (`alignText`, `paginate`, `layout`, `namesIn`, `segmentWords`, `wordsFromTokens`).
- [x] 4. README: "Tests" section before "Status".
- Env note: tests import `chrome.ts` (`inEnglish`), `agent.ts` and `captions.ts`; these load the playwright-core module (no launch) but none imports `env.js`, so the real .env is never read. No test touches the network, Chrome or the file system. `keys.ts` itself is not imported by any test.
- Bugs found: none. One test failed at first (alignText with a zero-length gap: the 0.05 s minimum step overlaps the next word); that is by design, so the test now uses a real gap.
- Verification: `yarn build` clean; `yarn test`: 4 files, 56 tests passed; `dist/` has no test files (dist/util.js and dist/flow/key-format.js are new, expected); `node dist/index.js` listened on 127.0.0.1:7462 ("MCP listening on http://127.0.0.1:7462/mcp"; port was free before), then was stopped. The 32-tool count was NOT re-checked (no MCP call made); tool registration code is untouched.
- Deviations: vite devDependency added; two extension sniffers instead of one; `renderingNote` added beyond the plan list (the other half of the music.ts regex extraction); the plan's "say so in the changelog" for bugs is moot (none).
