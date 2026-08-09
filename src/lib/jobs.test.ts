import { existsSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadProgress } from "@/lib/ytdlp";
import type { JobSnapshot, Track } from "@/types";

vi.mock("@/lib/ytdlp", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ytdlp")>("@/lib/ytdlp");
  return { ...actual, downloadTrack: vi.fn() };
});

import { downloadTrack, YtdlpError } from "@/lib/ytdlp";
import {
  cancelJob,
  createJob,
  deleteJob,
  getJob,
  getSnapshot,
  retryTrack,
  subscribe,
  trackFilePath,
} from "@/lib/jobs";

const mockDownloadTrack = vi.mocked(downloadTrack);

function track(id: string): Track {
  return { id, title: `Title ${id}`, duration: 100, thumbnail: undefined, uploader: undefined };
}

// Every temp dir created in a test, cleaned up as a safety net regardless of
// whether the test's own assertions already removed it.
const tmpDirs: string[] = [];
async function newJob(kind: "video" | "playlist", tracks: Track[]) {
  const id = await createJob(kind, "Test job", tracks);
  tmpDirs.push(getJob(id)!.tmpDir);
  return id;
}

beforeEach(() => {
  mockDownloadTrack.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tmpDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("createJob", () => {
  it("creates a real temp directory", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {})); // never resolves
    const id = await newJob("video", [track("a")]);
    expect(existsSync(getJob(id)!.tmpDir)).toBe(true);
  });

  it("queues tracks beyond the concurrency limit (3) as pending with zero attempts", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {})); // never resolves
    const tracks = ["a", "b", "c", "d", "e"].map(track);
    const id = await newJob("playlist", tracks);

    const snap = getSnapshot(id)!;
    expect(snap.tracks.slice(0, 3).every((t) => t.status === "downloading" && t.attempts === 1)).toBe(
      true,
    );
    expect(snap.tracks.slice(3).every((t) => t.status === "pending" && t.attempts === 0)).toBe(true);
  });
});

describe("happy path", () => {
  it("drives a track through downloading -> converting -> done and records its file size", async () => {
    // Manual gates so the test can observe each phase deterministically,
    // rather than racing a subscriber against work that starts synchronously
    // inside createJob (before the test ever gets a chance to subscribe).
    let releaseDownloading!: () => void;
    let releaseConverting!: () => void;
    const downloadingGate = new Promise<void>((r) => (releaseDownloading = r));
    const convertingGate = new Promise<void>((r) => (releaseConverting = r));

    mockDownloadTrack.mockImplementation(async (videoId, tmpDir, onProgress: (p: DownloadProgress) => void) => {
      onProgress({ phase: "downloading", pct: 50, etaSeconds: 10 });
      await downloadingGate;
      await writeFile(trackFilePath(tmpDir, videoId), "fake-mp3-bytes");
      onProgress({ phase: "converting" });
      await convertingGate;
    });

    const id = await newJob("video", [track("a")]);

    expect(getSnapshot(id)!.tracks[0]).toMatchObject({
      status: "downloading",
      pct: 50,
      etaSeconds: 10,
    });

    releaseDownloading();
    await vi.waitFor(() => expect(getSnapshot(id)!.tracks[0].status).toBe("converting"));

    releaseConverting();
    await vi.waitFor(() => expect(getSnapshot(id)!.tracks[0].status).toBe("done"));

    const final = getSnapshot(id)!;
    expect(final.status).toBe("done");
    expect(final.tracks[0].fileSize).toBe("fake-mp3-bytes".length);
    expect(final.tracks[0].pct).toBe(100);
  });

  it("never runs more than 3 downloads concurrently, queueing the rest", async () => {
    const releasers = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    mockDownloadTrack.mockImplementation(
      (videoId: string) =>
        new Promise<void>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releasers.set(videoId, () => {
            active--;
            resolve();
          });
        }),
    );

    const ids = ["a", "b", "c", "d", "e", "f"];
    const id = await newJob("playlist", ids.map(track));

    expect(mockDownloadTrack).toHaveBeenCalledTimes(3);
    expect(peak).toBeLessThanOrEqual(3);

    for (const videoId of ids) {
      await vi.waitFor(() => expect(releasers.has(videoId)).toBe(true));
      releasers.get(videoId)!();
    }

    await vi.waitFor(() => expect(getSnapshot(id)!.status).toBe("done"));
    expect(mockDownloadTrack).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(3);
    expect(getSnapshot(id)!.tracks.every((t) => t.status === "done")).toBe(true);
  });

  it("lets other tracks finish when one track fails outright", async () => {
    vi.useFakeTimers();
    mockDownloadTrack.mockImplementation((videoId: string) => {
      if (videoId === "bad") return Promise.reject(new YtdlpError("boom", ""));
      return Promise.resolve();
    });

    const id = await newJob("playlist", [track("good1"), track("bad"), track("good2")]);
    // Two failed attempts, 1.5s apart, before the job as a whole settles.
    await vi.advanceTimersByTimeAsync(5000);

    const snap = getSnapshot(id)!;
    expect(snap.status).toBe("done");
    const good1 = snap.tracks.find((t) => t.id === "good1")!;
    const bad = snap.tracks.find((t) => t.id === "bad")!;
    expect(good1.status).toBe("done");
    expect(bad.status).toBe("failed");
    expect(bad.error).toBe("boom");
  });
});

describe("automatic retry", () => {
  it("retries a failing track once (2 total attempts) before giving up", async () => {
    vi.useFakeTimers();
    mockDownloadTrack.mockImplementation(() => Promise.reject(new YtdlpError("boom", "")));

    const id = await newJob("video", [track("a")]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockDownloadTrack).toHaveBeenCalledTimes(2);
    const snap = getSnapshot(id)!;
    expect(snap.tracks[0].status).toBe("failed");
    expect(snap.tracks[0].attempts).toBe(2);
    expect(snap.status).toBe("failed"); // single track, and it failed -> job failed
  });

  it("succeeds on the second attempt without exhausting retries", async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockDownloadTrack.mockImplementation(() => {
      calls++;
      return calls === 1 ? Promise.reject(new YtdlpError("boom", "")) : Promise.resolve();
    });

    const id = await newJob("video", [track("a")]);
    // Advance past the one retry delay, then switch to real timers: the
    // eventual success path awaits a real fs.stat() call, which fake timers
    // don't reliably pump to completion.
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    await vi.waitFor(() => expect(getSnapshot(id)!.tracks[0].status).toBe("done"));

    expect(mockDownloadTrack).toHaveBeenCalledTimes(2);
    const snap = getSnapshot(id)!;
    expect(snap.tracks[0].attempts).toBe(2);
    expect(snap.status).toBe("done");
  });
});

describe("retryTrack", () => {
  it("returns not-found for an unknown job or track", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {}));
    const id = await newJob("video", [track("a")]);
    expect(await retryTrack("no-such-job", "a")).toBe("not-found");
    expect(await retryTrack(id, "no-such-track")).toBe("not-found");
  });

  it("returns not-retryable for a track that isn't in a failed state", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {})); // stays "downloading"
    const id = await newJob("video", [track("a")]);
    expect(await retryTrack(id, "a")).toBe("not-retryable");
  });

  it("returns not-retryable if the job was canceled, even if the track is failed", async () => {
    vi.useFakeTimers();
    mockDownloadTrack.mockImplementation(() => Promise.reject(new YtdlpError("boom", "")));
    const id = await newJob("video", [track("a")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getSnapshot(id)!.tracks[0].status).toBe("failed");

    await cancelJob(id); // aborts the controller without deleting the job

    expect(await retryTrack(id, "a")).toBe("not-retryable");
  });

  it("resets attempts, flips the job back to running, then settles again on success", async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockDownloadTrack.mockImplementation(() => {
      calls++;
      return calls <= 2 ? Promise.reject(new YtdlpError("boom", "")) : Promise.resolve();
    });

    const id = await newJob("video", [track("a")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getSnapshot(id)!.tracks[0].status).toBe("failed");
    expect(getSnapshot(id)!.status).toBe("failed");

    const result = await retryTrack(id, "a");
    expect(result).toBe("started");

    // retryTrack kicks the new attempt off synchronously (same as the initial
    // pool does in createJob), so by the time it returns the track is already
    // mid-attempt, not sitting in "pending".
    const midSnap = getSnapshot(id)!;
    expect(midSnap.status).toBe("running");
    expect(midSnap.tracks[0].status).toBe("downloading");
    expect(midSnap.tracks[0].attempts).toBe(1);
    expect(midSnap.tracks[0].error).toBeUndefined();

    // The retried attempt succeeds immediately (mock call #3), which awaits a
    // real fs.stat() call — switch to real timers so that reliably settles.
    vi.useRealTimers();
    await vi.waitFor(() => expect(getSnapshot(id)!.tracks[0].status).toBe("done"));
    const finalSnap = getSnapshot(id)!;
    expect(finalSnap.status).toBe("done");
  });
});

describe("cancelJob", () => {
  it("marks non-terminal tracks canceled, keeps the job (not deleted), and removes the temp dir", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {})); // hangs forever
    const tracks = ["a", "b", "c", "d"].map(track); // 3 downloading, 1 still pending
    const id = await newJob("playlist", tracks);
    const tmpDir = getJob(id)!.tmpDir;

    const ok = await cancelJob(id);
    expect(ok).toBe(true);

    const snap = getSnapshot(id);
    expect(snap).toBeDefined(); // still present
    expect(snap!.status).toBe("canceled");
    expect(snap!.tracks.every((t) => t.status === "canceled")).toBe(true);
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("returns false for an unknown job", async () => {
    expect(await cancelJob("no-such-job")).toBe(false);
  });

  it("does not stomp the status of a job that already finished", async () => {
    mockDownloadTrack.mockImplementation(() => Promise.resolve());
    const id = await newJob("video", [track("a")]);
    await vi.waitFor(() => expect(getSnapshot(id)!.status).toBe("done"));

    await cancelJob(id);

    expect(getSnapshot(id)!.status).toBe("done");
  });
});

describe("deleteJob", () => {
  it("cancels in-flight work, marks tracks canceled in the final broadcast, and removes the job", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {})); // hangs forever
    const tracks = ["a", "b", "c", "d"].map(track); // 3 downloading, 1 pending
    const id = await newJob("playlist", tracks);
    const tmpDir = getJob(id)!.tmpDir;

    let lastSnapshot: JobSnapshot | undefined;
    subscribe(id, (s) => {
      lastSnapshot = s;
    });

    const ok = await deleteJob(id);
    expect(ok).toBe(true);

    expect(lastSnapshot?.status).toBe("canceled");
    expect(lastSnapshot?.tracks.every((t) => t.status === "canceled")).toBe(true);
    expect(getJob(id)).toBeUndefined();
    expect(existsSync(tmpDir)).toBe(false);
  });

  it("returns false for an unknown job", async () => {
    expect(await deleteJob("no-such-job")).toBe(false);
  });
});

describe("subscribe", () => {
  it("delivers snapshots on every change and stops after unsubscribing", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {}));
    const id = await newJob("video", [track("a")]);

    const received: JobSnapshot[] = [];
    const unsubscribe = subscribe(id, (s) => received.push(s));
    expect(unsubscribe).toBeTypeOf("function");

    const countAfterSubscribe = received.length;
    await cancelJob(id);
    expect(received.length).toBeGreaterThan(countAfterSubscribe);

    const countAfterCancel = received.length;
    unsubscribe!();
    await deleteJob(id); // would otherwise emit again
    expect(received.length).toBe(countAfterCancel);
  });

  it("returns undefined for an unknown job", () => {
    expect(subscribe("no-such-job", () => {})).toBeUndefined();
  });
});

describe("getSnapshot", () => {
  it("returns independent copies, not a live reference into the store", async () => {
    mockDownloadTrack.mockImplementation(() => new Promise(() => {}));
    const id = await newJob("video", [track("a")]);

    const snap1 = getSnapshot(id)!;
    snap1.tracks[0].status = "done";
    snap1.status = "done";

    const snap2 = getSnapshot(id)!;
    expect(snap2.tracks[0].status).not.toBe("done");
    expect(snap2.status).not.toBe("done");
  });

  it("returns undefined for an unknown job", () => {
    expect(getSnapshot("no-such-job")).toBeUndefined();
  });
});
