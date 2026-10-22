import { describe, expect, it } from "vitest";
import {
  AUDIO_FORMATS,
  DEFAULT_GEMINI_TTS,
  GEMINI_VOICES,
  TEXT_MAX,
  formatArgs,
  formatOf,
  geminiRateLimited,
  parseWindowsVoices,
  textLimitError,
} from "../src/flow/voice-pure.js";

describe("format to ffmpeg target mapping", () => {
  it("knows exactly mp3, wav, ogg, m4a", () => {
    expect([...AUDIO_FORMATS]).toEqual(["mp3", "wav", "ogg", "m4a"]);
  });
  it("picks the encoder for each format; m4a adds none (old behaviour)", () => {
    expect(formatArgs("m4a")).toEqual([]);
    expect(formatArgs("mp3")).toContain("libmp3lame");
    expect(formatArgs("wav")).toContain("pcm_s16le");
    expect(formatArgs("ogg")).toContain("libvorbis");
  });
  it("reads the format from the target path, defaulting to m4a", () => {
    expect(formatOf("C:\out\line-01.mp3")).toBe("mp3");
    expect(formatOf("/tmp/a.WAV")).toBe("wav");
    expect(formatOf("/tmp/a.ogg")).toBe("ogg");
    expect(formatOf("/tmp/a.m4a")).toBe("m4a");
    expect(formatOf("/tmp/a.flac")).toBe("m4a");
    expect(formatOf("/tmp/noext")).toBe("m4a");
  });
});

describe("text limits", () => {
  it("lets gemini and windows take 4000 characters and flow only 400", () => {
    expect(TEXT_MAX).toEqual({ flow: 400, gemini: 4000, windows: 4000 });
    expect(textLimitError("gemini", "a".repeat(4000))).toBeUndefined();
    expect(textLimitError("windows", "a".repeat(4000))).toBeUndefined();
    expect(textLimitError("flow", "a".repeat(400))).toBeUndefined();
  });
  it("names the engine and the limit when over", () => {
    expect(textLimitError("flow", "a".repeat(401))).toMatch(/flow.*400/);
    expect(textLimitError("gemini", "a".repeat(4001))).toMatch(/gemini.*4000/);
  });
});

describe("parseWindowsVoices", () => {
  it("keeps every culture, not only en-*", () => {
    const v = parseWindowsVoices("Microsoft David Desktop|en-US|Male\r\nMicrosoft Zira Desktop|en-US|Female\r\nMicrosoft Matej|hr-HR|Male\r\n");
    expect(v.map((x) => [x.name, x.culture, x.gender])).toEqual([
      ["Microsoft David Desktop", "en-US", "male"],
      ["Microsoft Zira Desktop", "en-US", "female"],
      ["Microsoft Matej", "hr-HR", "male"],
    ]);
    expect(v[2]?.description).toBe("hr-HR · Windows, free");
  });
  it("skips blank and malformed lines, and tolerates a missing or odd gender", () => {
    const v = parseWindowsVoices("\n  \nNoCulture\nVoice A|de-DE\nVoice B|fr-FR|Neutral\n");
    expect(v.map((x) => x.name)).toEqual(["Voice A", "Voice B"]);
    expect(v[0]?.gender).toBeUndefined();
    expect(v[1]?.gender).toBeUndefined();
  });
  it("returns nothing for empty output", () => {
    expect(parseWindowsVoices("")).toEqual([]);
  });
});

describe("Gemini voice table", () => {
  it("has 30 unique voices, each with a description and a gender", () => {
    expect(GEMINI_VOICES).toHaveLength(30);
    expect(new Set(GEMINI_VOICES.map((v) => v.name)).size).toBe(30);
    for (const v of GEMINI_VOICES) {
      expect(v.description.length).toBeGreaterThan(0);
      expect(["female", "male"]).toContain(v.gender);
    }
  });
  it("has both genders and the voices the docs name", () => {
    expect(GEMINI_VOICES.some((v) => v.gender === "female")).toBe(true);
    expect(GEMINI_VOICES.some((v) => v.gender === "male")).toBe(true);
    const g = (n: string) => GEMINI_VOICES.find((v) => v.name === n)?.gender;
    expect(g("Charon")).toBe("male");
    expect(g("Aoede")).toBe("female");
    expect(g("Gacrux")).toBe("female");
  });
});

describe("Gemini model and errors", () => {
  it("defaults to gemini-3.8-flash-tts", () => {
    expect(DEFAULT_GEMINI_TTS).toBe("gemini-3.8-flash-tts");
  });
  it("says 'rate limited' on a 429 and keeps Google's text", () => {
    const msg = geminiRateLimited("Quota exceeded");
    expect(msg).toMatch(/rate limited/);
    expect(msg).toMatch(/Quota exceeded/);
    expect(geminiRateLimited()).toMatch(/no detail/);
  });
});
