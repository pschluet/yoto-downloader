import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@/types";

vi.mock("@/lib/jobs", () => ({ getSnapshot: vi.fn(), subscribe: vi.fn() }));

import { getSnapshot, subscribe } from "@/lib/jobs";
import { GET } from "./route";

const mockGetSnapshot = vi.mocked(getSnapshot);
const mockSubscribe = vi.mocked(subscribe);

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const snapshot: JobSnapshot = {
  id: "job-1",
  kind: "video",
  title: "T",
  status: "running",
  tracks: [],
  createdAt: 0,
};

async function readOne(res: Response) {
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

beforeEach(() => {
  mockGetSnapshot.mockReset();
  mockSubscribe.mockReset();
});

describe("GET /api/jobs/[id]/events", () => {
  it("404s for an unknown job without subscribing", async () => {
    mockGetSnapshot.mockReturnValue(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing"));
    expect(res.status).toBe(404);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("sets SSE headers and sends the current snapshot immediately", async () => {
    mockGetSnapshot.mockReturnValue(snapshot);
    mockSubscribe.mockReturnValue(vi.fn());
    const controller = new AbortController();

    const res = await GET(new Request("http://localhost", { signal: controller.signal }), ctx("job-1"));

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    expect(await readOne(res)).toBe(`data: ${JSON.stringify(snapshot)}\n\n`);
    controller.abort();
  });

  it("streams a new chunk whenever the job store's subscriber callback fires", async () => {
    mockGetSnapshot.mockReturnValue(snapshot);
    let capturedSend: ((s: JobSnapshot) => void) | undefined;
    mockSubscribe.mockImplementation((_id, cb) => {
      capturedSend = cb;
      return vi.fn();
    });
    const controller = new AbortController();

    const res = await GET(new Request("http://localhost", { signal: controller.signal }), ctx("job-1"));
    const reader = res.body!.getReader();
    await reader.read(); // the immediate current-snapshot chunk

    const updated: JobSnapshot = { ...snapshot, status: "done" };
    capturedSend!(updated);

    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(`data: ${JSON.stringify(updated)}\n\n`);
    controller.abort();
  });

  it("unsubscribes when the request is aborted", async () => {
    mockGetSnapshot.mockReturnValue(snapshot);
    const unsubscribe = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribe);
    const controller = new AbortController();

    const res = await GET(new Request("http://localhost", { signal: controller.signal }), ctx("job-1"));
    await readOne(res);

    controller.abort();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });
});
