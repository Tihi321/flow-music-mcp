import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closedWindowError } from "../src/chrome.js";
import { BaseJobQueue, MAX_JOBS, RESTART_ERROR, statusAfterRun, type BaseJob } from "../src/jobs.js";

interface TJob extends BaseJob<{ n: number }> {
  out?: number;
}

// A queue with an injectable runner, clock and sleep: pacing is recorded, never waited for.
class TQueue extends BaseJobQueue<TJob, { n: number }, number> {
  sleeps: number[] = [];
  constructor(runner: (job: TJob) => Promise<number>, file: string | undefined, key = "music", clock = { t: 1_000_000 }) {
    super(runner, { key, file, pauseMinMs: 1000, pauseMaxMs: 3000, rand: () => 0.5, now: () => clock.t, sleep: async (ms) => { clock.t += ms; this.sleeps.push(ms); } });
  }
  protected create(id: string, params: { n: number }): TJob {
    return { id, status: "queued", params, createdAt: "t" };
  }
  protected apply(job: TJob, out: number): void {
    job.out = out;
  }
}

// A queue like Flow's: cancels running jobs, and a result above 0 counts as made.
class CancelQueue extends TQueue {
  protected override get cancelsRunning(): boolean {
    return true;
  }
  protected override madeSomething(out: number): boolean {
    return out > 0;
  }
}

let dir: string;
let file: string;
beforeEach(() => {
  const base = join(process.cwd(), ".claude", "temp");
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, "jobs-test-"));
  file = join(dir, "jobs.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("statusAfterRun", () => {
  it("is done unless a cancel was requested and nothing was made", () => {
    expect(statusAfterRun(undefined, false)).toBe("done");
    expect(statusAfterRun(true, true)).toBe("done");
    expect(statusAfterRun(true, false)).toBe("cancelled");
  });
});

describe("cancel of a running job", () => {
  const run = async (made: number, throws = false) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new CancelQueue(async () => {
      await gate;
      if (throws) throw new Error("cancelled");
      return made;
    }, undefined);
    const job = q.add({ n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    q.cancel(job.id);
    release();
    await q.idle();
    return q.get(job.id)!;
  };
  it("ends done when the runner returned something", async () => {
    expect(await run(2)).toMatchObject({ status: "done", out: 2 });
  });
  it("ends cancelled when it made nothing, or threw", async () => {
    expect((await run(0)).status).toBe("cancelled");
    expect(await run(0, true)).toMatchObject({ status: "cancelled", error: "cancelled" });
  });
});

describe("BaseJobQueue", () => {
  it("runs jobs in order, pausing between them but not before the first", async () => {
    const order: number[] = [];
    const q = new TQueue(async (j) => (order.push(j.params.n), j.params.n * 2), file);
    const a = q.add({ n: 1 });
    q.add({ n: 2 });
    q.add({ n: 3 });
    await q.idle();
    expect(order).toEqual([1, 2, 3]);
    expect(q.get(a.id)).toMatchObject({ status: "done", out: 2 });
    expect(q.sleeps).toEqual([2000, 2000]); // min + 0.5 * (max - min), twice
    expect(q.pausedReason).toBeNull();
  });

  it("cancels a queued job, ignores a running one (music) and retries failed or cancelled ones", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fail = true;
    const q = new TQueue(async (j) => {
      if (j.params.n === 1) await gate;
      if (j.params.n === 2 && fail) throw new Error("boom");
      return 1;
    }, file);
    const running = q.add({ n: 1 });
    const queued = q.add({ n: 2 });
    expect(q.cancel(running.id)?.status).toBe("running");
    expect(running.cancelRequested).toBeUndefined();
    expect(q.cancel(queued.id)?.status).toBe("cancelled");
    expect(q.retry(running.id)?.status).toBe("running"); // not failed or cancelled: unchanged
    release();
    await q.idle();
    expect(running.status).toBe("done");
    fail = true;
    expect(q.retry(queued.id)?.status).toBe("queued");
    await q.idle();
    expect(queued).toMatchObject({ status: "failed", error: "boom" });
    fail = false;
    q.retry(queued.id);
    await q.idle();
    expect(queued).toMatchObject({ status: "done", error: undefined, finishedAt: expect.any(String) });
  });

  it("saves jobs and loads them back", async () => {
    const q = new TQueue(async () => 7, file);
    const job = q.add({ n: 5 });
    await q.idle();
    const again = new TQueue(async () => 0, file);
    expect(again.get(job.id)).toMatchObject({ status: "done", out: 7, params: { n: 5 } });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("fails queued and running jobs on load and never resumes them", () => {
    writeFileSync(
      file,
      JSON.stringify({
        music: [
          { id: "q", status: "queued", params: { n: 1 }, createdAt: "t" },
          { id: "r", status: "running", params: { n: 2 }, createdAt: "t", cancelRequested: true, progress: "x" },
          { id: "d", status: "done", params: { n: 3 }, createdAt: "t" },
        ],
      }),
    );
    let ran = 0;
    const q = new TQueue(async () => ++ran, file);
    expect(q.get("q")).toMatchObject({ status: "failed", error: RESTART_ERROR });
    expect(q.get("r")).toMatchObject({ status: "failed", error: RESTART_ERROR, cancelRequested: undefined, progress: undefined });
    expect(q.get("d")?.status).toBe("done");
    expect(ran).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).music.map((j: TJob) => j.status)).toEqual(["failed", "failed", "done"]);
  });

  it("keeps the other queue's key when saving", async () => {
    const music = new TQueue(async () => 1, file, "music");
    const flow = new TQueue(async () => 2, file, "flow");
    music.add({ n: 1 });
    await music.idle();
    flow.add({ n: 2 });
    await flow.idle();
    music.add({ n: 3 });
    await music.idle();
    const data = JSON.parse(readFileSync(file, "utf8"));
    expect(data.music).toHaveLength(2);
    expect(data.flow).toHaveLength(1);
  });

  it("moves a corrupt file to .bad and starts empty", () => {
    writeFileSync(file, "{ not json");
    const q = new TQueue(async () => 1, file);
    expect(q.list()).toEqual([]);
    expect(existsSync(`${file}.bad`)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("starts empty with no file and writes nothing without a path", async () => {
    const q = new TQueue(async () => 1, undefined);
    q.add({ n: 1 });
    await q.idle();
    expect(q.list()).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the newest 200 jobs, dropping the oldest finished first", () => {
    const jobs = Array.from({ length: MAX_JOBS + 5 }, (_, i) => ({ id: `j${i}`, status: i === 0 ? "done" : i < 3 ? "failed" : "done", params: { n: i }, createdAt: "t" }));
    jobs[100] = { id: "j100", status: "queued", params: { n: 100 }, createdAt: "t" }; // restart rule turns it into failed
    writeFileSync(file, JSON.stringify({ music: jobs }));
    const q = new TQueue(async () => 1, file);
    q.save();
    const ids = q.list().map((j) => j.id);
    expect(ids).toHaveLength(MAX_JOBS);
    expect(ids[0]).toBe("j5");
    expect(ids.at(-1)).toBe(`j${MAX_JOBS + 4}`);
  });
});

describe("closedWindowError", () => {
  const closed = [
    "page.click: Target page, context or browser has been closed",
    "browserContext.newPage: Target closed",
    "Browser has been disconnected",
  ];
  it.each(closed)("maps %s", (msg) => {
    const out = closedWindowError("flow", new Error(msg)) as Error;
    expect(out.message).toMatch(/^The Flow window was closed \(or Chrome quit\) while the job ran\./);
  });
  it("names Flow Music for the music site", () => {
    expect((closedWindowError("music", new Error("Target closed")) as Error).message).toMatch(/^The Flow Music window was closed/);
  });
  it("passes other errors through unchanged", () => {
    const err = new Error("Flow is not signed in.");
    expect(closedWindowError("flow", err)).toBe(err);
    expect(closedWindowError("flow", "plain")).toBe("plain");
  });
});
