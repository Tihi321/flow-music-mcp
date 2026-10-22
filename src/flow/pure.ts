// Pure helpers for the Flow driver: no playwright, env or fs imports, so tests can load them.

// ---- Video identity (FMM-08) ----
// A settled video tile has no uuid. Its thumbnail is https://flow.google.com/asb/<token>, and on a real pointer hover the img
// is replaced by a <video> whose src starts with the same token plus more characters (mapped 2026-10-22). The handle is
// "asb:<token>". TILE_JS in driver.ts repeats this regex inside the page, keep them in step.
const ASB_RE = /\/asb\/([^/?#"'\s]+)/;

export const asbToken = (src: string | null | undefined): string | undefined => (src ? ASB_RE.exec(src)?.[1] : undefined);

// A user-given handle ("asb:<token>") -> the token, or undefined when it is some other kind of id.
export function parseAsbHandle(id: string): string | undefined {
  if (!id.startsWith("asb:")) return undefined;
  const token = id.slice(4).replace(/[^A-Za-z0-9_\-.~%]/g, "");
  return token.length >= 8 ? token : undefined;
}

// The key a tile is de-duplicated and diffed by: its id, except that an id-less settled video (id "title:<title>", titles
// repeat) is keyed by its thumbnail token. The tile's own id is left as it is.
export const tileKey = (t: { id: string; thumb?: string }): string => (t.id.startsWith("title:") && t.thumb ? `asb:${t.thumb}` : t.id);

// Whether a tile (its current thumb token and title) is the one a handle names. Prefix both ways: a hover <video> token is
// longer than the thumbnail's, and a handle may have been recorded from either. Never by title (titles repeat).
export function tileMatchesHandle(tile: { id?: string; thumb?: string }, handle: string): boolean {
  if (tile.id && tile.id === handle) return true;
  const token = parseAsbHandle(handle);
  if (!token || !tile.thumb) return false;
  return tile.thumb.startsWith(token) || token.startsWith(tile.thumb);
}

// ---- Trouble in Flow's own words ----

export interface FlowTrouble {
  kind: "high_demand" | "went_wrong" | "failed";
  // Flow itself says the credits come back or were not charged.
  refunded: boolean;
  text: string;
}

// Classifies a page notice or an agent reply. High demand wins over a plain failure: it is the reason.
export function flowTrouble(text: string): FlowTrouble | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const kind = /experiencing high demand/i.test(t) ? "high_demand" : /something went wrong/i.test(t) ? "went_wrong" : /failed to generate|generation failed/i.test(t) ? "failed" : undefined;
  if (!kind) return undefined;
  return { kind, refunded: /refund|not charged/i.test(t), text: t.slice(0, 300) };
}

// The sentence an error starts with. Credits are said to come back only when Flow says so.
export function troubleMessage(t: FlowTrouble): string {
  const lead = t.kind === "high_demand" ? "Flow reports high demand" : t.kind === "went_wrong" ? "Flow reported an error (\"Something went wrong\")" : "Flow reported a failed generation";
  return `${lead}: ${t.text}${t.refunded ? " (Flow says credits are refunded for failed requests; check the balance.)" : ""}`;
}

// ---- Cancel ----

export const CANCEL_BEFORE_START = "cancelled before starting (nothing spent)";
export const CANCEL_AFTER_START = "cancelled; the generation already started in Flow and will finish and be charged there";
export const FINISHED_AFTER_CANCEL = "finished before the cancel took effect";

// ---- Failed tiles ----

// Indexes (in grid order) of failed tiles above the first tile that existed before the job. Failed tiles have no id, so they
// are told apart by position, as in scanNew. With no known tile in view every failed tile counts.
export function newErrorIndexes(tiles: { id: string; error: boolean }[], known: Set<string>): number[] {
  const firstKnown = tiles.findIndex((t) => t.id && known.has(t.id));
  const end = firstKnown < 0 ? tiles.length : firstKnown;
  const out: number[] = [];
  for (let i = 0; i < end; i++) if (tiles[i]!.error) out.push(i);
  return out;
}

// ---- Re-ask for dropped scenes ----

export const MAX_ROUNDS = 3;

// The scenes (indexes) to ask the agent for in round `round` (0 = the first ask), or [] when the run is over: all done, the
// rounds are used up, or a re-ask round after the first re-ask made nothing (another would not either). `lastProduced` is
// the number of scenes the previous round delivered.
export function sceneRound(total: number, done: Set<number>, round: number, lastProduced?: number): number[] {
  if (round >= MAX_ROUNDS) return [];
  if (round >= 2 && lastProduced === 0) return [];
  const todo: number[] = [];
  for (let i = 0; i < total; i++) if (!done.has(i)) todo.push(i);
  return todo;
}
