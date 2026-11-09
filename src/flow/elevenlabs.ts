// ElevenLabs text to speech, free tier only (FMM-17). Plain `fetch` (Node 24), no SDK. The key comes from
// ELEVENLABS_API_KEY: the real environment first, then the .env files (src/env.ts; ~/.flow-music-mcp/.env lives outside
// every repo). There is no tool that sets or stores it: only the user does. The key is sent only as the `xi-api-key`
// header, and every error, log line and result goes through `redactKey`, so it never leaves this module.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ENV_FILES, presetEnv } from "../env.js";
import { plausible } from "./key-format.js";
import { ElevenError, elevenApiError, elevenReserve, readModels, readSubscription, readVoices, redactKey, type ElevenModel, type ElevenVoice } from "./voice-pure.js";

const BASE = "https://api.elevenlabs.io";
const KEY_NAME = "ELEVENLABS_API_KEY";

export interface ElevenKey {
  key: string;
  source: "env" | "file";
}

export const ELEVEN_KEY_HINT =
  "No ElevenLabs key yet. The user (never an assistant) makes a free account on elevenlabs.io, creates an API key " +
  "(restricted to Text to Speech plus read access to Voices, Models and User if the dialog offers those), and puts it in " +
  "the ELEVENLABS_API_KEY environment variable or in ~/.flow-music-mcp/.env as ELEVENLABS_API_KEY=..., then restarts flow-music-mcp.";

// The key: a real environment variable first, then the first .env file that holds a usable one. Reading the files here
// (not only process.env) means an empty ELEVENLABS_API_KEY= copied from .env.example cannot hide the real one.
export function elevenKey(): ElevenKey | undefined {
  const env = plausible(presetEnv[KEY_NAME] ?? "");
  if (env) return { key: env, source: "env" };
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
}

export interface ElevenStatus {
  ready: boolean;
  source?: "env" | "file";
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

  return { status, voices, models, subscription, request, reserve, needKey, clean, log };
}

// The process-wide client the tools use.
export const eleven = elevenClient();
