import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Settings and keys from .env files, so they can be set by hand in a text editor (no tool, no assistant): first the
// repo's own .env (next to package.json), then ~/.flow-music-mcp/.env, which survives a fresh clone. A variable that is
// already set in the real environment wins, then the first file that sets it (Node's process.loadEnvFile never
// overwrites). See .env.example for every setting. Imported first by index.ts, before anything reads process.env.

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
export const ENV_FILES = [join(REPO_DIR, ".env"), join(HOME, ".env")];
export const loadedEnvFiles: string[] = [];

for (const file of ENV_FILES) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
    loadedEnvFiles.push(file);
  } catch (err) {
    process.stderr.write(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
