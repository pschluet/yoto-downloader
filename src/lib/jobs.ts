import { randomUUID } from "node:crypto";
import {
  deleteJobItem,
  getJobItem,
  getSnapshot as dbGetSnapshot,
  markCanceled,
  putJob,
  updateTrack,
  type JobItem,
} from "@/lib/db";
import { deleteJobFiles } from "@/lib/storage";
import { enqueueTrack } from "@/lib/queue";
import type { JobSnapshot, JobTrack, Track } from "@/types";

export type { JobItem } from "@/lib/db";

/**
 * Creates a job and kicks off one SQS message per track. Unlike the
 * local/Docker version of this app, there's no in-process worker here —
 * the actual downloading happens in the worker Lambda, triggered by those
 * messages (see src/worker/handler.ts).
 */
export async function createJob(
  kind: "video" | "playlist",
  title: string,
  tracks: Track[],
): Promise<string> {
  const jobId = randomUUID();
  const jobTracks: JobTrack[] = tracks.map((t) => ({
    ...t,
    status: "pending",
    pct: 0,
    etaSeconds: undefined,
    error: undefined,
    fileSize: undefined,
    attempts: 0,
  }));

  await putJob(jobId, kind, title, jobTracks);
  await Promise.all(
    jobTracks.map((track, index) => enqueueTrack({ jobId, trackIndex: index, videoId: track.id })),
  );

  return jobId;
}

/** Raw job record (kind/title/tracks/canceled), for routes that need more than the snapshot. */
export async function getJob(jobId: string): Promise<JobItem | undefined> {
  return getJobItem(jobId);
}

export async function getSnapshot(jobId: string): Promise<JobSnapshot | undefined> {
  return dbGetSnapshot(jobId);
}

export type RetryResult = "started" | "not-found" | "not-retryable";

/** Manually retries one failed track by resetting it and re-enqueueing it. */
export async function retryTrack(jobId: string, trackId: string): Promise<RetryResult> {
  const item = await getJobItem(jobId);
  if (!item) return "not-found";

  const index = item.tracks.findIndex((t) => t.id === trackId);
  if (index === -1) return "not-found";

  const track = item.tracks[index];
  if (track.status !== "failed" || item.canceled) return "not-retryable";

  await updateTrack(jobId, index, { status: "pending", error: undefined, attempts: 0 });
  await enqueueTrack({ jobId, trackIndex: index, videoId: track.id });
  return "started";
}

/**
 * Best-effort cancel: flips a flag the worker checks between attempts and
 * before starting a track. There's no way to remotely kill a worker
 * invocation that's already running — unlike the local/Docker version's
 * instant SIGKILL, an in-flight download here runs to completion (or its
 * own failure) before the cancellation takes effect.
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const item = await getJobItem(jobId);
  if (!item) return false;
  await markCanceled(jobId);
  return true;
}

export async function deleteJob(jobId: string): Promise<boolean> {
  const item = await getJobItem(jobId);
  if (!item) return false;
  await markCanceled(jobId);
  await deleteJobFiles(jobId);
  await deleteJobItem(jobId);
  return true;
}
