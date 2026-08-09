import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/jobs";
import type { JobTrack } from "@/types";

vi.mock("@/lib/jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jobs")>("@/lib/jobs");
  return { ...actual, getJob: vi.fn() };
});

import { getJob, trackFilePath } from "@/lib/jobs";
import { GET } from "./route";

const mockGetJob = vi.mocked(getJob);

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

function makeJob(overrides: Partial<Job> & { tmpDir: string }): Job {
  return {
    id: "job-1",
    kind: "playlist",
    title: "Test Job",
    status: "done",
    tracks: [],
    createdAt: 0,
    controller: new AbortController(),
    subscribers: new Set(),
    cleanedUp: false,
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function makeTmpDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "yoto-route-test-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  mockGetJob.mockReset();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/jobs/[id]/file/[trackId]", () => {
  it("404s for an unknown job", async () => {
    mockGetJob.mockReturnValue(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing", "t"));
    expect(res.status).toBe(404);
  });

  it("409s for a track id that isn't part of the job", async () => {
    const tmpDir = makeTmpDir();
    mockGetJob.mockReturnValue(makeJob({ tmpDir, tracks: [makeTrack({ id: "a", status: "done" })] }));
    const res = await GET(new Request("http://localhost"), ctx("job-1", "nope"));
    expect(res.status).toBe(409);
  });

  it("409s for a track that hasn't finished yet", async () => {
    const tmpDir = makeTmpDir();
    mockGetJob.mockReturnValue(
      makeJob({ tmpDir, tracks: [makeTrack({ id: "a", status: "downloading" })] }),
    );
    const res = await GET(new Request("http://localhost"), ctx("job-1", "a"));
    expect(res.status).toBe(409);
  });

  it("streams the file for a completed track", async () => {
    const tmpDir = makeTmpDir();
    const content = Buffer.from("individual track bytes");
    writeFileSync(trackFilePath(tmpDir, "a"), content);

    mockGetJob.mockReturnValue(
      makeJob({
        tmpDir,
        tracks: [makeTrack({ id: "a", title: "Neat Track", status: "done", fileSize: content.length })],
      }),
    );

    const res = await GET(new Request("http://localhost"), ctx("job-1", "a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Content-Disposition")).toContain('filename="Neat Track.mp3"');
    expect(res.headers.get("Content-Length")).toBe(String(content.length));

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(content)).toBe(true);
  });
});
