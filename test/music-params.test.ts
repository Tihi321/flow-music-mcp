import { describe, expect, it } from "vitest";
import { LOOP_WORDING, escapeRegExp, lengthSeconds, lengthValid, loopFriendlySound, modelItemPattern, parseCredits, remixItemPattern, songIdOf, videoTemplateCard } from "../src/util.js";

describe("lengthValid", () => {
  it("accepts m:ss from 1:00 to 3:00 and bare minutes", () => {
    for (const ok of ["1:00", "2:30", "3:00", "1:59", "2", "3", " 2:30 "]) expect(lengthValid(ok), ok).toBe(true);
  });
  it("rejects out of range and malformed values", () => {
    for (const bad of ["0:30", "3:01", "4:00", "0", "5", "150", "9:99", "2:5", "90s", "", "1:00:00", "-1"]) expect(lengthValid(bad), bad).toBe(false);
  });
  it("reads seconds", () => {
    expect(lengthSeconds("2:30")).toBe(150);
    expect(lengthSeconds("2")).toBe(120);
    expect(lengthSeconds("x")).toBeUndefined();
  });
});

describe("parseCredits", () => {
  it("reads the balance from the menu item text", () => {
    expect(parseCredits("13190 credits")).toBe(13190);
    expect(parseCredits("13,190 credits")).toBe(13190);
    expect(parseCredits("  13190\n credits ")).toBe(13190);
  });
  it("ignores other menu items", () => {
    expect(parseCredits("Account settings")).toBeUndefined();
    expect(parseCredits("Log out")).toBeUndefined();
    expect(parseCredits("credits")).toBeUndefined();
  });
});

describe("modelItemPattern", () => {
  const flagship = "Lyria 3.5 Top performing, flagship model";
  const pro = "Lyria 3 Pro Legacy model";
  it("matches the model at the start of the item name", () => {
    expect(modelItemPattern("Lyria 3.5").test(flagship)).toBe(true);
    expect(modelItemPattern("Lyria 3 Pro").test(pro)).toBe(true);
    expect(modelItemPattern("Lyria 3.5").test("Lyria 3.5")).toBe(true);
  });
  it("does not confuse the two models", () => {
    expect(modelItemPattern("Lyria 3.5").test(pro)).toBe(false);
    expect(modelItemPattern("Lyria 3 Pro").test(flagship)).toBe(false);
    expect(modelItemPattern("Lyria 3").test(flagship)).toBe(false);
  });
  it("treats the name literally", () => {
    expect(modelItemPattern("Lyria 3.5").test("Lyria 3x5 model")).toBe(false);
    expect(escapeRegExp("a.b(c)[d]")).toBe("a\\.b\\(c\\)\\[d\\]");
  });
});

describe("FMM-07 helpers", () => {
  it("appends the loop wording once", () => {
    expect(loopFriendlySound("calm piano, 80 bpm.")).toBe(`calm piano, 80 bpm. ${LOOP_WORDING}`);
    expect(loopFriendlySound("calm piano")).toBe(`calm piano. ${LOOP_WORDING}`);
    expect(loopFriendlySound(`calm piano. ${LOOP_WORDING}`)).toBe(`calm piano. ${LOOP_WORDING}`);
  });
  it("matches a video template card by its whole text", () => {
    expect(videoTemplateCard("simple").pattern.test("Simple")).toBe(true);
    expect(videoTemplateCard("simple").pattern.test("Simple video")).toBe(false);
    expect(videoTemplateCard("music_video").pattern.test("Music video NEW")).toBe(true);
    expect(videoTemplateCard("music_video").pattern.test("NEW Music video")).toBe(true);
    expect(videoTemplateCard("music_video").pattern.test("Modern")).toBe(false);
    expect(videoTemplateCard("modern").label).toBe("Modern");
    expect(videoTemplateCard("player").label).toBe("Player");
  });
  it("matches the Remix submenu items exactly", () => {
    expect(remixItemPattern("variation").test("Variation")).toBe(true);
    expect(remixItemPattern("variation").test("Use prompt")).toBe(false);
    expect(remixItemPattern("extend").test("Extend")).toBe(true);
    expect(remixItemPattern("extend").test("Extended")).toBe(false);
  });
  it("reads a song id from an id or a link", () => {
    expect(songIdOf("7be13b39-82da-4980-9842-f42cd6fd888f")).toBe("7be13b39-82da-4980-9842-f42cd6fd888f");
    expect(songIdOf("https://www.flowmusic.app/song/7BE13B39-82DA-4980-9842-F42CD6FD888F?x=1")).toBe("7be13b39-82da-4980-9842-f42cd6fd888f");
    expect(songIdOf("hello")).toBeUndefined();
  });
});
