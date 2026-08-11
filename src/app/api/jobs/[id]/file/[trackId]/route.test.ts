import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobItem } from "@/lib/jobs";
import type { JobTrack } from "@/types";

vi.mock("@/lib/jobs", () => ({ getJob: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getPresignedDownloadUrl: vi.fn() }));

import { getJob } from "@/lib/jobs";
import { getPresignedDownloadUrl } from "@/lib/storage";
import { GET } from "./route";

const mockGetJob = vi.mocked(getJob);
const mockGetPresignedDownloadUrl = vi.mocked(getPresignedDownloadUrl);

function ctx(id: string, trackId: string) {
  return { params: Promise.resolve({ id, trackId }) };
}

function makeTrack(overrides: Partial<JobTrack> & { id: string }): JobTrack {
  return {
    title: `Title ${overrides.id}`,
    duration: 100,
    thumbnail: undefined,
    uploader: undefined,
    status: "done",
    pct: 100,
    etaSeconds: undefined,
    error: undefined,
    fileSize: undefined,
    attempts: 1,
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobItem> = {}): JobItem {
  return {
    jobId: "job-1",
    kind: "playlist",
    title: "Test Job",
    tracks: [],
    canceled: false,
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetJob.mockReset();
  mockGetPresignedDownloadUrl.mockReset();
});

describe("GET /api/jobs/[id]/file/[trackId]", () => {
  it("404s for an unknown job", async () => {
    mockGetJob.mockResolvedValue(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing", "t"));
    expect(res.status).toBe(404);
  });

  it("409s for a track id that isn't part of the job", async () => {
    mockGetJob.mockResolvedValue(makeJob({ tracks: [makeTrack({ id: "a", status: "done" })] }));
    const res = await GET(new Request("http://localhost"), ctx("job-1", "nope"));
    expect(res.status).toBe(409);
  });

  it("409s for a track that hasn't finished yet", async () => {
    mockGetJob.mockResolvedValue(
      makeJob({ tracks: [makeTrack({ id: "a", status: "downloading" })] }),
    );
    const res = await GET(new Request("http://localhost"), ctx("job-1", "a"));
    expect(res.status).toBe(409);
  });

  it("redirects to a presigned URL for a completed track", async () => {
    mockGetJob.mockResolvedValue(
      makeJob({ tracks: [makeTrack({ id: "a", title: "Neat Track", status: "done" })] }),
    );
    mockGetPresignedDownloadUrl.mockResolvedValue("https://s3.example.com/signed-url");

    const res = await GET(new Request("http://localhost"), ctx("job-1", "a"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://s3.example.com/signed-url");
    expect(mockGetPresignedDownloadUrl).toHaveBeenCalledWith("job-1", "a", "Neat Track.mp3");
  });
});
