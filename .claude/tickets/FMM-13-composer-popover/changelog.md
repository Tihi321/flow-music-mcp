# FMM-13 changelog

## 2026-10-23: the composer's settings popover no longer blocks the prompt box

Branch `FMM-13_composer-popover` (from master bb0c023). Committed, not pushed.

- `src/flow/direct.ts` (6452c04): new `closePopover(page)`: while the settings popover is open (its `Image` radio shows), press Escape and wait up to 1.5 s; if still open, click `Settings trigger` to toggle it; at most 3 rounds, then `clearBackdrops`; throws "Flow's generation settings popover did not close" otherwise. `applySettings` ends with it (instead of one Escape), and `typePrompt` starts with it, before clicking the prompt box.
- `CLAUDE.md`, `ROADMAP.md`, `plan.md` (6d903b4): a dated UI-map note and a done line.

## Verification

- `yarn build`, `yarn typecheck`, `yarn test` (146 tests): pass. No unit test: the helper is browser calls only.
- Live (hub HUB-07 run, `runs/hub07-flow-test.md`): before the fix the 16:9 cover of `vno-hub07-flow-test` failed three times with the popover's `credit-cost-label` intercepting the click (seen in a screenshot); after rebuilding and restarting flow-music-mcp on this branch, the same image was made at the first try (11:30, 2026-10-23). Flow balance unchanged (1,050), images are free.
- Not seen live: the toggle fallback (Escape alone may have closed it on the retry run).
