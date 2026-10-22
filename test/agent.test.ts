import { describe, expect, it } from "vitest";
import { matchScenes, newestNanoBanana } from "../src/flow/agent.js";

describe("newestNanoBanana", () => {
  it("picks the highest version that is not Lite", () => {
    const names = ["Nano Banana Pro", "Nano Banana 2 Lite", "Nano Banana 2.1"];
    expect(newestNanoBanana(names)).toBe(2);
  });
  it("compares versions part by part", () => {
    expect(newestNanoBanana(["Nano Banana 2.1", "Nano Banana 2.10", "Nano Banana 2.9"])).toBe(1);
    expect(newestNanoBanana(["Nano Banana 2", "Nano Banana 3", "Nano Banana 2.5"])).toBe(1);
    expect(newestNanoBanana(["Nano Banana 2.2", "Nano Banana 2.1"])).toBe(0);
  });
  it("ignores names without a version and Lite models", () => {
    expect(newestNanoBanana(["Nano Banana Pro", "Nano Banana 3 Lite"])).toBe(-1);
    expect(newestNanoBanana([])).toBe(-1);
  });
});

describe("matchScenes", () => {
  const scenes = [
    "A red fox sitting in fresh snow, flat cartoon style.",
    "A blue heron standing in a quiet river at dawn, flat cartoon style.",
    "A small wooden boat drifting under a bright full moon, flat cartoon style.",
  ];

  it("matches tiles that arrive in finish order (3, 1, 2) by the stored prompt, without the Scene N: prefix", () => {
    const prompts = [scenes[2]!, scenes[0]!, scenes[1]!];
    expect(matchScenes(scenes, prompts)).toEqual([[1], [2], [0]]);
  });

  it("gives leftover tiles to their best scene as extra takes", () => {
    const prompts = [scenes[0]!, scenes[1]!, scenes[0]!];
    const out = matchScenes(scenes, prompts);
    expect(out[0]).toHaveLength(2);
    expect(out[1]).toEqual([1]);
    expect(out[2]).toEqual([]);
  });

  it("leaves a scene empty when no prompt covers half its words", () => {
    expect(matchScenes(scenes, ["Something entirely unrelated about trains"])).toEqual([[], [], []]);
  });

  it("handles no tiles and no scenes", () => {
    expect(matchScenes(scenes, [])).toEqual([[], [], []]);
    expect(matchScenes([], ["anything"])).toEqual([]);
  });
});
