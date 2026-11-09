import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Settings and keys from .env files, so they can be set by hand in a text editor (no tool, no assistant): first the
// repo's own .env (next to package.json), then ~/.flow-music-mcp/.env, which survives a fresh clone. A variable that is
// already set in the real environment wins, then the first file that sets it (Node's process.loadEnvFile never
// overwrites). See .env.example for every setting. Imported first by index.ts, before anything reads process.env.

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
export const ENV_FILES = [join(REPO_DIR, ".env"), join(HOME, ".env")];
export const loadedEnvFiles: string[] = [];
// The real environment as it was before any .env file was read, so a setting can tell where it came from ("env" or
// "file"; the ElevenLabs key status uses it).
export const presetEnv: Readonly<Record<string, string | undefined>> = { ...process.env };

for (const file of ENV_FILES) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
    loadedEnvFiles.push(file);
  } catch (err) {
    process.stderr.write(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// A key's value: the real environment first, then the first .env file that holds a usable one (`accept` returns the
// cleaned value, or undefined for empty or template text). Reading the files here, not process.env, means an empty
// `NAME=` copied from .env.example into the repo's .env cannot hide a real key in ~/.flow-music-mcp/.env. The value is
// never logged. `files` is for tests.
export function keyFromEnv(
  name: string,
  accept: (raw: string) => string | undefined,
  files: readonly string[] = ENV_FILES,
): { value: string; source: "env" | "file"; file?: string } | undefined {
  const env = accept(presetEnv[name] ?? "");
  if (env) return { value: env, source: "env" };
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const value = accept(parseEnv(readFileSync(file, "utf8"))[name] ?? "");
      if (value) return { value, source: "file", file };
    } catch {
      // An unreadable file is reported at start-up.
    }
  }
  return undefined;
}
