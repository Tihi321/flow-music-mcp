import { describe, expect, it } from "vitest";
import { audioExtensionOfBytes, classifySongText, mediaExtensionOfBytes, nextDelay, renderingNote, slug } from "../src/util.js";
import { inEnglish } from "../src/chrome.js";
import { psQuote } from "../src/flow/platform.js";

// 12 bytes: the given bytes, zero-padded.
const head = (...bytes: (number | string)[]) => {
  const out = Buffer.alloc(12);
  let at = 0;
  for (const b of bytes) {
    if (typeof b === "number") out[at++] = b;
    else at += out.write(b, at, "latin1");
  }
  return out;
};
const at4 = (s: string) => head(0, 0, 0, 0, s);

describe("slug", () => {
  it("lowercases, strips marks and joins words with dashes", () => {
    expect(slug("Café Del Mar!", "x")).toBe("cafe-del-mar");
    expect(slug("  a_b  c ", "x")).toBe("a-b-c");
  });
  it("uses the fallback when nothing is left", () => {
    expect(slug("", "song")).toBe("song");
    expect(slug("!!! ???", "image")).toBe("image");
  });
  it("cuts at 60 characters", () => {
    expect(slug("a".repeat(100), "x")).toHaveLength(60);
  });
});

describe("audioExtensionOfBytes", () => {
  it("knows MP3 by ID3 tag and by frame sync", () => {
    expect(audioExtensionOfBytes(head("ID3"))).toBe(".mp3");
    expect(audioExtensionOfBytes(head(0xff, 0xfb))).toBe(".mp3");
    expect(audioExtensionOfBytes(head(0xff, 0x10))).toBeUndefined();
  });
  it("knows WAV, M4A, OGG, FLAC and ZIP", () => {
    expect(audioExtensionOfBytes(head("RIFF", 0, 0, 0, 0, "WAVE"))).toBe(".wav");
    expect(audioExtensionOfBytes(at4("ftypM4A "))).toBe(".m4a");
    expect(audioExtensionOfBytes(head("OggS"))).toBe(".ogg");
    expect(audioExtensionOfBytes(head("fLaC"))).toBe(".flac");
    expect(audioExtensionOfBytes(head("PK", 3, 4))).toBe(".zip");
  });
  it("returns undefined for the rest, and for RIFF that is not WAVE", () => {
    expect(audioExtensionOfBytes(head("hello"))).toBeUndefined();
    expect(audioExtensionOfBytes(head("RIFF", 0, 0, 0, 0, "WEBP"))).toBeUndefined();
    expect(audioExtensionOfBytes(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("mediaExtensionOfBytes", () => {
  it("knows JPEG, PNG, WebP, MP4, GIF and ZIP", () => {
    expect(mediaExtensionOfBytes(head(0xff, 0xd8, 0xff, 0xe0))).toBe(".jpeg");
    expect(mediaExtensionOfBytes(head(0x89, "PNG"))).toBe(".png");
    expect(mediaExtensionOfBytes(head("RIFF", 0, 0, 0, 0, "WEBP"))).toBe(".webp");
    expect(mediaExtensionOfBytes(at4("ftypisom"))).toBe(".mp4");
    expect(mediaExtensionOfBytes(head("GIF89a"))).toBe(".gif");
    expect(mediaExtensionOfBytes(head(0x50, 0x4b, 0x03, 0x04))).toBe(".zip");
  });
  it("falls back to .bin", () => {
    expect(mediaExtensionOfBytes(head("hello"))).toBe(".bin");
    expect(mediaExtensionOfBytes(head("PK", 5, 6))).toBe(".bin");
    expect(mediaExtensionOfBytes(Buffer.alloc(0))).toBe(".bin");
  });
});

describe("nextDelay", () => {
  it("is 0 before any job has finished", () => {
    expect(nextDelay(undefined, 1000, 20_000, 45_000, () => 0.5)).toBe(0);
    expect(nextDelay(0, 1000, 20_000, 45_000, () => 0.5)).toBe(0);
  });
  it("is the random pause minus the time already passed", () => {
    expect(nextDelay(1000, 1000, 20_000, 45_000, () => 0)).toBe(20_000);
    expect(nextDelay(1000, 1000, 20_000, 45_000, () => 1)).toBe(45_000);
    expect(nextDelay(1000, 11_000, 20_000, 45_000, () => 0.2)).toBe(15_000);
  });
  it("goes negative once the pause is over", () => {
    expect(nextDelay(1000, 100_000, 20_000, 45_000, () => 1)).toBeLessThan(0);
  });
});

describe("classifySongText", () => {
  it("reads failure words as failed, ahead of busy", () => {
    expect(classifySongText("My Song 2:40 Failed")).toBe("failed");
    expect(classifySongText("We couldn't make it")).toBe("failed");
    expect(classifySongText("Something went wrong while generating")).toBe("failed");
  });
  it("reads percentages and generating as busy", () => {
    expect(classifySongText("42% Generating My Song")).toBe("busy");
    expect(classifySongText("generating")).toBe("busy");
  });
  it("reads a plain row as ready", () => {
    expect(classifySongText("My Song 2:40 Play Remix Like")).toBe("ready");
  });
});

describe("renderingNote", () => {
  it("finds the generating row", () => {
    expect(renderingNote('Creating "Neon Rain"... 37% Generating Neon Rain... other')).toBe("37% Generating Neon Rain");
  });
  it('says "creating" while only the Creating line shows', () => {
    expect(renderingNote('Creating "Neon Rain"...')).toBe("creating");
  });
  it("is undefined when nothing renders", () => {
    expect(renderingNote("Neon Rain 2:40")).toBeUndefined();
  });
});

describe("inEnglish", () => {
  it("adds hl=en and keeps the rest", () => {
    expect(inEnglish("https://flow.google.com/")).toBe("https://flow.google.com/?hl=en");
    expect(inEnglish("https://flow.google.com/project/abc?x=1")).toBe("https://flow.google.com/project/abc?x=1&hl=en");
  });
  it("replaces another language", () => {
    expect(inEnglish("https://flow.google.com/?hl=de")).toBe("https://flow.google.com/?hl=en");
  });
});

describe("psQuote", () => {
  it("single-quotes and doubles embedded quotes", () => {
    expect(psQuote("C:\\a b\\c.mp4")).toBe("'C:\\a b\\c.mp4'");
    expect(psQuote("it's")).toBe("'it''s'");
  });
});
