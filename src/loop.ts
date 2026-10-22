import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG_HINT } from "./flow/platform.js";
import { findLoop, seamMetrics, type SeamMetrics } from "./loop-analysis.js";

// music_loop: find a loop in a track and write it with its end crossfaded into its start. Local ffmpeg only, no browser.

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MUSIC_MCP_FFMPEG ?? "ffmpeg";
const SR = 22_050; // analysis rate

export interface LoopParams {
  input: string;
  output_dir: string;
  // File name without extension (default "<input name>-loop").
  stem?: string;
  min_seconds: number;
  crossfade_ms: number;
}

export interface LoopResult {
  file: string;
  loop_start_s: number;
  loop_end_s: number;
  loop_seconds: number;
  crossfade_ms: number;
  // 0-1, 1 = the audio around the two points is identical; distance_db is the mean band-level difference behind it.
  score: number;
  distance_db: number;
  steady_from_s: number;
  steady_to_s: number;
  seam: SeamMetrics;
}

const sec = (n: number) => Number(n.toFixed(3));

function ffmpegError(err: unknown, what: string): Error {
  const e = err as { code?: string; stderr?: string };
  return new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `${what}: ${(e.stderr ?? String(err)).slice(-400)}`);
}

// The file as mono float samples at 22.05 kHz.
async function decode(file: string): Promise<Float32Array> {
  try {
    const { stdout } = await run(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    const buf = stdout as Buffer;
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
  } catch (err) {
    throw ffmpegError(err, `ffmpeg could not read ${file}`);
  }
}

const CODEC: Record<string, string[]> = {
  ".wav": ["-c:a", "pcm_s16le"],
  ".mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
  ".m4a": ["-c:a", "aac", "-b:a", "192k"],
};

export async function makeLoop(p: LoopParams): Promise<LoopResult> {
  if (!existsSync(p.input)) throw new Error(`No such file: ${p.input}`);
  const ext = extname(p.input).toLowerCase();
  const codec = CODEC[ext];
  if (!codec) throw new Error(`music_loop writes .wav, .mp3 or .m4a and reads the same kind of file; got "${ext || p.input}".`);
  const x = await decode(p.input);
  const cf = p.crossfade_ms / 1000;
  const pts = findLoop(x, { sampleRate: SR, minSeconds: p.min_seconds, crossfadeSeconds: cf });
  const s = pts.startSample / SR;
  const e = pts.endSample / SR;

  // File = audio[s .. e-cf] then audio[e-cf .. e] fading out while audio[s-cf .. s] fades in. Played back to back, the
  // jump from the end to the start lands on audio[s] right after audio[s-cf .. s], so it is continuous.
  const t = (n: number) => n.toFixed(6);
  const filter =
    `[0:a]atrim=start=${t(s)}:end=${t(e - cf)},asetpts=PTS-STARTPTS[body];` +
    `[0:a]atrim=start=${t(e - cf)}:end=${t(e)},asetpts=PTS-STARTPTS[out];` +
    `[0:a]atrim=start=${t(s - cf)}:end=${t(s)},asetpts=PTS-STARTPTS[in];` +
    `[out][in]acrossfade=d=${t(cf)}:c1=qsin:c2=qsin[x];` +
    `[body][x]concat=n=2:v=0:a=1[a]`;
  mkdirSync(p.output_dir, { recursive: true });
  const file = join(p.output_dir, `${p.stem ?? `${basename(p.input, extname(p.input))}-loop`}${ext}`);
  if (file === p.input) throw new Error("The loop would overwrite the input file; pass a different name or out folder.");
  try {
    await run(FFMPEG, ["-v", "error", "-y", "-i", p.input, "-filter_complex", filter, "-map", "[a]", "-vn", ...codec, file], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    throw ffmpegError(err, "ffmpeg could not write the loop");
  }
  const seam = seamMetrics(await decode(file), SR);
  return {
    file,
    loop_start_s: sec(s),
    loop_end_s: sec(e),
    loop_seconds: sec(e - s),
    crossfade_ms: p.crossfade_ms,
    score: sec(pts.score),
    distance_db: sec(pts.distanceDb),
    steady_from_s: sec(pts.usableFromSample / SR),
    steady_to_s: sec(pts.usableToSample / SR),
    seam: { ...seam, seamJumpDb: sec(seam.seamJumpDb), typicalJumpDb: sec(seam.typicalJumpDb), clickRatio: sec(seam.clickRatio) },
  };
}
