// The Gemini (Google AI Studio) key. Lookup order: env GEMINI_API_KEY, ~/.flow-music-mcp/gemini-key, then the older
// ~/.flow-mcp/gemini-key (flow-mcp's file). The key is never printed, logged or returned: only its last 4 characters.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import "../env.js";
import { HOME_DIR } from "../chrome.js";

const OWN_FILE = () => join(HOME_DIR, "gemini-key");
const LEGACY_FILE = () => join(homedir(), ".flow-mcp", "gemini-key");

// A key is one unbroken run of characters (AI Studio keys start "AIza", newer ones "AQ"). Anything shorter or still
// holding template text is not a key.
const plausible = (raw: string): string | undefined => {
  const key = raw.trim();
  if (!key || key.length < 20 || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) return undefined;
  return key;
};

function find(): { key: string; source: string } | undefined {
  const env = plausible(process.env.GEMINI_API_KEY ?? "");
  if (env) return { key: env, source: "GEMINI_API_KEY (environment or .env)" };
  for (const file of [OWN_FILE(), LEGACY_FILE()]) {
    if (!existsSync(file)) continue;
    const key = plausible(readFileSync(file, "utf8"));
    if (key) return { key, source: file };
  }
  return undefined;
}

export const geminiKey = (): string | undefined => find()?.key;

export function keyStatus(): { ready: boolean; source?: string; last4?: string } {
  const f = find();
  return f ? { ready: true, source: f.source, last4: f.key.slice(-4) } : { ready: false };
}

// Saves a key to ~/.flow-music-mcp/gemini-key. It is checked with Google BEFORE anything is written, so a mistyped or
// placeholder key can never replace one that works. The check lists models (no text-to-speech quota is spent).
export async function setGeminiKey(raw: string): Promise<{ saved: true; file: string; last4: string }> {
  const key = raw.trim();
  if (!/^[A-Za-z0-9._~+/=-]{20,512}$/.test(key) || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) {
    throw new Error("That doesn't look like a Google AI Studio key. Copy the whole key from aistudio.google.com/apikey, with no spaces.");
  }
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key } }).catch(() => null);
  if (!res) throw new Error("Couldn't reach Google to check the key. Check the internet connection and try again.");
  if (!res.ok) throw new Error("Google didn't accept that key. Copy it again from aistudio.google.com/apikey. Your previous key, if any, is unchanged.");
  const file = OWN_FILE();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file lives in the user's profile folder.
  }
  return { saved: true, file, last4: key.slice(-4) };
}
