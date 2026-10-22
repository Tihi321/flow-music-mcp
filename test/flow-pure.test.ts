import { describe, expect, it } from "vitest";
import { asbToken, flowTrouble, newErrorIndexes, parseAsbHandle, sceneRound, tileKey, tileMatchesHandle, troubleMessage } from "../src/flow/pure.js";

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
