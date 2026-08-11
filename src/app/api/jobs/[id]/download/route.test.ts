import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobItem } from "@/lib/jobs";
import type { JobTrack } from "@/types";
import { listZipEntryNames } from "@/test/helpers";

vi.mock("@/lib/jobs", () => ({ getJob: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  getObjectReadStream: vi.fn(),
  getPresignedDownloadUrl: vi.fn(),
}));

import { getJob } from "@/lib/jobs";
import { getObjectReadStream, getPresignedDownloadUrl } from "@/lib/storage";
import { GET } from "./route";

const mockGetJob = vi.mocked(getJob);
const mockGetPresignedDownloadUrl = vi.mocked(getPresignedDownloadUrl);
const mockGetObjectReadStream = vi.mocked(getObjectReadStream);

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
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
    kind: "video",
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
  mockGetObjectReadStream.mockReset();
});

describe("GET /api/jobs/[id]/download", () => {
  it("404s for an unknown job", async () => {
    mockGetJob.mockResolvedValue(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("409s when no track has finished yet", async () => {
    mockGetJob.mockResolvedValue(
      makeJob({ tracks: [makeTrack({ id: "a", status: "downloading" })] }),
    );
    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(409);
  });

  it("redirects to a presigned URL for a video job", async () => {
    mockGetJob.mockResolvedValue(
      makeJob({
        kind: "video",
        tracks: [makeTrack({ id: "abc", title: "Arcángel", status: "done" })],
      }),
    );
    mockGetPresignedDownloadUrl.mockResolvedValue("https://s3.example.com/signed-url");

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://s3.example.com/signed-url");
    expect(mockGetPresignedDownloadUrl).toHaveBeenCalledWith("job-1", "abc", "Arcángel.mp3");
  });

  it("streams a valid zip for a playlist job, including only completed tracks", async () => {
    mockGetJob.mockResolvedValue(
      makeJob({
        kind: "playlist",
        title: "My Mix",
        tracks: [
          makeTrack({ id: "id1", title: "Song One", status: "done" }),
          makeTrack({ id: "id2", title: "Song Two", status: "done" }),
          makeTrack({ id: "id3", title: "Song Three", status: "downloading" }),
        ],
      }),
    );
    mockGetObjectReadStream.mockImplementation(async (_jobId, videoId) =>
      Readable.from([Buffer.from(`bytes for ${videoId}`)]),
    );

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain('filename="My Mix.zip"');

    const body = Buffer.from(await res.arrayBuffer());
    expect(listZipEntryNames(body).sort()).toEqual(["Song One.mp3", "Song Two.mp3"]);
    expect(mockGetObjectReadStream).toHaveBeenCalledTimes(2);
    expect(mockGetObjectReadStream).not.toHaveBeenCalledWith("job-1", "id3");
  });

  it("dedupes same-titled tracks inside the zip so entries never collide", async () => {
    mockGetJob.mockResolvedValue(
      makeJob({
        kind: "playlist",
        title: "Dup Titles",
        tracks: [
          makeTrack({ id: "id1", title: "Same Name", status: "done" }),
          makeTrack({ id: "id2", title: "Same Name", status: "done" }),
        ],
      }),
    );
    mockGetObjectReadStream.mockImplementation(async (_jobId, videoId) =>
      Readable.from([Buffer.from(videoId)]),
    );

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    const names = listZipEntryNames(body);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(["Same Name (2).mp3", "Same Name.mp3"]);
  });
});
