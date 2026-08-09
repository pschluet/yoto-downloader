import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs", () => ({ createJob: vi.fn() }));

import { createJob } from "@/lib/jobs";
import { POST } from "./route";

const mockCreateJob = vi.mocked(createJob);

function post(body: unknown) {
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validTrack = { id: "dQw4w9WgXcQ", title: "A Video" };

beforeEach(() => {
  mockCreateJob.mockReset();
  mockCreateJob.mockResolvedValue("job-123");
});

describe("POST /api/jobs", () => {
  it("400s on an unparseable body", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
  });

  it("400s when kind is missing or invalid", async () => {
    const res = await POST(post({ kind: "album", tracks: [validTrack] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/kind/i);
  });

  it("400s when tracks is empty", async () => {
    const res = await POST(post({ kind: "video", tracks: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/select at least one track/i);
  });

  it("400s when tracks is missing entirely", async () => {
    const res = await POST(post({ kind: "video" }));
    expect(res.status).toBe(400);
  });

  it("drops tracks with a malformed video id", async () => {
    const res = await POST(
      post({
        kind: "playlist",
        tracks: [validTrack, { id: "not-11-chars", title: "Bad" }, { id: "'; DROP TABLE", title: "Bad" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateJob).toHaveBeenCalledWith("playlist", "Download", [validTrack]);
  });

  it("400s if every track is dropped by id validation", async () => {
    const res = await POST(post({ kind: "video", tracks: [{ id: "short", title: "Bad" }] }));
    expect(res.status).toBe(400);
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("drops tracks missing a title", async () => {
    const res = await POST(
      post({ kind: "video", tracks: [{ id: "dQw4w9WgXcQ" }, validTrack] }),
    );
    expect(res.status).toBe(200);
    expect(mockCreateJob).toHaveBeenCalledWith("video", "Download", [validTrack]);
  });

  it("defaults the title to 'Download' when none is given", async () => {
    await POST(post({ kind: "video", tracks: [validTrack] }));
    expect(mockCreateJob).toHaveBeenCalledWith("video", "Download", [validTrack]);
  });

  it("passes a given title through", async () => {
    await POST(post({ kind: "playlist", title: "My Mix", tracks: [validTrack] }));
    expect(mockCreateJob).toHaveBeenCalledWith("playlist", "My Mix", [validTrack]);
  });

  it("200s with the new job id", async () => {
    const res = await POST(post({ kind: "video", tracks: [validTrack] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: "job-123" });
  });
});
