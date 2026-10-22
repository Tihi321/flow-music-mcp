import { describe, expect, it } from "vitest";
import { languageNote } from "../src/flow/language-note.js";

describe("languageNote", () => {
  it("warns when auto picks a Cyrillic language", () => {
    expect(languageNote("auto", "uk")).toMatch(/pass `language`/);
    expect(languageNote("auto", "ru")).toBeDefined();
  });
  it("is silent for an explicit language or a Latin-script one", () => {
    expect(languageNote("uk", "uk")).toBeUndefined();
    expect(languageNote("auto", "hr")).toBeUndefined();
    expect(languageNote("auto", "en")).toBeUndefined();
  });
});
