import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadTrack, YtdlpError } from "@/lib/ytdlp";
import type { JobSnapshot, JobStatus, JobTrack, Track } from "@/types";

export type Job = {
  id: string;
  kind: "video" | "playlist";
  title: string;
  status: JobStatus;
  tracks: JobTrack[];
  createdAt: number;
  tmpDir: string;
  controller: AbortController;
  subscribers: Set<(snapshot: JobSnapshot) => void>;
  cleanedUp: boolean;
};

// Keep the job map (and the interval/exit-handler below) on globalThis so
// Next's dev-mode module reloading doesn't drop jobs that are mid-download.
const g = globalThis as unknown as {
  __ytoJobs?: Map<string, Job>;
  __ytoJobsInitialized?: boolean;
};
const jobs: Map<string, Job> = g.__ytoJobs ?? new Map();
g.__ytoJobs = jobs;

const CONCURRENCY = 3;
const MAX_AGE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_AUTO_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

export function trackFilePath(tmpDir: string, videoId: string): string {
  return path.join(tmpDir, `${videoId}.mp3`);
}

function toSnapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    tracks: job.tracks.map((t) => ({ ...t })),
    createdAt: job.createdAt,
  };
}

function emit(job: Job) {
  const snap = toSnapshot(job);
  for (const cb of job.subscribers) cb(snap);
}

async function cleanupJob(job: Job) {
  if (job.cleanedUp) return;
  job.cleanedUp = true;
  await rm(job.tmpDir, { recursive: true, force: true }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one download attempt, mutating the track's live progress fields as it goes. */
async function attemptDownload(job: Job, track: JobTrack): Promise<"done" | "canceled" | "failed"> {
  track.status = "downloading";
  track.pct = 0;
  track.etaSeconds = undefined;
  track.error = undefined;
  emit(job);

  try {
    await downloadTrack(
      track.id,
      job.tmpDir,
      (progress) => {
        if (progress.phase === "downloading") {
          track.status = "downloading";
          track.pct = progress.pct;
          track.etaSeconds = progress.etaSeconds;
        } else {
          track.status = "converting";
        }
        emit(job);
      },
      job.controller.signal,
    );
    track.pct = 100;
    try {
      const info = await stat(trackFilePath(job.tmpDir, track.id));
      track.fileSize = info.size;
    } catch {
      // Non-fatal: file size is cosmetic.
    }
    return "done";
  } catch (err) {
    if (job.controller.signal.aborted) return "canceled";
    track.error = err instanceof YtdlpError ? err.message : "Download failed.";
    return "failed";
  }
}

/**
 * Downloads one track, automatically retrying transient failures up to
 * MAX_AUTO_ATTEMPTS times before settling on "failed" (at which point the
 * client offers a manual retry — see retryTrack below).
 */
async function runTrack(job: Job, index: number) {
  const track = job.tracks[index];
  if (job.controller.signal.aborted) {
    track.status = "canceled";
    emit(job);
    return;
  }

  for (let attempt = 1; attempt <= MAX_AUTO_ATTEMPTS; attempt++) {
    track.attempts = attempt;
    const outcome = await attemptDownload(job, track);
    track.status = outcome;
    emit(job);
    if (outcome !== "failed") return;
    if (attempt < MAX_AUTO_ATTEMPTS && !job.controller.signal.aborted) {
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function recomputeStatus(job: Job) {
  if (job.controller.signal.aborted) {
    job.status = "canceled";
  } else if (job.tracks.length > 0 && job.tracks.every((t) => t.status === "failed")) {
    job.status = "failed";
  } else if (
    job.tracks.some((t) => t.status === "pending" || t.status === "downloading" || t.status === "converting")
  ) {
    job.status = "running";
  } else {
    job.status = "done";
  }
  emit(job);
}

/** Runs every track through a small concurrency pool, then finalizes job.status. */
async function runJob(job: Job) {
  const indices = job.tracks.map((_, i) => i);
  let cursor = 0;
  let active = 0;

  await new Promise<void>((done) => {
    let remaining = indices.length;
    if (remaining === 0) {
      done();
      return;
    }

    const pump = () => {
      if (job.controller.signal.aborted) {
        if (active === 0) done();
        return;
      }
      while (active < CONCURRENCY && cursor < indices.length) {
        const index = indices[cursor++];
        active++;
        runTrack(job, index).finally(() => {
          active--;
          remaining--;
          if (remaining === 0) done();
          else pump();
        });
      }
    };
    pump();
  });

  recomputeStatus(job);
}

export async function createJob(
  kind: "video" | "playlist",
  title: string,
  tracks: Track[],
): Promise<string> {
  const id = randomUUID();
  const tmpDir = await mkdtemp(path.join(tmpdir(), "yoto-"));
  const job: Job = {
    id,
    kind,
    title,
    status: "running",
    tracks: tracks.map((t): JobTrack => ({
      ...t,
      status: "pending",
      pct: 0,
      etaSeconds: undefined,
      error: undefined,
      fileSize: undefined,
      attempts: 0,
    })),
    createdAt: Date.now(),
    tmpDir,
    controller: new AbortController(),
    subscribers: new Set(),
    cleanedUp: false,
  };
  jobs.set(id, job);
  ensureLifecycleHandlers();

  // Fire and forget; per-track errors are captured on the track itself.
  void runJob(job);

  return id;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getSnapshot(id: string): JobSnapshot | undefined {
  const job = jobs.get(id);
  return job ? toSnapshot(job) : undefined;
}

export function subscribe(
  id: string,
  cb: (snapshot: JobSnapshot) => void,
): (() => void) | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.subscribers.add(cb);
  return () => job.subscribers.delete(cb);
}

/**
 * Aborts a job's in-flight work. If the job hadn't already reached a terminal
 * state, marks it (and any track that never got to run) "canceled" and emits
 * — leaving an already-finished job's status alone so deleting a completed
 * job for cleanup doesn't stomp its real outcome.
 */
function markCanceled(job: Job) {
  job.controller.abort();
  if (job.status !== "running") return;
  job.status = "canceled";
  for (const track of job.tracks) {
    if (track.status === "pending" || track.status === "downloading" || track.status === "converting") {
      track.status = "canceled";
    }
  }
  emit(job);
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  markCanceled(job);
  await cleanupJob(job);
  return true;
}

export type RetryResult = "started" | "not-found" | "not-retryable";

/** Manually retries one failed track. Re-enters the same auto-retry loop as a fresh download. */
export async function retryTrack(jobId: string, trackId: string): Promise<RetryResult> {
  const job = jobs.get(jobId);
  if (!job) return "not-found";

  const index = job.tracks.findIndex((t) => t.id === trackId);
  if (index === -1) return "not-found";

  const track = job.tracks[index];
  if (track.status !== "failed" || job.controller.signal.aborted) {
    return "not-retryable";
  }

  track.status = "pending";
  track.error = undefined;
  track.attempts = 0;
  job.status = "running";
  emit(job);

  void runTrack(job, index).finally(() => recomputeStatus(job));
  return "started";
}

export async function deleteJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  markCanceled(job);
  await cleanupJob(job);
  jobs.delete(id);
  return true;
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > MAX_AGE_MS) {
      markCanceled(job);
      void cleanupJob(job).finally(() => jobs.delete(id));
    }
  }
}

function ensureLifecycleHandlers() {
  if (g.__ytoJobsInitialized) return;
  g.__ytoJobsInitialized = true;

  const interval = setInterval(sweep, SWEEP_INTERVAL_MS);
  interval.unref();

  // Best-effort synchronous cleanup if the process exits with jobs still around.
  process.on("exit", () => {
    for (const job of jobs.values()) {
      try {
        rmSync(job.tmpDir, { recursive: true, force: true });
      } catch {
        // Nothing more we can do on the way out.
      }
    }
  });
}
