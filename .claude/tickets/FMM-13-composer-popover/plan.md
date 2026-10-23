# FMM-13: the composer's settings popover must not block the prompt box

Found 2026-10-23 by the hub's HUB-07 live run (VN Studio `art.provider: flow`, project `vno-hub07-flow-test`). Branch `FMM-13_composer-popover` from master bb0c023, in the main checkout `C:\projects\Personal\flow-music-mcp` (the hub rebuilds and restarts it from here for the live check).

## What happened

Ten images (16:9 backgrounds and CG, 9:16 sheets and sprites) were made in a row; the next one, the 16:9 cover, failed three times in `typePrompt` (`src/flow/direct.ts`): `locator('.ProseMirror').last().click` timed out because `<span class="credit-cost-label">` from the `.cdk-overlay-container` "intercepts pointer events". A screenshot showed the generation settings popover (Image/Video, 16:9 ... 9:16, Nano Banana 2.1, x1-x4, "Generating will use 0 credits") still open, sitting over the prompt box. `applySettings` presses Escape once and calls `clearBackdrops`, but this popover has no `.cdk-overlay-backdrop-showing`, and the single Escape did not close it (it stayed open across the retries too).

## Fix

- [x] A `closePopover(page)` helper in `src/flow/direct.ts`: while the popover's probe (the `Image` radio, as `openPopover` uses) is visible, press Escape and wait for it to hide; if it is still visible, click the `Settings trigger` button to toggle it shut; at most 3 tries, then `clearBackdrops`. Throw a clear error if it never closes ("Flow's generation settings popover did not close").
- [x] Use it at the end of `applySettings` (instead of the lone Escape) and at the start of `typePrompt` (before the click), so a popover left open by anything is closed first.
- [x] (no pure piece fits: the helper is all browser calls; `yarn build`, `yarn typecheck`, `yarn test` 146 pass) If there is a pure piece worth a unit test, test it; the browser path is checked live by the hub (the HUB-07 run continues on this build).
- [x] `CLAUDE.md` (the UI map) gets one dated line about the popover not closing on one Escape; `ROADMAP.md` a done line.

## Rules

- One commit `FMM-13: ...` for the code (plus test), one `FMM-13: roadmap, plan` for docs, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push.
- Do not start, stop or call the running flow-music-mcp or Chrome. `yarn build` and `yarn test` must pass.
