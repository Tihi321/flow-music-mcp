import { randomUUID } from "node:crypto";
import type { ComposeParams, Song } from "./music.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  params: ComposeParams;
  songs: Song[];
  session?: string;
  progress?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<{ session: string; songs: Song[] }>;

// Like flow-mcp: one generation at a time, with a randomised pause between them, the way a person would use the site.
const PAUSE_MIN_MS = Number(process.env.FLOW_MUSIC_MCP_PAUSE_MIN_S ?? 20) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MUSIC_MCP_PAUSE_MAX_S ?? 45) * 1000;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;

  constructor(private runner: JobRunner) {}

  add(params: ComposeParams): Job {
    const job: Job = { id: randomUUID().slice(0, 8), status: "queued", params, songs: [], createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job?.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  // Puts a failed or cancelled job back in line. Never done automatically: a failed job may still have spent credits.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
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
        try {
          const { session, songs } = await this.runner(job);
          job.session = session;
          job.songs = songs;
          job.status = "done";
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          job.status = "failed";
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
