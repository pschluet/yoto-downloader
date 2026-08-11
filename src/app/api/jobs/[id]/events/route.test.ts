import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@/types";

vi.mock("@/lib/jobs", () => ({ getSnapshot: vi.fn() }));

import { getSnapshot } from "@/lib/jobs";
import { GET } from "./route";

const mockGetSnapshot = vi.mocked(getSnapshot);

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function snap(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "job-1",
    kind: "video",
    title: "T",
    status: "running",
    tracks: [],
    createdAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetSnapshot.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let result = await reader.read();
  while (!result.done) result = await reader.read();
}

describe("GET /api/jobs/[id]/events", () => {
  it("404s for an unknown job", async () => {
    mockGetSnapshot.mockResolvedValueOnce(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("sets SSE headers and sends the current snapshot immediately", async () => {
    mockGetSnapshot.mockResolvedValueOnce(snap({ status: "done" }));
    const res = await GET(new Request("http://localhost"), ctx("job-1"));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const reader = res.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe(
      `data: ${JSON.stringify(snap({ status: "done" }))}\n\n`,
    );
  });

  it("closes without polling further when the job is already in a terminal state", async () => {
    mockGetSnapshot.mockResolvedValueOnce(snap({ status: "done" }));
    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    const reader = res.body!.getReader();

    await reader.read(); // initial chunk
    const final = await reader.read();

    expect(final.done).toBe(true);
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
  });

  it("polls and streams updates while running, closing once it goes terminal", async () => {
    mockGetSnapshot
      .mockResolvedValueOnce(snap({ status: "running" })) // initial fetch in GET()
      .mockResolvedValueOnce(snap({ status: "running" })) // first poll tick
      .mockResolvedValueOnce(snap({ status: "done" })); // second poll tick

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const chunk1 = await reader.read();
    expect(decoder.decode(chunk1.value)).toContain('"status":"running"');

    await vi.advanceTimersByTimeAsync(1000);
    const chunk2 = await reader.read();
    expect(decoder.decode(chunk2.value)).toContain('"status":"running"');

    await vi.advanceTimersByTimeAsync(1000);
    const chunk3 = await reader.read();
    expect(decoder.decode(chunk3.value)).toContain('"status":"done"');

    const final = await reader.read();
    expect(final.done).toBe(true);
  });

  it("stops polling once the max stream duration elapses, even if still running", async () => {
    mockGetSnapshot.mockResolvedValue(snap({ status: "running" }));

    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    const reader = res.body!.getReader();
    await reader.read(); // initial chunk

    await vi.advanceTimersByTimeAsync(30_000); // past the ~25s bound
    await drain(reader);
  });

  it("stops polling when the request is aborted", async () => {
    mockGetSnapshot.mockResolvedValue(snap({ status: "running" }));
    const controller = new AbortController();

    const res = await GET(
      new Request("http://localhost", { signal: controller.signal }),
      ctx("job-1"),
    );
    const reader = res.body!.getReader();
    await reader.read(); // initial chunk

    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await drain(reader);

    // Only the initial fetch — the loop should never have polled again.
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1);
  });
});
