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
import { listZipEntryNames } from "@/test/helpers";
import { GET } from "./route";

const mockGetJob = vi.mocked(getJob);

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

function makeJob(overrides: Partial<Job> & { tmpDir: string }): Job {
  return {
    id: "job-1",
    kind: "video",
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

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

beforeEach(() => {
  mockGetJob.mockReset();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GET /api/jobs/[id]/download", () => {
  it("404s for an unknown job", async () => {
    mockGetJob.mockReturnValue(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("409s when no track has finished yet", async () => {
    const tmpDir = makeTmpDir();
    mockGetJob.mockReturnValue(
      makeJob({ tmpDir, tracks: [makeTrack({ id: "a", status: "downloading" })] }),
    );
    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(409);
  });

  it("streams the single mp3 for a video job", async () => {
    const tmpDir = makeTmpDir();
    const content = Buffer.from("fake-mp3-bytes-for-video");
    writeFileSync(trackFilePath(tmpDir, "abc"), content);

    mockGetJob.mockReturnValue(
      makeJob({
        kind: "video",
        tmpDir,
        tracks: [makeTrack({ id: "abc", title: "Arcángel", status: "done", fileSize: content.length })],
      }),
    );

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    const disposition = res.headers.get("Content-Disposition")!;
    expect(disposition).toContain('filename="Arc_ngel.mp3"');
    expect(disposition).toContain("filename*=UTF-8''Arc%C3%A1ngel.mp3");
    expect(res.headers.get("Content-Length")).toBe(String(content.length));

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(content)).toBe(true);
  });

  it("streams a valid zip for a playlist job, including only completed tracks", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(trackFilePath(tmpDir, "id1"), "song one bytes");
    writeFileSync(trackFilePath(tmpDir, "id2"), "song two bytes");
    // id3 is still downloading and has no file on disk at all.

    mockGetJob.mockReturnValue(
      makeJob({
        kind: "playlist",
        title: "My Mix",
        tmpDir,
        tracks: [
          makeTrack({ id: "id1", title: "Song One", status: "done" }),
          makeTrack({ id: "id2", title: "Song Two", status: "done" }),
          makeTrack({ id: "id3", title: "Song Three", status: "downloading" }),
        ],
      }),
    );

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain('filename="My Mix.zip"');

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
    expect(listZipEntryNames(body).sort()).toEqual(["Song One.mp3", "Song Two.mp3"]);
  });

  it("dedupes same-titled tracks inside the zip so entries never collide", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(trackFilePath(tmpDir, "id1"), "one");
    writeFileSync(trackFilePath(tmpDir, "id2"), "two");

    mockGetJob.mockReturnValue(
      makeJob({
        kind: "playlist",
        title: "Dup Titles",
        tmpDir,
        tracks: [
          makeTrack({ id: "id1", title: "Same Name", status: "done" }),
          makeTrack({ id: "id2", title: "Same Name", status: "done" }),
        ],
      }),
    );

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    const names = listZipEntryNames(body);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(["Same Name (2).mp3", "Same Name.mp3"]);
  });
});
