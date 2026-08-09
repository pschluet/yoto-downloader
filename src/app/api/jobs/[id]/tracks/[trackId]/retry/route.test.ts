import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs", () => ({ retryTrack: vi.fn() }));

import { retryTrack } from "@/lib/jobs";
import { POST } from "./route";

const mockRetryTrack = vi.mocked(retryTrack);

function ctx(id: string, trackId: string) {
  return { params: Promise.resolve({ id, trackId }) };
}

beforeEach(() => {
  mockRetryTrack.mockReset();
});

describe("POST /api/jobs/[id]/tracks/[trackId]/retry", () => {
  it("404s when the job or track isn't found", async () => {
    mockRetryTrack.mockResolvedValue("not-found");
    const res = await POST(new Request("http://localhost", { method: "POST" }), ctx("j", "t"));
    expect(res.status).toBe(404);
  });

  it("409s when the track isn't in a failed state", async () => {
    mockRetryTrack.mockResolvedValue("not-retryable");
    const res = await POST(new Request("http://localhost", { method: "POST" }), ctx("j", "t"));
    expect(res.status).toBe(409);
  });

  it("200s when the retry starts", async () => {
    mockRetryTrack.mockResolvedValue("started");
    const res = await POST(new Request("http://localhost", { method: "POST" }), ctx("j", "t"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRetryTrack).toHaveBeenCalledWith("j", "t");
  });
});
