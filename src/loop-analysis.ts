// Loop-point search on decoded audio. No imports and no I/O, so tests can run it on synthetic signals.
//
// The idea: a loop plays audio[start..end) over and over, so at the seam the audio after `end` must look like the audio
// after `start`, and the audio before `end` like the audio before `start`. Each short frame gets a vector of band levels
// in dB; a (start, end) pair is scored by the mean absolute dB difference over a window on both sides of the two points
// (lower is better). The best pair at least `minSeconds` apart, outside the fade-in and the fade-out, wins, and the end
// point is then nudged by up to one frame so the two waveforms line up (cross-correlation).

export const FRAME = 2048; // samples per analysis frame (no overlap): 93 ms at 22.05 kHz
const BANDS = 16;
const FLOOR_DB = -90;
const LENGTH_COST_DB_PER_S = 0.01;

export interface LoopOptions {
  sampleRate: number;
  minSeconds: number;
  // Seconds of audio that must exist before `start` for the crossfade (default 1.5).
  crossfadeSeconds?: number;
  // Seconds on each side of a point that must match (default 1.5).
  contextSeconds?: number;
}

export interface LoopPoints {
  startSample: number;
  endSample: number;
  // Mean absolute band-level difference around the seam, in dB (0 = identical). Lower is better.
  distanceDb: number;
  // 1 = identical, 0 = 12 dB or more apart.
  score: number;
  // Frames of the usable (steady) part, for reporting.
  usableFromSample: number;
  usableToSample: number;
}

// In-place radix-2 FFT of `re`/`im` (length a power of two).
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// Frame i covers samples [i*FRAME, (i+1)*FRAME). Features are `BANDS` log-spaced band levels in dB (60 Hz to 10 kHz).
export function frameFeatures(x: Float32Array, sampleRate: number): { features: Float32Array; rms: Float32Array; frames: number } {
  const frames = Math.floor(x.length / FRAME);
  const features = new Float32Array(frames * BANDS);
  const rms = new Float32Array(frames);
  const hann = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const hi = Math.min(10_000, sampleRate / 2 - 1);
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.min(FRAME / 2, Math.max(1, Math.round(((60 * (hi / 60) ** (b / BANDS)) * FRAME) / sampleRate))));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const v = x[f * FRAME + i]!;
      sum += v * v;
      re[i] = v * hann[i]!;
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sum / FRAME);
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      const lo = edges[b]!;
      const up = Math.max(lo + 1, edges[b + 1]!);
      let e = 0;
      for (let k = lo; k < up; k++) e += re[k]! * re[k]! + im[k]! * im[k]!;
      e /= (up - lo) * FRAME * FRAME * 0.375; // per bin, scaled so a full-scale sine sits near 0 dB
      features[f * BANDS + b] = Math.max(FLOOR_DB, 10 * Math.log10(e + 1e-12));
    }
  }
  return { features, rms, frames };
}

// The steady part of a track: from the first frame whose (smoothed) level reaches `ratio` of the median level to the last
// such frame. A fade-in or intro swell starts the track below it; a fade-out tail ends below it. Frame indexes, [from, to).
export function steadyRange(rms: Float32Array, ratio = 0.5): { from: number; to: number } {
  const n = rms.length;
  if (n === 0) return { from: 0, to: 0 };
  const sm = new Float32Array(n);
  const r = 2;
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++, c++) s += rms[j]!;
    sm[i] = s / c;
  }
  const median = [...sm].sort((a, b) => a - b)[Math.floor(n / 2)]!;
  const limit = median * ratio;
  let from = 0;
  while (from < n && sm[from]! < limit) from++;
  let to = n;
  while (to > from && sm[to - 1]! < limit) to--;
  return { from, to };
}

export function findLoop(x: Float32Array, o: LoopOptions): LoopPoints {
  const { features, rms, frames } = frameFeatures(x, o.sampleRate);
  const cf = Math.ceil(((o.crossfadeSeconds ?? 1.5) * o.sampleRate) / FRAME);
  const W = Math.max(2, Math.round(((o.contextSeconds ?? 1.5) * o.sampleRate) / FRAME));
  const minFrames = Math.ceil((o.minSeconds * o.sampleRate) / FRAME);
  const steady = steadyRange(rms);
  // A point needs W frames of context on both sides inside the steady part; the start also needs the crossfade before it.
  const sLo = Math.max(steady.from + W, cf);
  const eHi = steady.to - W;
  if (eHi - sLo < minFrames) {
    throw new Error(
      `The usable part of this track (${(((steady.to - steady.from) * FRAME) / o.sampleRate).toFixed(1)} s after the fade-in and before the fade-out) is too short for a loop of at least ${o.minSeconds} s with a ${o.crossfadeSeconds ?? 1.5} s crossfade. Lower min_seconds or crossfade_ms.`,
    );
  }
  const span = 2 * W;
  const total = span * BANDS;
  // Cost = band difference plus a small charge per second beyond the minimum, so of two equally good seams the shorter wins.
  const perFrame = (LENGTH_COST_DB_PER_S * FRAME) / o.sampleRate;
  let bestCost = Infinity;
  let best = Infinity;
  let bs = -1;
  let be = -1;
  for (let s = sLo; s + minFrames <= eHi; s++) {
    const sBase = (s - W) * BANDS;
    for (let e = s + minFrames; e <= eHi; e++) {
      const pen = (e - s - minFrames) * perFrame;
      if (pen >= bestCost) break;
      const eBase = (e - W) * BANDS;
      let sum = 0;
      const stop = (bestCost - pen) * total;
      for (let k = 0; k < total; k++) {
        sum += Math.abs(features[sBase + k]! - features[eBase + k]!);
        if (sum >= stop) break;
      }
      if (sum < stop) {
        best = sum / total;
        bestCost = best + pen;
        bs = s;
        be = e;
      }
    }
  }
  if (bs < 0) throw new Error("No loop points found.");

  const startSample = bs * FRAME;
  const endSample = refineEnd(x, startSample, be * FRAME, FRAME, o.minSeconds * o.sampleRate);
  return {
    startSample,
    endSample,
    distanceDb: best,
    score: Math.max(0, Math.min(1, 1 - best / 12)),
    usableFromSample: steady.from * FRAME,
    usableToSample: steady.to * FRAME,
  };
}

// Moves the end point by up to `reach` samples so the waveform after it lines up with the waveform after the start
// (normalised cross-correlation over `win` samples on both sides). The loop never gets shorter than `minLength`.
export function refineEnd(x: Float32Array, start: number, end: number, reach: number, minLength: number, win = 2048): number {
  let bestD = 0;
  let bestC = -Infinity;
  const ref = (i: number) => x[start + i] ?? 0;
  for (let d = -reach; d <= reach; d += 1) {
    const e = end + d;
    if (e - start < minLength || e + win > x.length || e - win < 0 || start - win < 0) continue;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = -win; i < win; i += 2) {
      const a = ref(i);
      const b = x[e + i]!;
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    const c = dot / (Math.sqrt(na * nb) + 1e-12);
    if (c > bestC) {
      bestC = c;
      bestD = d;
    }
  }
  return end + bestD;
}

export interface SeamMetrics {
  // RMS level change across the seam (50 ms before vs 50 ms after), in dB.
  seamJumpDb: number;
  // The 95th percentile of the same change between neighbouring 50 ms windows inside the loop: what is normal for it.
  typicalJumpDb: number;
  // Largest sample-to-sample step at the seam versus the 99.9th percentile of steps elsewhere (>1 means a click).
  clickRatio: number;
  // seamJumpDb <= max(typicalJumpDb, 1.5) and clickRatio <= 1.5.
  clean: boolean;
}

// How well `loop` (one pass) repeats: the seam is where it ends and starts again (the file played back to back).
export function seamMetrics(loop: Float32Array, sampleRate: number): SeamMetrics {
  const w = Math.max(16, Math.round(sampleRate * 0.05));
  const rmsOf = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += loop[i]! * loop[i]!;
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const db = (a: number, b: number) => Math.abs(20 * Math.log10((a + 1e-9) / (b + 1e-9)));
  const n = loop.length;
  if (n < w * 8) throw new Error("The loop is too short to check.");
  const seamJumpDb = db(rmsOf(n - w, n), rmsOf(0, w));
  const jumps: number[] = [];
  for (let i = 0; i + 2 * w <= n; i += w) jumps.push(db(rmsOf(i, i + w), rmsOf(i + w, i + 2 * w)));
  jumps.sort((a, b) => a - b);
  const typicalJumpDb = jumps[Math.floor(jumps.length * 0.95)] ?? 0;
  const steps: number[] = [];
  for (let i = 1; i < n; i++) steps.push(Math.abs(loop[i]! - loop[i - 1]!));
  const seamStep = Math.abs(loop[0]! - loop[n - 1]!);
  const sorted = steps.sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.999)] ?? 0;
  const clickRatio = seamStep / (ref + 1e-9);
  return { seamJumpDb, typicalJumpDb, clickRatio, clean: seamJumpDb <= Math.max(typicalJumpDb, 1.5) && clickRatio <= 1.5 };
}
