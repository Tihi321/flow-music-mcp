import { join } from "node:path";
import { HOME_DIR } from "../chrome.js";
import { BaseJobQueue, type BaseJob, type JobStatus } from "../jobs.js";
import type { ImageSize } from "./driver.js";
import { FINISHED_AFTER_CANCEL } from "./pure.js";

// The Flow job queue, ported from flow-mcp (src/queue.ts): one Flow generation at a time with a randomised pause between
// them, the way a person would use the site. Separate from the Flow Music queue (src/queue.ts): a song and a Flow job may
// run at the same time, two Flow jobs may not.

export type { JobStatus };
export type Aspect = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export interface FlowJobParams {
  // images: one agent request for all scenes (flow_agent_images); scene: one generation in the direct composer
  // (flow_generate, flow_narrate engine flow); continue: flow_continue; edit_video: flow_edit on a video.
  kind: "images" | "scene" | "continue" | "edit_video";
  // For "images": every scene of the job. Other kinds carry one prompt in scenes[0].
  scenes: string[];
  // The number each scene is saved as (scene-03.jpeg), same length as scenes.
  numbers: number[];
  project?: string;
  create_project?: boolean;
  aspect: Aspect;
  variants: number;
  model?: string;
  size: ImageSize;
  // scene
  type?: "image" | "video";
  duration?: number;
  resolution?: "360p" | "720p";
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  // The previous scene's job: its last frame becomes this scene's first frame / its image a reference (flow-mcp).
  chain_from?: string;
  reference_from?: string;
  voice?: string;
  voice_image?: string;
  // flow_narrate engine flow: where the take's sound is saved as .m4a once the take is downloaded.
  audio_target?: string;
  retries?: number;
  download_quality?: "original" | "upscaled";
  // continue / edit_video: the video to continue or edit (media id or title); characters to keep; I2V "exact" or R2V "likeness"
  asset?: string;
  attach?: string[];
  mode?: "exact" | "likeness";
  max_credits: number;
  output_dir: string;
  file_stem: string;
  label: string;
}

export interface FlowFile {
  scene: number;
  file: string;
  media_id: string;
  title: string;
  variant: number;
  // The video's /asb/ token (FMM-08): a settled video tile has no uuid, "asb:<thumb>" is its handle.
  thumb?: string;
}

export interface FlowJob extends BaseJob<FlowJobParams> {
  files: FlowFile[];
  // Scene numbers still missing after the agent was asked again; flow_retry makes just these.
  failed_scenes: number[];
  project?: { id: string; name: string };
  note?: string;
  // Credits the composer quoted before starting, and the balance change measured around the job.
  credits_quote?: number;
  credits_spent?: number;
  attempts: number;
}

export interface JobOutcome {
  files: FlowFile[];
  failed: number[];
  note?: string;
  project?: { id: string; name: string };
  credits_quote?: number;
  credits_spent?: number;
}

export type JobRunner = (job: FlowJob) => Promise<JobOutcome>;

const PAUSE_MIN_MS = Number(process.env.FLOW_MUSIC_MCP_FLOW_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MUSIC_MCP_FLOW_PAUSE_MAX_S ?? 70) * 1000;

export class FlowJobQueue extends BaseJobQueue<FlowJob, FlowJobParams, JobOutcome> {
  constructor(runner: JobRunner, file = join(HOME_DIR, "jobs.json")) {
    super(runner, { key: "flow", file, pauseMinMs: PAUSE_MIN_MS, pauseMaxMs: PAUSE_MAX_MS });
  }

  // A running Flow job is asked to stop (the agent's Stop button) and ends as cancelled, or done when it had already made files.
  protected override get cancelsRunning(): boolean {
    return true;
  }

  protected create(id: string, params: FlowJobParams): FlowJob {
    return { id, status: "queued", params, files: [], failed_scenes: [], attempts: 0, createdAt: new Date().toISOString() };
  }

  protected override started(job: FlowJob): void {
    job.attempts++;
  }

  protected override madeSomething(out: JobOutcome): boolean {
    return out.files.length > 0;
  }

  protected override finishedAfterCancel(job: FlowJob): void {
    job.note = [job.note, FINISHED_AFTER_CANCEL].filter(Boolean).join(" · ");
  }

  protected apply(job: FlowJob, out: JobOutcome): void {
    job.files = out.files;
    job.failed_scenes = out.failed;
    job.note = out.note;
    job.project = out.project ?? job.project;
    job.credits_quote = out.credits_quote;
    job.credits_spent = out.credits_spent;
  }
}
