import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { FFMPEG_HINT } from "./platform.js";

// Ported from flow-mcp (github.com/GTAI-1/flow-mcp), chain.ts.
const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MUSIC_MCP_FFMPEG ?? "ffmpeg";

// Saves the final frame of a clip so the next scene can start exactly where this one ended.
export async function extractLastFrame(video: string): Promise<string> {
  const out = video.replace(/\.\w+$/, "") + "-lastframe.jpg";
  try {
    await run(FFMPEG, ["-y", "-sseof", "-0.2", "-i", video, "-update", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`chain_previous needs ffmpeg to grab the previous clip's last frame: ${reason}`);
  }
  return out;
}

// The sound of a clip as an .m4a (flow_narrate engine "flow": a Flow voice only speaks inside a video take).
export async function extractAudio(video: string, target: string): Promise<string> {
  mkdirSync(dirname(target), { recursive: true });
  try {
    await run(FFMPEG, ["-y", "-i", video, "-vn", "-c:a", "aac", "-b:a", "192k", target]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err).slice(0, 300);
    throw new Error(`Could not extract the take's sound: ${reason}`);
  }
  return target;
}
