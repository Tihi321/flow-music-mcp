// ElevenLabs text to speech, free tier only (FMM-17). Plain `fetch` (Node 24), no SDK. The key comes from
// ELEVENLABS_API_KEY: the real environment first, then the .env files (src/env.ts; ~/.flow-music-mcp/.env lives outside
// every repo). There is no tool that sets or stores it: only the user does. The key is sent only as the `xi-api-key`
// header, and every error, log line and result goes through `redactKey`, so it never leaves this module.
// FMM-18 adds `speak`: POST /v1/text-to-speech/{voice}/with-timestamps (mp3_44100_128, free tier), the quota and tier
// guard before it, ffmpeg conversion to the asked format, and the character alignment turned into word times.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { ENV_FILES, presetEnv } from "../env.js";
import { plausible } from "./key-format.js";
import {
  ELEVEN_DEFAULT_MODEL,
  ELEVEN_LANGUAGE_CODE_MODELS,
  ELEVEN_OUTPUT_FORMAT,
  ElevenError,
  alignmentToWords,
  elevenApiError,
  elevenGuard,
  elevenReserve,
  formatArgs,
  formatOf,
  langOf,
  readModels,
  readSubscription,
  readVoices,
  redactKey,
  type ElevenAlignment,
  type ElevenModel,
  type ElevenVoice,
  type TimedWord,
} from "./voice-pure.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MUSIC_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MUSIC_MCP_FFPROBE ?? "ffprobe";

// The same conversion as the Gemini engine (gemini.ts): high-pass, loudness -16 LUFS, 48 kHz stereo, the target's
// encoder. Nothing is trimmed, so word times stay relative to the start of the file. Returns the duration in seconds.
async function convertWithFfmpeg(source: string, target: string): Promise<number> {
  await run(FFMPEG, ["-y", "-i", source, "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", ...formatArgs(formatOf(target)), target]);
  const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  return Number(stdout.trim());
}

const BASE = "https://api.elevenlabs.io";
const KEY_NAME = "ELEVENLABS_API_KEY";
// The user's own name for the key, a Windows user-scope variable (HUB-31). Read after KEY_NAME, never in .env files.
const CREATOR_KEY_NAME = "ELEVEN_CREATOR_KEY";

export interface ElevenKey {
  key: string;
  source: "env" | "env:ELEVEN_CREATOR_KEY" | "file";
}

export const ELEVEN_KEY_HINT =
  "No ElevenLabs key yet. The user (never an assistant) makes a free account on elevenlabs.io, creates an API key " +
  "(restricted to Text to Speech plus read access to Voices, Models and User if the dialog offers those), and puts it in " +
  "the ELEVENLABS_API_KEY (or ELEVEN_CREATOR_KEY) environment variable or in ~/.flow-music-mcp/.env as ELEVENLABS_API_KEY=..., then restarts flow-music-mcp.";

// The key: a real environment variable first (ELEVENLABS_API_KEY, then ELEVEN_CREATOR_KEY), then the first .env file that holds a usable one. Reading the files here
// (not only process.env) means an empty ELEVENLABS_API_KEY= copied from .env.example cannot hide the real one.
export function elevenKey(): ElevenKey | undefined {
  const env = plausible(presetEnv[KEY_NAME] ?? "");
  if (env) return { key: env, source: "env" };
  const creator = plausible(presetEnv[CREATOR_KEY_NAME] ?? "");
  if (creator) return { key: creator, source: "env:ELEVEN_CREATOR_KEY" };
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    try {
      const key = plausible(parseEnv(readFileSync(file, "utf8"))[KEY_NAME] ?? "");
      if (key) return { key, source: "file" };
    } catch {
      // An unreadable file is reported by env.ts at start-up.
    }
  }
  return undefined;
}

// One request at a time across the whole process (the free tier allows 2-4 at once; one is safe).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export interface ElevenDeps {
  fetch?: typeof fetch;
  key?: () => ElevenKey | undefined;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  reserve?: () => number;
  convert?: (source: string, target: string) => Promise<number>;
}

export interface ElevenSpeakArgs {
  text: string;
  voice: string;
  target: string;
  model?: string;
  voice_settings?: { stability?: number; similarity_boost?: number; style?: number; speed?: number; use_speaker_boost?: boolean };
  language?: string;
  timestamps?: boolean;
}

// The flow_narrate engine "elevenlabs" result. `words` times are seconds from the start of `file`.
export interface ElevenSpeakResult {
  file: string;
  durationSec: number;
  engine: "elevenlabs";
  voice: string;
  model: string;
  words?: TimedWord[];
  characters: number;
  credits_estimate: number;
  remaining_after: number | null;
}

export interface ElevenStatus {
  ready: boolean;
  source?: ElevenKey["source"];
  tier?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  reserve?: number;
  resetAt?: string | null;
  paidRisk?: boolean;
  models?: { id: string; tts: boolean; hr: boolean; en: boolean; multiplier: number }[];
  code?: string;
  hint?: string;
}

const RETRIES_429 = 3;
const MODELS_TTL_MS = 10 * 60_000;

export function elevenClient(deps: ElevenDeps = {}) {
  const doFetch: typeof fetch = deps.fetch ?? fetch;
  const findKey = deps.key ?? elevenKey;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reserve = deps.reserve ?? (() => elevenReserve(process.env.FLOW_MUSIC_MCP_ELEVEN_RESERVE));
  const convert = deps.convert ?? convertWithFfmpeg;
  let modelsCache: { at: number; models: ElevenModel[] } | undefined;

  const needKey = (): ElevenKey => {
    const k = findKey();
    if (!k) throw new ElevenError("E_ELEVEN_KEY", ELEVEN_KEY_HINT);
    return k;
  };
  const log = (line: string, key: string): void => {
    const text = `[elevenlabs] ${redactKey(line, key)}`;
    if (deps.log) deps.log(text);
    else process.stderr.write(`[${new Date().toISOString()}] ${text}\n`);
  };
  // Re-throws anything as an ElevenError whose message has no key in it.
  const clean = (err: unknown, key: string): ElevenError => {
    if (err instanceof ElevenError) {
      const msg = redactKey(err.message, key);
      return msg === err.message ? err : new ElevenError(err.code, msg.replace(/^E_ELEVEN_\w+: /, ""));
    }
    return new ElevenError("E_ELEVEN_API", redactKey(`could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}`, key));
  };

  // GET or POST one endpoint, one at a time; a 429 waits (Retry-After, else 1, 2, 4 s) and tries again.
  async function request(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<unknown> {
    const { key } = needKey();
    const method = init.method ?? "GET";
    const where = path.split("?")[0];
    try {
      return await serial(async () => {
        for (let attempt = 0; ; attempt++) {
          const res = await doFetch(`${BASE}${path}`, {
            method,
            headers: { "xi-api-key": key, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
            ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          });
          log(`${method} ${where} -> ${res.status}`, key);
          if (res.ok) return (await res.json()) as unknown;
          const text = await res.text().catch(() => "");
          if (res.status === 429 && attempt < RETRIES_429) {
            const after = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
            continue;
          }
          const e = elevenApiError(res.status, text);
          throw new ElevenError(e.code, e.message);
        }
      });
    } catch (err) {
      const e = clean(err, key);
      log(`${method} ${where} failed: ${e.message}`, key);
      throw e;
    }
  }

  async function models(fresh = false): Promise<ElevenModel[]> {
    if (!fresh && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
    const list = readModels(await request("/v1/models"));
    modelsCache = { at: Date.now(), models: list };
    return list;
  }

  const subscription = async () => readSubscription(await request("/v1/user/subscription"));

  // Ready, where the key came from, the live quota and which models read Croatian and English. Never throws and never
  // carries the key: with no key it is { ready: false, hint }; a refused key or an API error is { ready: false, code, hint }.
  async function status(): Promise<ElevenStatus> {
    const k = findKey();
    if (!k) return { ready: false, hint: ELEVEN_KEY_HINT };
    try {
      const sub = await subscription();
      const list = await models(true);
      return {
        ready: true,
        source: k.source,
        tier: sub.tier,
        used: sub.used,
        limit: sub.limit,
        remaining: sub.remaining,
        reserve: reserve(),
        resetAt: sub.resetAt,
        paidRisk: sub.paidRisk,
        models: list.map(({ id, tts, hr, en, multiplier }) => ({ id, tts, hr, en, multiplier })),
      };
    } catch (err) {
      const e = clean(err, k.key);
      return { ready: false, source: k.source, code: e.code, hint: redactKey(e.message, k.key) };
    }
  }

  // The voices this account can use (premade ones on the free tier). Preview files are never downloaded.
  async function voices(): Promise<ElevenVoice[]> {
    return readVoices(await request("/v1/voices"));
  }

  // Speaks one line. The quota and tier are read live and checked BEFORE the TTS request (a refusal sends nothing);
  // afterwards a fresh subscription read gives `remaining_after`.
  async function speak(a: ElevenSpeakArgs): Promise<ElevenSpeakResult> {
    const { key } = needKey();
    const text = a.text.trim();
    const modelId = a.model ?? ELEVEN_DEFAULT_MODEL;
    const sub = await subscription();
    const guard = elevenGuard({ text, model: modelId, language: a.language, subscription: sub, models: await models(), reserve: reserve() });
    if (!guard.ok) {
      const e = new ElevenError(guard.code, redactKey(guard.message, key));
      log(`refused ${modelId}: ${e.message}`, key);
      throw e;
    }
    const body: Record<string, unknown> = { text, model_id: modelId };
    if (a.voice_settings) body.voice_settings = a.voice_settings;
    if (a.language && ELEVEN_LANGUAGE_CODE_MODELS.includes(modelId)) body.language_code = langOf(a.language);
    const raw = (await request(`/v1/text-to-speech/${encodeURIComponent(a.voice)}/with-timestamps?output_format=${ELEVEN_OUTPUT_FORMAT}`, { method: "POST", body })) as {
      audio_base64?: string;
      alignment?: ElevenAlignment | null;
    };
    if (!raw.audio_base64) throw new ElevenError("E_ELEVEN_API", "ElevenLabs returned no audio for this line.");
    const mp3 = a.target.replace(/\.\w+$/, "") + ".eleven.mp3";
    writeFileSync(mp3, Buffer.from(raw.audio_base64, "base64"));
    let durationSec: number;
    try {
      durationSec = await convert(mp3, a.target);
    } finally {
      rmSync(mp3, { force: true });
    }
    let remaining_after: number | null = null;
    try {
      remaining_after = (await subscription()).remaining;
    } catch {
      // The line is made; a failed re-read only leaves remaining_after unknown (the error is in the log).
    }
    return {
      file: a.target,
      durationSec: Math.round(durationSec * 1000) / 1000,
      engine: "elevenlabs",
      voice: a.voice,
      model: modelId,
      ...(a.timestamps === false ? {} : { words: alignmentToWords(raw.alignment) }),
      characters: [...text].length,
      credits_estimate: guard.estimate,
      remaining_after,
    };
  }

  return { status, voices, speak, models, subscription, request, reserve, needKey, clean, log };
}

// The process-wide client the tools use.
export const eleven = elevenClient();
