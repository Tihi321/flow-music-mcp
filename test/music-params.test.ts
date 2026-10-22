import { describe, expect, it } from "vitest";
import { escapeRegExp, lengthSeconds, lengthValid, modelItemPattern, parseCredits } from "../src/util.js";

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
