import { randomUUID } from "node:crypto";
import type { ImageSize } from "./driver.js";

// The Flow job queue, ported from flow-mcp (src/queue.ts): one Flow generation at a time with a randomised pause between
// them, the way a person would use the site. Separate from the Flow Music queue (src/queue.ts): a song and a Flow job may
// run at the same time, two Flow jobs may not.

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Aspect = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export interface FlowJobParams {
  kind: "images";
  // One agent request: every scene of the job. flow_generate makes one job per scene, flow_agent_images one job for all.
  scenes: string[];
  // The number each scene is saved as (scene-03.jpeg), same length as scenes.
  numbers: number[];
  project?: string;
  create_project?: boolean;
  aspect: Aspect;
  variants: number;
  model?: string;
  size: ImageSize;
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
}

export interface FlowJob {
  id: string;
  status: JobStatus;
  params: FlowJobParams;
  files: FlowFile[];
  // Scene numbers still missing after the agent was asked again; flow_retry makes just these.
  failed_scenes: number[];
  project?: { id: string; name: string };
  progress?: string;
  note?: string;
  error?: string;
  attempts: number;
  cancelRequested?: boolean;
  createdAt: string;
  finishedAt?: string;
}

export interface JobOutcome {
  files: FlowFile[];
  failed: number[];
  note?: string;
  project?: { id: string; name: string };
}

export type JobRunner = (job: FlowJob) => Promise<JobOutcome>;

const PAUSE_MIN_MS = Number(process.env.FLOW_MUSIC_MCP_FLOW_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MUSIC_MCP_FLOW_PAUSE_MAX_S ?? 70) * 1000;

export class FlowJobQueue {
  private jobs = new Map<string, FlowJob>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;

  constructor(private runner: JobRunner) {}

  add(params: FlowJobParams): FlowJob {
    const job: FlowJob = { id: randomUUID().slice(0, 8), status: "queued", params, files: [], failed_scenes: [], attempts: 0, createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): FlowJob | undefined {
    return this.jobs.get(id);
  }

  list(): FlowJob[] {
    return [...this.jobs.values()];
  }

  // A queued job is cancelled at once; a running one is asked to stop (the agent's Stop button) and ends as cancelled.
  cancel(id: string): FlowJob | undefined {
    const job = this.jobs.get(id);
    if (job?.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    } else if (job?.status === "running") job.cancelRequested = true;
    return job;
  }

  // Puts a failed or cancelled job back in line. Never automatic: a failed job may still have spent credits.
  retry(id: string): FlowJob | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.cancelRequested = false;
      job.finishedAt = undefined;
      void this.work();
    }
    return job;
  }

  async wait(ids: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const open = () => ids.some((id) => ["queued", "running"].includes(this.jobs.get(id)?.status ?? ""));
    while (open() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const remaining = this.lastFinished + PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS) - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        job.status = "running";
        job.attempts++;
        try {
          const out = await this.runner(job);
          job.files = out.files;
          job.failed_scenes = out.failed;
          job.note = out.note;
          job.project = out.project ?? job.project;
          job.status = job.cancelRequested ? "cancelled" : "done";
          job.error = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          job.status = job.cancelRequested ? "cancelled" : "failed";
        }
        job.progress = undefined;
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
