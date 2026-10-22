import { describe, expect, it } from "vitest";
import { type PlacedClip, buildGraph, isStill, planCue, specFile, timelineOf, trimmedSeconds, zoomScale } from "../src/flow/timeline-pure.js";

const video = (file: string, seconds: number, from = 0, hasAudio = true): PlacedClip => ({ kind: "video", file, from, seconds, hasAudio, zoom: 1 });
const still = (file: string, seconds: number, zoom = 1): PlacedClip => ({ kind: "still", file, from: 0, seconds, hasAudio: false, zoom });
const base = { width: 1280, height: 720, clipVolume: 1, hold: 0, cues: [], duck: false };

describe("clip specs", () => {
  it("tells paths, trims and stills apart", () => {
    expect(specFile("/a.mp4")).toBe("/a.mp4");
    expect(specFile({ file: "/b.mp4", from: 1 })).toBe("/b.mp4");
    expect(specFile({ image: "/c.png", seconds: 2 })).toBe("/c.png");
    expect(isStill({ image: "/c.png", seconds: 2 })).toBe(true);
    expect(isStill("/a.mp4")).toBe(false);
    expect(isStill({ file: "/b.mp4" })).toBe(false);
  });
  it("maps zoom to an end scale", () => {
    expect(zoomScale(undefined)).toBe(1);
    expect(zoomScale(false)).toBe(1);
    expect(zoomScale(true)).toBe(1.1);
    expect(zoomScale(1.3)).toBe(1.3);
    expect(zoomScale(5)).toBe(2);
  });
});

describe("trimmedSeconds", () => {
  it("keeps the whole video by default", () => {
    expect(trimmedSeconds({}, 8)).toEqual({ from: 0, seconds: 8 });
  });
  it("cuts from..to and clamps `to` to the source", () => {
    expect(trimmedSeconds({ from: 1, to: 3.5 }, 8)).toEqual({ from: 1, seconds: 2.5 });
    expect(trimmedSeconds({ from: 2, to: 99 }, 8)).toEqual({ from: 2, seconds: 6 });
    expect(trimmedSeconds({ to: 3 }, 8)).toEqual({ from: 0, seconds: 3 });
  });
  it("refuses a from past the end or a to before from", () => {
    expect(() => trimmedSeconds({ from: 8 }, 8, "Clip 2")).toThrow(/Clip 2.*from/);
    expect(() => trimmedSeconds({ from: 3, to: 2 }, 8)).toThrow(/"to"/);
  });
});

describe("timeline: still + trimmed clip + video", () => {
  it("places each clip at the sum of the ones before", () => {
    const t = timelineOf([
      { file: "title.png", seconds: 3 },
      { file: "a.mp4", seconds: 2.5 },
      { file: "b.mp4", seconds: 8 },
    ]);
    expect(t.map((r) => r.at)).toEqual([0, 3, 5.5]);
    expect(t.map((r) => r.seconds)).toEqual([3, 2.5, 8]);
    expect(t.map((r) => r.index)).toEqual([0, 1, 2]);
  });
  it("builds a graph with a looped still, a trim and a plain video", () => {
    const g = buildGraph({ ...base, clips: [still("/t.png", 3), video("/a.mp4", 2.5, 1), video("/b.mp4", 8, 0, false)] });
    expect(g.filmSeconds).toBeCloseTo(13.5);
    expect(g.inputArgs).toEqual(["-loop", "1", "-framerate", "24", "-t", "3.000", "-i", "/t.png", "-i", "/a.mp4", "-i", "/b.mp4"]);
    const f = g.filters.join(";");
    expect(f).toContain("[1:v]trim=start=1.000:duration=2.500");
    expect(f).toContain("[1:a]atrim=start=1.000:duration=2.500");
    expect(f).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=3.000[a0]");
    expect(f).toContain("anullsrc=r=48000:cl=stereo,atrim=duration=8.000[a2]");
    expect(f).toContain("concat=n=3:v=1:a=1[v][clipaudio]");
    expect(f).not.toContain("zoompan");
    expect(f).toMatch(/\[clipaudio\]anull\[a\]$/);
  });
  it("zooms a still when asked and holds the last frame", () => {
    const g = buildGraph({ ...base, hold: 1.5, clips: [still("/t.png", 2, 1.1)] });
    const f = g.filters.join(";");
    expect(f).toContain("zoompan=z='1+0.1000*on/48'");
    expect(f).toContain("tpad=stop_mode=clone:stop_duration=1.50");
    expect(f).toContain("atrim=duration=3.500[a0]");
    expect(g.filmSeconds).toBeCloseTo(3.5);
  });
});

describe("music cues", () => {
  it("defaults to the film's end with 1.5 s in and 2 s out", () => {
    const c = planCue({ file: "m.mp3", at: 4 }, 20, 0.25);
    expect(c).toEqual({ file: "m.mp3", at: 4, seconds: 16, volume: 0.25, fadeIn: 1.5, fadeOut: 2 });
  });
  it("honours until, volume and fades, and clamps until to the film", () => {
    expect(planCue({ file: "m", at: 0, until: 6, volume: 0.5, fade_in: 0, fade_out: 1 }, 20, 0.25)).toMatchObject({ seconds: 6, volume: 0.5, fadeIn: 0, fadeOut: 1 });
    expect(planCue({ file: "m", at: 5, until: 99 }, 20, 0.25).seconds).toBe(15);
  });
  it("shrinks fades on a short cue and refuses bad windows", () => {
    const c = planCue({ file: "m", at: 0, until: 1.75 }, 20, 0.25);
    expect(c.fadeIn + c.fadeOut).toBeCloseTo(1.75);
    expect(() => planCue({ file: "m", at: 20 }, 20, 0.25)).toThrow(/at/);
    expect(() => planCue({ file: "m", at: 5, until: 4 }, 20, 0.25)).toThrow(/until/);
  });
  it("builds two cues with fades, delayed and mixed", () => {
    const cues = [planCue({ file: "/m1.mp3", at: 0, until: 8, volume: 0.3 }, 20, 0.25), planCue({ file: "/m2.mp3", at: 10, fade_in: 3 }, 20, 0.25)];
    const g = buildGraph({ ...base, clips: [video("/a.mp4", 20)], cues });
    const f = g.filters.join(";");
    expect(g.inputArgs).toEqual(["-i", "/a.mp4", "-stream_loop", "-1", "-i", "/m1.mp3", "-stream_loop", "-1", "-i", "/m2.mp3"]);
    expect(f).toContain("[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=8.000,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.500,afade=t=out:st=6.000:d=2.000,volume=0.3,adelay=0|0[cue0]");
    expect(f).toContain("atrim=duration=10.000");
    expect(f).toContain("afade=t=in:st=0:d=3.000");
    expect(f).toContain("afade=t=out:st=8.000:d=2.000");
    expect(f).toContain("adelay=10000|10000[cue1]");
    expect(f).toContain("[cue0][cue1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[music]");
    expect(f).toContain("[clipaudio][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]");
  });
  it("leaves the fades out when both are 0 (the single `music` bed)", () => {
    const cue = planCue({ file: "/m.mp3", at: 0, fade_in: 0, fade_out: 0, volume: 0.25 }, 10, 0.25);
    const f = buildGraph({ ...base, clips: [video("/a.mp4", 10)], cues: [cue] }).filters.join(";");
    expect(f).not.toContain("afade");
    expect(f).toContain("volume=0.25,adelay=0|0[cue0]");
  });
});

describe("duck", () => {
  const cues = [planCue({ file: "/m.mp3", at: 0 }, 10, 0.25)];
  const clips = [video("/a.mp4", 10)];
  it("off: music and voice are plain mix inputs", () => {
    const f = buildGraph({ ...base, clips, cues, voiceover: "/v.wav" }).filters.join(";");
    expect(f).not.toContain("sidechaincompress");
    expect(f).toContain("[clipaudio][cue0][vo]amix=inputs=3");
  });
  it("on: the voice keys a compressor on the music", () => {
    const f = buildGraph({ ...base, clips, cues, voiceover: "/v.wav", duck: true }).filters.join(";");
    expect(f).toContain("[vo]asplit=2[vo_play][vo_raw];[vo_raw]apad[vo_key]");
    expect(f).toContain("[cue0][vo_key]sidechaincompress=");
    expect(f).toContain("[clipaudio][ducked][vo_play]amix=inputs=3");
  });
  it("on without a voice or without music does nothing", () => {
    expect(buildGraph({ ...base, clips, cues, duck: true }).filters.join(";")).not.toContain("sidechaincompress");
    expect(buildGraph({ ...base, clips, voiceover: "/v.wav", duck: true }).filters.join(";")).not.toContain("sidechaincompress");
  });
});

describe("voice_lines + music_cues graph", () => {
  it("orders inputs clips, cues, voice track", () => {
    const cues = [planCue({ file: "/m.mp3", at: 1 }, 12, 0.2)];
    const g = buildGraph({ ...base, clips: [still("/t.png", 4), video("/a.mp4", 8)], cues, voiceover: "/f-voice.wav", duck: true });
    expect(g.inputArgs.filter((x) => x === "-i").length).toBe(4);
    expect(g.inputArgs.at(-1)).toBe("/f-voice.wav");
    const f = g.filters.join(";");
    expect(f).toContain("[3:a]aresample=48000,aformat=channel_layouts=stereo[vo]");
    expect(f).toContain("[2:a]aresample=48000");
    expect(f).toContain("adelay=1000|1000[cue0]");
  });
});
