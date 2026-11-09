import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { elevenClient } from "../src/flow/elevenlabs.js";
import { alignmentToWords } from "../src/flow/voice-pure.js";

// Fake key: never a real one, and not shaped like one (the repo grep looks for sk_ keys).
const FAKE_KEY = "fake-eleven-test-key-0123456789abcdef";

const MODELS = [
  {
    model_id: "eleven_multilingual_v2",
    can_do_text_to_speech: true,
    languages: [{ language_id: "en" }, { language_id: "hr" }],
    model_rates: { character_cost_multiplier: 1 },
  },
];

// A fake fetch that answers the reads and records every URL asked for.
function fakeFetch(subscription: Record<string, unknown>) {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/v1/user/subscription")) return Response.json(subscription);
    if (url.includes("/v1/models")) return Response.json(MODELS);
    return Response.json({ audio_base64: "AAAA", alignment: null });
  }) as typeof fetch;
  return { fn, urls };
}

const client = (fetchFn: typeof fetch, log: (l: string) => void = () => {}) =>
  elevenClient({ fetch: fetchFn, key: () => ({ key: FAKE_KEY, source: "file" }), log, reserve: () => 200, sleep: async () => {}, convert: async () => 1 });

describe("ElevenLabs guard", () => {
  it("refuses over-quota and non-free tiers before any TTS request", async () => {
    const line = { text: "x".repeat(150), voice: "voice123", target: "C:/nowhere/line.mp3" };

    // 300 remaining - 200 reserve = 100 allowed < 150 estimated.
    const quota = fakeFetch({ tier: "free", character_count: 9700, character_limit: 10000, can_extend_character_limit: false });
    await expect(client(quota.fn).speak(line)).rejects.toMatchObject({ code: "E_ELEVEN_QUOTA" });
    expect(quota.urls.some((u) => u.includes("/text-to-speech/"))).toBe(false);

    const paid = fakeFetch({ tier: "starter", character_count: 0, character_limit: 30000, can_extend_character_limit: false });
    await expect(client(paid.fn).speak(line)).rejects.toMatchObject({ code: "E_ELEVEN_PAID_TIER" });
    expect(paid.urls.some((u) => u.includes("/text-to-speech/"))).toBe(false);
  });
});

describe("subscription reads (FMM-20)", () => {
  const SUB = { tier: "free", character_count: 0, character_limit: 10000, can_extend_character_limit: false };
  const dir = mkdtempSync(join(tmpdir(), "eleven-test-"));
  const line = { text: "Bok!", voice: "voice123", target: join(dir, "line.mp3") };

  it("reads the subscription about once per line, not twice", async () => {
    const f = fakeFetch(SUB);
    const c = client(f.fn);
    for (let i = 0; i < 5; i++) await c.speak({ ...line, target: join(dir, `line${i}.mp3`) });
    expect(f.urls.filter((u) => u.includes("/v1/user/subscription")).length).toBeLessThanOrEqual(6); // 5 lines, not 10
  });

  it("fills remaining_after from the before-read minus the line when every after-read gets a 429", async () => {
    let subReads = 0;
    const fn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/user/subscription")) {
        subReads++;
        return subReads === 1 ? Response.json(SUB) : new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      }
      if (url.includes("/v1/models")) return Response.json(MODELS);
      return Response.json({ audio_base64: "AAAA", alignment: null });
    }) as typeof fetch;
    const c = client(fn);
    const r = await c.speak(line);
    expect(r.remaining_after).toBe(10000 - 4);
    expect(r.remaining_after_source).toBe("estimate");
    // The cached read minus the 4 spent credits is what the next guard sees: 9996 - 200 reserve < 9800, refused with no new read.
    const reads = subReads;
    await expect(c.speak({ ...line, text: "x".repeat(9800) })).rejects.toMatchObject({ code: "E_ELEVEN_QUOTA" });
    expect(subReads).toBe(reads);
  });
});

describe("429 handling (FMM-21)", () => {
  const SUB = { tier: "free", character_count: 0, character_limit: 10000, can_extend_character_limit: false };
  const line = { text: "Bok!", voice: "voice123", target: join(mkdtempSync(join(tmpdir(), "eleven-test-")), "line.mp3") };

  it("never resends a TTS POST that got a 429, and retries an after-read only through request()'s own 3 retries", async () => {
    let posts = 0;
    const fn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/models")) return Response.json(MODELS);
      if (url.includes("/v1/user/subscription")) return Response.json(SUB);
      posts++;
      return new Response("{}", { status: 429 });
    }) as typeof fetch;
    await expect(client(fn).speak(line)).rejects.toMatchObject({ code: "E_ELEVEN_RATE" });
    expect(posts).toBe(1);

    let reads = 0;
    const slept: number[] = [];
    const fn2 = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/models")) return Response.json(MODELS);
      if (url.includes("/v1/user/subscription")) return ++reads === 1 ? Response.json(SUB) : new Response("{}", { status: 429 });
      return Response.json({ audio_base64: "AAAA", alignment: null });
    }) as typeof fetch;
    const c = elevenClient({ fetch: fn2, key: () => ({ key: FAKE_KEY, source: "file" }), log: () => {}, reserve: () => 200, sleep: async (ms) => void slept.push(ms), convert: async () => 1 });
    const r = await c.speak(line);
    expect(r.remaining_after_source).toBe("estimate");
    expect(reads).toBe(1 + 4); // the guard read, then one after-read: 1 try + 3 retries
    expect(slept.length).toBe(3); // no sleep after the last failed try
  });
});

describe("alignmentToWords", () => {
  it("groups characters into words, drops edge punctuation and keeps Croatian letters", () => {
    const text = "Bruno, čekaj malo!";
    const chars = [...text];
    const start = chars.map((_, i) => i * 0.1);
    const end = chars.map((_, i) => i * 0.1 + 0.08);
    expect(alignmentToWords({ characters: chars, character_start_times_seconds: start, character_end_times_seconds: end })).toEqual([
      { w: "Bruno", t0: 0, t1: 0.48 },
      { w: "čekaj", t0: 0.7, t1: 1.18 },
      { w: "malo", t0: 1.3, t1: 1.68 },
    ]);
  });
});

describe("key redaction", () => {
  it("keeps the key out of the error, the log and the status result when a 401 echoes it", async () => {
    const lines: string[] = [];
    const echo = (async () =>
      new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: `Invalid API key: ${FAKE_KEY}` } }), { status: 401 })) as typeof fetch;
    const c = client(echo, (l) => lines.push(l));

    const err = await c.speak({ text: "Bok!", voice: "voice123", target: "C:/nowhere/line.mp3" }).catch((e: Error) => e);
    const status = await c.status();

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("E_ELEVEN_KEY");
    expect(lines.length).toBeGreaterThan(0);
    expect(status.ready).toBe(false);
    for (const text of [(err as Error).message, ...lines, JSON.stringify(status)]) expect(text).not.toContain(FAKE_KEY);
  });
});
