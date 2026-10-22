import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR, MUSIC_URL, getMusicPage, withDownloadLock } from "./chrome.js";

// The Flow Music UI driver. Every selector here was mapped from the live page (see CLAUDE.md, "UI map"); never guess one.
// Flow Music is driven through its Compose panel, not the Producer chat: Compose takes the sound, lyrics and title as
// fields, so a request goes in exactly as written and comes back as two takes, with no back-and-forth with the agent.

export type AudioFormat = "mp3" | "wav" | "m4a";

export interface ComposeParams {
  sound: string;
  lyrics?: string;
  instrumental?: boolean;
  title?: string;
  bpm?: number;
  length?: string;
  seed?: number;
  model?: string;
  format: AudioFormat;
  output_dir: string;
  file_stem: string;
}

export interface Song {
  id: string;
  title: string;
  url: string;
  file?: string;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const songUrl = (id: string) => new URL(`song/${id}`, MUSIC_URL).toString();

// One Chrome tab, one action at a time: a status check must not click around in the middle of a generation.
let chain: Promise<unknown> = Promise.resolve();
export function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = chain.then(async () => fn(await getMusicPage()));
  chain = run.catch(() => {});
  return run;
}

// Signed in, the left sidebar links to the library. Signed out, it does not.
export async function signedIn(page: Page): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded");
  return page
    .locator('a[href="/library/my-songs"]')
    .first()
    .waitFor({ state: "attached", timeout: 10_000 })
    .then(() => true, () => false);
}

async function requireSignedIn(page: Page): Promise<void> {
  if (!(await signedIn(page)))
    throw new Error("Flow Music is not signed in. Run `yarn login` in flow-music-mcp and sign in to Google in the Chrome window that opens.");
}

// Song links in the page's <main>. The player bar at the bottom links to whatever song is playing, so it is left out.
const SONG_LINK = 'main a[href^="/song/"]';
async function songIds(page: Page): Promise<string[]> {
  return page.locator(SONG_LINK).evaluateAll((links) => {
    const ids = links.map((a) => (a.getAttribute("href") ?? "").split("/song/")[1]?.split(/[?#]/)[0] ?? "").filter(Boolean);
    return [...new Set(ids)];
  });
}

async function songTitle(page: Page, id: string): Promise<string> {
  return ((await page.locator(`main a[href="/song/${id}"]`).first().textContent().catch(() => "")) ?? "").trim();
}

// The row of one song: the deepest element in <main> that holds both its link and a "More options for ..." button.
// Ancestors come before descendants in document order, so the last match is the row itself.
function songRow(page: Page, id: string): Locator {
  return page
    .locator("main *")
    .filter({ has: page.locator(`a[href="/song/${id}"]`) })
    .filter({ has: page.getByRole("button", { name: /^More options for/ }) })
    .last();
}

// ---- Compose ----

async function openCompose(page: Page): Promise<void> {
  // "New session" in the sidebar links to /session. The Compose toggle is "Open compose panel" on the home page and
  // "Toggle compose panel" inside a session.
  await page.goto(new URL("session", MUSIC_URL).toString(), { waitUntil: "domcontentloaded" });
  await requireSignedIn(page);
  const sound = page.getByRole("textbox", { name: "Sound description" });
  if (!(await sound.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /compose panel/i }).first().click({ timeout: 15_000 });
  }
  await sound.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (!(await sound.isVisible().catch(() => false))) {
    // The Sound section can be collapsed, which hides its textbox.
    await expand(page, "Sound");
    await sound.waitFor({ state: "visible", timeout: 10_000 });
  }
}

// Compose has three sections, each with an "Expand <name> section" / "Collapse <name> section" button.
async function expand(page: Page, section: "Lyrics" | "Sound" | "Details"): Promise<void> {
  const open = page.getByRole("button", { name: `Expand ${section} section` });
  if (await open.isVisible().catch(() => false)) {
    await open.click();
    await pause(300);
  }
}

async function setSwitch(sw: Locator, on: boolean): Promise<void> {
  await sw.waitFor({ state: "visible", timeout: 10_000 });
  const checked = (await sw.getAttribute("aria-checked")) === "true" || (await sw.getAttribute("data-state")) === "checked";
  if (checked !== on) {
    await sw.click();
    await pause(300);
  }
}

async function fillCompose(page: Page, p: ComposeParams): Promise<void> {
  await expand(page, "Lyrics");
  await setSwitch(page.getByRole("switch", { name: "Toggle instrumental mode" }), Boolean(p.instrumental));
  if (!p.instrumental) await page.getByRole("textbox", { name: "Lyrics" }).fill(p.lyrics ?? "");

  await expand(page, "Sound");
  await page.getByRole("textbox", { name: "Sound description" }).fill(p.sound);
  // "Advanced" adds Dynamics: BPM, Length, Seed (text boxes that read "Auto" when empty) and the Model menu.
  const advanced = p.bpm !== undefined || p.length !== undefined || p.seed !== undefined || p.model !== undefined;
  await setSwitch(page.getByRole("switch", { name: "Toggle advanced sound mode" }), advanced);
  if (advanced) {
    for (const [label, value] of [["BPM", p.bpm], ["Length", p.length], ["Seed", p.seed]] as const) {
      await page.getByLabel(label, { exact: true }).fill(value === undefined ? "" : String(value));
    }
    if (p.model) await chooseModel(page, p.model);
  }

  if (p.title) {
    await expand(page, "Details");
    // The title box has no name of its own: it is the first text field after the Details header.
    await page
      .getByRole("button", { name: /Details section$/ })
      .locator("xpath=following::*[self::input or self::textarea][1]")
      .fill(p.title);
  }
}

// UNVERIFIED: only the closed Model button ("Lyria 3.5") has been seen, not the list it opens.
async function chooseModel(page: Page, model: string): Promise<void> {
  const button = page.getByText("Model", { exact: true }).locator("xpath=following::button[1]");
  if (((await button.textContent()) ?? "").trim() === model) return;
  await button.click();
  const option = page.getByRole("option", { name: model }).or(page.getByRole("menuitem", { name: model })).first();
  if (!(await option.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false))) {
    const offered = await page.locator('[role="option"], [role="menuitem"]').allTextContents();
    await page.keyboard.press("Escape");
    throw new Error(`Flow Music has no model "${model}". It offered: ${offered.map((t) => t.trim()).filter(Boolean).join(" | ") || "nothing"}`);
  }
  await option.click();
}

// What a dialog or alert on the page says, for error messages (out of credits, a policy refusal...). Next.js's route
// announcer is a role="alert" that only repeats the page title, so it is left out.
async function pageNotice(page: Page): Promise<string> {
  const texts = await page
    .evaluate(() =>
      [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], [data-sonner-toast]')]
        .filter((el) => !el.closest("next-route-announcer"))
        .map((el) => (el as HTMLElement).innerText),
    )
    .catch(() => [] as string[]);
  const title = await page.title().catch(() => "");
  return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && t !== title).join(" | ");
}

// While a take renders, the session shows `Creating "<title>"...` and a row "NN% Generating <title>..." that has no
// song link yet; the link appears when the take is done (seen 2026-10-22: ~1 min for an instrumental).
async function rendering(page: Page): Promise<string | undefined> {
  const text = ((await page.locator("main").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  return /(\d+%\s*)?Generating [^.]{0,60}/.exec(text)?.[0] ?? (/Creating "/.test(text) ? "creating" : undefined);
}

// A finished take's row. A failed one has not been seen yet: this guesses from its text.
async function songState(page: Page, id: string): Promise<"ready" | "busy" | "failed"> {
  const row = songRow(page, id);
  if (!(await row.count())) return "busy";
  const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
  if (/\bfailed\b|couldn.t|could not|something went wrong/i.test(text)) return "failed";
  if (/\d+\s*%|generating/i.test(text)) return "busy";
  return "ready";
}

export async function generate(page: Page, p: ComposeParams, progress: (note: string) => void): Promise<{ session: string; songs: Song[] }> {
  progress("opening Compose");
  await openCompose(page);
  await fillCompose(page, p);
  const before = new Set(await songIds(page));
  const generateButton = page.getByRole("button", { name: "Generate", exact: true });
  progress("generating");
  await generateButton.click();
  // On a brand-new /session the first Generate only created the session and rendered nothing (2026-10-22, no credits
  // spent); a second press started the take. Press again only when nothing has started 20 s later.
  const started = async (ms: number) => {
    const by = Date.now() + ms;
    while (Date.now() < by) {
      if ((await rendering(page)) || (await songIds(page)).some((id) => !before.has(id))) return true;
      await pause(1000);
    }
    return false;
  };
  if (!(await started(20_000))) {
    if (!(await generateButton.isEnabled().catch(() => false))) {
      const notice = await pageNotice(page);
      throw new Error(`Generate did not start and the button is disabled.${notice ? ` The page says: ${notice}` : ""}`);
    }
    progress("generating (second press)");
    await generateButton.click();
    if (!(await started(30_000))) {
      const notice = await pageNotice(page);
      throw new Error(`Flow Music started nothing after two presses of Generate.${notice ? ` The page says: ${notice}` : ""}`);
    }
  }
  const session = page.url();

  // Wait while anything renders, then a little longer in case a second take follows the first.
  let fresh: string[] = [];
  let quietSince = 0;
  const readyBy = Date.now() + 15 * 60_000;
  while (Date.now() < readyBy) {
    fresh = (await songIds(page)).filter((id) => !before.has(id));
    const now = await rendering(page);
    progress(now ? `rendering: ${now}` : `takes: ${fresh.length}`);
    if (now) quietSince = 0;
    else if (fresh.length) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince > 8000) break;
    }
    await pause(3000);
  }
  if (!fresh.length) throw new Error(`No take finished within 15 minutes. Session: ${session}`);
  // A finished take starts playing in the tool's Chrome; stop it.
  await page.getByRole("button", { name: /^Pause / }).first().click({ timeout: 2000 }).catch(() => {});
  const states = await Promise.all(fresh.map((id) => songState(page, id)));
  const ready = fresh.filter((_, i) => states[i] === "ready");
  if (!ready.length) throw new Error(`No take finished (${states.join(", ")}). Session: ${session}`);

  const songs: Song[] = [];
  for (const [i, id] of ready.entries()) {
    const stem = ready.length > 1 ? `${p.file_stem}-${String.fromCharCode(97 + i)}` : p.file_stem;
    progress(`downloading take ${i + 1} of ${ready.length}`);
    const file = await downloadFromRow(page, id, p.format, join(p.output_dir, stem));
    songs.push({ id, title: await songTitle(page, id), url: songUrl(id), file });
  }
  // A new session only gets its /session/<id> address after the first take, so read it again at the end.
  return { session: page.url(), songs };
}

// ---- Download ----

const DOWNLOAD_DIR = join(HOME_DIR, "downloads");
const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

// From flow-mcp: Playwright keeps a download in a per-connection temp file it may delete, so Chrome is pointed at a
// folder we own. Another CDP client attaching resets this browser-wide, so it is set again before every download.
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
async function waitForDownloadedFile(before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let stable: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await pause(500);
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
  throw new Error("Flow Music started the download but no file arrived in the tool's folder or ~/Downloads.");
}

// "allowAndName" saves under a bare id, so the type is read from the first bytes.
function extensionOf(file: string): string | undefined {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (ascii(0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return ".mp3";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return ".wav";
  if (ascii(4, 8) === "ftyp") return ".m4a";
  if (ascii(0, 4) === "OggS") return ".ogg";
  if (ascii(0, 4) === "fLaC") return ".flac";
  if (ascii(0, 2) === "PK") return ".zip";
  return undefined;
}

// The row's "More options" menu: Download > M4A | MP3 | WAV (also "Download video" and "Get stems", not used here).
// One download at a time across both sites (chrome.ts withDownloadLock).
function downloadFromRow(page: Page, id: string, format: AudioFormat, stem: string): Promise<string> {
  return withDownloadLock(() => downloadFromRowNow(page, id, format, stem));
}

async function downloadFromRowNow(page: Page, id: string, format: AudioFormat, stem: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await useOwnDownloadDir(page);
      const row = songRow(page, id);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await row.getByRole("button", { name: /^More options for/ }).first().click({ timeout: 10_000 });
      const download = page.getByRole("menuitem", { name: "Download", exact: true });
      if (!(await download.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false))) {
        const items = await page.locator('[role="menuitem"]').allTextContents();
        throw new Error(items.length ? `The song menu has no Download item. It offered: ${items.map((t) => t.trim()).join(" | ")}` : "The song menu did not open.");
      }
      // By keyboard: a pointer moving from "Download" to its submenu closes the submenu on the way (2026-10-22).
      await download.focus();
      await page.keyboard.press("ArrowRight");
      const item = page.getByRole("menuitem", { name: format.toUpperCase(), exact: true });
      await item.waitFor({ state: "visible", timeout: 5000 });
      if ((await item.getAttribute("aria-disabled")) === "true" || (await item.getAttribute("data-disabled")) !== null)
        throw new Error(`${format.toUpperCase()} is not available for this song yet.`);
      const before = downloadsNow();
      await item.focus();
      await page.keyboard.press("Enter");
      // MP3 arrived in 6 s (GET /__api/download/audio/<id>?format=mp3). UNVERIFIED: WAV may be rendered on demand.
      const file = await waitForDownloadedFile(before, format === "wav" ? 600_000 : 180_000);
      const target = `${stem}${extensionOf(file) ?? `.${format}`}`;
      mkdirSync(dirname(target), { recursive: true });
      renameSync(file, target);
      await page.keyboard.press("Escape").catch(() => {});
      return target;
    } catch (err) {
      lastError = err;
      await page.keyboard.press("Escape").catch(() => {});
      await pause(3000);
    }
  }
  throw lastError;
}

// A song that is not on the current page: open its own page first.
// UNVERIFIED: the /song/<id> page layout has not been mapped; this assumes it shows the song's row with the same menu.
export async function downloadSong(page: Page, id: string, format: AudioFormat, stem: string): Promise<Song> {
  if (!(await songRow(page, id).count())) {
    await page.goto(songUrl(id), { waitUntil: "domcontentloaded" });
    await requireSignedIn(page);
    await page.getByRole("button", { name: /^More options for/ }).first().waitFor({ state: "visible", timeout: 15_000 });
  }
  const file = await downloadFromRow(page, id, format, stem);
  return { id, title: await songTitle(page, id), url: songUrl(id), file };
}

// ---- Library and debugging ----

export async function listSongs(page: Page, limit: number): Promise<Song[]> {
  await page.goto(new URL("library/my-songs", MUSIC_URL).toString(), { waitUntil: "domcontentloaded" });
  await requireSignedIn(page);
  await page.locator(SONG_LINK).first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  const ids = (await songIds(page)).slice(0, limit);
  return Promise.all(ids.map(async (id) => ({ id, title: await songTitle(page, id), url: songUrl(id) })));
}

// Every visible control on the current page with its role and name: the starting point for remapping selectors after
// Flow Music changes its UI.
export async function inspect(page: Page): Promise<unknown> {
  const controls = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const sel = 'button, a[href], input, textarea, [role="switch"], [role="menuitem"], [role="option"], [role="textbox"], [contenteditable="true"]';
    return [...document.querySelectorAll(sel)]
      .filter(visible)
      .slice(0, 300)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? undefined,
        name: (el.getAttribute("aria-label") ?? (el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
        placeholder: el.getAttribute("placeholder") ?? undefined,
        href: el.getAttribute("href") ?? undefined,
        checked: el.getAttribute("aria-checked") ?? undefined,
      }));
  });
  return { url: page.url(), signed_in: await signedIn(page), notice: (await pageNotice(page)) || undefined, controls };
}
