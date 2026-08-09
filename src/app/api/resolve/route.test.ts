import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ytdlp", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ytdlp")>("@/lib/ytdlp");
  return { ...actual, resolve: vi.fn() };
});

import { resolve, YtdlpError } from "@/lib/ytdlp";
import { POST } from "./route";

const mockResolve = vi.mocked(resolve);

function post(body: unknown) {
  const init: RequestInit = { method: "POST" };
  if (typeof body === "string") {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request("http://localhost/api/resolve", init);
}

beforeEach(() => {
  mockResolve.mockReset();
});

describe("POST /api/resolve", () => {
  it("400s on an unparseable body", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid request body/i);
  });

  it("400s when url is missing", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/enter a youtube url/i);
  });

  it("400s when url is blank", async () => {
    const res = await POST(post({ url: "   " }));
    expect(res.status).toBe(400);
  });

  it("400s when url is not a YouTube host", async () => {
    const res = await POST(post({ url: "https://example.com/watch?v=abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/doesn't look like a youtube url/i);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("502s with the YtdlpError message when resolve() throws one", async () => {
    mockResolve.mockRejectedValue(new YtdlpError("This video is private or unavailable.", ""));
    const res = await POST(post({ url: "https://www.youtube.com/watch?v=abc" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("This video is private or unavailable.");
  });

  it("502s with a generic message on an unexpected error", async () => {
    mockResolve.mockRejectedValue(new Error("boom"));
    const res = await POST(post({ url: "https://www.youtube.com/watch?v=abc" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Failed to resolve that URL.");
  });

  it("200s and passes the resolve() result straight through", async () => {
    const result = {
      kind: "video",
      track: { id: "abc", title: "T", duration: 1, thumbnail: undefined, uploader: undefined },
    };
    mockResolve.mockResolvedValue(result as never);
    const res = await POST(post({ url: "https://www.youtube.com/watch?v=abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockResolve).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
  });

  it("trims the url before validating and resolving", async () => {
    mockResolve.mockResolvedValue({ kind: "video", track: {} } as never);
    await POST(post({ url: "  https://www.youtube.com/watch?v=abc  " }));
    expect(mockResolve).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
  });
});
