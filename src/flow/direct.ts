import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { newestNanoBanana } from "./agent.js";
import {
  clearBackdrops,
  dismissCookieNotice,
  downloadTileAll,
  ensureProjectGrid,
  findTile,
  hoverTile,
  openProject,
  pause,
  readAccount,
  scanNew,
  scrollToTop,
  tileResolver,
  topIds,
  type DlSize,
  type Tile,
} from "./driver.js";
import type { FlowFile, FlowJob, JobOutcome } from "./queue.js";

// Flow's DIRECT composer (the bottom prompt box). Since the redesign it is reachable by closing the agent panel (`Close`)
// and turning the `Agent` pill off (mapped 2026-10-22, CLAUDE.md "Flow UI map"). It takes the prompt exactly as written,
// shows the live credit quote ("Generating will use N credits") BEFORE anything is spent, and has Frames / Ingredients
// modes for video. Ported from flow-mcp's runGeneration (src/flow.ts); selectors re-mapped, none guessed.

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Radio names carry their icon word ("videocam Video", "crop_16_9 16:9", "360p info"): match the label as a word.
const word = (label: string) => new RegExp(`(^|\\s)${escapeRe(label)}(\\s|$)`);
const cleanName = (t: string) => t.replace(/\b(volume_up|volume_off|arrow_drop_down)\b/g, " ").replace(/\s+/g, " ").replace(/^[^A-Za-z0-9]+/, "").trim();

export type SceneType = "image" | "video";

export interface SceneRun {
  prompt: string;
  type: SceneType;
  model?: string;
  aspect?: string;
  duration?: number;
  resolution?: "360p" | "720p";
  variants: number;
  first_frame?: string;
  last_frame?: string;
  // The composer already holds a start frame (flow_continue's Animate): stay in Frames mode.
  frames_attached?: boolean;
  reference_images?: string[];
  // A Flow voice (Voices tab of the ingredients picker) attached as an ingredient: flow_narrate engine "flow".
  voice?: string;
  // The picture the voice speaks from: a voice alone leaves Start disabled (mapped 2026-10-22). Default: the newest image.
  voice_image?: string;
  max_credits: number;
  retries: number;
  download_quality: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

// ---- Composer ----

export async function ensureDirectComposer(page: Page): Promise<void> {
  await dismissCookieNotice(page);
  await clearBackdrops(page);
  const panel = page.locator("flow-agent-panel");
  if (await panel.isVisible().catch(() => false)) {
    await panel.getByRole("button", { name: "Close", exact: true }).click({ timeout: 5000 });
    await pause(page, 1000);
  }
  const dismiss = page.getByRole("button", { name: "Got it, dismiss onboarding message" });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click({ timeout: 3000 }).catch(() => {});
  const agent = page.getByRole("button", { name: "Agent", exact: true });
  if (!(await agent.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false))) {
    throw new Error("Flow's direct composer did not show (no `Agent` pill after closing the agent panel). Run flow_inspect to see the page.");
  }
  if ((await agent.getAttribute("aria-pressed")) === "true") {
    await agent.click({ timeout: 4000 });
    await pause(page, 900);
  }
  await page.getByRole("button", { name: "Settings trigger" }).waitFor({ state: "visible", timeout: 8000 });
  // "Clear prompt" removes the text and chips one press at a time: leftovers of an earlier run must not ride along.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  for (let i = 0; i < 6 && (await clear.isVisible().catch(() => false)); i++) {
    await clear.click({ timeout: 3000 }).catch(() => {});
    await pause(page, 400);
  }
}

async function openPopover(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: word("Image") });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe.isVisible().catch(() => false)) return;
    await page.getByRole("button", { name: "Settings trigger" }).click({ timeout: 5000 });
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Could not open Flow's generation settings popover.");
}

async function pickRadio(page: Page, label: string): Promise<void> {
  const radio = page.getByRole("radio", { name: word(label) }).first();
  if (!(await radio.isVisible().catch(() => false))) throw new Error(`Flow has no "${label}" option for the current mode/model.`);
  if ((await radio.getAttribute("aria-checked")) !== "true") {
    await radio.click({ timeout: 5000 });
    await pause(page, 500);
  }
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  const latest = model === "latest";
  const shown = cleanName(await button.innerText());
  if (!latest && shown.toLowerCase().includes(model.toLowerCase())) return;
  await button.click({ timeout: 5000 });
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map(cleanName);
  const index = latest ? newestNanoBanana(names) : names.findIndex((n) => n.toLowerCase().includes(model.toLowerCase()));
  if (index < 0 || (latest && shown.includes(names[index]!))) {
    await page.keyboard.press("Escape");
    await clearBackdrops(page);
    if (index < 0 && !latest) throw new Error(`Flow has no model "${model}" here. It offers: ${names.join(" | ")}`);
    return;
  }
  await items.nth(index).click({ timeout: 5000 });
  await pause(page, 700);
  await clearBackdrops(page);
}

// Applies the scene's settings and returns the credit cost Flow quotes for them (read BEFORE anything is started).
export async function applySettings(page: Page, s: SceneRun): Promise<number> {
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame || s.frames_attached);
  await openPopover(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video");
  if (s.type === "video") await pickRadio(page, framesMode ? "Frames" : "Ingredients");
  if (s.aspect) await pickRadio(page, s.aspect);
  const model = s.model && !/^(nano banana( 2)?|latest)$/i.test(s.model.trim()) ? s.model : s.type === "image" ? "latest" : undefined;
  if (model) await pickModel(page, model);
  if (s.type === "video" && s.resolution) await pickRadio(page, s.resolution);
  if (s.type === "video" && s.duration) await pickRadio(page, `${s.duration}s`);
  await pickRadio(page, `x${s.variants}`);
  await pause(page, 700);
  const text = await page.getByRole("link", { name: /credits?$/ }).first().innerText();
  const cost = Number(text.match(/\d+/)?.[0] ?? NaN);
  await page.keyboard.press("Escape");
  await pause(page, 400);
  await clearBackdrops(page);
  if (Number.isNaN(cost)) throw new Error(`Could not read the credit quote from Flow ("${text}").`);
  return cost;
}

// ---- Assets: uploads and pickers ----

async function waitForUpload(page: Page, prefix: string, timeoutMs: number): Promise<void> {
  const tile = page.locator(`flow-grid-tile-container[aria-label^="${prefix}"]:has([data-media-id])`);
  if (!(await tile.first().waitFor({ state: "attached", timeout: timeoutMs }).then(() => true, () => false))) {
    throw new Error(`Flow did not finish processing the upload "${prefix}" within ${Math.round(timeoutMs / 1000)}s.`);
  }
  await pause(page, 1000);
}

// Uploads under a unique name (fm-<job>-<label>) so the asset can be picked unambiguously afterwards. Returns the name
// prefix to pick it by. The grid must be showing (not the agent panel's view).
export async function uploadAsset(page: Page, jobTag: string, file: string, label: string): Promise<string> {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const prefix = `fm-${jobTag}-${label}`;
  const staged = join(mkdtempSync(join(tmpdir(), "flow-music-mcp-")), `${prefix}${extname(file).toLowerCase()}`);
  copyFileSync(file, staged);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Add media menu" }).click({ timeout: 5000 });
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem").filter({ hasText: /Upload\s*$/ }).first().click({ timeout: 5000 });
  await (await chooser).setFiles(staged);
  // Flow asks for a confirmation of the rights to an uploaded file ("Rights to use this image": Cancel / I agree). That is
  // the user's declaration to make, never ours: stop and say so.
  const rights = page.getByText("Rights to use this image");
  if (await rights.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    await page.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 4000 }).catch(() => {});
    throw new Error(
      "Flow asks you to confirm you have the rights to files you upload (a dialog with Cancel / I agree). That is your declaration to make, so it was cancelled and nothing was uploaded. Upload any image once by hand in the Flow Chrome window (Add media > Upload, then I agree), or use asset:<media_id> for images already in the project, and try again.",
    );
  }
  await waitForUpload(page, prefix, 90_000);
  return prefix;
}

// The title Flow shows for a media id (pickers list assets by title).
export async function titleOf(page: Page, ref: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(ref)) return ref;
  const tile = await findTile(page, ref);
  const title = await tile.getAttribute("aria-label");
  if (!title) throw new Error(`The tile ${ref} has no title to pick it by.`);
  return title;
}

// Picks an asset in a picker opened by `opener` (the ingredients `+`, or the Start/End frame buttons). The picker only
// previews on a click and attaches with `Add to prompt` (ingredients); it reopens on the last tab used, so it starts at All
// and falls back to the Voices / Characters / Uploads tabs.
export async function attachAsset(page: Page, opener: Locator, assetName: string, firstTab = "All"): Promise<void> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  const tab = (name: string) => page.getByRole("tab").filter({ hasText: new RegExp(`${escapeRe(name)}\\s*$`) }).first();
  const shows = (l: Locator, ms: number) => l.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    if (attempt) {
      await page.keyboard.press("Escape");
      await pause(page, 800);
    }
    await opener.click({ timeout: 5000 });
    opened = await Promise.race([shows(list, 5000), shows(tab("All"), 5000)]);
  }
  if (!opened) throw new Error(`Flow's media picker did not open (three tries) while attaching "${assetName}". Nothing was generated.`);
  const select = async (name: string) => {
    const t = tab(name);
    if ((await t.isVisible().catch(() => false)) && (await t.getAttribute("aria-selected")) !== "true") {
      await t.click({ timeout: 4000 });
      await pause(page, 1000);
    }
  };
  await select(firstTab);
  await list.waitFor({ state: "visible", timeout: 10_000 });
  const optionFor = () => list.getByRole("option", { name: new RegExp(`(^|\\s)${escapeRe(assetName)}`, "i") }).first();
  let option = optionFor();
  if (!(await option.isVisible().catch(() => false))) {
    for (const name of ["All", "Voices", "Characters", "Uploads", "Images", "Videos"]) {
      if (name === firstTab) continue;
      if (!(await tab(name).isVisible().catch(() => false))) continue;
      await select(name);
      option = optionFor();
      if (await option.isVisible().catch(() => false)) break;
    }
  }
  if (!(await option.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape");
    throw new Error(`No asset called "${assetName}" in Flow's picker. Use flow_assets / flow_characters to list names.`);
  }
  await option.click({ timeout: 5000 });
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  if (await add.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) await add.click({ timeout: 4000 }).catch(() => {});
  await list.waitFor({ state: "hidden", timeout: 10_000 });
  await pause(page, 500);
}

const ASSET = "asset:";

// The first (newest) image of the picker's Images tab.
async function attachNewestImage(page: Page, opener: Locator): Promise<void> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  if (!(await list.isVisible().catch(() => false))) await opener.click({ timeout: 5000 });
  await list.waitFor({ state: "visible", timeout: 8000 });
  await page.getByRole("tab").filter({ hasText: /Images\s*$/ }).first().click({ timeout: 4000 });
  await pause(page, 1200);
  const first = list.getByRole("option").first();
  if (!(await first.waitFor({ state: "visible", timeout: 6000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape");
    throw new Error("The project has no image to attach for the voice to speak from. Pass image, or make one first.");
  }
  await first.click({ timeout: 5000 });
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  if (await add.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false)) await add.click({ timeout: 4000 }).catch(() => {});
  await list.waitFor({ state: "hidden", timeout: 10_000 });
  await pause(page, 500);
}

// ---- One generation ----

export async function typePrompt(page: Page, prompt: string): Promise<void> {
  const box = page.locator(".ProseMirror").last();
  await box.click({ timeout: 6000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // Enter submits in Flow, so the prompt goes in as a single line.
  await page.keyboard.type(prompt.replace(/\s*\n+\s*/g, " ").trim(), { delay: 8 });
  await pause(page, 500);
}

async function progressOf(page: Page): Promise<string | undefined> {
  const pct = await page.evaluate(() =>
    [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map((t) => (t as HTMLElement).innerText.match(/\d+%/)?.[0]).filter(Boolean),
  );
  return pct.join(", ") || undefined;
}

// Flow's own Retry on a failed tile re-renders the same prompt free of charge (direct generations only; agent-made error
// tiles offer Delete alone).
async function retryErrorTile(page: Page): Promise<boolean> {
  const tile = page.locator("flow-grid-tile-container:has(flow-error-tile)").first();
  if (!(await tile.count())) return false;
  await hoverTile(page, tile);
  const retry = tile.getByRole("button", { name: "Retry" });
  if (!(await retry.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false))) return false;
  await retry.click({ timeout: 8000 });
  await pause(page, 1500);
  await scrollToTop(page);
  return true;
}

// New tiles of this generation, once none is still rendering. Freshness is by media id (never by title); our own uploads
// (fm-...), tiles of the wrong kind (a "Save frame" still in a video job) and tiles still counting up are skipped.
export async function waitForNewMedia(
  page: Page,
  before: Set<string>,
  count: number,
  kind: SceneType,
  timeoutMs: number,
  retries: number,
  hooks: { progress: (s: string) => void; cancelled: () => boolean },
): Promise<Tile[]> {
  const deadline = Date.now() + timeoutMs;
  let retriesLeft = retries;
  let failures = 0;
  while (Date.now() < deadline) {
    await pause(page, 2000);
    if (hooks.cancelled()) throw new Error("cancelled");
    const r = await scanNew(page, before);
    const fresh = r.fresh.filter((t) => t.kind === kind && !t.busy);
    const busy = r.fresh.some((t) => t.kind === kind && t.busy);
    if (fresh.length >= count || (fresh.length && !busy && kind === "video")) {
      // Takes of one request may land a moment apart: settle once.
      if (fresh.length < count) await pause(page, 5000);
      const again = (await scanNew(page, before)).fresh.filter((t) => t.kind === kind && !t.busy);
      return (again.length >= fresh.length ? again : fresh).slice(0, Math.max(count, 1) * (kind === "video" ? 4 : 1));
    }
    const pct = await progressOf(page);
    hooks.progress(pct ? `Flow is rendering: ${pct}` : "waiting for Flow");
    if (pct || r.errors === 0) continue;
    failures += r.errors;
    if (retriesLeft > 0) {
      retriesLeft--;
      hooks.progress("Flow reported a failure, pressing its Retry");
      if (await retryErrorTile(page)) continue;
    }
    if (fresh.length) return fresh;
    throw new Error(`Flow failed this generation ${failures} time(s) ("Sorry, this ${kind} failed to generate"). Nothing was charged. Try again later or reword the prompt.`);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish. Check flow_assets before generating again: the take may still arrive (and may have been charged).`);
}

const sizeFor = (type: SceneType, quality: "original" | "upscaled"): DlSize => (type === "image" ? (quality === "upscaled" ? "2K" : "1K") : quality);

export async function runScene(
  page: Page,
  job: FlowJob,
  s: SceneRun,
  number: number,
  hooks: { progress: (s: string) => void; cancelled: () => boolean },
): Promise<JobOutcome & { credits_quote: number; credits_spent?: number }> {
  const progress = (t: string) => {
    job.progress = t;
    hooks.progress(t);
  };
  progress("opening the project");
  const project = await openProject(page, job.params.project, job.params.create_project ?? false);
  job.project = { id: project.id, name: project.name };
  await ensureProjectGrid(page);
  await ensureDirectComposer(page);

  // Video (and a voice take) spends credits: note the balance first, to record what the take really cost.
  const paid = s.type === "video";
  const balance = paid ? (await readAccount(page).catch((): { credits?: number } => ({}))).credits : undefined;
  if (paid) await ensureDirectComposer(page);
  progress("applying the settings and reading the quote");
  const quote = await applySettings(page, s);
  if (quote > s.max_credits) {
    throw new Error(`Flow quotes ${quote} credits for this scene, above max_credits=${s.max_credits}. Nothing was generated. Raise max_credits or pick a cheaper model, resolution, duration or variants.`);
  }
  job.note = `quote ${quote} credit(s)`;
  const notes: string[] = [];

  const tag = job.id;
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  const asset = async (ref: string, label: string) => (ref.startsWith(ASSET) ? await titleOf(page, ref.slice(ASSET.length).trim()) : await uploadAsset(page, tag, ref, label));
  if (s.first_frame) {
    progress("attaching the first frame");
    await attachAsset(page, page.getByRole("button", { name: "Start", exact: true }), await asset(s.first_frame, "start"));
  }
  if (s.last_frame) {
    progress("attaching the last frame");
    await attachAsset(page, page.getByRole("button", { name: "End", exact: true }), await asset(s.last_frame, "end"));
  }
  // Flow's composer offers Frames OR Ingredients, never both (flow-mcp): frames pin the look, so references are dropped.
  let refs = s.reference_images ?? [];
  if (framesMode && refs.length) {
    notes.push(`first/last frames were set, so ${refs.length} reference image(s) were skipped (Flow's composer allows one or the other)`);
    refs = [];
  }
  const opener = page.getByRole("button", { name: "Add ingredients to the prompt box" });
  for (const [i, ref] of refs.entries()) {
    progress(`attaching reference ${i + 1}`);
    await attachAsset(page, opener, await asset(ref, `ref${i + 1}`));
  }
  if (s.voice) {
    progress(`attaching the voice ${s.voice}`);
    await attachAsset(page, opener, s.voice, "Voices");
    if (!refs.length) {
      progress("attaching a picture for the voice to speak from");
      if (s.voice_image) await attachAsset(page, opener, await asset(s.voice_image, "voice"), "Images");
      else await attachNewestImage(page, opener);
    }
  }
  const wanted = refs.length + (s.voice ? 1 : 0);
  if (wanted && !(await page.getByRole("button", { name: /ingredient/i }).count())) {
    throw new Error(`None of the ${wanted} reference(s)/voice attached in Flow; nothing was generated.`);
  }

  await typePrompt(page, s.prompt);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or inputs were not accepted.");
  await scrollToTop(page);
  const before = new Set(await topIds(page));
  progress("generating");
  await start.click({ timeout: 6000 });

  const fresh = await waitForNewMedia(page, before, s.variants, s.type, s.type === "image" ? 3 * 60_000 : 12 * 60_000, s.retries, { progress, cancelled: hooks.cancelled });
  progress("downloading");
  mkdirSync(s.output_dir, { recursive: true });
  const files: FlowFile[] = [];
  for (const [i, t] of fresh.entries()) {
    const stem = join(s.output_dir, `${s.file_stem}-${String(number).padStart(2, "0")}${i ? `-v${i + 1}` : ""}`);
    const saved = await downloadTileAll(page, tileResolver(page, t.id, t.title), stem, sizeFor(s.type, s.download_quality));
    for (const file of saved) files.push({ scene: number, file, media_id: t.id, title: t.title, variant: files.length + 1 });
    await pause(page, 1200);
  }
  let spent: number | undefined;
  if (balance !== undefined) {
    const after = (await readAccount(page).catch((): { credits?: number } => ({}))).credits;
    if (after !== undefined) spent = balance - after;
  }
  job.progress = undefined;
  return { files, failed: [], note: [`quote ${quote} credit(s)${spent !== undefined ? `, balance change ${spent}` : ""}`, ...notes].join(" · "), project: job.project, credits_quote: quote, credits_spent: spent };
}
