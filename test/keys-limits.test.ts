import { afterEach, describe, expect, it } from "vitest";
import { looksLikeKey, plausible } from "../src/flow/key-format.js";
import { DEFAULT_MAX_CREDITS, capOf, defaultMaxCredits } from "../src/flow/limits.js";

const KEY = "AIzaSyA1234567890abcdefghijklmnopqrstu";

describe("plausible", () => {
  it("accepts a real-looking key and trims it", () => {
    expect(plausible(`  ${KEY}\n`)).toBe(KEY);
  });
  it("rejects empty, short and template text", () => {
    expect(plausible("")).toBeUndefined();
    expect(plausible("   ")).toBeUndefined();
    expect(plausible("AIzaShort")).toBeUndefined();
    expect(plausible("YOUR_GEMINI_API_KEY_GOES_HERE")).toBeUndefined();
    expect(plausible("paste-your-key-here-1234567890")).toBeUndefined();
    expect(plausible("<your key here 1234567890>")).toBeUndefined();
    expect(plausible("$GEMINI_API_KEY_____________")).toBeUndefined();
    expect(plausible("AIzaSyEXAMPLE1234567890abcdef")).toBeUndefined();
  });
});

describe("looksLikeKey", () => {
  it("accepts one unbroken run of key characters", () => {
    expect(looksLikeKey(KEY)).toBe(true);
    expect(looksLikeKey("AQ.Ab8RN6-_abc+def/ghi=jkl~mnop")).toBe(true);
  });
  it("rejects spaces, bad length, odd characters and placeholders", () => {
    expect(looksLikeKey(`${KEY} ${KEY}`)).toBe(false);
    expect(looksLikeKey("short")).toBe(false);
    expect(looksLikeKey("a".repeat(513))).toBe(false);
    expect(looksLikeKey("AIza" + "é".repeat(20))).toBe(false);
    expect(looksLikeKey("YOUR_KEY_HERE_0123456789")).toBe(false);
    expect(looksLikeKey("AIzaSyEXAMPLE1234567890abcdef")).toBe(false);
  });
});

describe("capOf / defaultMaxCredits", () => {
  const saved = process.env.FLOW_MUSIC_MCP_MAX_CREDITS;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLOW_MUSIC_MCP_MAX_CREDITS;
    else process.env.FLOW_MUSIC_MCP_MAX_CREDITS = saved;
  });
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.FLOW_MUSIC_MCP_MAX_CREDITS;
    else process.env.FLOW_MUSIC_MCP_MAX_CREDITS = v;
  };

  it("is 50 when unset or empty", () => {
    set(undefined);
    expect(defaultMaxCredits()).toBe(DEFAULT_MAX_CREDITS);
    expect(DEFAULT_MAX_CREDITS).toBe(50);
    set("");
    expect(defaultMaxCredits()).toBe(50);
    set("  ");
    expect(defaultMaxCredits()).toBe(50);
  });
  it("reads a whole number, 0 included", () => {
    set("120");
    expect(defaultMaxCredits()).toBe(120);
    set("0");
    expect(defaultMaxCredits()).toBe(0);
  });
  it("falls back to 50 for junk, negatives and fractions", () => {
    for (const v of ["abc", "-5", "2.5", "1e400"]) {
      set(v);
      expect(defaultMaxCredits()).toBe(50);
    }
  });
  it("capOf prefers the caller's value, even 0", () => {
    set("120");
    expect(capOf(undefined)).toBe(120);
    expect(capOf(10)).toBe(10);
    expect(capOf(0)).toBe(0);
  });
});
