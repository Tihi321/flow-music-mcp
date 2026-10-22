import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR, MUSIC_URL, withDownloadLock } from "./chrome.js";
import { audioExtensionOfBytes, classifySongText, lengthValid, mediaExtensionOfBytes, modelItemPattern, parseCredits, remixItemPattern, renderingNote, videoTemplateCard, type VideoTemplate } from "./util.js";

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

// A remix of an existing song (FMM-07): a paid job like a Compose generation. "variation" renders at once; "extend" opens the
// edit mode, where the optional instruction is typed and Generate pressed.
export interface RemixParams {
  remix: { song_id: string; mode: "variation" | "extend"; instruction?: string };
  title?: undefined;
  format: AudioFormat;
  output_dir: string;
  file_stem: string;
}

export type MusicParams = ComposeParams | RemixParams;

export interface Song {
  id: string;
  title: string;
  url: string;
  file?: string;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const songUrl = (id: string) => new URL(`song/${id}`, MUSIC_URL).toString();

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
      await fillDynamics(page, label, value === undefined ? "" : String(value));
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

// The labels in the Advanced box are not tied to their inputs (no "for", no wrapping), so getByLabel finds nothing: take
// the first input after the label (mapped 2026-10-22).
const afterLabel = (page: Page, label: string, target: "input" | "button"): Locator =>
  page.locator("label", { hasText: new RegExp(`^${label}$`) }).locator(`xpath=following::${target}[1]`);

// Fill, then Tab: Length is normalised on blur ("2" -> "2:00", out of range -> clamped, junk -> empty). Read it back so a
// value Flow Music threw away fails here and not as a wrong song.
async function fillDynamics(page: Page, label: "BPM" | "Length" | "Seed", value: string): Promise<void> {
  if (label === "Length" && value && !lengthValid(value)) throw new Error(`Length "${value}" is not m:ss between 1:00 and 3:00.`);
  const box = afterLabel(page, label, "input");
  await box.fill(value);
  await page.keyboard.press("Tab");
  const shown = await box.inputValue();
  if (value && !shown) throw new Error(`Flow Music rejected ${label} "${value}": the box is empty after Tab.`);
}

// Open the button after the "Model" label and pick the menu item whose name starts with the model ("Lyria 3.5", "Lyria 3 Pro").
async function chooseModel(page: Page, model: string): Promise<void> {
  const button = afterLabel(page, "Model", "button");
  const pattern = modelItemPattern(model);
  if (pattern.test(((await button.textContent()) ?? "").trim())) return;
  await button.click();
  const option = page.getByRole("menuitem", { name: pattern }).first();
  if (!(await option.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false))) {
    const offered = await page.locator('[role="menuitem"]').allTextContents();
    await page.keyboard.press("Escape");
    throw new Error(`Flow Music has no model "${model}". It offered: ${offered.map((t) => t.trim()).filter(Boolean).join(" | ") || "nothing"}`);
  }
  await option.click();
}

// ---- Credits ----

// The balance, from the sidebar's "Settings menu" (menuitem "13190 credits"). Opens the menu, reads, and always closes it
// with Escape; nothing in it is clicked (it holds "Log out"). Best effort: undefined when anything fails.
// The menu's balance is read at page load and goes stale until the next load (seen 2026-10-22: 13190 stayed until a
// reload showed 13185), so `fresh` reloads the page first.
export async function readCredits(page: Page, opts: { fresh?: boolean } = {}): Promise<number | undefined> {
  try {
    if (opts.fresh) await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings menu" }).first().waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: "Settings menu" }).first().click({ timeout: 5000 });
    const item = page.getByRole("menuitem", { name: /^[\d,.]+\s+credits$/ }).first();
    await item.waitFor({ state: "visible", timeout: 5000 });
    return parseCredits((await item.textContent()) ?? "");
  } catch {
    return undefined;
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
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
  return renderingNote(text);
}

// A finished take's row. A failed one has not been seen yet: this guesses from its text.
async function songState(page: Page, id: string): Promise<"ready" | "busy" | "failed"> {
  const row = songRow(page, id);
  if (!(await row.count())) return "busy";
  const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
  return classifySongText(text);
}

export interface GenerateResult {
  session: string;
  songs: Song[];
  credits_after?: number;
  credits_spent?: number;
}

// A failed run leaves a dump of the page's controls next to the logs, so the cause can be read without a live session.
// Best effort: the dump never hides the real error.
async function failWithDump(page: Page, message: string): Promise<never> {
  const notice = await pageNotice(page);
  let dump = "";
  try {
    const file = join(HOME_DIR, "debug", `music-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(await inspect(page), null, 2));
    dump = ` Page dump: ${file}`;
  } catch {
    // no dump
  }
  throw new Error(`${message}${notice ? ` The page says: ${notice}` : ""}${dump}`);
}

export async function generate(page: Page, p: ComposeParams, progress: (note: string) => void): Promise<GenerateResult> {
  progress("opening Compose");
  await openCompose(page);
  // openCompose just loaded /session, so this balance is fresh. Before the form is filled: opening the Settings menu and closing it again leaves the compose panel as it was.
  const creditsBefore = await readCredits(page);
  await fillCompose(page, p);
  const before = new Set(await songIds(page));
  const generateButton = page.getByRole("button", { name: "Generate", exact: true });
  progress("generating");
  await generateButton.click();
  // On a brand-new /session the first Generate only created the session and rendered nothing (2026-10-22, no credits
  // spent); a second press started the take. Press again only when nothing has started 20 s later.
  if (!(await started(page, before, 20_000))) {
    if (!(await generateButton.isEnabled().catch(() => false))) {
      const notice = await pageNotice(page);
      throw new Error(`Generate did not start and the button is disabled.${notice ? ` The page says: ${notice}` : ""}`);
    }
    progress("generating (second press)");
    await generateButton.click();
    if (!(await started(page, before, 30_000))) {
      const notice = await pageNotice(page);
      throw new Error(`Flow Music started nothing after two presses of Generate.${notice ? ` The page says: ${notice}` : ""}`);
    }
  }
  return collectTakes(page, before, p, progress, creditsBefore);
}

// Something has started: a render in progress, or a song link that was not there before.
async function started(page: Page, before: Set<string>, ms: number): Promise<boolean> {
  const by = Date.now() + ms;
  while (Date.now() < by) {
    if ((await rendering(page)) || (await songIds(page)).some((id) => !before.has(id))) return true;
    await pause(1000);
  }
  return false;
}

// Shared by generate and remix, once a render has started: wait while anything renders (and a little longer in case a
// second take follows), stop the playback, keep the takes that are ready, download each and read the credits again.
async function collectTakes(
  page: Page,
  before: Set<string>,
  p: { format: AudioFormat; output_dir: string; file_stem: string },
  progress: (note: string) => void,
  creditsBefore: number | undefined,
): Promise<GenerateResult> {
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
  if (!fresh.length) await failWithDump(page, `No take finished within 15 minutes. Session: ${session}`);
  // A finished take starts playing in the tool's Chrome; stop it.
  await page.getByRole("button", { name: /^Pause / }).first().click({ timeout: 2000 }).catch(() => {});
  const states = await Promise.all(fresh.map((id) => songState(page, id)));
  const ready = fresh.filter((_, i) => states[i] === "ready");
  if (!ready.length) {
    const rows = await Promise.all(fresh.map(async (id) => (await songRow(page, id).innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200)));
    await failWithDump(page, `No take finished (${states.join(", ")}). Row text: ${rows.join(" | ") || "none"}. Session: ${session}`);
  }

  const songs: Song[] = [];
  for (const [i, id] of ready.entries()) {
    const stem = ready.length > 1 ? `${p.file_stem}-${String.fromCharCode(97 + i)}` : p.file_stem;
    progress(`downloading take ${i + 1} of ${ready.length}`);
    const file = await downloadFromRow(page, p.format, join(p.output_dir, stem), rowMenu(page, id));
    songs.push({ id, title: await songTitle(page, id), url: songUrl(id), file });
  }
  // After the downloads, so the balance is what the takes cost. A failed read never fails the job.
  const creditsAfter = await readCredits(page, { fresh: true });
  const spent = creditsBefore !== undefined && creditsAfter !== undefined ? creditsBefore - creditsAfter : undefined;
  // A new session only gets its /session/<id> address after the first take, so read it again at the end.
  return {
    session: page.url(),
    songs,
    ...(creditsAfter !== undefined ? { credits_after: creditsAfter } : {}),
    ...(spent !== undefined ? { credits_spent: spent } : {}),
  };
}

// Opens a song's own page and its menu (the unnamed button after Share), then Remix > <sub> by keyboard: a pointer moving
// onto a submenu closes it (the same as Download, 2026-10-22). Submenu items: Start session, Cover, Replace, Extend,
// Use prompt, Variation, Trim. Mapped 2026-10-22 (FMM-07); the code path itself is not yet verified live.
export async function remix(page: Page, p: RemixParams, progress: (note: string) => void): Promise<GenerateResult> {
  const { song_id: id, mode, instruction } = p.remix;
  progress("opening the song");
  await page.goto(songUrl(id), { waitUntil: "domcontentloaded" });
  await requireSignedIn(page);
  const spot = songPageMenu(page);
  await spot.button.waitFor({ state: "visible", timeout: 15_000 });
  // The page has just loaded, so the balance is current.
  const creditsBefore = await readCredits(page);
  await spot.button.click({ timeout: 10_000 });
  const remixItem = page.getByRole("menuitem", { name: /^Remix/ }).first();
  if (!(await remixItem.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false))) {
    const items = await page.locator('[role="menuitem"]').allTextContents();
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(items.length ? `The song menu has no Remix item. It offered: ${items.map((t) => t.trim()).join(" | ")}` : "The song menu did not open.");
  }
  await remixItem.focus();
  await page.keyboard.press("ArrowRight");
  const label = mode === "variation" ? "Variation" : "Extend";
  const item = page.getByRole("menuitem", { name: remixItemPattern(mode) }).first();
  if (!(await item.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false))) {
    const items = await page.locator('[role="menuitem"]').allTextContents();
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(`The Remix menu has no ${label} item. It offered: ${items.map((t) => t.trim()).join(" | ")}`);
  }
  progress(mode === "variation" ? "starting the variation" : "opening the extend editor");
  await item.focus();
  await page.keyboard.press("Enter");
  // Both modes open a new session (/session/<uuid>?t=true for a variation, /session?t=true for the extend editor).
  await page.waitForURL(/\/session/, { timeout: 30_000 });
  await requireSignedIn(page);

  if (mode === "extend") {
    const box = page.getByRole("textbox", { name: "Instruction" });
    await box.waitFor({ state: "visible", timeout: 20_000 });
    if (instruction) await box.fill(instruction);
  } else {
    // Let the new session settle so a take that is already listed is not counted as new.
    await pause(2000);
  }
  // What is on the page now is not a new take: the source song may be listed in the session. A variation has already
  // started rendering; an extend starts when Generate is pressed.
  const before = new Set([id, ...(await songIds(page))]);
  if (mode === "extend") {
    progress("generating the extension");
    await page.getByRole("button", { name: "Generate", exact: true }).click({ timeout: 10_000 });
  }
  if (!(await started(page, before, 30_000))) await failWithDump(page, `The ${mode} did not start.`);
  return collectTakes(page, before, p, progress, creditsBefore);
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
async function waitForDownloadedFile(before: Set<string>, timeoutMs: number, what = "download"): Promise<string> {
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
  throw new Error(`Flow Music started the ${what} but no file arrived in the tool's folder or ~/Downloads within ${Math.round(timeoutMs / 60_000)} min.`);
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
  return audioExtensionOfBytes(head);
}

// Where a song's menu button is: `area` is moved over first (a row shows its buttons on hover), `button` is clicked.
interface MenuSpot {
  area: Locator;
  button: Locator;
}

// In a session thread or list: the row's "More options for <title>" button.
function rowMenu(page: Page, id: string): MenuSpot {
  const area = songRow(page, id);
  return { area, button: area.getByRole("button", { name: /^More options for/ }).first() };
}

// On /song/<id>: no "More options" name there; the menu button is the unnamed one after the Share button in <main>.
function songPageMenu(page: Page): MenuSpot {
  const button = page
    .locator("main")
    .getByRole("button", { name: "Share", exact: true })
    .first()
    .locator("xpath=following::button[@aria-haspopup='menu'][1]");
  return { area: button, button };
}

// The song menu: Download > M4A | MP3 | WAV (also "Download video" and "Get stems", not used here).
// One download at a time across both sites (chrome.ts withDownloadLock).
function downloadFromRow(page: Page, format: AudioFormat, stem: string, spot: MenuSpot): Promise<string> {
  return withDownloadLock(() => downloadFromRowNow(page, format, stem, spot));
}

async function downloadFromRowNow(page: Page, format: AudioFormat, stem: string, spot: MenuSpot): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await useOwnDownloadDir(page);
      await spot.area.scrollIntoViewIfNeeded();
      const box = await spot.area.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await spot.button.click({ timeout: 10_000 });
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

// A song that is not on the current page: open its own page (mapped 2026-10-22: no row there, the menu is behind the
// unnamed button after Share) and use the same keyboard Download path.
export async function downloadSong(page: Page, id: string, format: AudioFormat, stem: string): Promise<Song> {
  if (await songRow(page, id).count()) {
    const file = await downloadFromRow(page, format, stem, rowMenu(page, id));
    return { id, title: await songTitle(page, id), url: songUrl(id), file };
  }
  await page.goto(songUrl(id), { waitUntil: "domcontentloaded" });
  await requireSignedIn(page);
  const spot = songPageMenu(page);
  await spot.button.waitFor({ state: "visible", timeout: 15_000 });
  const title = ((await page.locator('main [role="textbox"]').first().innerText().catch(() => "")) ?? "").trim();
  const file = await downloadFromRow(page, format, stem, spot);
  return { id, title, url: songUrl(id), file };
}

// ---- Music video ----

export interface VideoResult {
  id: string;
  title: string;
  url: string;
  template: VideoTemplate;
  file: string;
}

// Song menu > Download > Download video opens the dialog "Pick a template to create your video" (mapped 2026-10-22);
// clicking a template card posts POST /__api/video/clip. A first render took over 3 minutes with nothing shown, and leaving
// the page stops it, so this stays on the song page until Chrome saves "<title>.mp4" (a repeat request returned at once).
// Holds the download lock for the whole render: one download at a time across both sites, so the new file is ours.
export function downloadVideo(page: Page, id: string, template: VideoTemplate, stem: string, timeoutMs: number, progress: (note: string) => void = () => {}): Promise<VideoResult> {
  return withDownloadLock(async () => {
    progress("opening the song");
    await page.goto(songUrl(id), { waitUntil: "domcontentloaded" });
    await requireSignedIn(page);
    const spot = songPageMenu(page);
    await spot.button.waitFor({ state: "visible", timeout: 15_000 });
    const title = ((await page.locator('main [role="textbox"]').first().innerText().catch(() => "")) ?? "").trim();
    await useOwnDownloadDir(page);
    await spot.button.click({ timeout: 10_000 });
    const download = page.getByRole("menuitem", { name: "Download", exact: true });
    if (!(await download.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false))) {
      const items = await page.locator('[role="menuitem"]').allTextContents();
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(items.length ? `The song menu has no Download item. It offered: ${items.map((t) => t.trim()).join(" | ")}` : "The song menu did not open.");
    }
    await download.focus();
    await page.keyboard.press("ArrowRight");
    const item = page.getByRole("menuitem", { name: "Download video", exact: true });
    await item.waitFor({ state: "visible", timeout: 5000 });
    await item.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const { label, pattern } = videoTemplateCard(template);
    const card = dialog.locator("div.cursor-pointer", { hasText: pattern }).first();
    if (!(await card.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false))) {
      const cards = await dialog.locator("div.cursor-pointer").allInnerTexts();
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(`The video dialog has no "${label}" card. It offered: ${cards.map((t) => t.replace(/\s+/g, " ").trim()).join(" | ") || "nothing"}`);
    }
    const before = downloadsNow();
    progress(`rendering the ${label} video (a first render can take several minutes; the page stays open)`);
    await card.click();
    const file = await waitForDownloadedFile(before, timeoutMs, "video render");
    const head = Buffer.alloc(12);
    const fd = openSync(file, "r");
    try {
      readSync(fd, head, 0, 12, 0);
    } finally {
      closeSync(fd);
    }
    const ext = mediaExtensionOfBytes(head);
    if (ext !== ".mp4") throw new Error(`The downloaded file is not an MP4 (starts as ${ext}); it was left at ${file}.`);
    const target = `${stem}.mp4`;
    mkdirSync(dirname(target), { recursive: true });
    renameSync(file, target);
    await page.keyboard.press("Escape").catch(() => {});
    return { id, title, url: songUrl(id), template, file: target };
  });
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
