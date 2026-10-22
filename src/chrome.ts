import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

// Same approach as flow-mcp (github.com/GTAI-1/flow-mcp, src/chrome.ts): real Chrome with a dedicated profile, driven over
// CDP. Google sign-in works normally and persists, and the user's everyday profile is never touched. It has its own
// profile and CDP port so it never shares a Chrome with flow-mcp: two Playwright clients on one Chrome sweep each
// other's download artifacts (flow-mcp CLAUDE.md, 2026-09-20).

export const MUSIC_URL = "https://www.flowmusic.app/";
const MUSIC_HOST = /^https:\/\/(www\.)?flowmusic\.app\//;
export const HOME_DIR = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
export const CDP_PORT = Number(process.env.FLOW_MUSIC_MCP_CDP_PORT ?? 9334);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.FLOW_MUSIC_MCP_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

export async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found. Set FLOW_MUSIC_MCP_CHROME to the Chrome executable path.");
  return chromePath;
}

async function launchChrome(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    chromeExecutable(),
    [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check", MUSIC_URL],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${CDP_PORT} never came up.`);
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  // Chrome quit or the connection dropped: forget it, so this call reconnects (or relaunches Chrome).
  browser = null;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

export type Site = "flow" | "music";

export const FLOW_URL = "https://flow.google.com/";
const FLOW_HOST = /^https:\/\/flow\.google\.com\//;
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that (flow-mcp CLAUDE.md, 2026-10-13): it holds
// through in-app navigation and only lasts until the next full page load, so every load adds it.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};

// Reloads Flow in English when it shows another language (a page opened by hand, or a redirect without hl).
async function ensureEnglish(page: Page): Promise<void> {
  if (!FLOW_HOST.test(page.url())) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(`Flow is showing in "${after}" and would not switch to English. Add ?hl=en to Flow's address in the Chrome window, or set the Google account's language to English.`);
  }
}

// The tab of one site in the dedicated Chrome, opened when there is none. One Chrome, one tab per site.
export async function getPage(site: Site): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; close the Flow Music Chrome window and try again.");
  const host = site === "flow" ? FLOW_HOST : MUSIC_HOST;
  const existing = context.pages().find((p) => host.test(p.url()));
  if (existing) {
    if (site === "flow") await ensureEnglish(existing);
    return existing;
  }
  const page = await context.newPage();
  await page.goto(site === "flow" ? inEnglish(FLOW_URL) : MUSIC_URL, { waitUntil: "domcontentloaded" });
  if (site === "flow") await ensureEnglish(page);
  return page;
}

// The Flow Music tab of the dedicated Chrome, opened when there is none.
export function getMusicPage(): Promise<Page> {
  return getPage("music");
}

// One action at a time per site: Flow must not block Music and the other way round, but two actions on one tab would
// click over each other.
const chains: Record<Site, Promise<unknown>> = { flow: Promise.resolve(), music: Promise.resolve() };
export function withSitePage<T>(site: Site, fn: (page: Page) => Promise<T>): Promise<T> {
  const run = chains[site].then(async () => fn(await getPage(site)));
  chains[site] = run.catch(() => {});
  return run;
}

// Playwright's errors when the tab, its context or Chrome went away under a running action.
const CLOSED = /(page|context|browser|target).{0,40}has been closed|target closed|browser has been disconnected|browser.{0,20}disconnected/i;

// For a job runner's catch: a closed-window error becomes a clear message, any other error is returned unchanged.
export function closedWindowError(site: Site, err: unknown): unknown {
  const text = err instanceof Error ? err.message : String(err);
  if (!CLOSED.test(text)) return err;
  const name = site === "flow" ? "Flow" : "Flow Music";
  return new Error(
    `The ${name} window was closed (or Chrome quit) while the job ran. It reopens on the next call; check the site before retrying, the generation may have finished there.`,
  );
}

// Downloads of both sites share ~/.flow-music-mcp/downloads and Chrome's browser-wide download setting, and each one
// waits for "a new file" there: never two at once, across sites too, or one site could take the other's file.
let downloadChain: Promise<unknown> = Promise.resolve();
export function withDownloadLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = downloadChain.then(fn);
  downloadChain = run.catch(() => {});
  return run;
}
