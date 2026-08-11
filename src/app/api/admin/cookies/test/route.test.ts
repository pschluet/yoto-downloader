import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cookies", () => ({
  getCookieStatus: vi.fn(),
  invalidateCookies: vi.fn(),
}));
vi.mock("@/lib/ytdlp", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ytdlp")>("@/lib/ytdlp");
  return { ...actual, resolve: vi.fn() };
});

import { getCookieStatus, invalidateCookies } from "@/lib/cookies";
import { resolve, YtdlpError } from "@/lib/ytdlp";
import { POST } from "./route";

const mockGetCookieStatus = vi.mocked(getCookieStatus);
const mockInvalidateCookies = vi.mocked(invalidateCookies);
const mockResolve = vi.mocked(resolve);

function req(body?: unknown, headers: Record<string, string> = { "x-user-groups": "Admins" }) {
  const init: RequestInit = { method: "POST", headers };
  if (typeof body === "string") init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return new Request("http://localhost/api/admin/cookies/test", init);
}

beforeEach(() => {
  mockGetCookieStatus.mockReset().mockResolvedValue({
    present: true,
    lastModified: null,
    size: null,
    uploadedBy: null,
  });
  mockInvalidateCookies.mockReset();
  mockResolve.mockReset();
});

describe("POST /api/admin/cookies/test", () => {
  it("403s without the Admins group", async () => {
    const res = await POST(req(undefined, {}));
    expect(res.status).toBe(403);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("uses the default test video when the body is absent", async () => {
    mockResolve.mockResolvedValue({ kind: "video", track: { title: "T" } } as never);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("uses the default test video when the body is unparseable JSON", async () => {
    mockResolve.mockResolvedValue({ kind: "video", track: { title: "T" } } as never);
    const res = await POST(req("not json"));
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("uses a custom YouTube URL when provided", async () => {
    mockResolve.mockResolvedValue({ kind: "video", track: { title: "T" } } as never);
    await POST(req({ url: "https://www.youtube.com/watch?v=custom123" }));
    expect(mockResolve).toHaveBeenCalledWith("https://www.youtube.com/watch?v=custom123");
  });

  it("400s on a non-YouTube URL without calling resolve", async () => {
    const res = await POST(req({ url: "https://example.com" }));
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("invalidates the cookie cache before resolving", async () => {
    mockResolve.mockImplementation(async () => {
      expect(mockInvalidateCookies).toHaveBeenCalledTimes(1);
      return { kind: "video", track: { title: "T" } } as never;
    });
    await POST(req());
    expect(mockInvalidateCookies).toHaveBeenCalledTimes(1);
  });

  it("502s with the YtdlpError message on failure", async () => {
    mockResolve.mockRejectedValue(new YtdlpError("bot check failed", "", true));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("bot check failed");
  });

  it("502s with a generic message on an unexpected error", async () => {
    mockResolve.mockRejectedValue(new Error("boom"));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Test failed.");
  });

  it("200s with the resolved title and whether cookies were used, for a video result", async () => {
    mockResolve.mockResolvedValue({ kind: "video", track: { title: "Some Song" } } as never);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: "Some Song", usedCookies: true });
  });

  it("200s with the playlist title for a playlist result", async () => {
    mockResolve.mockResolvedValue({ kind: "playlist", title: "Some Playlist" } as never);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Some Playlist");
  });

  it("reports usedCookies: false when no cookies are configured", async () => {
    mockGetCookieStatus.mockResolvedValue({
      present: false,
      lastModified: null,
      size: null,
      uploadedBy: null,
    });
    mockResolve.mockResolvedValue({ kind: "video", track: { title: "T" } } as never);
    const res = await POST(req());
    expect((await res.json()).usedCookies).toBe(false);
  });
});
