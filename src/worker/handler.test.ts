import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "aws-lambda";
import type { DownloadProgress } from "@/lib/ytdlp";

vi.mock("@/lib/db", () => ({ isCanceled: vi.fn(), updateTrack: vi.fn() }));
vi.mock("@/lib/storage", () => ({ uploadTrackFile: vi.fn() }));
vi.mock("@/lib/ytdlp", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ytdlp")>("@/lib/ytdlp");
  return { ...actual, downloadTrack: vi.fn() };
});

import { isCanceled, updateTrack } from "@/lib/db";
import { uploadTrackFile } from "@/lib/storage";
import { downloadTrack, YtdlpError } from "@/lib/ytdlp";
import { handler } from "./handler";

const mockIsCanceled = vi.mocked(isCanceled);
const mockUpdateTrack = vi.mocked(updateTrack);
const mockUploadTrackFile = vi.mocked(uploadTrackFile);
const mockDownloadTrack = vi.mocked(downloadTrack);

const noopContext = {} as Context;
const noopCallback = () => {};

function sqsEvent(...bodies: object[]) {
  return {
    Records: bodies.map((body, i) => ({
      messageId: `msg-${i}`,
      body: JSON.stringify(body),
    })),
  } as never;
}

function localPathFor(videoId: string): string {
  return path.join(tmpdir(), `${videoId}.mp3`);
}

const writtenPaths: string[] = [];

beforeEach(() => {
  mockIsCanceled.mockReset().mockResolvedValue(false);
  mockUpdateTrack.mockReset().mockResolvedValue(undefined);
  mockUploadTrackFile.mockReset().mockResolvedValue(undefined);
  mockDownloadTrack.mockReset();
});

afterEach(async () => {
  for (const p of writtenPaths.splice(0)) {
    if (existsSync(p)) await unlink(p).catch(() => {});
  }
});

describe("worker handler", () => {
  it("downloads a track, uploads it to S3, and marks it done", async () => {
    mockDownloadTrack.mockImplementation(
      async (videoId, _tmpDir, onProgress: (p: DownloadProgress) => void) => {
        onProgress({ phase: "downloading", pct: 50, etaSeconds: 5 });
        const p = localPathFor(videoId);
        writtenPaths.push(p);
        await writeFile(p, "fake-mp3-bytes");
        onProgress({ phase: "converting" });
      },
    );

    await handler(sqsEvent({ jobId: "job-1", trackIndex: 2, videoId: "abc" }), noopContext, noopCallback);

    expect(mockUpdateTrack).toHaveBeenCalledWith(
      "job-1",
      2,
      expect.objectContaining({ status: "downloading", attempts: 1 }),
    );
    expect(mockUpdateTrack).toHaveBeenCalledWith("job-1", 2, {
      status: "downloading",
      pct: 50,
      etaSeconds: 5,
    });
    expect(mockUpdateTrack).toHaveBeenCalledWith("job-1", 2, { status: "converting" });
    expect(mockUploadTrackFile).toHaveBeenCalledWith("job-1", "abc", localPathFor("abc"));
    expect(mockUpdateTrack).toHaveBeenLastCalledWith("job-1", 2, {
      status: "done",
      pct: 100,
      fileSize: "fake-mp3-bytes".length,
    });
    expect(existsSync(localPathFor("abc"))).toBe(false); // cleaned up after upload
  });

  it("retries once on failure before giving up", async () => {
    mockDownloadTrack.mockRejectedValue(new YtdlpError("boom", ""));

    const start = Date.now();
    await handler(sqsEvent({ jobId: "job-1", trackIndex: 0, videoId: "bad" }), noopContext, noopCallback);
    const elapsed = Date.now() - start;

    expect(mockDownloadTrack).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(1400); // the 1.5s inter-attempt delay
    expect(mockUpdateTrack).toHaveBeenLastCalledWith("job-1", 0, {
      status: "failed",
      error: "boom",
    });
    expect(mockUploadTrackFile).not.toHaveBeenCalled();
  }, 10_000);

  it("succeeds on the second attempt without a third", async () => {
    let calls = 0;
    mockDownloadTrack.mockImplementation(
      async (videoId, _tmpDir, onProgress: (p: DownloadProgress) => void) => {
        calls++;
        if (calls === 1) throw new YtdlpError("transient", "");
        const p = localPathFor(videoId);
        writtenPaths.push(p);
        await writeFile(p, "ok");
        onProgress({ phase: "converting" });
      },
    );

    await handler(sqsEvent({ jobId: "job-1", trackIndex: 0, videoId: "abc" }), noopContext, noopCallback);

    expect(mockDownloadTrack).toHaveBeenCalledTimes(2);
    expect(mockUpdateTrack).toHaveBeenLastCalledWith("job-1", 0, {
      status: "done",
      pct: 100,
      fileSize: 2,
    });
  }, 10_000);

  it("checks for cancellation before starting and skips the download entirely if canceled", async () => {
    mockIsCanceled.mockResolvedValue(true);

    await handler(sqsEvent({ jobId: "job-1", trackIndex: 0, videoId: "abc" }), noopContext, noopCallback);

    expect(mockDownloadTrack).not.toHaveBeenCalled();
    expect(mockUpdateTrack).toHaveBeenCalledWith("job-1", 0, { status: "canceled" });
  });

  it("reports a batch item failure for an unexpected (non-download) error, for SQS to retry", async () => {
    mockIsCanceled.mockRejectedValue(new Error("DynamoDB is down"));

    const result = await handler(
      sqsEvent({ jobId: "job-1", trackIndex: 0, videoId: "abc" }),
      noopContext,
      noopCallback,
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
  });

  it("processes multiple records in one batch independently", async () => {
    mockDownloadTrack.mockImplementation(
      async (videoId, _tmpDir, onProgress: (p: DownloadProgress) => void) => {
        const p = localPathFor(videoId);
        writtenPaths.push(p);
        await writeFile(p, "ok");
        onProgress({ phase: "converting" });
      },
    );

    await handler(
      sqsEvent(
        { jobId: "job-1", trackIndex: 0, videoId: "a" },
        { jobId: "job-1", trackIndex: 1, videoId: "b" },
      ),
      noopContext,
      noopCallback,
    );

    expect(mockDownloadTrack).toHaveBeenCalledTimes(2);
    expect(mockUploadTrackFile).toHaveBeenCalledWith("job-1", "a", localPathFor("a"));
    expect(mockUploadTrackFile).toHaveBeenCalledWith("job-1", "b", localPathFor("b"));
  });
});
