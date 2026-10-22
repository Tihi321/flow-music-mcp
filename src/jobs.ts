import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nextDelay } from "./util.js";

// The job queue both sites share (music: src/queue.ts, Flow: src/flow/queue.ts). No playwright or env imports, so tests can
// load it. One job at a time with a randomised pause between jobs, the way a person would use the site, and the jobs are
// saved to a JSON file so a restart does not forget job ids.

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface BaseJob<P> {
  id: string;
  status: JobStatus;
  params: P;
  progress?: string;
  error?: string;
  cancelRequested?: boolean;
  createdAt: string;
  finishedAt?: string;
}

export interface QueueOptions {
  // Key in the shared jobs file ("music" or "flow"): each queue only ever writes its own.
  key: string;
  // The jobs file; undefined = nothing is saved.
  file?: string;
  pauseMinMs: number;
  pauseMaxMs: number;
  // Injectable for tests (defaults: Math.random, Date.now, setTimeout).
  rand?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const MAX_JOBS = 200;
export const RESTART_ERROR = "The server restarted before this job finished; files already saved are kept. Use *_retry to run it again.";

type JobsFile = Record<string, unknown[]>;

// The whole file, or {} when missing. A corrupt file is moved to <file>.bad and treated as empty.
function readFile(file: string): JobsFile {
  if (!existsSync(file)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data as JobsFile;
  } catch {
    // falls through to the .bad rename
  }
  try {
    renameSync(file, `${file}.bad`);
  } catch {
    // nothing more to do; the next write replaces it
  }
  return {};
}

export abstract class BaseJobQueue<J extends BaseJob<P>, P, R = unknown> {
  protected jobs = new Map<string, J>();
  private working = false;
  private lastFinished = 0;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  pausedReason: string | null = null;

  constructor(
    private runner: (job: J) => Promise<R>,
    private opts: QueueOptions,
  ) {
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.load();
  }

  // A new queued job with empty results.
  protected abstract create(id: string, params: P): J;
  // Copies a runner's result onto the job (songs, files, credits ...).
  protected abstract apply(job: J, out: R): void;
  // Whether cancel() on a running job asks it to stop (Flow) or does nothing (music).
  protected get cancelsRunning(): boolean {
    return false;
  }
  // Runs when a job starts.
  protected started(_job: J): void {}

  // Jobs from the file; one that was queued or running when the server stopped is failed, never resumed (it could
  // spend credits again).
  private load(): void {
    if (!this.opts.file) return;
    let changed = false;
    for (const raw of readFile(this.opts.file)[this.opts.key] ?? []) {
      const job = raw as J;
      if (!job || typeof job.id !== "string") continue;
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error = RESTART_ERROR;
        job.finishedAt = new Date(this.now()).toISOString();
        changed = true;
      }
      job.cancelRequested = undefined;
      job.progress = undefined;
      this.jobs.set(job.id, job);
    }
    if (changed) this.save();
  }

  // Writes this queue's jobs under its own key; the file is read again first so the other queue's key is kept. Keeps the
  // newest MAX_JOBS, dropping the oldest finished jobs first.
  save(): void {
    this.trim();
    const file = this.opts.file;
    if (!file) return;
    try {
      const data = readFile(file);
      data[this.opts.key] = this.list();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 1));
      renameSync(tmp, file);
    } catch (err) {
      console.error(`could not save ${file}:`, err);
    }
  }

  private trim(): void {
    let extra = this.jobs.size - MAX_JOBS;
    for (const finished of [true, false]) {
      for (const job of [...this.jobs.values()]) {
        if (extra <= 0) return;
        if (finished === (job.status !== "queued" && job.status !== "running")) {
          this.jobs.delete(job.id);
          extra--;
        }
      }
    }
  }

  add(params: P): J {
    const job = this.create(randomUUID().slice(0, 8), params);
    this.jobs.set(job.id, job);
    this.save();
    void this.work();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): J | undefined {
    return this.jobs.get(id);
  }

  list(): J[] {
    return [...this.jobs.values()];
  }

  // A queued job is cancelled at once. A running one is asked to stop when the site's runner can (Flow).
  cancel(id: string): J | undefined {
    const job = this.jobs.get(id);
    if (job?.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date(this.now()).toISOString();
      this.save();
    } else if (job?.status === "running" && this.cancelsRunning) {
      job.cancelRequested = true;
      this.save();
    }
    return job;
  }

  // Puts a failed or cancelled job back in line. Never automatic: a failed job may still have spent credits.
  retry(id: string): J | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.cancelRequested = false;
      job.finishedAt = undefined;
      this.save();
      void this.work();
    }
    return job;
  }

  async wait(ids: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const open = () => ids.some((id) => ["queued", "running"].includes(this.jobs.get(id)?.status ?? ""));
    while (open() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  }

  // Resolves when the work loop is idle (for tests).
  async idle(): Promise<void> {
    while (this.working) await new Promise((r) => setTimeout(r, 5));
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const remaining = nextDelay(this.lastFinished, this.now(), this.opts.pauseMinMs, this.opts.pauseMaxMs, this.rand);
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await this.sleep(remaining);
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        job.status = "running";
        this.started(job);
        this.save();
        try {
          this.apply(job, await this.runner(job));
          job.error = undefined;
          job.status = job.cancelRequested ? "cancelled" : "done";
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          job.status = job.cancelRequested ? "cancelled" : "failed";
        }
        job.progress = undefined;
        job.finishedAt = new Date(this.now()).toISOString();
        this.lastFinished = this.now();
        this.save();
      }
    } finally {
      this.working = false;
    }
  }
}
