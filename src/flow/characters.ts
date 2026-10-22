import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Page } from "playwright-core";
import { withDownloadLock } from "../chrome.js";
import {
  clearBackdrops,
  clickProjectNav,
  dismissOverlays,
  downloadTile,
  downloadsNow,
  ensureProjectGrid,
  extensionOf,
  findTile,
  hoverTile,
  pause,
  scrollToTop,
  tileResolver,
  useOwnDownloadDir,
  waitForDownloadedFile,
  type ImageSize,
} from "./driver.js";

// Characters and image edits (FMM-02 phase 5), ported from flow-mcp's createCharacter / editCharacter / runEdit with the
// selectors re-mapped on the redesigned Flow (CLAUDE.md "Flow UI map"). All free (Nano Banana). In the new UI a described
// character is drawn straight into the character editor (/character/<uuid>); there is no separate portrait step.

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ICONS = /\b(accessibility_new|person|movie|image|videocam|mic)\b/g;

export interface CharacterInput {
  name: string;
  describe?: string;
  image?: string;
  personality?: string;
  voice?: string;
}

// The Characters filter of the project's grid. With none yet Flow opens the "new character" page instead.
export async function listCharacters(page: Page): Promise<string[]> {
  await ensureProjectGrid(page);
  if (!(await clickProjectNav(page, "Characters"))) throw new Error("Flow's left menu has no Characters entry (is a project open?).");
  await pause(page, 2500);
  const none = /\/character$/.test(new URL(page.url()).pathname);
  const names = none
    ? []
    : await page.evaluate(() => [...document.querySelectorAll("flow-character-tile")].map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean));
  await ensureProjectGrid(page).catch(() => {});
  // The user's own "Me" avatar is not a character of the project.
  return [...new Set(names.map((n) => n.replace(ICONS, "").replace(/\s+/g, " ").trim()))].filter((n) => n && n !== "Me");
}

// The portrait's toolbar (Download image, Delete image) shows for a real pointer move over the picture only (flow-mcp).
async function savePortrait(page: Page, dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const picture = page.getByRole("img", { name: "Generated character image" }).first();
  const button = page.getByRole("button", { name: "Download image", exact: true });
  return withDownloadLock(async () => {
    await useOwnDownloadDir(page);
    const before = downloadsNow();
    let pressed = false;
    for (let attempt = 0; attempt < 3 && !pressed; attempt++) {
      await hoverTile(page, picture, 500);
      pressed = await button.click({ timeout: 4000 }).then(() => true, () => false);
    }
    if (!pressed) throw new Error("Flow never showed the portrait's Download image button.");
    // A size menu may follow (1K / 2K / 4K): take the original.
    const original = page.getByRole("menuitem").filter({ hasText: /^\s*1K/ }).first();
    if (await original.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false)) await original.click({ timeout: 4000 });
    const file = await waitForDownloadedFile(page, before, 120_000);
    const target = join(dir, `${name.replace(/[^\w.-]+/g, "_")}${extensionOf(file)}`);
    renameSync(file, target);
    return target;
  });
}

// Waits for the editor's portrait: no "NN%" anywhere and (when given) a picture that differs from `previous`.
async function waitForPortrait(page: Page, previous: string | null, timeoutMs: number, progress: (s: string) => void): Promise<string> {
  const img = page.getByRole("img", { name: "Generated character image" }).first();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await pause(page, 3000);
    const src = await img.getAttribute("src").catch(() => null);
    const pct = (await page.locator("body").innerText().catch(() => "")).match(/\d+%/)?.[0];
    if (pct) progress(`Flow is drawing: ${pct}`);
    if (src && src !== previous && !pct) return src;
    if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to draw the character.");
  }
}

async function leaveEditor(page: Page): Promise<void> {
  if (/\/character\//.test(new URL(page.url()).pathname)) {
    await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 12_000 }).catch(() => {});
  }
  await ensureProjectGrid(page).catch(() => {});
}

export async function createCharacter(page: Page, c: CharacterInput, castDir: string, progress: (s: string) => void): Promise<{ name: string; url: string; portrait?: string; note?: string }> {
  if (!c.image && !c.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
  await ensureProjectGrid(page);
  await dismissOverlays(page);
  await scrollToTop(page);
  progress("opening the character page");
  await page.getByRole("button", { name: "Add media menu" }).click({ timeout: 5000 });
  await page.getByRole("menuitem").filter({ hasText: /Create character\s*$/ }).click({ timeout: 5000 });
  await page.waitForURL(/\/character$/, { timeout: 15_000 });
  await pause(page, 1200);

  if (c.describe) {
    progress("drawing the character");
    await page.locator(".ProseMirror").last().click({ timeout: 6000 });
    await page.keyboard.insertText(c.describe.replace(/\s*\n+\s*/g, " ").trim());
    await pause(page, 500);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow did not accept the description (Start generation stayed disabled).");
    await start.click({ timeout: 5000 });
  } else if (c.image!.startsWith("asset:")) {
    const title = c.image!.slice(6).trim();
    await page.getByRole("button", { name: "Add from project", exact: true }).click({ timeout: 5000 });
    const list = page.getByRole("listbox", { name: "Asset list" });
    await list.waitFor({ state: "visible", timeout: 10_000 });
    let option = list.getByRole("option", { name: new RegExp(`^${escapeRe(title)}`, "i") }).first();
    if (!(await option.isVisible().catch(() => false))) {
      await page.getByRole("tab").filter({ hasText: /Uploads\s*$/ }).first().click({ timeout: 4000 }).catch(() => {});
      await pause(page, 1000);
      option = list.getByRole("option", { name: new RegExp(`^${escapeRe(title)}`, "i") }).first();
    }
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape");
      throw new Error(`No image titled "${title}" in the Flow project. Use flow_assets to list titles.`);
    }
    await option.click({ timeout: 5000 });
    await page.getByRole("button", { name: "Add media", exact: true }).click({ timeout: 5000 });
  } else {
    if (!existsSync(c.image!)) throw new Error(`File not found: ${c.image}`);
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("button", { name: "Upload", exact: true }).click({ timeout: 5000 });
    await (await chooser).setFiles(c.image!);
  }
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const url = page.url();
  if (c.describe) await waitForPortrait(page, null, 4 * 60_000, progress);

  progress("naming the character");
  const name = page.getByRole("textbox", { name: "Character name" });
  await name.waitFor({ state: "visible", timeout: 15_000 });
  await name.fill(c.name);
  await name.press("Enter");
  if (c.personality) await page.getByRole("textbox", { name: "Character personality" }).fill(c.personality);

  let note: string | undefined;
  if (c.voice) {
    progress("choosing the voice");
    await page.getByRole("button", { name: "Select a voice" }).click({ timeout: 5000 });
    const voices = page.getByRole("listbox", { name: "Asset list" });
    await voices.waitFor({ state: "visible", timeout: 10_000 });
    const option = voices.getByRole("option", { name: new RegExp(`(^|\\s)${escapeRe(c.voice)}(\\s|$)`, "i") }).first();
    if (await option.isVisible().catch(() => false)) {
      await option.click({ timeout: 5000 });
      // "Customize performance" would turn this into generating a new voice; stock voices only.
      await page.getByRole("button", { name: "Add to character", exact: true }).click({ timeout: 5000 });
      await pause(page, 1000);
    } else {
      const available = (await voices.getByRole("option").allInnerTexts()).map((t) => t.replace(/voice_selection/g, "").replace(/\s+/g, " ").trim().split(" ")[0]);
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click({ timeout: 4000 }).catch(() => page.keyboard.press("Escape"));
      note = `Voice "${c.voice}" not found, so the character has no voice. Available: ${available.join(", ")}`;
    }
  }

  let portrait: string | undefined;
  try {
    progress("saving the portrait");
    portrait = await savePortrait(page, castDir, c.name);
  } catch (err) {
    note = [note, `the portrait could not be saved (${(err as Error).message.split("\n")[0]}); flow_character_edit with just the name saves it`].filter(Boolean).join(" · ");
  }
  await leaveEditor(page);
  return { name: c.name, url, portrait, note };
}

// Opens an existing character and restyles its portrait in place (Nano Banana, free). Without a change it only saves the
// current portrait. The editor always draws 16:9 and a vague edit once made three copies side by side (flow-mcp), so every
// edit pins a single figure.
export async function editCharacter(page: Page, name: string, change: string | undefined, castDir: string, progress: (s: string) => void): Promise<{ name: string; portrait?: string; note?: string }> {
  await leaveEditor(page);
  await ensureProjectGrid(page);
  if (!(await clickProjectNav(page, "Characters"))) throw new Error("Flow's left menu has no Characters entry.");
  await pause(page, 2500);
  const card = page.locator("flow-character-tile").filter({ hasText: name }).first();
  if (!(await card.isVisible().catch(() => false))) {
    await ensureProjectGrid(page).catch(() => {});
    throw new Error(`No character called "${name}". Use flow_characters to list them.`);
  }
  await card.scrollIntoViewIfNeeded();
  await card.click({ timeout: 6000 });
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await pause(page, 2000);

  if (change) {
    const img = page.getByRole("img", { name: "Generated character image" }).first();
    const before = await img.getAttribute("src").catch(() => null);
    const box = page.locator(".ProseMirror").last();
    await box.click({ timeout: 6000 });
    await page.keyboard.press("ControlOrMeta+a");
    // Delete leaves a full selection standing in this editor; Backspace clears it (flow-mcp, 2026-10-02).
    await page.keyboard.press("Backspace");
    const told = `${change.replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".")} Exactly one ${name} in the picture: never add copies of ${name} or extra poses side by side.`;
    await page.keyboard.insertText(told);
    await pause(page, 600);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow did not accept the change (Start generation stayed disabled).");
    progress("redrawing the character");
    await start.click({ timeout: 5000 });
    await waitForPortrait(page, before, 4 * 60_000, progress);
  }
  // From here the edit is done in Flow: a failed download must never throw it away, so it becomes a note.
  let portrait: string | undefined;
  let note: string | undefined;
  try {
    progress("saving the portrait");
    portrait = await savePortrait(page, castDir, name);
  } catch (err) {
    note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${(err as Error).message.split("\n")[0]}). Call flow_character_edit with just the name to save it.`;
  }
  await leaveEditor(page);
  return { name, portrait, note };
}

// ---- Image edit (the tile's edit view) ----

const lastUuid = (src: string | null) => /\/image\/([0-9a-f-]{36})/.exec(src ?? "")?.[1] ?? "";

// Edits one image in its edit view ("What do you want to change?", free). Flow replaces the tile in place: the grid keeps
// one tile under the same title with a NEW media id (the old picture stays in the tile's history), so the result is the
// tile carrying the id the edit view shows afterwards.
export async function editImage(
  page: Page,
  mediaId: string,
  prompt: string,
  stem: string,
  size: ImageSize,
  progress: (s: string) => void,
): Promise<{ file: string; media_id: string; previous_media_id: string }> {
  await ensureProjectGrid(page);
  const tile = await findTile(page, mediaId);
  await hoverTile(page, tile);
  const box = await tile.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 20_000 });
  await pause(page, 2500);
  const main = () => page.evaluate(() => [...document.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 300).map((i) => i.getAttribute("src")));
  const before = lastUuid((await main())[0] ?? null);
  const kind = await page.locator("main video, video").count();
  if (kind) throw new Error("That tile is a video: use flow_edit with max_credits (video edits spend credits).");
  const box2 = page.locator(".ProseMirror").last();
  await box2.click({ timeout: 6000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(prompt.replace(/\s*\n+\s*/g, " ").trim());
  await pause(page, 600);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow did not accept the edit prompt (Start generation stayed disabled).");
  progress("editing the image");
  await start.click({ timeout: 5000 });
  const deadline = Date.now() + 4 * 60_000;
  let now = before;
  for (;;) {
    await pause(page, 3000);
    const pct = (await page.locator("main").first().innerText().catch(() => "")).match(/\d+%/)?.[0];
    if (pct) progress(`Flow is editing: ${pct}`);
    now = lastUuid((await main())[0] ?? null);
    if (!pct && now && now !== before) break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to finish the image edit.");
  }
  await pause(page, 1500);
  await page.getByRole("button", { name: "Back button to go to previous page" }).click({ timeout: 6000 });
  await pause(page, 2500);
  await ensureProjectGrid(page);
  mkdirSync(join(stem, ".."), { recursive: true });
  progress("downloading the edited image");
  const file = await downloadTile(page, tileResolver(page, now), stem, size);
  await clearBackdrops(page);
  return { file, media_id: now, previous_media_id: before };
}

// Copies a local file under a unique name for uploads (used by callers that stage references).
export function stageUpload(file: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-music-mcp-"));
  const staged = join(dir, `${name}${extname(file).toLowerCase()}`);
  copyFileSync(file, staged);
  return staged;
}
