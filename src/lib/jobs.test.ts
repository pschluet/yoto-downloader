import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobItem } from "@/lib/db";
import type { JobSnapshot, Track } from "@/types";

vi.mock("@/lib/db", () => ({
  putJob: vi.fn(),
  getJobItem: vi.fn(),
  getSnapshot: vi.fn(),
  updateTrack: vi.fn(),
  markCanceled: vi.fn(),
  deleteJobItem: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ deleteJobFiles: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueTrack: vi.fn() }));

import {
  deleteJobItem,
  getJobItem,
  getSnapshot as dbGetSnapshot,
  markCanceled,
  putJob,
  updateTrack,
} from "@/lib/db";
import { deleteJobFiles } from "@/lib/storage";
import { enqueueTrack } from "@/lib/queue";
import { cancelJob, createJob, deleteJob, getJob, getSnapshot, retryTrack } from "@/lib/jobs";

const mockPutJob = vi.mocked(putJob);
const mockGetJobItem = vi.mocked(getJobItem);
const mockDbGetSnapshot = vi.mocked(dbGetSnapshot);
const mockUpdateTrack = vi.mocked(updateTrack);
const mockMarkCanceled = vi.mocked(markCanceled);
const mockDeleteJobItem = vi.mocked(deleteJobItem);
const mockDeleteJobFiles = vi.mocked(deleteJobFiles);
const mockEnqueueTrack = vi.mocked(enqueueTrack);

function track(id: string): Track {
  return { id, title: `Title ${id}`, duration: 100, thumbnail: undefined, uploader: undefined };
}

function makeItem(overrides: Partial<JobItem> = {}): JobItem {
  return {
    jobId: "job-1",
    kind: "video",
    title: "Test",
    tracks: [],
    canceled: false,
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockPutJob.mockReset();
  mockGetJobItem.mockReset();
  mockDbGetSnapshot.mockReset();
  mockUpdateTrack.mockReset();
  mockMarkCanceled.mockReset();
  mockDeleteJobItem.mockReset();
  mockDeleteJobFiles.mockReset();
  mockEnqueueTrack.mockReset();
});

describe("createJob", () => {
  it("seeds tracks as pending with zero attempts, persists the job, and enqueues one message per track", async () => {
    const tracks = [track("a"), track("b")];
    const jobId = await createJob("playlist", "My Playlist", tracks);

    expect(jobId).toMatch(/^[0-9a-f-]{36}$/); // a UUID

    expect(mockPutJob).toHaveBeenCalledTimes(1);
    const [putJobId, kind, title, jobTracks] = mockPutJob.mock.calls[0];
    expect(putJobId).toBe(jobId);
    expect(kind).toBe("playlist");
    expect(title).toBe("My Playlist");
    expect(jobTracks).toEqual([
      { ...track("a"), status: "pending", pct: 0, etaSeconds: undefined, error: undefined, fileSize: undefined, attempts: 0 },
      { ...track("b"), status: "pending", pct: 0, etaSeconds: undefined, error: undefined, fileSize: undefined, attempts: 0 },
    ]);

    expect(mockEnqueueTrack).toHaveBeenCalledTimes(2);
    expect(mockEnqueueTrack).toHaveBeenCalledWith({ jobId, trackIndex: 0, videoId: "a" });
    expect(mockEnqueueTrack).toHaveBeenCalledWith({ jobId, trackIndex: 1, videoId: "b" });
  });
});

describe("getJob / getSnapshot", () => {
  it("getJob delegates to the db layer's raw item lookup", async () => {
    const item = makeItem();
    mockGetJobItem.mockResolvedValue(item);
    expect(await getJob("job-1")).toBe(item);
    expect(mockGetJobItem).toHaveBeenCalledWith("job-1");
  });

  it("getSnapshot delegates to the db layer's derived snapshot", async () => {
    const snapshot: JobSnapshot = { id: "job-1", kind: "video", title: "T", status: "done", tracks: [], createdAt: 0 };
    mockDbGetSnapshot.mockResolvedValue(snapshot);
    expect(await getSnapshot("job-1")).toBe(snapshot);
  });
});

describe("retryTrack", () => {
  it("returns not-found for an unknown job", async () => {
    mockGetJobItem.mockResolvedValue(undefined);
    expect(await retryTrack("missing", "a")).toBe("not-found");
    expect(mockEnqueueTrack).not.toHaveBeenCalled();
  });

  it("returns not-found for an unknown track", async () => {
    mockGetJobItem.mockResolvedValue(
      makeItem({ tracks: [{ ...track("a"), status: "failed", pct: 0, etaSeconds: undefined, error: "boom", fileSize: undefined, attempts: 2 }] }),
    );
    expect(await retryTrack("job-1", "nope")).toBe("not-found");
  });

  it("returns not-retryable for a track that isn't failed", async () => {
    mockGetJobItem.mockResolvedValue(
      makeItem({ tracks: [{ ...track("a"), status: "done", pct: 100, etaSeconds: undefined, error: undefined, fileSize: 10, attempts: 1 }] }),
    );
    expect(await retryTrack("job-1", "a")).toBe("not-retryable");
    expect(mockEnqueueTrack).not.toHaveBeenCalled();
  });

  it("returns not-retryable if the job was canceled, even if the track is failed", async () => {
    mockGetJobItem.mockResolvedValue(
      makeItem({
        canceled: true,
        tracks: [{ ...track("a"), status: "failed", pct: 0, etaSeconds: undefined, error: "boom", fileSize: undefined, attempts: 2 }],
      }),
    );
    expect(await retryTrack("job-1", "a")).toBe("not-retryable");
  });

  it("resets the track and re-enqueues it when retryable", async () => {
    mockGetJobItem.mockResolvedValue(
      makeItem({
        tracks: [
          { ...track("a"), status: "done", pct: 100, etaSeconds: undefined, error: undefined, fileSize: 10, attempts: 1 },
          { ...track("b"), status: "failed", pct: 0, etaSeconds: undefined, error: "boom", fileSize: undefined, attempts: 2 },
        ],
      }),
    );

    const result = await retryTrack("job-1", "b");

    expect(result).toBe("started");
    expect(mockUpdateTrack).toHaveBeenCalledWith("job-1", 1, {
      status: "pending",
      error: undefined,
      attempts: 0,
    });
    expect(mockEnqueueTrack).toHaveBeenCalledWith({ jobId: "job-1", trackIndex: 1, videoId: "b" });
  });
});

describe("cancelJob", () => {
  it("returns false for an unknown job without marking anything", async () => {
    mockGetJobItem.mockResolvedValue(undefined);
    expect(await cancelJob("missing")).toBe(false);
    expect(mockMarkCanceled).not.toHaveBeenCalled();
  });

  it("marks a known job canceled", async () => {
    mockGetJobItem.mockResolvedValue(makeItem());
    expect(await cancelJob("job-1")).toBe(true);
    expect(mockMarkCanceled).toHaveBeenCalledWith("job-1");
  });
});

describe("deleteJob", () => {
  it("returns false for an unknown job without deleting anything", async () => {
    mockGetJobItem.mockResolvedValue(undefined);
    expect(await deleteJob("missing")).toBe(false);
    expect(mockMarkCanceled).not.toHaveBeenCalled();
    expect(mockDeleteJobFiles).not.toHaveBeenCalled();
    expect(mockDeleteJobItem).not.toHaveBeenCalled();
  });

  it("cancels in-flight work, deletes S3 files, and removes the DynamoDB item", async () => {
    mockGetJobItem.mockResolvedValue(makeItem());
    expect(await deleteJob("job-1")).toBe(true);
    expect(mockMarkCanceled).toHaveBeenCalledWith("job-1");
    expect(mockDeleteJobFiles).toHaveBeenCalledWith("job-1");
    expect(mockDeleteJobItem).toHaveBeenCalledWith("job-1");
  });
});
