// Pure helpers for flow_assemble's timeline (FMM-12): clip times, music cues, ducking and the ffmpeg filter graph.
// No fs, env or process imports, so tests can load it. assemble.ts probes the files and runs ffmpeg.

// ---- Clip specs ----
export type ClipSpec = string | { file: string; from?: number; to?: number } | { image: string; seconds: number; zoom?: boolean | number };

export interface PlacedClip {
  kind: "video" | "still";
  file: string;
  from: number; // video: where the cut starts in the source, seconds
  seconds: number; // how long it plays in the film
  hasAudio: boolean;
  zoom: number; // still: end scale of a slow zoom-in (1 = none)
}

export const DEFAULT_ZOOM = 1.1;

export const isStill = (c: ClipSpec): c is { image: string; seconds: number; zoom?: boolean | number } => typeof c === "object" && "image" in c;

// The file a spec refers to (a path, a trimmed video's file, or a still's image).
export const specFile = (c: ClipSpec): string => (typeof c === "string" ? c : isStill(c) ? c.image : c.file);

// A still's zoom option as an end scale: false/undefined -> 1, true -> 1.1, a number is the end scale (at least 1).
export function zoomScale(zoom: boolean | number | undefined): number {
  if (zoom === undefined || zoom === false) return 1;
  if (zoom === true) return DEFAULT_ZOOM;
  return Math.max(1, Math.min(2, zoom));
}

// How long a video clip plays once cut: from (default 0) to `to` (default the source's end, and never past it).
export function trimmedSeconds(spec: { from?: number; to?: number }, sourceDuration: number, label = "clip"): { from: number; seconds: number } {
  const from = Math.max(0, spec.from ?? 0);
  if (from >= sourceDuration - 0.05) throw new Error(`${label}: "from" (${from} s) is at or past the end of the video (${sourceDuration.toFixed(2)} s).`);
  const to = spec.to === undefined ? sourceDuration : Math.min(spec.to, sourceDuration);
  if (to <= from + 0.04) throw new Error(`${label}: "to" (${spec.to} s) must be later than "from" (${from} s).`);
  return { from, seconds: to - from };
}

// Where each clip starts in the film.
export function timelineOf(clips: { file: string; seconds: number }[]): { index: number; file: string; at: number; seconds: number }[] {
  let at = 0;
  return clips.map((c, index) => {
    const row = { index, file: c.file, at: Number(at.toFixed(3)), seconds: Number(c.seconds.toFixed(3)) };
    at += c.seconds;
    return row;
  });
}

// ---- Music cues ----
export interface MusicCue {
  file: string;
  at: number;
  until?: number;
  volume?: number;
  fade_in?: number;
  fade_out?: number;
}

export interface CuePlan {
  file: string;
  at: number;
  seconds: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

export const DEFAULT_FADE_IN = 1.5;
export const DEFAULT_FADE_OUT = 2;

// A cue's playing window inside a film of `filmSeconds`: starts at `at`, runs to `until` (default the film's end, never past it).
export function planCue(cue: MusicCue, filmSeconds: number, defaultVolume: number, label = "music cue"): CuePlan {
  const at = Math.max(0, cue.at);
  if (at >= filmSeconds - 0.05) throw new Error(`${label}: "at" (${at} s) is at or past the end of the film (${filmSeconds.toFixed(2)} s).`);
  const end = cue.until === undefined ? filmSeconds : Math.min(cue.until, filmSeconds);
  if (end <= at + 0.05) throw new Error(`${label}: "until" (${cue.until} s) must be later than "at" (${at} s).`);
  const seconds = end - at;
  let fadeIn = Math.max(0, cue.fade_in ?? DEFAULT_FADE_IN);
  let fadeOut = Math.max(0, cue.fade_out ?? DEFAULT_FADE_OUT);
  // Fades never overlap: a cue shorter than both fades shrinks them in proportion.
  if (fadeIn + fadeOut > seconds) {
    const k = seconds / (fadeIn + fadeOut);
    fadeIn *= k;
    fadeOut *= k;
  }
  return { file: cue.file, at, seconds, volume: cue.volume ?? defaultVolume, fadeIn, fadeOut };
}

const t3 = (n: number) => n.toFixed(3);

// One cue as a filter: the (looped) input is cut to its length, faded, levelled and delayed to its start.
export function cueFilter(input: number, c: CuePlan, label: string): string {
  const ms = Math.round(c.at * 1000);
  return (
    `[${input}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${t3(c.seconds)},asetpts=PTS-STARTPTS` +
    (c.fadeIn > 0.001 ? `,afade=t=in:st=0:d=${t3(c.fadeIn)}` : "") +
    (c.fadeOut > 0.001 ? `,afade=t=out:st=${t3(Math.max(0, c.seconds - c.fadeOut))}:d=${t3(c.fadeOut)}` : "") +
    `,volume=${c.volume},adelay=${ms}|${ms}[${label}]`
  );
}

// ---- The graph ----
export interface GraphInput {
  clips: PlacedClip[];
  width: number;
  height: number;
  clipVolume: number;
  hold: number; // seconds the last frame is held (a voiceover longer than the footage)
  cues: CuePlan[];
  voiceover?: string;
  duck: boolean;
}

export interface Graph {
  inputArgs: string[];
  filters: string[];
  filmSeconds: number;
}

export const DUCK_FILTER = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500";

const FPS = 24;

// Input order: clips, then cues, then the voiceover. Output labels: [v] picture, [a] sound.
export function buildGraph(g: GraphInput): Graph {
  const inputArgs: string[] = [];
  const filters: string[] = [];
  const last = g.clips.length - 1;
  const total = g.clips.reduce((s, c) => s + c.seconds, 0) + g.hold;
  const scale = `scale=${g.width}:${g.height}:force_original_aspect_ratio=decrease,pad=${g.width}:${g.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  g.clips.forEach((c, i) => {
    const holdHere = g.hold > 0.05 && i === last;
    const freeze = holdHere ? `,tpad=stop_mode=clone:stop_duration=${g.hold.toFixed(2)}` : "";
    const seconds = c.seconds + (holdHere ? g.hold : 0);
    if (c.kind === "still") {
      inputArgs.push("-loop", "1", "-framerate", String(FPS), "-t", t3(c.seconds), "-i", c.file);
      const frames = Math.max(1, Math.round(c.seconds * FPS));
      const zoom = c.zoom > 1.0001 ? `,zoompan=z='1+${(c.zoom - 1).toFixed(4)}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${g.width}x${g.height}:fps=${FPS}` : "";
      filters.push(`[${i}:v]${scale}${zoom},fps=${FPS}${freeze}[v${i}]`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${t3(seconds)}[a${i}]`);
      return;
    }
    inputArgs.push("-i", c.file);
    const cut = c.from > 0.001 ? `trim=start=${t3(c.from)}:duration=${t3(c.seconds)},setpts=PTS-STARTPTS,` : `trim=duration=${t3(c.seconds)},setpts=PTS-STARTPTS,`;
    filters.push(`[${i}:v]${cut}${scale},fps=${FPS}${freeze}[v${i}]`);
    filters.push(
      c.hasAudio
        ? `[${i}:a]atrim=start=${t3(c.from)}:duration=${t3(c.seconds)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${g.clipVolume}${holdHere ? `,apad=pad_dur=${g.hold.toFixed(2)}` : ""}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${t3(seconds)}[a${i}]`,
    );
  });
  filters.push(`${g.clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${g.clips.length}:v=1:a=1[v][clipaudio]`);

  let input = g.clips.length;
  const mix = ["[clipaudio]"];
  const cueLabels: string[] = [];
  g.cues.forEach((c, k) => {
    inputArgs.push("-stream_loop", "-1", "-i", c.file);
    filters.push(cueFilter(input, c, `cue${k}`));
    cueLabels.push(`[cue${k}]`);
    input++;
  });
  let musicBus: string | undefined;
  if (cueLabels.length === 1) musicBus = cueLabels[0];
  else if (cueLabels.length > 1) {
    filters.push(`${cueLabels.join("")}amix=inputs=${cueLabels.length}:duration=longest:dropout_transition=0:normalize=0[music]`);
    musicBus = "[music]";
  }
  let voice: string | undefined;
  if (g.voiceover) {
    inputArgs.push("-i", g.voiceover);
    filters.push(`[${input}:a]aresample=48000,aformat=channel_layouts=stereo[vo]`);
    voice = "[vo]";
  }
  if (musicBus && voice && g.duck) {
    // The voice both plays and keys the compressor, so it is split; the music dips while someone speaks.
    filters.push(`[vo]asplit=2[vo_play][vo_raw];[vo_raw]apad[vo_key]`);
    filters.push(`${musicBus}[vo_key]${DUCK_FILTER}[ducked]`);
    mix.push("[ducked]", "[vo_play]");
  } else {
    if (musicBus) mix.push(musicBus);
    if (voice) mix.push(voice);
  }
  filters.push(mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[a]` : "[clipaudio]anull[a]");
  return { inputArgs, filters, filmSeconds: total };
}
