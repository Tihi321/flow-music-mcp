import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { FLOW_URL, HOME_DIR, inEnglish, withDownloadLock } from "../chrome.js";

// The Google Flow UI driver (flow.google.com), rewritten for the redesigned Flow of 2026-10-22. Ported logic and lessons
// from flow-mcp (github.com/GTAI-1/flow-mcp, src/flow.ts, ISC per its package.json): the grid is virtual, tiles are found
// by media id (never by title), downloads go to a folder Chrome itself writes into, and menus carry icon words in their
// text. Every selector here was mapped from the live page: see CLAUDE.md, "Flow UI map (2026-10-22)". Never guess one.

export type ImageSize = "1K" | "2K" | "4K";
export type TileKind = "image" | "video" | "scene" | "other";

export interface Tile {
  id: string;
  title: string;
  kind: TileKind;
  busy: boolean;
}

export interface FlowState {
  url: string;
  signed_in: boolean;
  in_project: boolean;
  project_id?: string;
  project_name?: string;
  plan?: string;
  credits?: number;
  hint?: string;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// ---- Overlays and navigation ----

// The cookie notice at the bottom ("Hide") sits over the lower part of the agent panel and swallows clicks there.
export async function dismissCookieNotice(page: Page): Promise<void> {
  const hide = page.locator(".glue-cookie-notification-bar").getByRole("button", { name: "Hide", exact: true });
  if (await hide.isVisible().catch(() => false)) await hide.click({ timeout: 3000 }).catch(() => {});
}

// Some menus ignore Escape (the model menus of Agent settings do) and leave an invisible backdrop that swallows every
// click on the page. Clicking the backdrop closes the menu and picks nothing.
export async function clearBackdrops(page: Page): Promise<void> {
  const showing = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  for (let i = 0; i < 4 && (await showing.count().catch(() => 0)); i++) {
    await showing.last().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 400);
  }
}

// The left menu is a Material drawer and Escape shuts it whenever the keyboard focus is inside it (flow-mcp, 2026-10-13).
export async function leaveSideMenu(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("mat-sidenav")) focused.blur();
    })
    .catch(() => {});
}

export async function dismissOverlays(page: Page): Promise<void> {
  await leaveSideMenu(page);
  await page.keyboard.press("Escape").catch(() => {});
  const closePanel = page.getByRole("button", { name: "Close account panel" });
  if (await closePanel.isVisible().catch(() => false)) await closePanel.click({ timeout: 4000 }).catch(() => {});
  await clearBackdrops(page);
  await dismissCookieNotice(page);
}

// The grid is virtual and new tiles appear at the top, so every step starts from the top.
export async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0))).catch(() => {});
  await pause(page, 350);
}

async function scrollDown(page: Page): Promise<boolean> {
  const moved = await page.evaluate(() => {
    const el = document.querySelector(".page-container");
    if (!el) return false;
    const top = el.scrollTop;
    el.scrollTop = top + el.clientHeight * 0.8;
    return el.scrollTop > top;
  });
  await pause(page, 600);
  return moved;
}

export const projectRoot = (url: string): string | undefined => /^https:\/\/flow\.google\.com\/project\/[0-9a-f-]{36}/.exec(url)?.[0];

export async function isSignedIn(page: Page): Promise<boolean> {
  if (/accounts\.google\.com|\/about(\/|\?|$)/.test(page.url())) return false;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return page
    .getByRole("button", { name: "Account details" })
    .waitFor({ state: "visible", timeout: 12_000 })
    .then(() => true, () => false);
}

// The balance only shows inside the account panel ("N Google Flow credits"). Nothing else in that panel is touched: it
// also holds "Sign out of all accounts".
export async function readAccount(page: Page): Promise<{ plan?: string; credits?: number }> {
  await dismissOverlays(page);
  const button = page.getByRole("button", { name: "Account details" });
  const plan = await button.innerText().then((t) => t.trim().split("\n")[0], () => undefined);
  await button.click({ timeout: 5000 });
  try {
    const link = page.getByRole("link", { name: /Google Flow credits/ });
    await link.waitFor({ state: "visible", timeout: 6000 });
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    return { plan, credits: Number.isNaN(n) ? undefined : n };
  } catch {
    return { plan };
  } finally {
    await dismissOverlays(page);
    await pause(page, 300);
  }
}

export async function flowState(page: Page, detailed: boolean): Promise<FlowState> {
  const url = page.url();
  const signed_in = await isSignedIn(page);
  const root = projectRoot(page.url());
  const state: FlowState = { url: page.url(), signed_in, in_project: Boolean(root) };
  if (!signed_in) {
    state.hint = "Flow is not signed in. Run `yarn login` in flow-music-mcp and sign in to Google in the Chrome window that opens.";
    return state;
  }
  if (root) {
    state.project_id = UUID.exec(root)?.[0];
    state.project_name = await page.locator('input[aria-label="Editable text"]').first().inputValue({ timeout: 3000 }).catch(() => undefined);
  } else state.hint = `No project is open (page: ${url}). flow_generate opens one by name.`;
  if (detailed) Object.assign(state, await readAccount(page).catch(() => ({})));
  return state;
}

// ---- Projects ----

export async function listProjects(page: Page): Promise<ProjectRef[]> {
  const home = new URL(FLOW_URL);
  if (new URL(page.url()).pathname !== "/" || !/flow\.google\.com/.test(page.url())) {
    await page.goto(inEnglish(home.toString()), { waitUntil: "domcontentloaded" });
  }
  await dismissCookieNotice(page);
  // A signed-in home page always has the New project button, even with no projects at all.
  await page.getByRole("button", { name: "New project" }).waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await pause(page, 1200);
  return page.evaluate(() =>
    [...document.querySelectorAll(".project-card")].flatMap((card) => {
      const href = card.querySelector('a[href^="/project/"]')?.getAttribute("href") ?? "";
      const id = href.split("/project/")[1]?.split(/[?#/]/)[0] ?? "";
      // The label also holds the edit button's icon word on a second line.
      const name = ((card.querySelector(".project-title-label") as HTMLElement | null)?.innerText.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
      return id ? [{ id, name }] : [];
    }),
  );
}

// Opens a project by name or id, or the project already open when none is given. Creates one (free) when asked.
export async function openProject(page: Page, project: string | undefined, create: boolean): Promise<ProjectRef & { created: boolean }> {
  if (!(await isSignedIn(page))) throw new Error("Flow is not signed in. Run `yarn login` in flow-music-mcp and sign in to Google in the Chrome window that opens.");
  if (!project) {
    const root = projectRoot(page.url());
    if (!root) {
      const names = (await listProjects(page)).map((p) => p.name || p.id);
      throw new Error(`No Flow project is open and none was named. Pass project (name or id). Projects: ${names.join(" | ") || "none"}.`);
    }
    return { id: UUID.exec(root)![0], name: await page.locator('input[aria-label="Editable text"]').first().inputValue().catch(() => ""), created: false };
  }
  let id = UUID.test(project) ? UUID.exec(project)![0] : undefined;
  let name = id ?? project;
  if (!id) {
    const all = await listProjects(page);
    const same = all.filter((p) => p.name.toLowerCase() === project.trim().toLowerCase());
    if (same.length > 1) throw new Error(`${same.length} Flow projects are called "${project}". Pass the project id instead: ${same.map((p) => p.id).join(", ")}.`);
    if (same[0]) ({ id, name } = same[0]);
  } else {
    // Already there? Then nothing to load.
    if (projectRoot(page.url())?.endsWith(id)) return { id, name: await page.locator('input[aria-label="Editable text"]').first().inputValue().catch(() => id!), created: false };
  }
  if (id) {
    const root = projectRoot(page.url());
    if (!root?.endsWith(id)) await page.goto(inEnglish(new URL(`project/${id}`, FLOW_URL).toString()), { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Project navigation" }).waitFor({ state: "visible", timeout: 20_000 });
    await dismissCookieNotice(page);
    if (name === id) name = await page.locator('input[aria-label="Editable text"]').first().inputValue().catch(() => id!);
    return { id, name, created: false };
  }
  if (!create) {
    const names = (await listProjects(page)).map((p) => p.name || p.id);
    throw new Error(`No Flow project called "${project}". Projects: ${names.join(" | ") || "none"}. Pass create_project: true to make it.`);
  }
  await page.getByRole("button", { name: "New project" }).click({ timeout: 10_000 });
  await page.waitForURL(/\/project\//, { timeout: 25_000 });
  await page.getByRole("navigation", { name: "Project navigation" }).waitFor({ state: "visible", timeout: 20_000 });
  await dismissCookieNotice(page);
  const title = page.locator('input[aria-label="Editable text"]').first();
  await title.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(project.trim(), { delay: 8 });
  await page.keyboard.press("Enter");
  await pause(page, 1200);
  return { id: UUID.exec(page.url())![0], name: await title.inputValue().catch(() => project), created: true };
}

// The left "Project navigation" (All media, Images, Characters, Scenes, Library, Tools, Trash). Each item's text holds its
// icon word and its label ("dashboard All media"), also when the menu is collapsed to icons.
async function clickProjectNav(page: Page, item: string): Promise<boolean> {
  const button = page
    .getByRole("navigation", { name: "Project navigation" })
    .locator("button, a")
    .filter({ hasText: new RegExp(`${escapeRe(item)}\\s*$`) })
    .first();
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click({ timeout: 5000 });
  await leaveSideMenu(page);
  return true;
}

export async function ensureProjectGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = projectRoot(page.url());
  if (!root) throw new Error(`No Flow project is open (page: ${page.url()}).`);
  // From /edit/, /character, /trash or a scene view the grid is not on screen: go to the project root.
  if (new URL(page.url()).pathname !== new URL(root).pathname) {
    await page.goto(inEnglish(root), { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Project navigation" }).waitFor({ state: "visible", timeout: 20_000 });
    await dismissCookieNotice(page);
  }
  // "All media" clears the Images/Scenes filters. Without the menu the grid is still usable, so a miss is not an error.
  await clickProjectNav(page, "All media").catch(() => false);
  await pause(page, 700);
  await scrollToTop(page);
}

// ---- Tiles ----

// Every finished image tile carries its media id in data-media-id; some thumbnails also have it in the URL. Video tiles at
// rest expose neither (flow-mcp), so an id-less tile falls back to its title. Failed tiles have no title and no id.
const TILE_JS = `(tile) => {
  const media = tile.querySelector("img[data-media-id], video[data-media-id], img[src], video[src]");
  const id = media && (media.getAttribute("data-media-id") || media.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]);
  const title = tile.getAttribute("aria-label") || "";
  return {
    id: id || (title ? "title:" + title : ""),
    title,
    kind: tile.querySelector("flow-scene-tile") ? "scene" : tile.querySelector("flow-video-tile") ? "video" : tile.querySelector("flow-image-tile") ? "image" : "other",
    error: !!tile.querySelector("flow-error-tile"),
    busy: /\\d+%/.test(tile.innerText) || (!!tile.querySelector("flow-video-tile") && !tile.querySelector('img[alt="Generated video thumbnail"], video')),
  };
}`;

interface RawTile extends Tile {
  error: boolean;
}

async function readTiles(page: Page): Promise<RawTile[]> {
  return page.evaluate(
    (js) => [...document.querySelectorAll("flow-grid-tile-container")].map(eval(js) as (t: Element) => RawTile),
    TILE_JS,
  );
}

const tileById = (page: Page, id: string): Locator =>
  page
    .locator(
      id.startsWith("title:")
        ? `flow-grid-tile-container[aria-label="${id.slice(6).replace(/"/g, '\\"')}"]`
        : `flow-grid-tile-container:has([data-media-id="${id}"]), flow-grid-tile-container:has([src*="${id}"])`,
    )
    .first();

// Ids of the tiles on screen at the top of the grid: the "before" picture of a generation.
export async function topIds(page: Page): Promise<string[]> {
  await scrollToTop(page);
  return (await readTiles(page)).map((t) => t.id).filter(Boolean);
}

// New tiles appear at the top of an All-media grid sorted Newest, so a scan from the top stops at the first tile that
// existed before. Freshness is by media id, never by title: the agent reuses titles (flow-mcp lesson, 2026-09-20), and an
// agent edit of a reference image gives the tile a new id under the same title (seen 2026-10-22).
export async function scanNew(page: Page, before: Iterable<string>, full = false): Promise<{ fresh: Tile[]; errors: number }> {
  const known = new Set(before);
  await scrollToTop(page);
  const fresh = new Map<string, Tile>();
  let errors = 0;
  for (let step = 0; step < 200; step++) {
    const tiles = await readTiles(page);
    const firstKnown = tiles.findIndex((t) => t.id && known.has(t.id));
    // Failed tiles have no id; only the ones above the first known tile of this view are new (notes only).
    errors = Math.max(errors, tiles.slice(0, firstKnown < 0 ? undefined : firstKnown).filter((t) => t.error).length);
    for (const t of tiles) {
      if (t.error || !t.id || known.has(t.id) || t.title.startsWith("fm-")) continue;
      fresh.set(t.id, { id: t.id, title: t.title, kind: t.kind, busy: t.busy });
    }
    if (firstKnown >= 0 && !full) break;
    if (!(await scrollDown(page))) break;
  }
  await scrollToTop(page);
  return { fresh: [...fresh.values()], errors };
}

// The whole grid, every tile once (by id, or by title for id-less tiles). Walks down the virtual list.
export async function scanGrid(page: Page, stopAt?: (tiles: Tile[]) => boolean): Promise<Tile[]> {
  await scrollToTop(page);
  const seen = new Map<string, Tile>();
  for (let step = 0; step < 300; step++) {
    for (const t of await readTiles(page)) if (t.id && !seen.has(t.id)) seen.set(t.id, { id: t.id, title: t.title, kind: t.kind, busy: t.busy });
    if (stopAt?.([...seen.values()])) break;
    if (!(await scrollDown(page))) break;
  }
  return [...seen.values()];
}

// Walks down until the tile with this id is mounted (the grid unmounts what is off screen) and leaves it there: no
// scroll to the top after this, or the tile is unmounted again (flow-mcp's "virtual grid trap").
export async function findTile(page: Page, id: string): Promise<Locator> {
  await scrollToTop(page);
  for (let step = 0; step < 300; step++) {
    const tile = tileById(page, id);
    if (await tile.count()) {
      await tile.scrollIntoViewIfNeeded();
      return tile;
    }
    if (!(await scrollDown(page))) break;
  }
  throw new Error(`The tile ${id} is not in the open project's grid (trashed, or another project is open). Use flow_assets to list what is there.`);
}

// Flow reveals a tile's toolbar for a genuine pointer move only; Playwright's hover() does not trigger it.
async function hoverTile(page: Page, tile: Locator, settleMs = 250): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.hover();
  await pause(page, settleMs);
}

// The prompt Flow stored for a tile: "Reuse prompt" writes it into the agent's prompt box. The caller clears it again.
export async function storedPrompt(page: Page, tile: Locator): Promise<string> {
  await hoverTile(page, tile, 300);
  const reuse = tile.getByRole("button", { name: "Reuse prompt" });
  await reuse.waitFor({ state: "visible", timeout: 4000 });
  await reuse.click({ timeout: 5000 });
  await pause(page, 800);
  const text = await page.locator("flow-agent-panel .ProseMirror").first().innerText().catch(() => "");
  const clear = page.locator("flow-agent-panel").getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click({ timeout: 3000 }).catch(() => {});
  return text.replace(/\s+/g, " ").trim();
}

// ---- Download ----

export const DOWNLOAD_DIR = join(HOME_DIR, "downloads");
const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

// Playwright keeps a download in a per-connection temp file another client may sweep, so Chrome itself writes into a folder
// we own. The override is browser-wide and reset when another CDP client attaches, so it is set again before EVERY download
// (flow-mcp, 2026-09-21: downloads were going to ~/Downloads all along).
async function useOwnDownloadDir(page: Page): Promise<void> {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_DIR, eventsEnabled: true }).catch(() => {});
}

function downloadsNow(): Set<string> {
  const seen = new Set<string>();
  for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) if (existsSync(dir)) for (const f of readdirSync(dir)) seen.add(join(dir, f));
  return seen;
}

// A new file in either folder whose size held still across two checks.
async function waitForDownloadedFile(page: Page, before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stable: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await pause(page, 250);
    for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (before.has(path) || f.endsWith(".crdownload") || f.startsWith(".")) continue;
        const size = statSync(path).size;
        if (stable?.path === path && stable.size === size && size > 0) return path;
        stable = { path, size };
      }
    }
  }
  throw new Error("Flow started the download but no file arrived in the tool's folder or ~/Downloads.");
}

// "allowAndName" saves under a bare id with no extension, so the type is read from the first bytes.
export function extensionOf(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return ".png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(4, 8) === "ftyp") return ".mp4";
  if (ascii(0, 4) === "GIF8") return ".gif";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  return ".bin";
}

// Image download submenu (2026-10-22): "1K Original size", "2K Upscaled", "4K Upscaled".
const SIZE_RE: Record<ImageSize, RegExp> = { "1K": /^\s*1K/, "2K": /^\s*2K/, "4K": /^\s*4K/ };

// More options -> Download (the submenu opens on hover) -> a size. Returns the saved file path (extension by magic bytes).
// One download at a time across both sites (chrome.ts withDownloadLock).
export function downloadTile(page: Page, resolve: () => Promise<Locator>, stem: string, size: ImageSize): Promise<string> {
  return withDownloadLock(() => downloadTileNow(page, resolve, stem, size));
}

async function downloadTileNow(page: Page, resolve: () => Promise<Locator>, stem: string, size: ImageSize): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await useOwnDownloadDir(page);
      await clearBackdrops(page);
      const tile = await resolve();
      const before = downloadsNow();
      await hoverTile(page, tile);
      const more = tile.getByRole("button", { name: "More options" });
      await more.waitFor({ state: "visible", timeout: 4000 });
      await more.click();
      const download = page.getByRole("menuitem").filter({ hasText: /Download\s*$/ }).first();
      if (!(await download.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false))) {
        const items = await page.locator('[role="menuitem"]').allInnerTexts();
        throw new Error(items.length ? `The tile menu has no Download item. It offered: ${items.map((t) => t.replace(/\s+/g, " ").trim()).join(" | ")}` : "The tile menu did not open.");
      }
      const item = page.getByRole("menuitem").filter({ hasText: SIZE_RE[size] }).first();
      await download.hover();
      if (!(await item.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false))) {
        // The submenu did not open on hover: open it from the keyboard.
        await download.focus();
        await page.keyboard.press("ArrowRight");
        await item.waitFor({ state: "visible", timeout: 4000 });
      }
      if ((await item.getAttribute("aria-disabled")) === "true" || (await item.getAttribute("disabled")) !== null) {
        throw new Error(`${size} is not available for this tile (the menu item is disabled).`);
      }
      await item.click({ timeout: 6000 }).catch(async () => {
        await item.focus();
        await page.keyboard.press("Enter");
      });
      // Upscales render on demand and can take minutes.
      const file = await waitForDownloadedFile(page, before, size === "1K" ? 120_000 : 600_000);
      const target = `${stem}${extensionOf(file)}`;
      mkdirSync(join(target, ".."), { recursive: true });
      renameSync(file, target);
      await page.keyboard.press("Escape").catch(() => {});
      await clearBackdrops(page);
      return target;
    } catch (err) {
      lastError = err;
      await page.keyboard.press("Escape").catch(() => {});
      await clearBackdrops(page);
      await pause(page, 1500);
    }
  }
  throw lastError;
}

// Re-finds the tile on every attempt: the virtual grid may have unmounted it between steps.
export const tileResolver = (page: Page, id: string) => async (): Promise<Locator> => {
  const tile = tileById(page, id);
  if (await tile.count()) return tile;
  return findTile(page, id);
};

// ---- Assets, trash, debugging ----

export async function listAssets(page: Page): Promise<Tile[]> {
  await ensureProjectGrid(page);
  const tiles = await scanGrid(page);
  await scrollToTop(page);
  return tiles;
}

// Moves one tile to Flow's Trash (recoverable: Restore / Delete permanently there). Flow asks no confirmation.
export async function trashTile(page: Page, id: string): Promise<void> {
  await ensureProjectGrid(page);
  const tile = await findTile(page, id);
  await hoverTile(page, tile);
  const more = tile.getByRole("button", { name: "More options" });
  await more.waitFor({ state: "visible", timeout: 4000 });
  await more.click();
  const item = page.getByRole("menuitem").filter({ hasText: /Move to trash\s*$/ }).first();
  await item.waitFor({ state: "visible", timeout: 6000 });
  await item.click();
  await pause(page, 2000);
  await clearBackdrops(page);
  if (await tileById(page, id).count()) throw new Error(`The tile ${id} is still in the project: Flow did not move it to Trash.`);
  await scrollToTop(page);
}

// Every visible control on the Flow page with its role and name: the starting point for remapping selectors after Flow
// changes its UI.
export async function inspect(page: Page, scope?: string): Promise<unknown> {
  const controls = await page.evaluate((scopeSel) => {
    const root = (scopeSel ? document.querySelector(scopeSel) : null) ?? document.body;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const sel = 'button, a[href], input, textarea, [role="button"], [role="switch"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="textbox"], [contenteditable="true"]';
    return [...root.querySelectorAll(sel)]
      .filter(visible)
      .slice(0, 300)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? undefined,
        name: (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || undefined,
        href: el.getAttribute("href") ?? undefined,
        state: ["aria-pressed", "aria-checked", "aria-selected", "aria-expanded", "aria-disabled"].map((a) => (el.hasAttribute(a) ? `${a}=${el.getAttribute(a)}` : "")).filter(Boolean).join(" ") || undefined,
      }));
  }, scope);
  const dialogs = await page
    .evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"]')].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean))
    .catch(() => [] as string[]);
  return { url: page.url(), dialogs, controls };
}
