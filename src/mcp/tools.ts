import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CDP_PORT, HOME_DIR, PROFILE_DIR, cdpUp, closedWindowError, withSitePage } from "../chrome.js";
import { makeLoop } from "../loop.js";
import { downloadSong, downloadVideo, generate, inspect, listSongs, readCredits, remix, signedIn, type AudioFormat } from "../music.js";
import { buildLocalFlowTools } from "../flow/local-tools.js";
import { buildFlowTools } from "../flow/tools.js";
import { JobQueue, type Job } from "../queue.js";
import { lengthValid, loopFriendlySound, slug as slugOf, songIdOf } from "../util.js";

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
  ...(job.credits_spent !== undefined ? { credits_spent: job.credits_spent } : {}),
  ...(job.credits_after !== undefined ? { credits_after: job.credits_after } : {}),
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
      ("remix" in job.params ? remix : generate)(page, job.params as never, (note) => {
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
        // Signed in and no job on the page; best effort (undefined when the menu could not be read).
        const credits = signed ? await withSitePage("music", (page) => readCredits(page, { fresh: true })) : undefined;
        return {
          chrome_running: chrome,
          ...(busy ? { note: "A song is being made; the page was not touched, so signed_in was not checked." } : {}),
          signed_in: signed,
          ...(credits !== undefined ? { credits } : {}),
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
      "Makes a song in Flow Music's Compose panel and downloads it (Compose makes one take, saved as <name>.<format>; if Flow Music ever returns more they are <name>-a, <name>-b). SPENDS FLOW MUSIC CREDITS: ask the user before the first one. Give lyrics with section tags ([Verse], [Chorus]...), or instrumental: true; a vocal song with no lyrics lets Flow Music write them. BPM, length, seed and model switch on Compose's Advanced mode. The job reports credits_spent (balance before minus after) when both reads worked. Returns the files, or a job id while it is still running (then music_wait).",
      z.object({
          sound: z.string().min(1).describe("Sound description: genre, instruments, mood, tempo, production (Compose's Sound box)"),
          lyrics: z.string().optional().describe("Lyrics with section tags such as [Intro], [Verse 1], [Chorus], [Outro]. Leave out (with instrumental false) to let Flow Music write them"),
          instrumental: z.boolean().optional().describe("No vocals (Compose's instrumental switch)"),
          title: z.string().optional().describe("Song title (Compose's Details box)"),
          loop_friendly: z
            .boolean()
            .optional()
            .describe('Appends "seamless loop, steady energy throughout, no intro, no fade-out, ends where it began" to the Sound description. A hint to the model only: the take may still fade. music_loop finds the loop point afterwards.'),
          bpm: z.number().int().min(30).max(300).optional().describe("Tempo (Advanced)"),
          length: z
            .string()
            .refine(lengthValid, "must be m:ss between 1:00 and 3:00 (a bare number is minutes)")
            .optional()
            .describe('Length as m:ss between 1:00 and 3:00, e.g. "2:30" (a bare number is minutes; Advanced)'),
          seed: z.number().int().min(0).optional().describe("Seed for repeatable takes (Advanced)"),
          model: z.string().optional().describe('Model name as the Model menu starts it: "Lyria 3.5" (default, flagship) or "Lyria 3 Pro" (legacy) (Advanced)'),
          format,
          out,
          name: z.string().optional().describe("File name stem (default: the title as a slug)"),
          wait,
      }),
      async (a) => {
        const job = queue.add({
          sound: a.loop_friendly ? loopFriendlySound(a.sound) : a.sound,
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
      "music_remix",
      "Remixes an existing Flow Music song from its song page (Remix menu) and downloads the new take. mode `variation`: a new take with the same sound and lyrics and a new seed, titled \"<title> (Remix)\". mode `extend`: Flow Music continues the song from its default extension range (shown on the song page as EXTENDED FROM), titled \"<title> (Extended)\"; `instruction` steers it. SPENDS FLOW MUSIC CREDITS: 5 per remix (measured 2026-10-22 for both modes): ask the user before the first one. A background job like music_generate (credits_spent is reported; music_wait collects it). Cover, Replace and Trim exist in the menu but are not exposed.",
      z.object({
        song_id: z.string().min(8).describe("The song to remix: an id from music_songs or a job, or a flowmusic.app/song/<id> link"),
        mode: z.enum(["variation", "extend"]),
        instruction: z.string().max(1000).optional().describe("Extend only: what the extension should do (the Instruction box). Ignored for variation."),
        format,
        out,
        name: z.string().optional().describe("File name stem (default: <song id first 8>-<mode>)"),
        wait,
      }),
      async (a) => {
        const id = songIdOf(a.song_id) ?? a.song_id;
        const job = queue.add({
          remix: { song_id: id, mode: a.mode, ...(a.mode === "extend" && a.instruction ? { instruction: a.instruction } : {}) },
          format: a.format as AudioFormat,
          output_dir: a.out ?? DEFAULT_OUT,
          file_stem: slug(a.name ?? `${id.slice(0, 8)}-${a.mode}`),
        });
        return settle(job, a.wait);
      },
    ),
    def(
      "music_video",
      "Makes the music video of an existing Flow Music song (song menu > Download > Download video) and saves it as <name>.mp4. template `simple` (default) cost 0 credits when measured (2026-10-22); `player`, `modern` and `music_video` were never tried and their cost is UNKNOWN: ask the user before using them. A first render can take more than 3 minutes with nothing shown, so this call runs until the file arrives (up to timeout_minutes, default 15) and the MCP client must allow a call that long; the Flow Music tab stays on the song page meanwhile and other Flow Music tools wait. Asking again for a song already rendered returns at once.",
      z.object({
        song_id: z.string().min(8).describe("An id from music_songs or a job, or a flowmusic.app/song/<id> link"),
        template: z.enum(["simple", "player", "modern", "music_video"]).default("simple"),
        out,
        name: z.string().optional().describe("File name stem (default: the song id)"),
        timeout_minutes: z.number().min(1).max(15).default(15),
      }),
      async (a) => {
        const id = songIdOf(a.song_id) ?? a.song_id;
        return withSitePage("music", (page) => downloadVideo(page, id, a.template, join(a.out ?? DEFAULT_OUT, slug(a.name ?? id)), a.timeout_minutes * 60_000)).catch((err) => {
          throw closedWindowError("music", err);
        });
      },
    ),
    def(
      "music_loop",
      "Finds a seamless loop in an audio file (local ffmpeg, no browser, no credits) and writes it as <name>-loop.<ext> in the same format (.wav, .mp3 or .m4a), the end crossfaded into the start so it repeats without a click. It skips the fade-in and fade-out, compares band levels around candidate points and picks the best pair at least min_seconds apart (the shorter wins a tie). Returns loop_start_s, loop_end_s, loop_seconds, score (1 = identical around the seam, 0 = 12 dB apart), distance_db and seam checks on the written file (seam.clean: no level jump or click beyond the loop's own). It cannot make a loop from a track that never repeats: check score, and use music_generate with loop_friendly for sources.",
      z.object({
        input: z.string().min(1).refine(isAbsolute, "must be an absolute path").describe("Absolute path of a .wav, .mp3 or .m4a file, e.g. a song from music_generate"),
        min_seconds: z.number().min(2).max(170).default(20).describe("The loop is at least this long"),
        crossfade_ms: z.number().int().min(50).max(5000).default(1500).describe("Length of the crossfade from the end back into the start"),
        out,
        name: z.string().optional().describe("File name stem (default <input name>-loop)"),
      }),
      async (a) => makeLoop({ input: a.input, output_dir: a.out ?? DEFAULT_OUT, ...(a.name ? { stem: slug(a.name) } : {}), min_seconds: a.min_seconds, crossfade_ms: a.crossfade_ms }),
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
