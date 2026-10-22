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

// ---- Model options (FMM-09) ----
// Veo models have no resolution and no duration radios in the direct composer's popover (mapped 2026-10-22): clips are
// fixed at 8 s. Those two options exist for Omni only, so asking for them under Veo must be ignored, not an error.
export const isVeoModel = (name: string | undefined): boolean => /^veo/i.test((name ?? "").replace(/^[^A-Za-z]+/, "").trim());

export const VEO_IGNORED_NOTE = "Veo 3.1 clips are fixed at 8 s; resolution/duration are Omni-only, ignored";

// Which of the requested resolution/duration the model's popover can take, and a note when some were dropped.
export function modelOptions(model: string | undefined, want: { resolution?: string; duration?: number }): { resolution?: string; duration?: number; ignored?: string } {
  if (!isVeoModel(model)) return { resolution: want.resolution, duration: want.duration };
  return want.resolution || want.duration ? { ignored: VEO_IGNORED_NOTE } : {};
}

// ---- What is new since Start (FMM-09) ----
// A video tile's identity changes over its life: a uuid right after it lands, an /asb/ token once Flow re-signs the thumbnail
// (live 2026-10-22: a finished clip from another job was taken as new and downloaded). So "new" must not rest on one key.
// The grid is newest first: the tiles now are [new tiles..., the tiles of the snapshot...]. The offset is found by aligning
// the snapshot with the current list position by position, scoring each pair (same uuid or same token 2, same title 1,
// different token 0), so a flipped key still aligns by position and title, and a new tile that shares an old tile's title
// cannot shift the alignment.
export interface SnapTile {
  id: string;
  thumb?: string;
  title: string;
  error: boolean;
}

const isUuid = (id: string) => !!id && !id.startsWith("title:");
const sameToken = (a: string, b: string) => a.startsWith(b) || b.startsWith(a); // a hover <video> token is longer

// 2 = same tile by a strong identity, 1 = same title only, 0 = different, -1 = replaced in place (same slot, new uuid).
export function tileMatch(a: SnapTile, b: SnapTile): number {
  if (isUuid(a.id) && isUuid(b.id)) return a.id === b.id ? 2 : -1;
  if (a.thumb && b.thumb) return sameToken(a.thumb, b.thumb) ? 2 : 0;
  if (a.error || b.error) return a.error && b.error ? 1 : 0;
  return a.title && a.title === b.title ? 1 : 0;
}

export interface NewTiles {
  fresh: number[]; // indexes into `now` of the new tiles (above the anchor, plus tiles replaced in place)
  errors: number[]; // indexes of new failed tiles
  anchor: number; // how many tiles of `now` sit above the snapshot's first tile
  overlap: number; // how many snapshot tiles were compared
  anchored: boolean; // false: nothing of the snapshot was recognised (then every tile counts as new)
}

export function locateNew(before: SnapTile[], now: SnapTile[]): NewTiles {
  let best = { k: now.length, score: 0, overlap: 0 };
  if (before.length) {
    for (let k = 0; k < now.length; k++) {
      const overlap = Math.min(before.length, now.length - k);
      let score = 0;
      for (let i = 0; i < overlap; i++) score += Math.max(0, tileMatch(before[i]!, now[k + i]!));
      // Ties go to the smaller offset: missing a new tile is safer than taking an old one.
      if (score > best.score) best = { k, score, overlap };
    }
  }
  const anchored = best.score > 0 || !before.length;
  const k = anchored ? best.k : now.length;
  const fresh: number[] = [];
  for (let i = 0; i < now.length; i++) {
    const replaced = i >= k && i - k < before.length && tileMatch(before[i - k]!, now[i]!) === -1;
    if (i < k || replaced) fresh.push(i);
  }
  return { fresh, errors: fresh.filter((i) => now[i]!.error), anchor: k, overlap: best.overlap, anchored };
}

// Appends the part of a later view of the virtual list that goes beyond what was collected so far.
export function mergeView<T extends SnapTile>(all: T[], view: T[]): T[] {
  for (let a = all.length - 1; a >= 0; a--) {
    const last = all[a]!;
    if (!isUuid(last.id) && !last.thumb) continue;
    const at = view.findIndex((t) => tileMatch(last, t) === 2);
    if (at >= 0) return [...all, ...view.slice(at + 1)];
    break;
  }
  return all.length ? [...all, ...view.filter((t) => !all.includes(t))] : [...view];
}
