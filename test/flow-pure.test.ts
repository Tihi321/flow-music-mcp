import { describe, expect, it } from "vitest";
import { asbToken, flowTrouble, locateNew, mergeView, type SnapTile, isVeoModel, modelOptions, VEO_IGNORED_NOTE, newErrorIndexes, optionMatchesTitle, parseAsbHandle, pickerSearchText, pickerTitle, sceneRound, tileKey, tileMatchesHandle, troubleMessage } from "../src/flow/pure.js";

describe("asb handles", () => {
  it("takes the token after /asb/ and stops at ? # /", () => {
    expect(asbToken("https://flow.google.com/asb/AbC123_-xyz")).toBe("AbC123_-xyz");
    expect(asbToken("https://flow.google.com/asb/AbC123_-xyz?x=1")).toBe("AbC123_-xyz");
    expect(asbToken("https://flow-content.google/image/0a1b")).toBeUndefined();
    expect(asbToken(null)).toBeUndefined();
  });
  it("parses only asb: handles with a usable token", () => {
    expect(parseAsbHandle("asb:AbC123_-xyz")).toBe("AbC123_-xyz");
    expect(parseAsbHandle("asb:a\"b]c1234567")).toBe("abc1234567");
    expect(parseAsbHandle("asb:short")).toBeUndefined();
    expect(parseAsbHandle("title:foo")).toBeUndefined();
    expect(parseAsbHandle("0a1b2c3d-1111-2222-3333-444455556666")).toBeUndefined();
  });
  it("matches a tile by its thumb token, in either prefix direction, never by title", () => {
    expect(tileMatchesHandle({ thumb: "AbC123xyz" }, "asb:AbC123xyz")).toBe(true);
    expect(tileMatchesHandle({ thumb: "AbC123xyzMORE" }, "asb:AbC123xyz")).toBe(true); // hover <video>
    expect(tileMatchesHandle({ thumb: "AbC123xyz" }, "asb:AbC123xyzMORE")).toBe(true); // handle recorded from a video src
    expect(tileMatchesHandle({ thumb: "ZZZ123xyz" }, "asb:AbC123xyz")).toBe(false);
    expect(tileMatchesHandle({}, "asb:AbC123xyz")).toBe(false);
    expect(tileMatchesHandle({ id: "0a1b" }, "0a1b")).toBe(true);
  });
});

describe("flowTrouble", () => {
  it("classifies the high-demand banner and notes the refund only when Flow says so", () => {
    const t = flowTrouble("Flow is currently experiencing high demand, affecting video generation. Credits will be refunded for any failed requests.");
    expect(t).toMatchObject({ kind: "high_demand", refunded: true });
    expect(troubleMessage(t!)).toMatch(/^Flow reports high demand: /);
    expect(troubleMessage(t!)).toMatch(/refunded/);
    const plain = flowTrouble("Flow is currently experiencing high demand");
    expect(plain?.refunded).toBe(false);
    expect(troubleMessage(plain!)).not.toMatch(/refund/);
  });
  it("classifies the agent's failure and failed tiles; ignores everything else", () => {
    expect(flowTrouble("Something went wrong. Please try again.")?.kind).toBe("went_wrong");
    expect(flowTrouble("Sorry, this video failed to generate. You were not charged.")).toMatchObject({ kind: "failed", refunded: true });
    expect(flowTrouble("I've generated your three scenes")).toBeUndefined();
    expect(flowTrouble("  ")).toBeUndefined();
  });
  it("prefers high demand over a plain failure", () => {
    expect(flowTrouble("Something went wrong. Flow is currently experiencing high demand")?.kind).toBe("high_demand");
  });
});

describe("newErrorIndexes", () => {
  const tile = (id: string, error = false) => ({ id, error });
  it("counts failed tiles above the first known tile only", () => {
    const tiles = [tile("", true), tile("a"), tile("", true), tile("old1"), tile("", true)];
    expect(newErrorIndexes(tiles, new Set(["old1"]))).toEqual([0, 2]);
  });
  it("ignores an old failed tile below the known tiles and counts all when none is known", () => {
    expect(newErrorIndexes([tile("old1"), tile("", true)], new Set(["old1"]))).toEqual([]);
    expect(newErrorIndexes([tile("", true), tile("x")], new Set())).toEqual([0]);
  });
});

describe("sceneRound", () => {
  it("asks for everything first, then only what is left", () => {
    expect(sceneRound(3, new Set(), 0)).toEqual([0, 1, 2]);
    expect(sceneRound(3, new Set([0, 2]), 1, 2)).toEqual([1]);
  });
  it("stops when all are done or the rounds are used up", () => {
    expect(sceneRound(2, new Set([0, 1]), 1, 2)).toEqual([]);
    expect(sceneRound(2, new Set([0]), 3, 1)).toEqual([]);
  });
  it("re-asks after a first round that made nothing, but not after a re-ask that made nothing", () => {
    expect(sceneRound(2, new Set(), 1, 0)).toEqual([0, 1]);
    expect(sceneRound(2, new Set(), 2, 0)).toEqual([]);
    expect(sceneRound(2, new Set([0]), 2, 1)).toEqual([1]);
  });
});

describe("tileKey", () => {
  it("keys an id-less video by its thumb, so same-titled videos stay apart", () => {
    const a = { id: "title:Paper boat", thumb: "AAAA1111" };
    const b = { id: "title:Paper boat", thumb: "BBBB2222" };
    expect(tileKey(a)).toBe("asb:AAAA1111");
    expect(tileKey(a)).not.toBe(tileKey(b));
    expect(tileKey({ id: "title:Paper boat" })).toBe("title:Paper boat");
    expect(tileKey({ id: "0a1b2c3d-1111-2222-3333-444455556666", thumb: "AAAA1111" })).toBe("0a1b2c3d-1111-2222-3333-444455556666");
  });
});

describe("model options (Veo has no resolution/duration)", () => {
  it("recognises Veo names (case-insensitive)", () => {
    expect(isVeoModel("Veo 3.1 - Fast")).toBe(true);
    expect(isVeoModel("veo 3.1 - lite")).toBe(true);
    expect(isVeoModel("Omni 1.1 Flash")).toBe(false);
    expect(isVeoModel(undefined)).toBe(false);
  });
  it("keeps resolution and duration for Omni", () => {
    expect(modelOptions("Omni 1.1 Flash", { resolution: "720p", duration: 8 })).toEqual({ resolution: "720p", duration: 8 });
  });
  it("drops them for Veo and says so only when something was asked", () => {
    expect(modelOptions("Veo 3.1 - Fast", { resolution: "360p", duration: 4 })).toEqual({ ignored: VEO_IGNORED_NOTE });
    expect(modelOptions("Veo 3.1 - Fast", {})).toEqual({});
  });
});

describe("what is new since Start (key flips, repeated titles)", () => {
  const U = (n: number) => `0000000${n}-0000-0000-0000-000000000000`;
  const img = (n: number, title: string): SnapTile => ({ id: U(n), title, error: false });
  const vidUuid = (n: number, title: string): SnapTile => ({ id: U(n), title, error: false });
  const vidAsb = (token: string, title: string): SnapTile => ({ id: `title:${title}`, thumb: token, title, error: false });
  const titles = (now: SnapTile[], r: { fresh: number[] }) => r.fresh.map((i) => now[i]!.title);

  it("an old video whose key flipped from uuid to asb is not new; the new clip is", () => {
    const before = [vidUuid(1, "Red kite rises"), img(2, "Lantern"), img(3, "Pier")];
    const now = [vidAsb("NEWTOKEN1", "Paper airplane lands"), vidAsb("KITETOKEN1", "Red kite rises"), img(2, "Lantern"), img(3, "Pier")];
    const r = locateNew(before, now);
    expect(r.anchored).toBe(true);
    expect(titles(now, r)).toEqual(["Paper airplane lands"]);
  });
  it("a new tile sharing an old tile's title does not shift the alignment", () => {
    const before = [vidAsb("OLDTOKEN1", "Paper airplane"), img(2, "Lantern"), img(3, "Pier")];
    const now = [vidUuid(9, "Paper airplane"), vidAsb("OLDTOKEN1", "Paper airplane"), img(2, "Lantern"), img(3, "Pier")];
    const r = locateNew(before, now);
    expect(r.fresh).toEqual([0]);
  });
  it("nothing new when the grid is unchanged apart from a key flip", () => {
    const before = [vidUuid(1, "A"), vidUuid(2, "B")];
    const now = [vidAsb("TOKENAAAA", "A"), vidAsb("TOKENBBBB", "B")];
    expect(locateNew(before, now).fresh).toEqual([]);
  });
  it("takes several new tiles in grid order and counts failed ones", () => {
    const before = [img(1, "Old")];
    const failed: SnapTile = { id: "", title: "", error: true };
    const now = [img(5, "N3"), failed, img(4, "N1"), img(1, "Old")];
    const r = locateNew(before, now);
    expect(r.fresh).toEqual([0, 1, 2]);
    expect(r.errors).toEqual([1]);
  });
  it("an image replaced in place (new uuid, same title) counts as new", () => {
    const before = [img(1, "Teapot"), img(2, "B")];
    const now = [img(7, "Teapot"), img(2, "B")];
    expect(locateNew(before, now).fresh).toEqual([0]);
  });
  it("an empty snapshot makes everything new; an unrecognised one too", () => {
    expect(locateNew([], [img(1, "A")]).fresh).toEqual([0]);
    const r = locateNew([img(1, "A")], [vidAsb("TOKENZZZZ", "Z")]);
    expect(r.anchored).toBe(false);
    expect(r.fresh).toEqual([0]);
  });
  it("merges scrolled views without repeating tiles", () => {
    const a = [img(1, "A"), img(2, "B"), img(3, "C")];
    const b = [img(3, "C"), img(4, "D")];
    expect(mergeView(a, b).map((t) => t.title)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("picker titles (FMM-14)", () => {
  it("drops a trailing ellipsis and extra spaces", () => {
    expect(pickerTitle("Mara adjusting oversized yellow …")).toBe("Mara adjusting oversized yellow");
    expect(pickerTitle("Mara adjusting  oversized yellow...")).toBe("Mara adjusting oversized yellow");
    expect(pickerTitle("Ferry approaches island lighthouse")).toBe("Ferry approaches island lighthouse");
    expect(pickerTitle("Wait... what")).toBe("Wait... what");
  });
  it("cuts a long search text at a word boundary", () => {
    const long = "A very long title about a ferry approaching the island lighthouse at dusk in heavy fog";
    const t = pickerSearchText(long);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(t)).toBe(true);
    expect(long[t.length]).toBe(" ");
    expect(pickerSearchText("Short title")).toBe("Short title");
  });
  it("matches an option by a prefix of the cleaned title", () => {
    expect(optionMatchesTitle("Mara adjusting oversized yellow raincoat Image", "Mara adjusting oversized yellow …")).toBe(true);
    expect(optionMatchesTitle("mara ADJUSTING oversized yellow raincoat Image", "Mara adjusting oversized yellow...")).toBe(true);
    expect(optionMatchesTitle("voice_selection Aoede Female", "Aoede")).toBe(true);
    expect(optionMatchesTitle("Ferry approaches island lighthouse Image", "Mara adjusting")).toBe(false);
    expect(optionMatchesTitle("Anything Image", "")).toBe(false);
  });
});
