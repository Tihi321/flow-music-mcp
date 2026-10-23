# FMM-13 changelog

## 2026-10-23 (later): FMM-14 to FMM-16, found by the hub's first film (HUB-11)

Same branch `FMM-13_composer-popover`. Committed, not pushed. Evidence: `creative-hub/runs/the-lighthouse-that-kept-lists-2.md` "Found".

| Ticket | Commit | Files | What changed |
|---|---|---|---|
| FMM-14 | e289543 | `src/flow/direct.ts`, `src/flow/pure.ts`, `test/flow-pure.test.ts` | `asset:` picking: the title is cleaned (trailing ellipsis dropped), typed into `Search assets` when the option is not rendered, then the `cdk-virtual-scroll-viewport` is scrolled in steps; truncated titles match by prefix. |
| FMM-15 | 215b5d6 | `src/flow/voice-pure.ts`, `src/flow/local-tools.ts`, `test/voice-pure.test.ts` | A Gemini 429 with a retry time of an hour or more says the daily free quota (limit N) is used up, when it resets, and suggests `windows`; short retry times keep the per-minute wording with Google's time. |
| FMM-16 | f3a86a1, c9273d8 | `src/flow/characters.ts`, `src/flow/tools.ts`, `src/flow/voice-pure.ts`, tests | The character voice dialog is a virtual list: the voice is now found by scrolling it (only the first 15 voices were rendered, so "Umbriel" looked missing). A truly unknown voice gives `voice_warning` with the full list; the tool descriptions say Flow character voices are not the Gemini TTS list. |
| docs | 28b1c9e | `ROADMAP.md`, `CLAUDE.md`, `plan.md` | Done lines, UI-map notes. |

Verification: `yarn test` (153+), `tsc --noEmit` pass. Live (hub, rebuilt server): FMM-14 `asset:9dec5f93-d0d9-4a33-ae26-4f158c45bdc8` as a reference in project `the-lighthouse-that-kept-lists-2` made the image (0 credits; six jobs had failed on it before). FMM-16: before c9273d8 "Umbriel" gave a warning listing only Achernar..Iapetus; after it, `flow_character {voice: "Umbriel"}` applied the voice with no warning (test characters "FMM16 Test" and "FMM16 Test 2" left in project fmm-02-test). Not seen live: FMM-15 (needs a real daily-quota 429), a truly unknown voice name after c9273d8 (unit-tested).

## 2026-10-23: the composer's settings popover no longer blocks the prompt box

Branch `FMM-13_composer-popover` (from master bb0c023). Committed, not pushed.

- `src/flow/direct.ts` (6452c04): new `closePopover(page)`: while the settings popover is open (its `Image` radio shows), press Escape and wait up to 1.5 s; if still open, click `Settings trigger` to toggle it; at most 3 rounds, then `clearBackdrops`; throws "Flow's generation settings popover did not close" otherwise. `applySettings` ends with it (instead of one Escape), and `typePrompt` starts with it, before clicking the prompt box.
- `CLAUDE.md`, `ROADMAP.md`, `plan.md` (6d903b4): a dated UI-map note and a done line.

## Verification

- `yarn build`, `yarn typecheck`, `yarn test` (146 tests): pass. No unit test: the helper is browser calls only.
- Live (hub HUB-07 run, `runs/hub07-flow-test.md`): before the fix the 16:9 cover of `vno-hub07-flow-test` failed three times with the popover's `credit-cost-label` intercepting the click (seen in a screenshot); after rebuilding and restarting flow-music-mcp on this branch, the same image was made at the first try (11:30, 2026-10-23). Flow balance unchanged (1,050), images are free.
- Not seen live: the toggle fallback (Escape alone may have closed it on the retry run).
