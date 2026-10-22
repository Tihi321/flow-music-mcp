// Pure helpers with no imports, so tests can load them without Chrome, playwright or .env.

// File-name part of a title: lower case, ASCII, words joined with "-", at most 60 characters.
export const slug = (s: string, fallback: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 60) || fallback;

// Audio type from a file's first 12 bytes (Flow Music saves under a bare id). Undefined when unknown.
export function audioExtensionOfBytes(head: Buffer): string | undefined {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (ascii(0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return ".mp3";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return ".wav";
  if (ascii(4, 8) === "ftyp") return ".m4a";
  if (ascii(0, 4) === "OggS") return ".ogg";
  if (ascii(0, 4) === "fLaC") return ".flac";
  if (ascii(0, 2) === "PK") return ".zip";
  return undefined;
}

// Image or video type from a file's first 12 bytes (Flow saves under a bare id with no extension). ".bin" when unknown.
export function mediaExtensionOfBytes(head: Buffer): string {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return ".png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(4, 8) === "ftyp") return ".mp4";
  if (ascii(0, 4) === "GIF8") return ".gif";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  return ".bin";
}

// Milliseconds still to wait before the next job: the pause is random between minMs and maxMs after the last job
// finished. Zero or less means go now; no job has finished yet (undefined/0) means no pause. `rand` is Math.random.
export const nextDelay = (lastFinished: number | undefined, now: number, minMs: number, maxMs: number, rand: () => number): number =>
  lastFinished ? lastFinished + minMs + rand() * (maxMs - minMs) - now : 0;

// What the text of a finished take's row says about it. A failed take has not been seen yet: this guesses.
export function classifySongText(text: string): "ready" | "busy" | "failed" {
  if (/\bfailed\b|couldn.t|could not|something went wrong/i.test(text)) return "failed";
  if (/\d+\s*%|generating/i.test(text)) return "busy";
  return "ready";
}

// The "still rendering" note in a session's text: "NN% Generating <title>", or "creating" while only `Creating "..."` shows.
export const renderingNote = (text: string): string | undefined =>
  /(\d+%\s*)?Generating [^.]{0,60}/.exec(text)?.[0] ?? (/Creating "/.test(text) ? "creating" : undefined);

// "13190 credits" (menu item text) -> 13190. Thousands separators are dropped. Undefined when it is not a credits line.
export function parseCredits(text: string): number | undefined {
  const m = /^([\d,.]+)\s+credits$/i.exec(text.replace(/\s+/g, " ").trim());
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// Length for Compose's Advanced box: "m:ss" or a bare number of minutes, from 1:00 to 3:00 (Flow Music clamps outside that).
export function lengthSeconds(length: string): number | undefined {
  const s = length.trim();
  const mmss = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  if (/^\d{1,2}$/.test(s)) return Number(s) * 60;
  return undefined;
}
export const lengthValid = (length: string): boolean => {
  const sec = lengthSeconds(length);
  return sec !== undefined && sec >= 60 && sec <= 180;
};

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Model menu items read "<model> <description>" ("Lyria 3.5 Top performing, flagship model", "Lyria 3 Pro Legacy model"),
// so match the name at the start followed by a space or the end: "Lyria 3" must not match "Lyria 3.5".
export const modelItemPattern = (model: string): RegExp => new RegExp(`^${escapeRegExp(model.trim())}(\\s|$)`);
