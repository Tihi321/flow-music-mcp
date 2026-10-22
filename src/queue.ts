import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";
import { BaseJobQueue, type BaseJob, type JobStatus } from "./jobs.js";
import type { GenerateResult, MusicParams, Song } from "./music.js";

export type { JobStatus };

export interface Job extends BaseJob<MusicParams> {
  songs: Song[];
  session?: string;
  credits_after?: number;
  credits_spent?: number;
}

export type JobRunner = (job: Job) => Promise<GenerateResult>;

// Like flow-mcp: one generation at a time, with a randomised pause between them, the way a person would use the site.
const PAUSE_MIN_MS = Number(process.env.FLOW_MUSIC_MCP_PAUSE_MIN_S ?? 20) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MUSIC_MCP_PAUSE_MAX_S ?? 45) * 1000;

export class JobQueue extends BaseJobQueue<Job, MusicParams, GenerateResult> {
  constructor(runner: JobRunner, file = join(HOME_DIR, "jobs.json")) {
    super(runner, { key: "music", file, pauseMinMs: PAUSE_MIN_MS, pauseMaxMs: PAUSE_MAX_MS });
  }

  protected create(id: string, params: MusicParams): Job {
    return { id, status: "queued", params, songs: [], createdAt: new Date().toISOString() };
  }

  protected apply(job: Job, out: GenerateResult): void {
    job.session = out.session;
    job.songs = out.songs;
    job.credits_after = out.credits_after;
    job.credits_spent = out.credits_spent;
  }
}
