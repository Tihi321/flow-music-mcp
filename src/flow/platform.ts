// Ported from flow-mcp (github.com/GTAI-1/flow-mcp), platform.ts - the Windows helpers only (the macOS and Linux
// branches are dropped: this server targets Windows).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const IS_WIN = process.platform === "win32";
export const COMPUTER = IS_WIN ? "this PC" : "this computer";
export const BIN = IS_WIN ? "the Recycle Bin" : "the Trash";
export const FFMPEG_HINT = IS_WIN ? "winget install Gyan.FFmpeg" : "install ffmpeg so it is on your PATH";

// PowerShell single-quoted string: the only character that needs escaping is the quote itself.
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function powershell(script: string, timeout = 120_000): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

// Puts a file or folder in the Recycle Bin so it can be restored. Never deletes anything outright.
export function moveToBin(target: string): string {
  const kind = statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
  powershell(`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`);
  return BIN;
}

// Unpacks a ZIP with the system's own tools (tar is bsdtar on Windows 10+). Returns every file inside.
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dest);
  return files;
}
