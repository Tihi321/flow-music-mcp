// Ported from flow-mcp (github.com/GTAI-1/flow-mcp), assemble.ts (the macOS `say` voice code is replaced by voices.ts)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { FFMPEG_HINT } from "./platform.js";
import { type ClipSpec, type MusicCue, type PlacedClip, buildGraph, isStill, planCue, specFile, timelineOf, trimmedSeconds, zoomScale } from "./timeline-pure.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MUSIC_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MUSIC_MCP_FFPROBE ?? "ffprobe";

export interface AssembleOptions {
  dir: string;
  clips?: ClipSpec[];
  music?: string;
  music_cues?: MusicCue[];
  duck?: boolean;
  music_volume: number;
  clip_volume?: number;
  voiceover?: string;
  output_name: string;
  hold_last_frame?: boolean;
}

interface ClipInfo {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

async function probe(file: string, still = false): Promise<ClipInfo> {
  // A raw ffprobe dump ("moov atom not found") told the user nothing. Say which file and what to do about it.
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]).catch(() => {
    throw new Error(`"${basename(file)}" isn't a playable video or picture - it may be an unfinished download or a ZIP of several clips. Remove it, or pick other clips.`);
  });
  const data = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`${file} has no video stream.`);
  return {
    width: video.width,
    height: video.height,
    duration: still ? 0 : Number(data.format.duration),
    hasAudio: !still && data.streams.some((s) => s.codec_type === "audio"),
  };
}

// Clips are normally scene-NN.mp4, but a film can also be cut from clips pulled out of Flow (clip-NN) or restyled
// ones (edit-NN). Narration takes and previously assembled films are never treated as footage.
function defaultClips(dir: string): string[] {
  if (!existsSync(dir)) {
    throw new Error(`There's no "${basename(dir)}" folder in your films yet. Add clips with "Upload a video" or "From my films", or type the name of a folder that already has clips in it.`);
  }
  const files = readdirSync(dir).filter((f) => /\.mp4$/i.test(f) && !/^narration-/i.test(f));
  const numbered = new Map<string, string>();
  for (const f of files.sort()) {
    const key = f.match(/^((?:scene|clip|edit)-\d+)(-v\d+)?\.mp4$/i)?.[1];
    if (key && !numbered.has(key)) numbered.set(key, join(dir, f));
  }
  if (numbered.size) return [...numbered.values()];
  // Nothing follows the naming scheme: fall back to every other mp4, oldest first, so a hand-named clip still works.
  return files
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map((x) => join(dir, x.f));
}

// Pulls the spoken track out of a generated clip so Flow's voices can be used as narration.
export async function extractAudio(video: string, target: string): Promise<{ output: string; duration: number }> {
  await run(FFMPEG, ["-y", "-i", video, "-vn", "-af", "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target]);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return { output: target, duration: Number(stdout.trim()) };
}

export interface VoiceLine {
  file: string;
  from?: number;
  to?: number;
  at: number;
  max_seconds?: number;
}

// Builds one voiceover track from separate lines, each cut from a take (audio or video, from..to), placed at its own
// moment in the film, and sped up slightly (at most 1.25x) when it would overrun max_seconds. Flow speaks a whole
// take at its own pace and cannot time a word to an on-screen title, so the timing is done here instead: 2026-10-12,
// a narration in the user's own Flow voice had to land each line on the kinetic text it describes.
export async function voiceTrack(lines: VoiceLine[], out: string): Promise<{ file: string; lines: { at: number; seconds: number; speed: number }[]; warnings: string[] }> {
  if (!lines.length) throw new Error("No voice lines given.");
  const work = mkdtempSync(join(tmpdir(), "flow-voice-"));
  try {
    // Pass 1: cut each line and trim the silence at both ends, so a line is only sped up when the SPEECH is too long.
    // On the first real run a cut kept 0.4 s of room tone after "Blender", was pushed to the 1.25x limit and still ran
    // into the next line.
    const quiet = (keep: number) => `silenceremove=start_periods=1:start_threshold=-42dB:start_silence=${keep}`;
    const cuts: { file: string; seconds: number }[] = [];
    for (const [i, l] of lines.entries()) {
      if (!existsSync(l.file)) throw new Error(`File not found: ${l.file}`);
      const from = Math.max(0, l.from ?? 0);
      const trim = `atrim=start=${from.toFixed(3)}${l.to !== undefined ? `:end=${l.to.toFixed(3)}` : ""}`;
      const cut = join(work, `line-${i + 1}.wav`);
      await run(FFMPEG, ["-v", "error", "-y", "-i", l.file, "-vn", "-af", `${trim},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${quiet(0.04)},areverse,${quiet(0.08)},areverse`, "-c:a", "pcm_s16le", cut]).catch(
        (err: NodeJS.ErrnoException & { stderr?: string }) => {
          throw new Error(err.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `Could not cut voice line ${i + 1}: ${(err.stderr ?? String(err)).slice(-300)}`);
        },
      );
      const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cut]);
      const seconds = Number(stdout.trim());
      if (!(seconds > 0.05)) throw new Error(`Voice line ${i + 1} has no speech in it (from ${from}${l.to !== undefined ? ` to ${l.to}` : ""}).`);
      cuts.push({ file: cut, seconds });
    }
    // Pass 2: speed each line to its slot only if it must, level it, and place it.
    const args: string[] = ["-y"];
    const filters: string[] = [];
    const placed: { at: number; seconds: number; speed: number }[] = [];
    for (const [i, l] of lines.entries()) {
      const speed = l.max_seconds && cuts[i]!.seconds > l.max_seconds ? Math.min(1.25, cuts[i]!.seconds / l.max_seconds) : 1;
      const seconds = cuts[i]!.seconds / speed;
      const delay = Math.round(Math.max(0, l.at) * 1000);
      args.push("-i", cuts[i]!.file);
      // Each line is levelled on its own: separate takes come back at different loudness.
      filters.push(
        `[${i}:a]${speed > 1.001 ? `atempo=${speed.toFixed(3)},` : ""}loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000` +
          `,afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, seconds - 0.04).toFixed(3)}:d=0.04,adelay=${delay}|${delay}[l${i}]`,
      );
      placed.push({ at: l.at, seconds: Number(seconds.toFixed(2)), speed: Number(speed.toFixed(3)) });
    }
    const warnings: string[] = [];
    placed.forEach((p, i) => {
      const next = placed[i + 1];
      if (next && p.at + p.seconds > next.at + 0.02) warnings.push(`Line ${i + 1} runs ${(p.at + p.seconds - next.at).toFixed(2)} s into line ${i + 2}.`);
      if (lines[i]!.max_seconds && p.seconds > lines[i]!.max_seconds! + 0.02) warnings.push(`Line ${i + 1} still needs ${p.seconds} s after speeding up as far as sounds natural (1.25x).`);
    });
    filters.push(lines.length > 1 ? `${lines.map((_, i) => `[l${i}]`).join("")}amix=inputs=${lines.length}:duration=longest:dropout_transition=0:normalize=0[a]` : "[l0]anull[a]");
    // Plain PCM: an AAC .m4a written from delayed, mixed lines came out unreadable ("Cannot calculate dts entry length"),
    // and this file is only a step on the way to the film.
    args.push("-filter_complex", filters.join(";"), "-map", "[a]", "-c:a", "pcm_s16le", out);
    try {
      await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg could not build the voice track: ${(e.stderr ?? String(e)).slice(-400)}`);
    }
    return { file: out, lines: placed, warnings };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface AssembledFilm {
  output: string;
  clips: string[];
  duration: number;
  held_last_frame: number;
  timeline: { index: number; file: string; at: number; seconds: number }[];
  music_cues?: { file: string; at: number; seconds: number; volume: number; fade_in: number; fade_out: number }[];
}

// Joins the clips (videos, trimmed videos and held stills) into one film, keeping their own sound and laying music cues /
// voiceover on top.
export async function assemble(o: AssembleOptions): Promise<AssembledFilm> {
  // Clips can now come from anywhere, so the project folder the film is saved into may not exist yet.
  if (o.clips?.length) mkdirSync(o.dir, { recursive: true });
  const out = join(o.dir, o.output_name.replace(/[^\w.-]+/g, "_").replace(/(\.mp4)?$/, ".mp4"));
  const specs: ClipSpec[] = (o.clips?.length ? o.clips : defaultClips(o.dir)).filter((c) => c !== out);
  if (!specs.length) throw new Error(`No clips found in ${o.dir}. Generate or download a clip first, or pass clips explicitly.`);
  const cueSpecs: MusicCue[] = o.music_cues?.length ? o.music_cues : o.music ? [{ file: o.music, at: 0, fade_in: 0, fade_out: 0, volume: o.music_volume }] : [];
  for (const f of [...specs.map(specFile), ...cueSpecs.map((c) => c.file), o.voiceover]) if (f && !existsSync(f)) throw new Error(`File not found: ${f}`);

  const infos = await Promise.all(specs.map((c) => probe(specFile(c), isStill(c))));
  const placed: PlacedClip[] = specs.map((c, i) => {
    const info = infos[i]!;
    if (isStill(c)) {
      if (!(c.seconds > 0)) throw new Error(`Clip ${i + 1}: a still needs seconds above 0.`);
      return { kind: "still", file: c.image, from: 0, seconds: c.seconds, hasAudio: false, zoom: zoomScale(c.zoom) };
    }
    const file = specFile(c);
    const trim = typeof c === "string" ? {} : c;
    const t = trimmedSeconds(trim, info.duration, `Clip ${i + 1} (${basename(file)})`);
    return { kind: "video", file, from: t.from, seconds: t.seconds, hasAudio: info.hasAudio, zoom: 1 };
  });
  const footage = placed.reduce((sum, c) => sum + c.seconds, 0);
  // A narration longer than the footage would be cut off, so the last frame is held until the voice finishes.
  let hold = 0;
  if (o.hold_last_frame !== false && o.voiceover) {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", o.voiceover]);
    hold = Math.max(0, Number(stdout.trim()) + 0.6 - footage);
  }
  // Size the film to the biggest clip so a 720p opener cannot pull a 1080p clip down with it. Even numbers for x264.
  const big = infos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
  const width = big.width - (big.width % 2);
  const height = big.height - (big.height % 2);
  const filmSeconds = footage + hold;
  const cues = cueSpecs.map((c, k) => planCue(c, filmSeconds, o.music_volume, `music_cues[${k}]`));
  // The clips' own sound used to play at full volume no matter what, drowning a narration laid on top. Music already
  // had its own level; the clips now do too.
  const clipVolume = Math.min(1, Math.max(0, o.clip_volume ?? 1));
  const graph = buildGraph({ clips: placed, width, height, clipVolume, hold, cues, voiceover: o.voiceover, duck: o.duck === true });

  const args = [
    "-y", ...graph.inputArgs,
    "-filter_complex", graph.filters.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    out,
  ];
  try {
    await run(FFMPEG, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg failed: ${(e.stderr ?? String(e)).slice(-600)}`);
  }
  return {
    output: out,
    clips: placed.map((c) => c.file),
    duration: filmSeconds,
    held_last_frame: Number(hold.toFixed(2)),
    timeline: timelineOf(placed),
    ...(cues.length ? { music_cues: cues.map((c) => ({ file: c.file, at: Number(c.at.toFixed(3)), seconds: Number(c.seconds.toFixed(3)), volume: c.volume, fade_in: Number(c.fadeIn.toFixed(3)), fade_out: Number(c.fadeOut.toFixed(3)) })) } : {}),
  };
}
