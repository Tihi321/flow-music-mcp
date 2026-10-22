import { describe, expect, it } from "vitest";
import { findLoop, frameFeatures, seamMetrics, steadyRange, FRAME } from "../src/loop-analysis.js";

const SR = 22_050;

// A pattern of 8 notes (0.5 s each, a different pitch each) that repeats every 4 s, with a fade-in and a fade-out and a
// little deterministic noise. The true loop length is 4 s or any multiple of it.
function pattern(seconds: number, fadeIn = 2, fadeOut = 3): Float32Array {
  const notes = [220, 330, 262, 440, 294, 392, 247, 349];
  const x = new Float32Array(Math.floor(seconds * SR));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const note = Math.floor((t % 4) / 0.5);
    const f = notes[note]!;
    const inNote = (t % 0.5) / 0.5;
    const env = Math.exp(-2 * inNote);
    let a = 0.5 * env * Math.sin(2 * Math.PI * f * t) + 0.2 * env * Math.sin(2 * Math.PI * f * 2 * t) + 0.02 * rnd();
    if (t < fadeIn) a *= t / fadeIn;
    if (t > seconds - fadeOut) a *= Math.max(0, (seconds - t) / fadeOut);
    x[i] = a;
  }
  return x;
}

describe("steadyRange", () => {
  it("skips a fade-in and a fade-out", () => {
    const x = pattern(40);
    const { rms, frames } = frameFeatures(x, SR);
    const r = steadyRange(rms);
    const from = (r.from * FRAME) / SR;
    const to = (r.to * FRAME) / SR;
    expect(from).toBeGreaterThan(0.5);
    expect(from).toBeLessThan(3.5);
    expect(to).toBeGreaterThan(34);
    expect(to).toBeLessThan(39);
    expect(frames).toBe(Math.floor(x.length / FRAME));
  });
  it("is empty for no audio", () => {
    expect(steadyRange(new Float32Array(0))).toEqual({ from: 0, to: 0 });
  });
});

describe("findLoop", () => {
  it("finds a loop length that is a multiple of the repeat period", () => {
    const x = pattern(40);
    const r = findLoop(x, { sampleRate: SR, minSeconds: 8 });
    const len = (r.endSample - r.startSample) / SR;
    expect(len).toBeGreaterThanOrEqual(8 - 0.01);
    const off = len / 4 - Math.round(len / 4);
    expect(Math.abs(off) * 4, `loop length ${len}`).toBeLessThan(0.05);
    expect(r.distanceDb).toBeLessThan(3);
    expect(r.score).toBeGreaterThan(0.7);
    // never inside the fade-in or past the fade-out
    expect(r.startSample).toBeGreaterThanOrEqual(r.usableFromSample);
    expect(r.endSample).toBeLessThanOrEqual(r.usableToSample);
  });

  it("scores a repeating track better than one that never repeats", () => {
    const repeating = findLoop(pattern(40), { sampleRate: SR, minSeconds: 8 });
    // The same notes in a pitch order that changes every pass: the sound never repeats.
    const x = new Float32Array(40 * SR);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 80; n++) {
      const f = 150 + Math.floor(rnd() * 900);
      for (let i = 0; i < SR / 2; i++) x[n * (SR / 2) + i] = 0.4 * Math.exp((-2 * i) / (SR / 2)) * Math.sin((2 * Math.PI * f * i) / SR) + 0.02 * (rnd() - 0.5);
    }
    const random = findLoop(x, { sampleRate: SR, minSeconds: 8 });
    expect(random.distanceDb).toBeGreaterThan(repeating.distanceDb * 1.5);
  });

  it("prefers the shorter loop when the seams are equally good", () => {
    const r = findLoop(pattern(60), { sampleRate: SR, minSeconds: 6 });
    expect((r.endSample - r.startSample) / SR).toBeLessThan(10.5);
  });

  it("says so when the track is too short", () => {
    expect(() => findLoop(pattern(12, 1, 1), { sampleRate: SR, minSeconds: 20 })).toThrow(/too short/);
  });
});

describe("seamMetrics", () => {
  const sine = (hz: number, seconds: number, phase = 0) => {
    const x = new Float32Array(Math.floor(seconds * SR));
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(phase + (2 * Math.PI * hz * i) / SR);
    return x;
  };

  it("calls a loop of whole sine cycles clean", () => {
    // 100 Hz for exactly 2 s is 200 cycles: the end meets the start without a step.
    const m = seamMetrics(sine(100, 2), SR);
    expect(m.seamJumpDb).toBeLessThan(0.5);
    expect(m.clean).toBe(true);
  });

  it("flags a level jump and a click at the seam", () => {
    const x = sine(100, 2);
    for (let i = x.length - SR / 2; i < x.length; i++) x[i] = (x[i] ?? 0) * 0.05; // quiet end, loud start
    const m = seamMetrics(x, SR);
    expect(m.seamJumpDb).toBeGreaterThan(10);
    expect(m.clean).toBe(false);
    const y = sine(100, 2);
    for (let i = y.length - 5; i < y.length; i++) y[i] = 0.9; // a step at the seam only
    expect(seamMetrics(y, SR).clickRatio).toBeGreaterThan(1.5);
  });

  it("refuses a loop that is too short", () => {
    expect(() => seamMetrics(new Float32Array(100), SR)).toThrow(/too short/);
  });
});
