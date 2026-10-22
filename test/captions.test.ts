import { describe, expect, it } from "vitest";
import { alignText, layout, namesIn, paginate, segmentWords, wordsFromTokens, type Word } from "../src/flow/captions.js";

const w = (text: string, start: number, end: number, br?: boolean): Word => (br ? { text, start, end, br } : { text, start, end });
// Evenly timed words, 0.3 s each with no gaps.
const timed = (...texts: string[]) => texts.map((t, i) => w(t, i * 0.3, i * 0.3 + 0.3));

describe("alignText", () => {
  it("takes the typed text and the heard timings", () => {
    const out = alignText(timed("hello", "flo", "world"), "Hello Flow world");
    expect(out.map((x) => x.text)).toEqual(["Hello", "Flow", "world"]);
    expect(out[0]).toMatchObject({ start: 0 });
    expect(out[2]).toMatchObject({ start: 0.6 });
    expect(out[1]!.start).toBeGreaterThanOrEqual(0);
    expect(out[1]!.end).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it("spreads a word that was never heard over the gap, in order", () => {
    const out = alignText([w("one", 0, 0.3), w("three", 1.1, 1.4)], "one two three");
    expect(out.map((x) => x.text)).toEqual(["one", "two", "three"]);
    expect(out[1]!.start).toBeGreaterThanOrEqual(out[0]!.end - 1e-9);
    expect(out[1]!.end).toBeLessThanOrEqual(out[2]!.start + 1e-9);
    expect(out.every((x) => Number.isFinite(x.start) && Number.isFinite(x.end))).toBe(true);
  });

  it("marks the first word of each typed line as a break", () => {
    const out = alignText(timed("a", "b", "c"), "a b\nc");
    expect(out.map((x) => !!x.br)).toEqual([false, false, true]);
  });

  it("returns nothing for empty text", () => {
    expect(alignText(timed("a"), "  \n ")).toEqual([]);
  });

  it("splits unspaced languages with the word breaker", () => {
    const out = alignText([w("今日", 0, 1), w("は", 1, 2)], "今日は", "ja");
    expect(out.map((x) => x.text).join("")).toBe("今日は");
  });
});

describe("paginate", () => {
  const words = timed("a", "b", "c", "d", "e");
  it("breaks at maxWords", () => {
    expect(paginate(words, 2, 100, " ").map((p) => p.length)).toEqual([2, 2, 1]);
  });
  it("breaks at maxChars", () => {
    const long = timed("aaaa", "bbbb", "cccc");
    expect(paginate(long, 10, 10, " ").map((p) => p.length)).toEqual([2, 1]);
  });
  it("breaks after sentence and clause ends, on a typed break and on a long pause", () => {
    expect(paginate(timed("Hi.", "there"), 9, 100, " ").map((p) => p.length)).toEqual([1, 1]);
    expect(paginate(timed("Hi,", "there"), 9, 100, " ").map((p) => p.length)).toEqual([1, 1]);
    expect(paginate([w("a", 0, 0.2), w("b", 0.2, 0.4, true)], 9, 100, " ").map((p) => p.length)).toEqual([1, 1]);
    expect(paginate([w("a", 0, 0.2), w("b", 1.5, 1.7)], 9, 100, " ").map((p) => p.length)).toEqual([1, 1]);
  });
  it("returns no pages for no words", () => {
    expect(paginate([], 3, 10, " ")).toEqual([]);
  });
});

describe("layout", () => {
  const heard = [w("Hello", 0, 0.4), w("big", 0.4, 0.8), w("world.", 0.8, 1.2), w("Again", 3, 3.4)];

  it("makes one state per page for a style without highlight", () => {
    const { pages, states } = layout(heard, "clean", 1280, 720, "medium", "as_said", 0, "en");
    expect(pages.map((p) => p.map((x) => x.text))).toEqual([["Hello", "big", "world."], ["Again"]]);
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({ words: ["Hello", "big", "world."], active: -1 });
  });

  it("makes one state per word for a highlight style and never overlaps", () => {
    const { states } = layout(heard, "reveal", 1280, 720, "medium", "as_said", 0, "en");
    expect(states.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < states.length; i++) expect(states[i]!.from).toBeGreaterThanOrEqual(states[i - 1]!.to - 1e-9);
    expect(states.every((s) => s.to > s.from)).toBe(true);
  });

  it("adds the grow-in frames for the pop style", () => {
    const { states } = layout(heard, "bold", 1280, 720, "medium", "capitals", 0, "en");
    expect(states.some((s) => s.scale < 1)).toBe(true);
  });

  it("drops trailing commas and full stops unless letters are as_said", () => {
    const text = (letters: "as_said" | "lowercase") => layout(heard, "clean", 1280, 720, "medium", letters, 0, "en").states[0]!.words;
    expect(text("as_said")).toContain("world.");
    expect(text("lowercase")).toContain("world");
  });

  it("shifts timings by the lead and never below 0", () => {
    const { pages } = layout(heard, "clean", 1280, 720, "medium", "as_said", 0.5, "en");
    expect(pages[0]![0]!.start).toBe(0);
    expect(pages[1]![0]!.start).toBeCloseTo(2.5);
  });
});

describe("namesIn", () => {
  it("finds capitalised words that do not start a sentence", () => {
    const words = [w("Then", 0, 1), w("we", 1, 2), w("met", 2, 3), w("Juno.", 3, 4), w("Juno", 4, 5), w("laughed", 5, 6)];
    expect(namesIn(words)).toEqual(["juno"]);
  });
  it("ignores I, sentence starts and breaks, and adds the given names", () => {
    const words = [w("Hello", 0, 1), w("and", 1, 2), w("I'm", 2, 3), w("here", 3, 4), w("Now", 4, 5, true)];
    expect(namesIn(words, ["Kai!"])).toEqual(["kai"]);
  });
});

describe("segmentWords", () => {
  it("breaks Japanese into words with positions in the text", () => {
    const out = segmentWords("今日は人工知能", "ja");
    expect(out.map((x) => x.text).join("")).toBe("今日は人工知能");
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]!.from).toBe(0);
    expect(out.at(-1)!.to).toBe(7);
  });
  it("keeps punctuation with its word and an opener with the next word", () => {
    const out = segmentWords("「今日」は。", "ja");
    expect(out[0]!.text.startsWith("「")).toBe(true);
    expect(out.at(-1)!.text.endsWith("。")).toBe(true);
  });
});

describe("wordsFromTokens", () => {
  const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
  it("starts a word at a token with a leading space and joins the rest", () => {
    const json = { transcription: [{ tokens: [tok(" Don", 0, 200), tok("'t", 200, 300), tok(" go", 400, 600), tok(",", 600, 650)] }] };
    const out = wordsFromTokens(json, "en");
    expect(out.map((x) => x.text)).toEqual(["Don't", "go,"]);
    expect(out[0]).toMatchObject({ start: 0, end: 0.3 });
    expect(out[1]).toMatchObject({ start: 0.4, end: 0.65 });
  });
  it("keeps a lone opening mark with the next word and drops special and non-speech tokens", () => {
    const json = { transcription: [{ tokens: [tok("[_BEG_]", 0, 0), tok(" ¿", 0, 50), tok(" Qué", 50, 300), tok(" [MUSIC]", 300, 500), tok(" ♪", 500, 600)] }] };
    expect(wordsFromTokens(json, "es").map((x) => x.text)).toEqual(["¿Qué"]);
  });
  it("builds words for unspaced languages from the characters' tokens", () => {
    const json = { transcription: [{ tokens: [tok("今日", 0, 400), tok("は", 400, 600)] }] };
    const out = wordsFromTokens(json, "ja");
    expect(out.map((x) => x.text).join("")).toBe("今日は");
    expect(out[0]!.start).toBe(0);
    expect(out.at(-1)!.end).toBeCloseTo(0.6);
  });
});
