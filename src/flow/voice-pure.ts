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

// ---- Flow character voices (FMM-16) ----
// "Select a voice" lists Flow's stock voices as options like "voice_selection Achernar Female, soft, high pitch". The list is
// a virtual one: only about 15 of the 30 (the Gemini TTS names, alphabetical) are rendered at a time, so the driver scrolls
// it and collects every option text; names repeat across scroll steps and are de-duplicated here, in order.
export function stockVoiceNames(optionTexts: string[]): string[] {
  const names = optionTexts.map((t) => t.replace(/voice_selection/g, "").trim().split(/[^A-Za-z0-9]+/)[0] ?? "").filter(Boolean);
  return names.filter((n, i) => names.indexOf(n) === i);
}

// Whether the option texts (any scroll step) include the voice, as a whole word, case-insensitive.
export function hasVoice(optionTexts: string[], voice: string): boolean {
  const want = voice.trim().toLowerCase();
  return !!want && stockVoiceNames(optionTexts).some((n) => n.toLowerCase() === want);
}

export function voiceNotFoundWarning(voice: string, optionTexts: string[]): string {
  const names = stockVoiceNames(optionTexts);
  return `Voice "${voice}" is not in Flow's character voice list, so the character was made WITHOUT a voice (call flow_character again with another name or pick one in Flow's character editor). ${
    names.length ? `Flow's character voices (the whole scrolled list): ${names.join(", ")}. ` : ""
  }`.trim();
}

// ---- ElevenLabs (FMM-17) ----
// Pure parts of the ElevenLabs engine (src/flow/elevenlabs.ts): error codes, the key redactor and the readers of
// GET /v1/user/subscription, /v1/models and /v1/voices. The free tier only: see CLAUDE.md.

export const ELEVEN_DEFAULT_RESERVE = 200;

export type ElevenCode =
  | "E_ELEVEN_KEY" // no key, or ElevenLabs refused it (401 invalid key or missing permissions)
  | "E_ELEVEN_QUOTA" // the line would go past the free quota minus the reserve, or ElevenLabs says quota_exceeded
  | "E_ELEVEN_PAID_TIER" // the account is not on the free tier or could bill past its limit
  | "E_ELEVEN_LANG" // the model does not read the line's language
  | "E_ELEVEN_BLOCKED" // ElevenLabs answered detected_unusual_activity (the free tier blocks some VPNs and proxies)
  | "E_ELEVEN_MODEL" // the model is not on the account's /v1/models list or cannot do text to speech
  | "E_ELEVEN_RATE" // HTTP 429 (FMM-21); a text-to-speech request is not resent, because the repo cannot show that a 429 means "not charged"
  | "E_ELEVEN_API"; // any other answer, or ElevenLabs could not be reached

// The message starts with the code, so a tool error reads "E_ELEVEN_QUOTA: ...".
export class ElevenError extends Error {
  readonly code: ElevenCode;
  constructor(code: ElevenCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// Every error, log line and result goes through this: the key value becomes "[key]".
export function redactKey(text: string, key: string | undefined): string {
  if (!key) return text;
  return text.split(key).join("[key]");
}

// FLOW_MUSIC_MCP_ELEVEN_RESERVE: credits always left unused. Unset, empty or not a whole number >= 0 -> 200.
export function elevenReserve(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  const n = text === "" ? NaN : Number(text);
  return Number.isInteger(n) && n >= 0 ? n : ELEVEN_DEFAULT_RESERVE;
}

export interface ElevenSubscription {
  tier: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
  canExtend: boolean;
  // true when the account could be billed: a tier other than "free", or usage-based extension allowed.
  paidRisk: boolean;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function readSubscription(raw: unknown): ElevenSubscription {
  const s = (raw ?? {}) as Record<string, unknown>;
  const tier = typeof s.tier === "string" ? s.tier : "unknown";
  const used = num(s.character_count);
  const limit = num(s.character_limit);
  const reset = num(s.next_character_count_reset_unix);
  const canExtend = s.can_extend_character_limit === true;
  return {
    tier,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: reset > 0 ? new Date(reset * 1000).toISOString() : null,
    canExtend,
    paidRisk: tier !== "free" || canExtend,
  };
}

export interface ElevenModel {
  id: string;
  tts: boolean;
  hr: boolean;
  en: boolean;
  multiplier: number;
  languages: string[];
}

// "hr-HR", "HR", "hrv"? -> the two-letter part before any "-" or "_", lower case.
export const langOf = (code: string): string => code.trim().toLowerCase().split(/[-_]/)[0] ?? "";

// /v1/models is an array of { model_id, can_do_text_to_speech, languages: [{ language_id, name }], model_rates?:
// { character_cost_multiplier } }. The multiplier is 1.0 when the answer has none.
export function readModels(raw: unknown): ElevenModel[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((m) => (m ?? {}) as Record<string, unknown>)
    .filter((m) => typeof m.model_id === "string")
    .map((m) => {
      const languages = (Array.isArray(m.languages) ? m.languages : [])
        .map((l) => langOf(String(((l ?? {}) as Record<string, unknown>).language_id ?? "")))
        .filter(Boolean);
      const rates = (m.model_rates ?? {}) as Record<string, unknown>;
      const mult = rates.character_cost_multiplier ?? m.character_cost_multiplier;
      return {
        id: m.model_id as string,
        tts: m.can_do_text_to_speech === true,
        hr: languages.includes("hr"),
        en: languages.includes("en"),
        multiplier: typeof mult === "number" && Number.isFinite(mult) && mult > 0 ? mult : 1,
        languages,
      };
    });
}

export interface ElevenVoice {
  voiceId: string;
  name: string;
  category: string;
  labels: { gender?: string; age?: string; accent?: string; description?: string };
}

// /v1/voices -> { voices: [{ voice_id, name, category, labels }] }. Preview URLs are dropped (never downloaded).
export function readVoices(raw: unknown): ElevenVoice[] {
  const list = ((raw ?? {}) as Record<string, unknown>).voices;
  return (Array.isArray(list) ? list : [])
    .map((v) => (v ?? {}) as Record<string, unknown>)
    .filter((v) => typeof v.voice_id === "string")
    .map((v) => {
      const l = (v.labels ?? {}) as Record<string, unknown>;
      const s = (x: unknown) => (typeof x === "string" && x ? x : undefined);
      return {
        voiceId: v.voice_id as string,
        name: typeof v.name === "string" ? v.name : "",
        category: typeof v.category === "string" ? v.category : "",
        labels: { gender: s(l.gender), age: s(l.age), accent: s(l.accent), description: s(l.description ?? l.descriptive) },
      };
    });
}

// An ElevenLabs error answer -> code and a readable message. Bodies look like { detail: { status, message } } (newer:
// { detail: { type, code, message } }) or { detail: "text" }. The caller redacts the result.
export function elevenApiError(status: number, body: string): { code: ElevenCode; message: string } {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as Record<string, unknown>).detail;
  } catch {
    detail = undefined;
  }
  const d = (detail && typeof detail === "object" ? detail : {}) as Record<string, unknown>;
  const kind = [d.status, d.code, d.type].filter((x) => typeof x === "string").join(" ");
  const said = typeof d.message === "string" ? d.message : typeof detail === "string" ? detail : body.slice(0, 300);
  const text = `${kind} ${said}`;
  const says = `ElevenLabs says (${status}${kind ? ` ${kind}` : ""}): ${said || "no detail"}`;
  if (/quota_exceeded/i.test(text)) return { code: "E_ELEVEN_QUOTA", message: `the free monthly quota is used up for this line. ${says}` };
  if (/detected_unusual_activity/i.test(text)) {
    return { code: "E_ELEVEN_BLOCKED", message: `ElevenLabs blocked the free tier for unusual activity (a VPN or proxy can cause it). Nothing was made. ${says}` };
  }
  if (status === 401 || status === 403) {
    const scope = /permission/i.test(text) ? " The key lacks a permission: allow Text to Speech and read access to Voices, Models and User in the key's settings." : "";
    return { code: "E_ELEVEN_KEY", message: `ElevenLabs refused the key.${scope} ${says}` };
  }
  if (status === 429) return { code: "E_ELEVEN_RATE", message: `rate limited; try again in a minute (a text-to-speech request is never resent automatically: a 429 may still have been billed, so check flow_elevenlabs_status first). ${says}` };
  return { code: "E_ELEVEN_API", message: says };
}

// ---- ElevenLabs narration (FMM-18) ----
export const ELEVEN_DEFAULT_MODEL = "eleven_multilingual_v2";
// Allowed on the free tier (pcm_44100, wav_44100 and mp3_44100_192 are paid-only); ffmpeg converts it to the asked format.
export const ELEVEN_OUTPUT_FORMAT = "mp3_44100_128";
// Models that take `language_code`; eleven_multilingual_v2 does not (its language follows the text).
export const ELEVEN_LANGUAGE_CODE_MODELS: readonly string[] = ["eleven_flash_v2_5", "eleven_turbo_v2_5"];

// Credits a line costs: its characters times the model's multiplier, rounded up.
export const elevenEstimate = (text: string, multiplier: number): number => Math.ceil([...text].length * multiplier);

export interface ElevenGuardInput {
  text: string;
  model: string;
  language?: string;
  subscription: ElevenSubscription;
  models: ElevenModel[];
  reserve: number;
}

export type ElevenGuard = { ok: true; estimate: number; model: ElevenModel } | { ok: false; code: ElevenCode; message: string; estimate?: number };

// Whether a line may be sent. Checked before every TTS request; a refusal sends nothing. Order: billing risk, model,
// language, then the quota (refused when estimate > remaining - reserve).
export function elevenGuard(g: ElevenGuardInput): ElevenGuard {
  const s = g.subscription;
  if (s.paidRisk) {
    return {
      ok: false,
      code: "E_ELEVEN_PAID_TIER",
      message: `the ElevenLabs account is on tier "${s.tier}"${s.canExtend ? " and can extend its character limit (usage-based billing)" : ""}. This engine runs only on the free tier, so nothing can bill money. Nothing was sent.`,
    };
  }
  const model = g.models.find((m) => m.id === g.model);
  if (!model || !model.tts) {
    const tts = g.models.filter((m) => m.tts).map((m) => m.id);
    return { ok: false, code: "E_ELEVEN_MODEL", message: `model "${g.model}" ${model ? "cannot do text to speech" : "is not on this account's model list"}. Text-to-speech models: ${tts.join(", ") || "none"}. Nothing was sent.` };
  }
  const lang = g.language ? langOf(g.language) : "";
  if (lang && !model.languages.includes(lang)) {
    return { ok: false, code: "E_ELEVEN_LANG", message: `model "${model.id}" does not read "${lang}" (its languages: ${model.languages.join(", ") || "none listed"}). Nothing was sent.` };
  }
  const estimate = elevenEstimate(g.text, model.multiplier);
  const allowed = s.remaining - g.reserve;
  if (estimate > allowed) {
    return {
      ok: false,
      code: "E_ELEVEN_QUOTA",
      estimate,
      message: `this line needs about ${estimate} credits but only ${Math.max(0, allowed)} may be spent (remaining ${s.remaining} minus reserve ${g.reserve}${s.resetAt ? `; the quota resets ${s.resetAt}` : ""}). Use another engine for it. Nothing was sent.`,
    };
  }
  return { ok: true, estimate, model };
}

export interface ElevenAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface TimedWord {
  w: string;
  t0: number;
  t1: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

// ElevenLabs' character alignment -> words: split on whitespace, punctuation dropped from each word's edges (inner marks
// such as an apostrophe stay), letters of any script kept (č ć ž š đ). A "word" with no letter or digit is dropped.
export function alignmentToWords(a: ElevenAlignment | undefined | null): TimedWord[] {
  if (!a) return [];
  const words: TimedWord[] = [];
  let cur: { ch: string; t0: number; t1: number }[] = [];
  const flush = () => {
    let from = 0;
    let to = cur.length - 1;
    while (from <= to && !WORD_CHAR.test(cur[from]!.ch)) from++;
    while (to >= from && !WORD_CHAR.test(cur[to]!.ch)) to--;
    if (from <= to) {
      const part = cur.slice(from, to + 1);
      words.push({ w: part.map((c) => c.ch).join(""), t0: round3(part[0]!.t0), t1: round3(part[part.length - 1]!.t1) });
    }
    cur = [];
  };
  a.characters.forEach((ch, i) => {
    if (/^\s+$/u.test(ch)) return flush();
    cur.push({ ch, t0: a.character_start_times_seconds[i] ?? 0, t1: a.character_end_times_seconds[i] ?? 0 });
  });
  flush();
  return words;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
