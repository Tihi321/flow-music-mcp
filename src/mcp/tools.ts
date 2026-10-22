import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CDP_PORT, HOME_DIR, PROFILE_DIR, cdpUp, closedWindowError, withSitePage } from "../chrome.js";
import { downloadSong, generate, inspect, listSongs, signedIn, type AudioFormat } from "../music.js";
import { buildLocalFlowTools } from "../flow/local-tools.js";
import { buildFlowTools } from "../flow/tools.js";
import { JobQueue, type Job } from "../queue.js";
import { slug as slugOf } from "../util.js";

// The MCP tools. The tool shapes follow comfy-mcp (src/mcp/tools.ts): a generation is a background job, the call waits up
// to `wait` seconds and returns the result or the job id, and music_wait collects it. The Flow Music tools (music_*) are
// built here; the Google Flow tools (flow_*) come from src/flow/tools.ts and are listed after them.

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never) => Promise<unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// Most MCP clients give up on a call after about a minute, so no call holds on longer than this.
const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 50;
export const DEFAULT_OUT = join(HOME_DIR, "output");

const wait = z
  .number()
  .min(0)
  .max(MAX_WAIT_S)
  .optional()
  .describe(`Seconds to wait for the result before returning the job id (default ${DEFAULT_WAIT_S}, 0 = return the job id at once). Then call music_wait.`);
const format = z.enum(["mp3", "wav", "m4a"]).default("mp3").describe("Audio format to download (default mp3)");
const out = z
  .string()
  .refine(isAbsolute, "must be an absolute path")
  .optional()
  .describe(`Absolute output folder (default ${DEFAULT_OUT})`);

const slug = (s: string) => slugOf(s, "song");

const jobView = (job: Job) => ({
  job_id: job.id,
  status: job.status,
  ...(job.progress ? { progress: job.progress } : {}),
  ...(job.error ? { error: job.error } : {}),
  ...(job.session ? { session: job.session } : {}),
  songs: job.songs,
  files: job.songs.map((s) => s.file).filter(Boolean),
  title: job.params.title,
  created: job.createdAt,
  ...(job.finishedAt ? { finished: job.finishedAt } : {}),
});

export function buildTools(): Tool[] {
  return [...buildMusicTools(), ...buildFlowTools(), ...buildLocalFlowTools()];
}

function buildMusicTools(): Tool[] {
  const def = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.output<S>) => Promise<unknown>): Tool => ({
    name,
    description,
    schema,
    run: run as Tool["run"],
  });

  const queue = new JobQueue((job) =>
    withSitePage("music", (page) =>
      generate(page, job.params, (note) => {
        job.progress = note;
      }),
    ).catch((err) => {
      throw closedWindowError("music", err);
    }),
  );

  const settle = async (job: Job, waitS: number | undefined) => {
    await queue.wait([job.id], (waitS ?? DEFAULT_WAIT_S) * 1000);
    if (job.status === "queued" || job.status === "running")
      return { ...jobView(job), still_working: true, note: `Still on it, not a failure. Call music_wait with job_ids ["${job.id}"]; do not generate again.` };
    if (job.status === "failed") throw new Error(`${job.id} failed: ${job.error ?? ""}`);
    return jobView(job);
  };

  return [
    def(
      "music_status",
      "Whether the Flow Music Chrome window is up and signed in, the profile and output folders, and the job queue. Call it first; if signed_in is false, ask the user to run `yarn login` in flow-music-mcp.",
      z.object({}),
      async () => {
        const chrome = await cdpUp();
        const busy = queue.busy;
        const signed = chrome && !busy ? await withSitePage("music", (page) => signedIn(page)) : undefined;
        return {
          chrome_running: chrome,
          ...(busy ? { note: "A song is being made; the page was not touched, so signed_in was not checked." } : {}),
          signed_in: signed,
          cdp_port: CDP_PORT,
          profile: PROFILE_DIR,
          default_out: DEFAULT_OUT,
          paused: queue.pausedReason ?? undefined,
          jobs: queue.list().map(jobView),
        };
      },
    ),
    def(
      "music_generate",
      "Makes a song in Flow Music's Compose panel and downloads it (Compose makes one take, saved as <name>.<format>; if Flow Music ever returns more they are <name>-a, <name>-b). SPENDS FLOW MUSIC CREDITS: ask the user before the first one. Give lyrics with section tags ([Verse], [Chorus]...) or instrumental: true. BPM, length, seed and model switch on Compose's Advanced mode. Returns the files, or a job id while it is still running (then music_wait).",
      z
        .object({
          sound: z.string().min(1).describe("Sound description: genre, instruments, mood, tempo, production (Compose's Sound box)"),
          lyrics: z.string().optional().describe("Lyrics with section tags such as [Intro], [Verse 1], [Chorus], [Outro]"),
          instrumental: z.boolean().optional().describe("No vocals (Compose's instrumental switch)"),
          title: z.string().optional().describe("Song title (Compose's Details box)"),
          bpm: z.number().int().min(30).max(300).optional().describe("Tempo (Advanced)"),
          length: z.string().optional().describe('Length as Flow Music takes it, e.g. "2:30" (Advanced; the accepted format is not verified yet)'),
          seed: z.number().int().min(0).optional().describe("Seed for repeatable takes (Advanced)"),
          model: z.string().optional().describe('Model name as the Model menu shows it, e.g. "Lyria 3.5" (Advanced)'),
          format,
          out,
          name: z.string().optional().describe("File name stem (default: the title as a slug)"),
          wait,
        })
        .refine((a) => a.instrumental || (a.lyrics ?? "").trim(), { message: "give lyrics, or instrumental: true" }),
      async (a) => {
        const job = queue.add({
          sound: a.sound,
          lyrics: a.lyrics,
          instrumental: a.instrumental,
          title: a.title,
          bpm: a.bpm,
          length: a.length,
          seed: a.seed,
          model: a.model,
          format: a.format as AudioFormat,
          output_dir: a.out ?? DEFAULT_OUT,
          file_stem: slug(a.name ?? a.title ?? "song"),
        });
        return settle(job, a.wait);
      },
    ),
    def(
      "music_wait",
      `Waits for jobs (up to ${MAX_WAIT_S} s per call) and returns them. Call again while any is still queued or running.`,
      z.object({
        job_ids: z.array(z.string()).optional().describe("Job ids (default: every unfinished job)"),
        timeout_seconds: z.number().min(0).max(MAX_WAIT_S).default(40),
      }),
      async (a) => {
        const ids = a.job_ids ?? queue.list().filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id);
        await queue.wait(ids, a.timeout_seconds * 1000);
        const jobs = ids.map((id) => {
          const job = queue.get(id);
          return job ? jobView(job) : { job_id: id, status: "unknown", note: "Unknown job id (jobs are kept for the last 200 per server, so it may be older or from another install). Check music_songs." };
        });
        return { finished: jobs.every((j) => !["queued", "running"].includes(j.status)), jobs };
      },
    ),
    def("music_jobs", "The recent jobs (kept across server restarts, last 200) with their status, songs and files.", z.object({}), async () => ({
      paused: queue.pausedReason ?? undefined,
      jobs: queue.list().map(jobView),
    })),
    def("music_cancel", "Cancels a job that has not started yet. A running generation cannot be stopped.", z.object({ job_id: z.string() }), async (a) => {
      const job = queue.cancel(a.job_id);
      if (!job) throw new Error(`no job ${a.job_id}`);
      return jobView(job);
    }),
    def(
      "music_retry",
      "Queues a failed or cancelled job again with the same settings. A failed job may already have spent credits and made songs: check music_songs first.",
      z.object({ job_id: z.string() }),
      async (a) => {
        const job = queue.retry(a.job_id);
        if (!job) throw new Error(`no job ${a.job_id}`);
        return jobView(job);
      },
    ),
    def(
      "music_download",
      "Downloads an existing Flow Music song by id (from music_songs, a job, or a flowmusic.app/song/<id> link). Spends no credits.",
      z.object({ song_id: z.string().min(8), format, out, name: z.string().optional().describe("File name stem (default: the song id)") }),
      async (a) =>
        withSitePage("music", (page) => downloadSong(page, a.song_id, a.format as AudioFormat, join(a.out ?? DEFAULT_OUT, slug(a.name ?? a.song_id)))),
    ),
    def(
      "music_songs",
      "The newest songs in the user's Flow Music library (Songs page): id, title and link.",
      z.object({ limit: z.number().int().min(1).max(200).default(30) }),
      async (a) => ({ songs: await withSitePage("music", (page) => listSongs(page, a.limit)) }),
    ),
    def(
      "music_inspect",
      "Debugging: every visible control on the Flow Music page (role, name, placeholder, link) plus any dialog text. Use it to remap a selector after Flow Music changes its UI.",
      z.object({}),
      async () => withSitePage("music", (page) => inspect(page)),
    ),
  ];
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export async function callTool(tools: readonly Tool[], name: string, args: unknown): Promise<ToolResult> {
  const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail(`unknown tool "${name}"`);
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return fail(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  try {
    const result = await tool.run(parsed.data as never);
    const structured = (result !== null && typeof result === "object" && !Array.isArray(result) ? result : { result }) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: JSON.parse(JSON.stringify(structured)) as Record<string, unknown> };
  } catch (e) {
    return fail((e as Error).message);
  }
}

export function toolList(tools: readonly Tool[]): { name: string; description: string; inputSchema: { type: "object"; [k: string]: unknown } }[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchemaOf(t.schema) as { type: "object"; [k: string]: unknown } }));
}
