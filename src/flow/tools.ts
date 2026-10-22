import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { CDP_PORT, HOME_DIR, PROFILE_DIR, cdpUp, withSitePage } from "../chrome.js";
import type { Tool } from "../mcp/tools.js";
import { runImages } from "./agent.js";
import { downloadTile, ensureProjectGrid, findTile, flowState, inspect, listAssets, openProject, scanGrid, tileResolver, trashTile, type ImageSize } from "./driver.js";
import { FlowJobQueue, type Aspect, type FlowJob } from "./queue.js";

// The Flow MCP tools (flow.google.com). Names and shapes follow flow-mcp so skills and habits carry over; the engine is new
// (src/flow/agent.ts): every generation goes through Flow's creative agent. Images (Nano Banana) are free, Flow video and
// voices spend credits (video arrives in phase 6 of FMM-02).

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

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 60) || "image";

// Guidance handed to the calling model through flow_status, so it plans work Flow can run.
const PLAYBOOK = [
  "Call flow_status first. If it has a hint (not signed in, Chrome down), relay it to the user and stop.",
  "Flow images (Nano Banana) are free. Flow video, Flow voices and video edits SPEND CREDITS: ask the user first and set max_credits. Video arrives in phase 6; flow_generate refuses it now.",
  "flow_generate makes one image per scene as separate paced jobs (25-70 s apart); flow_agent_images asks the agent for all scenes in one request and is much faster for sets.",
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
  ...(job.project ? { project: job.project } : {}),
  files: job.files.map((f) => f.file),
  images: job.files,
  ...(job.failed_scenes.length ? { failed_scenes: job.failed_scenes } : {}),
  created: job.createdAt,
  ...(job.finishedAt ? { finished: job.finishedAt } : {}),
});

export function buildFlowTools(): Tool[] {
  const def = <S extends z.ZodType>(name: string, description: string, schema: S, run: (args: z.output<S>) => Promise<unknown>): Tool => ({
    name,
    description,
    schema,
    run: run as Tool["run"],
  });

  const queue = new FlowJobQueue((job) =>
    withSitePage("flow", (page) =>
      runImages(page, job, {
        progress: (note) => {
          job.progress = note;
        },
        cancelled: () => Boolean(job.cancelRequested),
      }),
    ),
  );

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
          paused: queue.pausedReason ?? undefined,
          jobs: queue.list().map(jobView),
          playbook: PLAYBOOK,
        };
      },
    ),
    def(
      "flow_generate",
      "Makes images in Flow through its creative agent, one paced job per scene, and downloads them as <name>-NN.jpeg (NN = scene number). IMAGES ARE FREE. Prompts go to the agent exactly as written. Video is not available yet (phase 6, spends credits). Returns the files, or job ids while still running (then flow_wait). For many images at once use flow_agent_images.",
      z.object({
        scenes: z
          .array(
            z.object({
              prompt: z.string().min(1).describe("Full English prompt for one image"),
              type: z.enum(["image", "video"]).default("image").describe("image only for now; video is refused (phase 6)"),
              aspect_ratio: aspect.optional().describe("Default 16:9"),
              variants: z.number().int().min(1).max(4).optional().describe("Variations of this scene (default 1); extras are saved as -vN"),
              model: z.string().optional().describe('Image model as the agent settings menu shows it, e.g. "Nano Banana Pro". Default: the newest Nano Banana (2.1 today).'),
            }),
          )
          .min(1)
          .max(50),
        project,
        create_project: createProject,
        out,
        name: z.string().optional().describe("File name stem (default: scene)"),
        start_number: startNumber,
        size,
        wait,
      }),
      async (a) => {
        const bad = a.scenes.findIndex((s) => s.type === "video");
        if (bad >= 0) throw new Error(`Scene ${bad + 1}: video arrives in phase 6 (FMM-02). It spends credits, so it is not offered yet; make images for now.`);
        const output_dir = a.out ?? DEFAULT_FLOW_OUT;
        const stem = slug(a.name ?? "scene");
        const first = a.start_number ?? nextNumber(output_dir, stem);
        const jobs = a.scenes.map((s, i) =>
          queue.add({
            kind: "images",
            scenes: [s.prompt],
            numbers: [first + i],
            project: a.project,
            create_project: a.create_project,
            aspect: (s.aspect_ratio ?? "16:9") as Aspect,
            variants: s.variants ?? 1,
            model: s.model,
            size: a.size as ImageSize,
            max_credits: 0,
            output_dir,
            file_stem: stem,
            label: s.prompt.slice(0, 60),
          }),
        );
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
          return job ? jobView(job) : { job_id: id, status: "unknown", note: "Not a job of this server process (it may have restarted). Check flow_assets: Flow's grid is the honest record." };
        });
        return { finished: jobs.every((j) => !["queued", "running"].includes(j.status)), paused: queue.pausedReason ?? undefined, jobs };
      },
    ),
    def(
      "flow_cancel",
      "Cancels a queued Flow job. A running job is asked to stop (the agent's Stop button is pressed) and ends as cancelled with whatever finished.",
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
      "Lists the media in a Flow project's grid (newest first): media_id, title and kind (image, video, scene). media_id is the stable handle; titles repeat. Spends no credits. Not available while a job is running.",
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
            assets: assets.slice(0, a.limit).map((t) => ({ media_id: t.id.startsWith("title:") ? undefined : t.id, title: t.title, kind: t.kind, ...(t.busy ? { rendering: true } : {}) })),
          };
        }),
    ),
    def(
      "flow_download",
      "Downloads one existing Flow image by media_id (from flow_assets or a job) or by title, at 1K (original), 2K or 4K (upscaled). Spends no credits. Not available while a job is running.",
      z.object({
        media_id: z.string().min(8).optional(),
        title: z.string().min(1).optional().describe("Title, when there is no media_id (exact match first, then prefix; the newest wins)"),
        project,
        size,
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
          if (await tile.locator("flow-video-tile, flow-scene-tile").count()) throw new Error("Video and scene downloads arrive in phase 6; flow_download handles images only for now.");
          const file = await downloadTile(page, tileResolver(page, id), join(a.out ?? DEFAULT_FLOW_OUT, slug(a.name ?? (title || id.slice(0, 8)))), a.size as ImageSize);
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
