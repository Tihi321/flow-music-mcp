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
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  return browser;
}

// The Flow Music tab of the dedicated Chrome, opened when there is none.
export async function getMusicPage(): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; close the Flow Music Chrome window and try again.");
  const existing = context.pages().find((p) => MUSIC_HOST.test(p.url()));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(MUSIC_URL, { waitUntil: "domcontentloaded" });
  return page;
}
