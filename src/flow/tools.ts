import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CDP_PORT, HOME_DIR, PROFILE_DIR, cdpUp, closedWindowError, withSitePage } from "../chrome.js";
import type { Tool } from "../mcp/tools.js";
import { runImages } from "./agent.js";
import { extractAudio, extractLastFrame } from "./chain.js";
import { createCharacter, editCharacter, editImage, listCharacters } from "./characters.js";
import { runScene, uploadRightsAgreed } from "./direct.js";
import { capOf, defaultMaxCredits } from "./limits.js";
import { downloadTile, downloadTileAll, ensureProjectGrid, findTile, flowState, inspect, listAssets, openProject, scanGrid, tileResolver, trashTile, type ImageSize } from "./driver.js";
import { FlowJobQueue, type Aspect, type FlowJob } from "./queue.js";
import { TECHNIQUES } from "./techniques.js";
import { runContinue, runVideoEdit } from "./video.js";
import { slug as slugOf } from "../util.js";

// The Flow MCP tools (flow.google.com). Names and shapes follow flow-mcp so skills and habits carry over; the engine is new
// (src/flow/agent.ts): every generation goes through Flow's creative agent. Images (Nano Banana) are free, Flow video and
// voices spend credits.

const DEFAULT_WAIT_S = 30;
const MAX_WAIT_S = 50;
export const DEFAULT_FLOW_OUT = join(HOME_DIR, "output", "flow");
const BUSY = "A Flow job is running in the Flow tab. Wait for it (flow_wait) and try again.";

const wait = z
  .number()
  .min(0)
  .max(MAX_WAIT_S)
  .optional()
  .describe(`Seconds to wait for the result before returning the job id (default ${DEFAULT_WAIT_S}, 0 = return the job id at once). Then call flow_wait.`);
const out = z.string().refine(isAbsolute, "must be an absolute path").optional().describe(`Absolute output folder (default ${DEFAULT_FLOW_OUT})`);
const project = z.string().min(1).optional().describe("Flow project, by name or id. Default: the project already open in the Flow tab.");
const createProject = z.boolean().optional().describe("Create the project (free) when no project has that name.");
const aspect = z.enum(["16:9", "4:3", "1:1", "3:4", "9:16"]);
const size = z.enum(["1K", "2K", "4K"]).default("1K").describe("Image size: 1K original, 2K or 4K upscaled (rendered on demand, can take minutes; 4K is unverified and may not be free)");
const startNumber = z.number().int().min(1).optional().describe("First scene number for the file names (default: the next free number for this name in the output folder)");

const slug = (s: string) => slugOf(s, "image");

// Guidance handed to the calling model through flow_status, so it plans work Flow can run.
const PLAYBOOK = [
  "Call flow_status first. If it has a hint (not signed in, Chrome down), relay it to the user and stop.",
  "Flow images (Nano Banana) are free. Flow video (flow_generate type video, flow_continue, flow_edit on a video, flow_narrate engine flow) SPENDS CREDITS: ask the user first. Each paid call is capped by max_credits, by default the user's FLOW_MUSIC_MCP_MAX_CREDITS from .env (50 if unset; see max_credits_default in flow_status); flow_generate and flow_continue read the composer's live quote and refuse before starting if it is above max_credits (Omni 1.1 Flash 360p 4 s = 4 credits).",
  "flow_generate makes one image or clip per scene as separate paced jobs (25-70 s apart) in Flow's direct composer with the exact prompt; flow_agent_images asks the agent for many free images in one request and is much faster for sets. Uploading a local file makes Flow ask for a rights confirmation ('I agree'). That is the user's to give: the tool agrees only when the user has set FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree in .env (see upload_rights in flow_status), and only for files the user gave. Never set it or ask to have it set on the user's behalf; asset:<media_id> needs no upload.",
  "A call waits up to `wait` seconds and otherwise returns job ids: call flow_wait until finished is true. Never generate the same scene again while its job is running.",
  "Files are saved as <name>-NN.jpeg in the output folder, NN being the scene number; extra variants are -NN-v2. A note 'still failed: scene N' means flow_retry makes just those again.",
  "Write prompts in English, one image per scene, and repeat the full description of a recurring character or product in every scene: the agent has no memory between scenes.",
  "Flow reuses titles for different images: refer to media by media_id from flow_assets, never by title.",
];

const jobView = (job: FlowJob) => ({
  job_id: job.id,
  status: job.status,
  scenes: job.params.numbers,
  ...(job.progress ? { progress: job.progress } : {}),
  ...(job.error ? { error: job.error } : {}),
  ...(job.note ? { note: job.note } : {}),
  ...(job.credits_quote !== undefined ? { credits_quote: job.credits_quote } : {}),
  ...(job.credits_spent !== undefined ? { credits_spent: job.credits_spent } : {}),
  ...(job.project ? { project: job.project } : {}),
  files: job.files.map((f) => f.file),
  images: job.files,
  ...(job.failed_scenes.length ? { failed_scenes: job.failed_scenes } : {}),
  created: job.createdAt,
  ...(job.finishedAt ? { finished: job.finishedAt } : {}),
});

let flowQueue: FlowJobQueue | undefined;

// flow_narrate engine "flow": a cheap 360p Omni take with a Flow voice attached as an ingredient, then the sound extracted
// to .m4a. SPENDS CREDITS (the live quote is checked against max_credits first). Ported from flow-mcp's removed engine.
export async function narrateWithFlow(a: { text: string; voice: string; out: string; name: string; max_credits: number; project?: string; image?: string; wait_s?: number }): Promise<unknown> {
  if (!flowQueue) throw new Error("The Flow tools are not running in this process.");
  const words = a.text.trim().split(/\s+/).length;
  const duration = words <= 12 ? 4 : words <= 18 ? 6 : words <= 24 ? 8 : 10;
  const stem = `${a.name}-take`;
  const job = flowQueue.add({
    kind: "scene",
    scenes: [`A calm presenter faces the camera, framed from the chest up, in a plain softly lit room. They say these exact words and nothing else, then stay silent: "${a.text.trim().replace(/"/g, "'")}"`],
    numbers: [1],
    project: a.project,
    aspect: "16:9",
    variants: 1,
    size: "1K",
    type: "video",
    duration,
    resolution: "360p",
    voice: a.voice,
    voice_image: a.image,
    audio_target: join(a.out, `${a.name}.m4a`),
    retries: 1,
    download_quality: "original",
    max_credits: a.max_credits,
    output_dir: a.out,
    file_stem: stem,
    label: `narration (Flow voice ${a.voice})`,
  });
  await flowQueue.wait([job.id], (a.wait_s ?? DEFAULT_WAIT_S) * 1000);
  if (job.status === "queued" || job.status === "running") {
    return { ...jobView(job), still_working: true, note: `Still on it, not a failure. Call flow_wait with job_ids ["${job.id}"]; when it is done the sound is saved as ${a.name}.m4a (and the take as ${stem}-01.mp4) in ${a.out}: read the files from the finished job.` };
  }
  if (job.status !== "done") throw new Error(`${job.id} ${job.status}: ${job.error ?? ""}`);
  const audio = job.files.find((f) => /\.m4a$/i.test(f.file))?.file;
  const take = job.files.find((f) => /\.(mp4|webm|mov)$/i.test(f.file))?.file;
  if (!audio || !take) throw new Error("Flow made no take.");
  return { engine: "flow", voice: a.voice, file: audio, take, credits_quote: job.credits_quote, credits_spent: job.credits_spent, note: job.note };
}

export function buildFlowTools(): Tool[] {
  const def = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.output<S>) => Promise<unknown>): Tool => ({
    name,
    description,
    schema,
    run: run as Tool["run"],
  });

  const queue: FlowJobQueue = new FlowJobQueue((job) =>
    withSitePage("flow", async (page) => {
      const hooks = {
        progress: (note: string) => {
          job.progress = note;
        },
        cancelled: () => Boolean(job.cancelRequested),
      };
      const p = job.params;
      switch (p.kind) {
        case "images":
          return runImages(page, job, hooks);
        case "continue":
          return runContinue(page, job, hooks);
        case "edit_video":
          return runVideoEdit(page, job, hooks);
        case "scene": {
          // chain_previous / reference_previous: the previous scene's files (flow-mcp chain_from / reference_from).
          let first = p.first_frame;
          let refs = p.reference_images;
          if (p.chain_from) {
            const clip = queue.get(p.chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f.file));
            if (!clip) throw new Error(`chain_previous: the previous scene (${p.chain_from}) produced no video, so this scene was skipped.`);
            first = await extractLastFrame(clip.file);
          }
          if (p.reference_from) {
            const still = queue.get(p.reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f.file));
            if (!still) throw new Error(`reference_previous: the previous scene (${p.reference_from}) produced no image.`);
            // By media id, not by file: a local file would have to be uploaded, which asks the user to confirm rights.
            refs = [`asset:${still.media_id}`, ...(refs ?? [])].slice(0, 3);
          }
          const made = await runScene(
            page,
            job,
            {
              prompt: p.scenes[0]!,
              type: p.type ?? "image",
              model: p.model,
              aspect: p.aspect,
              duration: p.duration,
              resolution: p.resolution,
              variants: p.variants,
              first_frame: first,
              last_frame: p.last_frame,
              reference_images: refs,
              voice: p.voice,
              voice_image: p.voice_image,
              max_credits: p.max_credits,
              retries: p.retries ?? 1,
              download_quality: p.download_quality ?? "original",
              output_dir: p.output_dir,
              file_stem: p.file_stem,
            },
            p.numbers[0]!,
            hooks,
          );
          if (p.audio_target) {
            const take = made.files.find((f) => /\.(mp4|webm|mov)$/i.test(f.file));
            if (!take) throw new Error("Flow made no take to take the sound from.");
            hooks.progress("extracting the sound");
            const audio = await extractAudio(take.file, p.audio_target);
            made.files.push({ scene: take.scene, file: audio, media_id: take.media_id, title: take.title, variant: 0 });
          }
          return made;
        }
      }
    }).catch((err) => {
      throw closedWindowError("flow", err);
    }),
  );
  flowQueue = queue;

  // The next free scene number for <stem>-NN in a folder, counting files on disk and jobs already queued for it.
  const nextNumber = (dir: string, stem: string): number => {
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)`);
    const onDisk = existsSync(dir) ? readdirSync(dir).map((f) => Number(re.exec(f)?.[1] ?? 0)) : [];
    const queued = queue.list().filter((j) => j.params.output_dir === dir && j.params.file_stem === stem).flatMap((j) => j.params.numbers);
    return Math.max(0, ...onDisk, ...queued) + 1;
  };

  const settle = async (jobs: FlowJob[], waitS: number | undefined, dir: string) => {
    await queue.wait(jobs.map((j) => j.id), (waitS ?? DEFAULT_WAIT_S) * 1000);
    const open = jobs.some((j) => j.status === "queued" || j.status === "running");
    if (!open && jobs.every((j) => j.status === "failed")) throw new Error(jobs.map((j) => `${j.id} failed: ${j.error ?? ""}`).join("; "));
    return {
      output_dir: dir,
      finished: !open,
      ...(open ? { still_working: true, note: `Still on it, not a failure. Call flow_wait with job_ids ${JSON.stringify(jobs.map((j) => j.id))}; do not generate again.` } : {}),
      jobs: jobs.map(jobView),
      files: jobs.flatMap((j) => j.files.map((f) => f.file)),
    };
  };

  // Pages are driven one action at a time; a running generation owns the tab, so these refuse instead of waiting minutes.
  const onPage = async <T>(projectName: string | undefined, fn: (page: import("playwright-core").Page) => Promise<T>): Promise<T> => {
    if (queue.busy) throw new Error(BUSY);
    return withSitePage("flow", async (page) => {
      await openProject(page, projectName, false);
      return fn(page);
    });
  };

  return [
    def(
      "flow_status",
      "Whether the Flow Chrome tab is signed in, the plan and credit balance, the open project, the job queue, and a short playbook. Call it first; if signed_in is false, ask the user to run `yarn login` in flow-music-mcp. Reading plan and credits briefly opens Flow's account panel, so it is skipped while a job is running.",
      z.object({ detailed: z.boolean().default(true).describe("false skips the plan/credits readout") }),
      async (a) => {
        const chrome = await cdpUp();
        const busy = queue.busy;
        const flow = chrome && !busy ? await withSitePage("flow", (page) => flowState(page, a.detailed)) : undefined;
        return {
          chrome_running: chrome,
          ...(busy ? { note: "A Flow job is running; the page was not touched, so plan and credits were not read." } : {}),
          flow,
          cdp_port: CDP_PORT,
          profile: PROFILE_DIR,
          default_out: DEFAULT_FLOW_OUT,
          // The cap a paid call gets when it passes no max_credits (FLOW_MUSIC_MCP_MAX_CREDITS in .env, 50 if unset).
          max_credits_default: defaultMaxCredits(),
          // The user's own setting (FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree in .env): whether local files may be uploaded.
          upload_rights: uploadRightsAgreed() ? "agree (set by the user in .env: local files the user gives are uploaded)" : "ask (local files are not uploaded; use asset:<media_id>, or the user sets FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree)",
          paused: queue.pausedReason ?? undefined,
          jobs: queue.list().map(jobView),
          playbook: PLAYBOOK,
        };
      },
    ),
    def(
      "flow_generate",
      "Makes images or videos in Flow's direct composer, one paced job per scene, and downloads them as <name>-NN.<ext> (NN = scene number; variants -vN). The prompt goes in EXACTLY as written, and the composer's live credit quote is read BEFORE anything starts: the scene is refused (nothing spent) when it exceeds max_credits. IMAGES (Nano Banana) ARE FREE. VIDEO SPENDS CREDITS: ask the user first and pass max_credits (required for video; measured quotes at 16:9 x1: Omni 1.1 Flash 360p 4 s 4, 720p 4 s 7 (720p 8 s x2 24); Veo 3.1 Lite 10, Fast 20, Quality 100; Veo has no resolution/duration options, clips are fixed at 8 s, and those two are ignored with a note). Options per scene: type, model, aspect_ratio, duration/resolution (Omni), variants, first_frame / last_frame (a local file, or asset:<media_id>), reference_images (up to 3; Flow's composer takes frames OR references on a video), chain_previous (continue the previous scene from its last frame; the frame is uploaded, which makes Flow ask YOU to confirm rights once: flow_continue needs no upload), reference_previous (the previous scene's image as a reference), technique (a flow_techniques id). Returns the files and the credit quote, or job ids while still running (then flow_wait). For many free images at once use flow_agent_images.",
      z.object({
        scenes: z
          .array(
            z.object({
              prompt: z.string().min(1).describe("Full English prompt for one image or clip: action, shot and camera move, location, style, light, sound."),
              type: z.enum(["image", "video"]).default("image"),
              model: z.string().optional().describe("Model as the composer's menu shows it: image 'Nano Banana Pro', 'Nano Banana 2 Lite' (default: the newest Nano Banana, 2.1 today); video 'Omni 1.1 Flash', 'Veo 3.1 - Lite', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality' (default: Flow's current video model)."),
              aspect_ratio: aspect.optional().describe("Video supports 16:9 and 9:16 only. Default: the composer's current one."),
              duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8 s."),
              resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
              max_credits: z.number().int().min(0).optional().describe("Spending cap per scene: refused BEFORE starting if the live quote is higher. Video default: FLOW_MUSIC_MCP_MAX_CREDITS from .env (50 if unset). Images are free (0)."),
              variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (video variants each spend credits). Default 1."),
              first_frame: z.string().optional().describe("First frame (video): absolute image path, or 'asset:<media_id or title>' for an image already in the project."),
              last_frame: z.string().optional().describe("Last frame (video): absolute image path, or 'asset:<media_id or title>'."),
              reference_images: z.array(z.string()).max(3).optional().describe("Reference media: absolute image paths, or 'asset:<media_id or title>' (images, characters). Skipped with a note when frames are set."),
              download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches the 720p video / 2K image upscale (slower). Default original."),
              retries: z.number().int().min(0).max(3).default(1).describe("Automatic presses of Flow's own Retry when Flow reports the generation failed (free)."),
              technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
              reference_previous: z.boolean().optional().describe("Use the previous scene's finished image as an extra reference (keeps a set of stills on-model). Not valid on the first scene."),
              chain_previous: z.boolean().optional().describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Needs a preceding video scene and ffmpeg; not valid with first_frame."),
            }),
          )
          .min(1)
          .max(50),
        project,
        create_project: createProject,
        out,
        name: z.string().optional().describe("File name stem (default: scene)"),
        start_number: startNumber,
        wait,
      }),
      async (a) => {
        const output_dir = a.out ?? DEFAULT_FLOW_OUT;
        const stem = slug(a.name ?? "scene");
        const first = a.start_number ?? nextNumber(output_dir, stem);
        for (const [i, s] of a.scenes.entries()) {
          if (s.chain_previous && (i === 0 || s.first_frame || s.type !== "video")) throw new Error(`Scene ${i + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
          if (s.reference_previous && i === 0) throw new Error("Scene 1 has no previous scene to reference.");
          if (s.technique && !TECHNIQUES.some((t) => t.id === s.technique)) throw new Error(`Unknown technique "${s.technique}". Call flow_techniques for valid ids.`);
        }
        const jobs: FlowJob[] = [];
        for (const [i, s] of a.scenes.entries()) {
          const phrase = s.technique ? TECHNIQUES.find((t) => t.id === s.technique)!.phrase : "";
          jobs.push(
            queue.add({
              kind: "scene",
              scenes: [`${s.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}`],
              numbers: [first + i],
              project: a.project,
              create_project: a.create_project,
              aspect: (s.aspect_ratio ?? "16:9") as Aspect,
              variants: s.variants ?? 1,
              model: s.model,
              size: "1K",
              type: s.type,
              duration: s.duration,
              resolution: s.resolution,
              first_frame: s.first_frame,
              last_frame: s.last_frame,
              reference_images: s.reference_images,
              chain_from: s.chain_previous ? jobs[i - 1]!.id : undefined,
              reference_from: s.reference_previous ? jobs[i - 1]!.id : undefined,
              retries: s.retries,
              download_quality: s.download_quality,
              // Video: the caller's cap or the default from .env; images: 0 (free; a paid image model is refused).
              max_credits: s.type === "video" ? capOf(s.max_credits) : (s.max_credits ?? 0),
              output_dir,
              file_stem: stem,
              label: s.prompt.slice(0, 60),
            }),
          );
        }
        return settle(jobs, a.wait, output_dir);
      },
    ),
    def(
      "flow_agent_images",
      "Asks Flow's agent for many images in ONE request (numbered scenes, up to 50), then matches each new tile to its scene by the prompt Flow stored for it and downloads them as <name>-NN.jpeg. Much faster than flow_generate for sets. Scenes the agent drops are asked for again (up to 2 more rounds). IMAGES ARE FREE.",
      z.object({
        scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order"),
        aspect_ratio: aspect.default("16:9"),
        variants: z.number().int().min(1).max(4).default(1).describe("Variations per scene; extras are saved as -vN"),
        model: z.string().optional().describe('Image model, e.g. "Nano Banana Pro" (default: the newest Nano Banana)'),
        project,
        create_project: createProject,
        out,
        name: z.string().optional().describe("File name stem (default: scene)"),
        start_number: startNumber,
        size,
        wait,
      }),
      async (a) => {
        const output_dir = a.out ?? DEFAULT_FLOW_OUT;
        const stem = slug(a.name ?? "scene");
        const first = a.start_number ?? nextNumber(output_dir, stem);
        const job = queue.add({
          kind: "images",
          scenes: a.scenes,
          numbers: a.scenes.map((_, i) => first + i),
          project: a.project,
          create_project: a.create_project,
          aspect: a.aspect_ratio as Aspect,
          variants: a.variants,
          model: a.model,
          size: a.size as ImageSize,
          max_credits: 0,
          output_dir,
          file_stem: stem,
          label: `${a.scenes.length} images in one agent request`,
        });
        return settle([job], a.wait, output_dir);
      },
    ),
    def(
      "flow_wait",
      `Waits for Flow jobs (up to ${MAX_WAIT_S} s per call) and returns them. Call again while finished is false.`,
      z.object({
        job_ids: z.array(z.string()).optional().describe("Job ids (default: every unfinished job)"),
        timeout_seconds: z.number().min(0).max(MAX_WAIT_S).default(40),
      }),
      async (a) => {
        const ids = a.job_ids ?? queue.list().filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id);
        await queue.wait(ids, a.timeout_seconds * 1000);
        const jobs = ids.map((id) => {
          const job = queue.get(id);
          return job ? jobView(job) : { job_id: id, status: "unknown", note: "Unknown job id (jobs are kept for the last 200 per server, so it may be older or from another install). Check flow_assets: Flow's grid is the honest record." };
        });
        return { finished: jobs.every((j) => !["queued", "running"].includes(j.status)), paused: queue.pausedReason ?? undefined, jobs };
      },
    ),
    def(
      "flow_cancel",
      "Cancels a queued Flow job. A running job is asked to stop at its next check (the agent's Stop button is pressed): before Flow's Start is pressed nothing is spent; after it, the generation already started in Flow finishes and is charged there. A job that already made files ends done (note: finished before the cancel took effect), otherwise cancelled.",
      z.object({ job_id: z.string() }),
      async (a) => {
        const job = queue.cancel(a.job_id);
        if (!job) throw new Error(`no job ${a.job_id}`);
        return jobView(job);
      },
    ),
    def(
      "flow_retry",
      "Queues failed or cancelled Flow jobs again. For a finished batch that says 'still failed: scene N', makes just those scenes again under their own numbers. Default: every failed job and every batch with failed scenes.",
      z.object({ job_ids: z.array(z.string()).optional() }),
      async (a) => {
        const ids = a.job_ids ?? queue.list().filter((j) => j.status === "failed" || j.failed_scenes.length).map((j) => j.id);
        const jobs: FlowJob[] = [];
        for (const id of ids) {
          const job = queue.get(id);
          if (!job) continue;
          if (job.status === "done" && job.failed_scenes.length) {
            const pick = job.failed_scenes.map((n) => job.params.numbers.indexOf(n)).filter((i) => i >= 0);
            job.failed_scenes = [];
            queue.save();
            jobs.push(queue.add({ ...job.params, scenes: pick.map((i) => job.params.scenes[i]!), numbers: pick.map((i) => job.params.numbers[i]!), label: `retry of ${job.id}` }));
            continue;
          }
          const again = queue.retry(id);
          if (again) jobs.push(again);
        }
        if (!jobs.length) throw new Error("Nothing to retry: no failed jobs and no batch with failed scenes.");
        return { jobs: jobs.map(jobView) };
      },
    ),
    def(
      "flow_assets",
      "Lists the media in a Flow project's grid (newest first): media_id, title and kind (image, video, scene). media_id is the stable handle (a settled video has no uuid, so it shows asb:<token>, which is stable across reloads but can change after a while: re-list before use; flow_download, flow_edit, flow_continue and flow_trash accept it); titles repeat. Spends no credits. Not available while a job is running.",
      z.object({
        project,
        kind: z.enum(["image", "video", "scene"]).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      async (a) =>
        onPage(a.project, async (page) => {
          const assets = (await listAssets(page)).filter((t) => (!a.kind || t.kind === a.kind) && t.kind !== "other");
          return {
            project: { url: page.url() },
            count: assets.length,
            assets: assets.slice(0, a.limit).map((t) => ({ media_id: t.id.startsWith("title:") ? (t.thumb ? `asb:${t.thumb}` : undefined) : t.id, title: t.title, kind: t.kind, ...(t.busy ? { rendering: true } : {}) })),
          };
        }),
    ),
    def(
      "flow_download",
      "Downloads one existing Flow image or video by media_id (from flow_assets or a job; asb:<token> for videos) or by title. Images: size 1K (original), 2K or 4K (upscaled). Videos: quality original (as made) or upscaled (720p upscale; renders on demand). Spends no credits. Not available while a job is running.",
      z.object({
        media_id: z.string().min(8).optional(),
        title: z.string().min(1).optional().describe("Title, when there is no media_id (exact match first, then prefix; the newest wins)"),
        project,
        size,
        quality: z.enum(["original", "upscaled"]).default("original").describe("Video only: original or upscaled."),
        out,
        name: z.string().optional().describe("File name stem (default: the title as a slug)"),
      }).refine((a) => a.media_id || a.title, { message: "give media_id or title" }),
      async (a) =>
        onPage(a.project, async (page) => {
          await ensureProjectGrid(page);
          let id = a.media_id;
          let title = "";
          let note: string | undefined;
          if (!id) {
            const wanted = a.title!.toLowerCase();
            const tiles = await scanGrid(page, (t) => t.some((x) => x.title.toLowerCase() === wanted));
            const exact = tiles.filter((t) => t.title.toLowerCase() === wanted);
            const matches = exact.length ? exact : tiles.filter((t) => t.title.toLowerCase().startsWith(wanted));
            if (!matches.length) throw new Error(`No media titled "${a.title}". Use flow_assets to list titles.`);
            id = matches[0]!.id;
            title = matches[0]!.title;
            if (matches.length > 1) note = `${matches.length} items match; took the newest. Pass media_id to be exact.`;
          }
          const tile = await findTile(page, id);
          if (!title) title = (await tile.getAttribute("aria-label")) ?? "";
          if (await tile.locator("flow-scene-tile").count()) throw new Error("Scene downloads are not supported yet (a scene's tile menu hands back a ZIP of loose clips; flow-mcp exported scenes from the scene view).");
          const stem = join(a.out ?? DEFAULT_FLOW_OUT, slug(a.name ?? (title || id.slice(0, 8))));
          if (await tile.locator("flow-video-tile").count()) {
            const files = await downloadTileAll(page, tileResolver(page, id, title), stem, a.quality);
            return { file: files[0], ...(files.length > 1 ? { files } : {}), media_id: id, title, quality: a.quality, ...(note ? { note } : {}) };
          }
          const file = await downloadTile(page, tileResolver(page, id), stem, a.size as ImageSize);
          return { file, media_id: id, title, size: a.size, ...(note ? { note } : {}) };
        }),
    ),
    def(
      "flow_trash",
      "Moves one Flow image to the project's Trash (Flow keeps it there with Restore; this never deletes permanently). Flow asks no confirmation, so confirm with the user first. Give media_id; a title is accepted only when exactly one item has it. Not available while a job is running.",
      z.object({ media_id: z.string().min(8).optional(), title: z.string().min(1).optional(), project }).refine((a) => a.media_id || a.title, { message: "give media_id or title" }),
      async (a) =>
        onPage(a.project, async (page) => {
          await ensureProjectGrid(page);
          let id = a.media_id;
          let title = a.title ?? "";
          if (!id) {
            const same = (await scanGrid(page)).filter((t) => t.title === a.title);
            if (!same.length) throw new Error(`Nothing in the open project is called "${a.title}".`);
            if (same.length > 1) throw new Error(`${same.length} items are called "${a.title}": pass media_id (flow_assets) so the right one is trashed.`);
            id = same[0]!.id;
          }
          if (!title) title = (await (await findTile(page, id)).getAttribute("aria-label")) ?? "";
          await trashTile(page, id);
          return { trashed: id, title };
        }),
    ),
    def(
      "flow_continue",
      "Continues a Flow video from its own last frame as a new clip: saves the clip's final frame, loads it as the first frame in the direct composer, reads the live credit quote and (only if it is within max_credits) generates. SPENDS CREDITS (Omni 1.1 Flash 360p 4 s quotes 4): ask the user first. mode 'exact' (default) begins on the real last frame, an invisible cut, and attached characters are ignored (Flow's first-frame tool takes no other references); mode 'likeness' keeps the characters in `attach` locked but the opening frame is only approximate. Saved as <name>-NN.mp4.",
      z.object({
        from_asset: z.string().min(1).describe("Media id (from flow_assets) or title (prefix) of the video to continue."),
        prompt: z.string().min(1).describe("What happens in the new clip, as one continuous shot with one camera move."),
        max_credits: z.number().int().min(1).optional().describe("Spending cap: refused before starting if the live quote is higher. Default: FLOW_MUSIC_MCP_MAX_CREDITS from .env (50 if unset)."),
        attach: z.array(z.string().min(1)).max(3).optional().describe("Characters to keep, by name (likeness mode only)."),
        mode: z.enum(["exact", "likeness"]).default("exact"),
        aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
        model: z.string().optional().describe("Video model (default: Flow's current one, Omni 1.1 Flash)."),
        duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional(),
        resolution: z.enum(["360p", "720p"]).optional(),
        download_quality: z.enum(["original", "upscaled"]).optional(),
        project,
        out,
        name: z.string().optional().describe("File name stem (default: shot)"),
        wait,
      }),
      async (a) => {
        const output_dir = a.out ?? DEFAULT_FLOW_OUT;
        const stem = slug(a.name ?? "shot");
        const job = queue.add({
          kind: "continue",
          scenes: [a.prompt],
          numbers: [nextNumber(output_dir, stem)],
          project: a.project,
          aspect: a.aspect_ratio as Aspect,
          variants: 1,
          model: a.model,
          size: "1K",
          duration: a.duration,
          resolution: a.resolution,
          asset: a.from_asset,
          attach: a.attach,
          mode: a.mode,
          download_quality: a.download_quality,
          max_credits: capOf(a.max_credits),
          output_dir,
          file_stem: stem,
          label: `continue ${a.from_asset}`.slice(0, 60),
        });
        return settle([job], a.wait, output_dir);
      },
    ),
    def(
      "flow_edit",
      "Edits an existing Flow image or video with a prompt. IMAGE (free): in the image's edit view; Flow replaces the tile in place (same title, NEW media id; the original stays in the tile's history), and the edited image is downloaded as <name>.jpeg. VIDEO (Omni, SPENDS CREDITS): done in the clip's edit view, which shows NO quote (a 360p 4 s clip cost 10 credits on 2026-10-22, flow-mcp measured 20), so max_credits is required but can only be checked against the balance before starting; the real cost is measured around the job and reported (credits_spent). The edited clip is saved as <name>-NN.mp4; Flow replaces the tile in place. Ask the user before a video edit.",
      z.object({
        asset: z.string().min(1).describe("Media id (from flow_assets) or title of the image or video to edit."),
        prompt: z.string().min(1).describe("What to change, e.g. 'make the lantern blue', 'make it snow', 'remove the cup'."),
        max_credits: z.number().int().min(0).optional().describe("Video edit only: the balance must cover it before starting, and the measured cost is reported (the edit view shows no quote). Default: FLOW_MUSIC_MCP_MAX_CREDITS from .env (50 if unset)."),
        size: size,
        download_quality: z.enum(["original", "upscaled"]).optional().describe("Video download: original or upscaled (720p)."),
        project,
        out,
        name: z.string().optional().describe("File name stem (default: edit)"),
        wait,
      }),
      async (a) => {
        const output_dir = a.out ?? DEFAULT_FLOW_OUT;
        const stem = slug(a.name ?? "edit");
        // Image or video? Look at the tile.
        const kind = await onPage(a.project, async (page) => {
          await ensureProjectGrid(page);
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a.asset)) {
            const tile = await findTile(page, a.asset);
            return (await tile.locator("flow-video-tile").count()) ? "video" : "image";
          }
          const want = a.asset.toLowerCase();
          const found = (await scanGrid(page, (t) => t.some((x) => x.title.toLowerCase().startsWith(want) && x.kind !== "other"))).find((x) => x.title.toLowerCase().startsWith(want) && x.kind !== "other");
          if (!found) throw new Error(`No image or video whose title starts with "${a.asset}". Use flow_assets to list them.`);
          return found.kind === "video" ? "video" : "image";
        });
        if (kind === "video") {
          const job = queue.add({
            kind: "edit_video",
            scenes: [a.prompt],
            numbers: [nextNumber(output_dir, stem)],
            project: a.project,
            aspect: "16:9",
            variants: 1,
            size: "1K",
            asset: a.asset,
            download_quality: a.download_quality,
            max_credits: capOf(a.max_credits),
            output_dir,
            file_stem: stem,
            label: `edit ${a.asset}`.slice(0, 60),
          });
          return settle([job], a.wait, output_dir);
        }
        // Image edits are free and quick: done in this call.
        return onPage(a.project, async (page) => {
          const id = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a.asset)
            ? a.asset
            : (await scanGrid(page, (t) => t.some((x) => x.title.toLowerCase().startsWith(a.asset.toLowerCase())))).find((x) => x.title.toLowerCase().startsWith(a.asset.toLowerCase()))!.id;
          const r = await editImage(page, id, a.prompt, join(output_dir, stem), a.size as ImageSize, () => {});
          return { ...r, credits: 0, note: "Flow replaced the tile in place: the original is in the tile's history, the new media_id is the edited image." };
        });
      },
    ),
    def(
      "flow_characters",
      "Lists the characters of a Flow project (the Characters page). Reference one in flow_generate as reference_images ['asset:<name>']. Not available while a job is running.",
      z.object({ project }),
      async (a) => onPage(a.project, async (page) => ({ characters: (await listCharacters(page)).map((name) => ({ name, use_as: `asset:${name}` })) })),
    ),
    def(
      "flow_character",
      "Creates a reusable Flow character (free: Nano Banana draws the portrait). Give `describe` (Flow draws the portrait straight into the character editor) or `image` (an absolute path, or 'asset:<title>' of an image in the project); then it is named, given a stock voice and a personality (the voice must be one of Flow's own character voices such as Aoede, Charon or Achernar, NOT any Gemini TTS voice from flow_narrate: a name Flow does not list is not applied, the character is still made without a voice, and the result carries `voice_warning` naming the valid voices), and the portrait is saved to <out>/_cast/<name>.jpeg. Use it afterwards as reference_images ['asset:<name>'].",
      z.object({
        name: z.string().min(1).max(60),
        describe: z.string().max(1200).optional().describe("What the character looks like (a full-body description works best)."),
        image: z.string().min(1).optional().describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>'."),
        personality: z.string().max(500).optional().describe("How the character acts; Flow's agent uses it when crafting scenes."),
        voice: z.string().optional().describe("Flow character voice (a stock voice in the character editor's 'Select a voice', not every Gemini TTS voice from flow_narrate), e.g. 'Aoede' (female, breezy) or 'Charon' (male, informative)."),
        project,
        create_project: createProject,
        out,
      }),
      async (a) => {
        if (queue.busy) throw new Error(BUSY);
        return withSitePage("flow", async (page) => {
          const proj = await openProject(page, a.project, a.create_project ?? false);
          const made = await createCharacter(page, a, join(a.out ?? DEFAULT_FLOW_OUT, "_cast"), () => {});
          return { ...made, project: proj, use_as: `asset:${a.name}`, credits: 0 };
        });
      },
    ),
    def(
      "flow_character_edit",
      "Changes a character's look by redrawing its portrait in place (free), then saves the portrait to <out>/_cast/<name>.jpeg. Without `change` it only saves the current portrait. The editor draws 16:9 and the request is worded to keep exactly one figure.",
      z.object({
        name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
        change: z.string().min(1).max(600).optional().describe("What to change about the look, e.g. 'make her raincoat red, keep everything else the same'."),
        project,
        out,
      }),
      async (a) => {
        if (queue.busy) throw new Error(BUSY);
        return withSitePage("flow", async (page) => {
          await openProject(page, a.project, false);
          const r = await editCharacter(page, a.name, a.change, join(a.out ?? DEFAULT_FLOW_OUT, "_cast"), () => {});
          return { ...r, use_as: `asset:${a.name}`, credits: 0 };
        });
      },
    ),
    def(
      "flow_inspect",
      "Debugging: every visible control on the Flow page (role, name, state, link) plus any dialog text. `scope` is an optional CSS selector, e.g. flow-agent-panel. Use it to remap a selector after Flow changes its UI. Not available while a job is running.",
      z.object({ scope: z.string().optional() }),
      async (a) => {
        if (queue.busy) throw new Error(BUSY);
        return withSitePage("flow", (page) => inspect(page, a.scope));
      },
    ),
  ];
}
