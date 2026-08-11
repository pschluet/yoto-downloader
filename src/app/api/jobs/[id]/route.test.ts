import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@/types";

vi.mock("@/lib/jobs", () => ({ getSnapshot: vi.fn(), deleteJob: vi.fn() }));

import { deleteJob, getSnapshot } from "@/lib/jobs";
import { DELETE, GET } from "./route";

const mockGetSnapshot = vi.mocked(getSnapshot);
const mockDeleteJob = vi.mocked(deleteJob);

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const snapshot: JobSnapshot = {
  id: "job-1",
  kind: "video",
  title: "T",
  status: "done",
  tracks: [],
  createdAt: 0,
};

beforeEach(() => {
  mockGetSnapshot.mockReset();
  mockDeleteJob.mockReset();
});

describe("GET /api/jobs/[id]", () => {
  it("404s for an unknown job", async () => {
    mockGetSnapshot.mockResolvedValue(undefined);
    const res = await GET(new Request("http://localhost"), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("200s with the snapshot for a known job", async () => {
    mockGetSnapshot.mockResolvedValue(snapshot);
    const res = await GET(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
  });
});

describe("DELETE /api/jobs/[id]", () => {
  it("404s for an unknown job", async () => {
    mockDeleteJob.mockResolvedValue(false);
    const res = await DELETE(new Request("http://localhost"), ctx("missing"));
    expect(res.status).toBe(404);
  });

  it("200s and reports ok for a known job", async () => {
    mockDeleteJob.mockResolvedValue(true);
    const res = await DELETE(new Request("http://localhost"), ctx("job-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockDeleteJob).toHaveBeenCalledWith("job-1");
  });
});
