import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { withDownloadLock } from "../chrome.js";
import { CANCEL_AFTER_START, CANCEL_BEFORE_START, parseAsbHandle, tileKey } from "./pure.js";
import { applySettings, attachAsset, ensureDirectComposer, typePrompt, waitForNewMedia } from "./direct.js";
import {
  clearBackdrops,
  downloadTileAll,
  downloadsNow,
  ensureProjectGrid,
  extensionOf,
  findTile,
  hoverTile,
  openProject,
  pause,
  readAccount,
  readTiles,
  scanGrid,
  topIds,
  tileResolver,
  tileThumb,
  troubleText,
  useOwnDownloadDir,
  waitForDownloadedFile,
} from "./driver.js";
import type { FlowFile, FlowJob, JobOutcome } from "./queue.js";

// flow_continue and the video flow_edit (FMM-02 phase 6). Both spend credits.
//  - continue: Flow's edit view saves the clip's last frame ("Save frame" -> an image tile "Saved frame from <title>"); the
//    tile's `Animate` puts that frame into the DIRECT composer as the start frame (Frames mode), where the live quote is
//    read before anything is started. (flow-mcp used the agent for this; the new direct composer needs no agent.)
//  - video edit: in the clip's edit view (see runVideoEdit for why not through the agent).

type Hooks = { progress: (s: string) => void; cancelled: () => boolean };

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
// "<Flow's own trouble text>. " or "".
const withTrouble = async (page: Page) => {
  const t = await troubleText(page);
  return t ? `${t}. ` : "";
};
const credits = async (page: Page) => (await readAccount(page).catch((): { credits?: number } => ({}))).credits;

// A video of the project by media id, by asb:<token> handle (flow_assets) or by (the start of) its title.
async function resolveVideo(page: Page, ref: string): Promise<{ id: string; title: string }> {
  if (uuidRe.test(ref) || parseAsbHandle(ref)) {
    const tile = await findTile(page, ref);
    return { id: ref, title: (await tile.getAttribute("aria-label")) ?? "" };
  }
  const want = ref.toLowerCase();
  const match = (t: { kind: string; title: string }) => t.kind === "video" && t.title.toLowerCase().startsWith(want);
  const found = (await scanGrid(page, (tiles) => tiles.some(match))).find(match);
  if (!found) throw new Error(`No video whose title starts with "${ref}". Use flow_assets (kind video) to list them.`);
  return { id: tileKey(found), title: found.title };
}

async function openEditView(page: Page, tile: Locator): Promise<void> {
  await hoverTile(page, tile, 500);
  const box = await tile.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 30_000 });
  await pause(page, 3500);
}

export async function runContinue(page: Page, job: FlowJob, hooks: Hooks): Promise<JobOutcome & { credits_quote: number; credits_spent?: number }> {
  const p = job.params;
  const progress = (t: string) => {
    job.progress = t;
    hooks.progress(t);
  };
  progress("opening the project");
  const project = await openProject(page, p.project, p.create_project ?? false);
  job.project = { id: project.id, name: project.name };
  await ensureProjectGrid(page);
  const source = await resolveVideo(page, p.asset!);
  const balance = await credits(page);
  await ensureProjectGrid(page);
  const likeness = p.mode === "likeness";

  progress("saving the last frame");
  await openEditView(page, await findTile(page, source.id));
  await page.getByRole("button", { name: "Skip to next clip" }).click({ timeout: 8000 });
  await pause(page, 2500);
  await page.getByRole("button", { name: "Save frame" }).click({ timeout: 8000 });
  await pause(page, 4500);
  await page.getByRole("button", { name: "Back button to go to previous page" }).click({ timeout: 8000 });
  await pause(page, 3500);
  await ensureProjectGrid(page);
  const frameTitle = `Saved frame from ${source.title}`;
  const frame = page.locator(`flow-grid-tile-container[aria-label="${frameTitle.replace(/"/g, '\\"')}"]`).first();
  await frame.waitFor({ state: "visible", timeout: 30_000 });

  const run = {
    prompt: p.scenes[0]!,
    type: "video" as const,
    model: p.model,
    aspect: p.aspect,
    duration: p.duration,
    resolution: p.resolution,
    variants: 1,
    max_credits: p.max_credits,
    retries: 0,
    download_quality: p.download_quality ?? "original",
    output_dir: p.output_dir,
    file_stem: p.file_stem,
  };
  try {
    await ensureDirectComposer(page);
    if (!likeness) {
      progress("loading the frame as the first frame");
      await hoverTile(page, frame, 500);
      await frame.getByRole("button", { name: "More options" }).click({ timeout: 6000 });
      await page.getByRole("menuitem").filter({ hasText: /Animate\s*$/ }).click({ timeout: 6000 });
      await pause(page, 3500);
    }
    progress("reading the quote");
    const { quote, ignored } = await applySettings(page, { ...run, frames_attached: !likeness });
    if (quote > p.max_credits) throw new Error(`Flow quotes ${quote} credits for this continuation, above max_credits=${p.max_credits}. Nothing was generated.`);
    job.note = `quote ${quote} credit(s)${ignored ? ` · ${ignored}` : ""}`;
    if (likeness) {
      // R2V: the frame as an ingredient, plus the characters; the opening frame is only approximate.
      const opener = page.getByRole("button", { name: "Add ingredients to the prompt box" });
      await attachAsset(page, opener, frameTitle);
      for (const name of p.attach ?? []) await attachAsset(page, opener, name, "Characters");
    }
    await typePrompt(page, p.scenes[0]!);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or the frame was not accepted.");
    const before = await topIds(page);
    if (hooks.cancelled()) throw new Error(CANCEL_BEFORE_START);
    progress("generating the continuation");
    await start.click({ timeout: 6000 });
    const fresh = await waitForNewMedia(page, before, 1, "video", 12 * 60_000, 0, hooks);
    mkdirSync(p.output_dir, { recursive: true });
    const files: FlowFile[] = [];
    progress("downloading");
    for (const t of fresh) {
      const saved = await downloadTileAll(page, tileResolver(page, t.id, t.title, t.thumb), join(p.output_dir, `${p.file_stem}-${String(p.numbers[0]).padStart(2, "0")}${files.length ? `-v${files.length + 1}` : ""}`), run.download_quality);
      const thumb = t.thumb ?? (await tileThumb(page, tileResolver(page, t.id, t.title)));
      for (const file of saved) files.push({ scene: p.numbers[0]!, file, media_id: t.id, title: t.title, variant: files.length + 1, ...(thumb ? { thumb } : {}) });
    }
    const after = await credits(page);
    const spent = balance !== undefined && after !== undefined ? balance - after : undefined;
    job.progress = undefined;
    return { files, failed: [], project: job.project, note: `continued "${source.title}" (${likeness ? "likeness: R2V" : "exact: first frame"}) · quote ${quote}${spent !== undefined ? `, balance change ${spent}` : ""}`, credits_quote: quote, credits_spent: spent };
  } finally {
    await clearBackdrops(page);
    const clear = page.getByRole("button", { name: "Clear prompt" });
    if (await clear.isVisible().catch(() => false)) await clear.click({ timeout: 3000 }).catch(() => {});
  }
}

// Downloads what the edit view shows: `Download media` -> "360p Original size" / "720p Upscaled" (mapped 2026-10-22).
async function downloadFromEditView(page: Page, stem: string, quality: "original" | "upscaled"): Promise<string> {
  mkdirSync(join(stem, ".."), { recursive: true });
  return withDownloadLock(async () => {
    await useOwnDownloadDir(page);
    const before = downloadsNow();
    await page.getByRole("button", { name: "Download media" }).click({ timeout: 6000 });
    const item = page.getByRole("menuitem").filter({ hasText: quality === "upscaled" ? /Upscaled/i : /Original/i }).first();
    await item.waitFor({ state: "visible", timeout: 6000 });
    await item.click({ timeout: 6000 });
    const file = await waitForDownloadedFile(page, before, quality === "upscaled" ? 600_000 : 180_000);
    const target = `${stem}${extensionOf(file)}`;
    renameSync(file, target);
    await clearBackdrops(page);
    return target;
  });
}

// Video-to-video edit (Omni) in the clip's edit view ("Describe how to edit this video...", Omni 1.1 Flash). That composer
// shows NO credit quote, so the cost cannot be checked before it starts (flow-mcp measured 20 credits for a 4 s clip; here a
// 360p 4 s clip cost 10): max_credits is a precondition on the balance, and the real cost is read from the balance around
// the job. (The agent route quotes the cost on a confirmation card but failed three times on 2026-10-22 with "Something
// went wrong", and quoted 20 where this route cost 10.) The result is read from the edit view itself, which shows the new
// version: the grid tile is replaced in place, so a grid scan cannot tell it from the original.
export async function runVideoEdit(page: Page, job: FlowJob, hooks: Hooks): Promise<JobOutcome & { credits_quote?: number; credits_spent?: number }> {
  const p = job.params;
  const progress = (t: string) => {
    job.progress = t;
    hooks.progress(t);
  };
  progress("opening the project");
  const project = await openProject(page, p.project, p.create_project ?? false);
  job.project = { id: project.id, name: project.name };
  await ensureProjectGrid(page);
  const source = await resolveVideo(page, p.asset!);
  const balance = await credits(page);
  if (balance !== undefined && balance < p.max_credits) throw new Error(`The balance (${balance}) is below max_credits (${p.max_credits}); nothing was started.`);
  await ensureProjectGrid(page);
  // A failed edit leaves a new error tile in the grid; the ones already there are not ours.
  const errorsBefore = (await readTiles(page)).filter((t) => t.error).length;

  progress("opening the edit view");
  await openEditView(page, await findTile(page, source.id));
  const prompt = p.scenes[0]!.replace(/\s*\n+\s*/g, " ").trim();
  const box = page.locator(".ProseMirror").last();
  await box.click({ timeout: 6000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(prompt);
  await pause(page, 600);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow did not accept the edit prompt (Start generation stayed disabled).");
  if (hooks.cancelled()) throw new Error(CANCEL_BEFORE_START);
  progress("editing the video");
  await start.click({ timeout: 6000 });

  // Progress shows as "NN%" in the edit view and disappears when the edit is ready (flow-mcp).
  const t0 = Date.now();
  const deadline = t0 + 10 * 60_000;
  let seen = false;
  for (;;) {
    await pause(page, 3000);
    if (hooks.cancelled()) throw new Error(CANCEL_AFTER_START);
    const text = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    const pct = /(\d+)%/.exec(text)?.[0];
    if (pct) {
      seen = true;
      progress(`Flow is editing: ${pct}`);
    } else if (seen) break;
    else if (Date.now() - t0 > 30_000 && !seen) throw new Error(`${await withTrouble(page)}The edit never started (no progress after 30 s). Check flow_assets and the balance before trying again.`);
    if (Date.now() > deadline) throw new Error(`${await withTrouble(page)}Timed out waiting for Flow to finish the video edit. Check flow_assets and the balance: it may still arrive (and may have been charged).`);
  }
  await pause(page, 2500);
  // A failed edit leaves an error tile in the grid ("Sorry, this video failed to generate"): look before downloading.
  progress("checking the result");
  await page.getByRole("button", { name: "Back button to go to previous page" }).click({ timeout: 6000 }).catch(() => {});
  await pause(page, 2500);
  await ensureProjectGrid(page);
  const errorsNow = (await readTiles(page)).filter((t) => t.error).length;
  if (errorsNow > errorsBefore) {
    throw new Error(`${await withTrouble(page)}Flow reports the video edit failed ("Sorry, this video failed to generate"; failed tiles are not charged, check the balance with flow_status). The failed tile is still in the project; nothing was downloaded.`);
  }
  await openEditView(page, await findTile(page, source.id));
  progress("downloading the edited video");
  const stem = join(p.output_dir, `${p.file_stem}-${String(p.numbers[0]).padStart(2, "0")}`);
  const file = await downloadFromEditView(page, stem, p.download_quality ?? "original");
  await page.getByRole("button", { name: "Back button to go to previous page" }).click({ timeout: 6000 }).catch(() => {});
  await pause(page, 2500);
  await ensureProjectGrid(page);
  const after = await credits(page);
  const spent = balance !== undefined && after !== undefined ? balance - after : undefined;
  job.progress = undefined;
  return {
    files: [{ scene: p.numbers[0]!, file, media_id: source.id, title: source.title, variant: 1 }],
    failed: [],
    project: job.project,
    note: `edited "${source.title}" in its edit view; the tile was replaced in place${spent !== undefined ? ` · balance change ${spent}${spent > p.max_credits ? ` (ABOVE max_credits ${p.max_credits}: the edit view shows no quote, so this could not be checked before starting)` : ""}` : ""}`,
    credits_spent: spent,
  };
}
