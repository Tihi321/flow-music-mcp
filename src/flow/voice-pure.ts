// Pure helpers for the narration tools (FMM-11): no env, fs or process imports, so tests can load them.

// ---- Output formats ----
export const AUDIO_FORMATS = ["mp3", "wav", "ogg", "m4a"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

// ffmpeg encoder arguments per target format (placed before the output file). m4a adds none: it is what ffmpeg picks for
// that extension (AAC), so a call without `format` makes the same file as before FMM-11.
const FORMAT_ARGS: Record<AudioFormat, string[]> = {
  m4a: [],
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  wav: ["-c:a", "pcm_s16le"],
  ogg: ["-c:a", "libvorbis", "-q:a", "5"],
};

export const formatArgs = (format: AudioFormat): string[] => FORMAT_ARGS[format];

// The target path's format, from its extension; unknown or missing -> m4a (the old behaviour).
export function formatOf(target: string): AudioFormat {
  const ext = /\.(\w+)$/.exec(target)?.[1]?.toLowerCase();
  return (AUDIO_FORMATS as readonly string[]).includes(ext ?? "") ? (ext as AudioFormat) : "m4a";
}

// ---- Text length ----
// The paid Flow engine speaks inside a short video take; gemini and windows have no such limit.
export const TEXT_MAX = { flow: 400, gemini: 4000, windows: 4000 } as const;
export const TEXT_MAX_ANY = 4000;

export function textLimitError(engine: keyof typeof TEXT_MAX, text: string): string | undefined {
  const max = TEXT_MAX[engine];
  return text.length > max ? `Text is ${text.length} characters; engine "${engine}" takes at most ${max}.` : undefined;
}

// ---- Gemini voices ----
export interface GeminiVoice {
  name: string;
  description: string;
  gender: "female" | "male";
}

// Gemini's prebuilt voices (genders as listed by Google's voice catalogue). Flow draws on the same set.
export const GEMINI_VOICES: GeminiVoice[] = [
  { name: "Zephyr", description: "bright", gender: "female" }, { name: "Puck", description: "upbeat", gender: "male" },
  { name: "Charon", description: "informative", gender: "male" }, { name: "Kore", description: "firm", gender: "female" },
  { name: "Fenrir", description: "excitable", gender: "male" }, { name: "Leda", description: "youthful", gender: "female" },
  { name: "Orus", description: "firm", gender: "male" }, { name: "Aoede", description: "breezy", gender: "female" },
  { name: "Callirrhoe", description: "easy-going", gender: "female" }, { name: "Autonoe", description: "bright", gender: "female" },
  { name: "Enceladus", description: "breathy", gender: "male" }, { name: "Iapetus", description: "clear", gender: "male" },
  { name: "Umbriel", description: "easy-going", gender: "male" }, { name: "Algieba", description: "smooth", gender: "male" },
  { name: "Despina", description: "smooth", gender: "female" }, { name: "Erinome", description: "clear", gender: "female" },
  { name: "Algenib", description: "gravelly", gender: "male" }, { name: "Rasalgethi", description: "informative", gender: "male" },
  { name: "Laomedeia", description: "upbeat", gender: "female" }, { name: "Achernar", description: "soft", gender: "female" },
  { name: "Alnilam", description: "firm", gender: "male" }, { name: "Schedar", description: "even", gender: "male" },
  { name: "Gacrux", description: "mature", gender: "female" }, { name: "Pulcherrima", description: "forward", gender: "female" },
  { name: "Achird", description: "friendly", gender: "male" }, { name: "Zubenelgenubi", description: "casual", gender: "male" },
  { name: "Vindemiatrix", description: "gentle", gender: "female" }, { name: "Sadachbia", description: "lively", gender: "male" },
  { name: "Sadaltager", description: "knowledgeable", gender: "male" }, { name: "Sulafat", description: "warm", gender: "female" },
];

export const DEFAULT_GEMINI_TTS = "gemini-3.8-flash-tts";

// ---- Windows voices ----
export interface WindowsVoice {
  name: string;
  culture: string;
  gender?: "female" | "male";
  description: string;
}

// One line per installed voice: "Name|culture|gender" (gender optional). Every culture is kept, not only en-*.
export function parseWindowsVoices(out: string): WindowsVoice[] {
  const voices: WindowsVoice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [name, culture, gender] = line.trim().split("|").map((s) => s.trim());
    if (!name || !culture) continue;
    const g = /^female$/i.test(gender ?? "") ? "female" : /^male$/i.test(gender ?? "") ? "male" : undefined;
    voices.push({ name, culture, ...(g ? { gender: g } : {}), description: `${culture} · Windows, free` });
  }
  return voices;
}

// ---- Gemini errors ----
// Google's 429 text carries the quota and a retry time, e.g. "Quota exceeded for metric: ...generate_content_free_tier_requests,
// limit: 10, model: gemini-3.8-flash-tts ... Please retry in 19h56m" or "Please retry in 34.5s".
export function geminiRetrySeconds(detail?: string): number | undefined {
  const m = /retry in[ ]+((?:[0-9]+(?:[.][0-9]+)?[ ]*[dhms][ ]*)+)/i.exec(detail ?? "");
  if (!m) return undefined;
  let total = 0;
  for (const part of (m[1] ?? "").matchAll(/([0-9]+(?:[.][0-9]+)?)[ ]*([dhms])/gi)) total += Number(part[1] ?? 0) * { d: 86400, h: 3600, m: 60, s: 1 }[(part[2] ?? "s").toLowerCase() as "d" | "h" | "m" | "s"];
  return total;
}

export function geminiQuotaLimit(detail?: string): number | undefined {
  const m = /limit:[ ]*([0-9]+)/i.exec(detail ?? "");
  return m ? Number(m[1]) : undefined;
}

function waitText(seconds: number): string {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const min = Math.round((seconds % 3600) / 60);
    return min ? `${h}h ${min}m` : `${h}h`;
  }
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.ceil(seconds)} s`;
}

export function geminiRateLimited(detail?: string): string {
  const says = `Google says: ${detail ?? "no detail"}`;
  const seconds = geminiRetrySeconds(detail);
  if (seconds !== undefined && seconds >= 3600) {
    const limit = geminiQuotaLimit(detail);
    return `Gemini TTS rate limited (HTTP 429): the daily free quota${limit !== undefined ? ` (limit ${limit})` : ""} is used up; it resets in about ${waitText(seconds)}. Waiting a minute will not help: use engine "windows" meanwhile, or try again after the reset. ${says}`;
  }
  const wait = seconds !== undefined ? `about ${waitText(seconds)}` : "about a minute";
  return `Gemini TTS rate limited (HTTP 429): the free tier allows only a few requests per minute. Wait ${wait} and retry. ${says}`;
}
