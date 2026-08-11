import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cookies", () => ({
  MAX_COOKIES_BYTES: 512 * 1024,
  getCookieStatus: vi.fn(),
  putCookies: vi.fn(),
  deleteCookies: vi.fn(),
  invalidateCookies: vi.fn(),
  validateNetscapeCookies: vi.fn(),
  normalizeCookies: vi.fn((s: string) => `NORMALIZED:${s}`),
}));

import {
  deleteCookies,
  getCookieStatus,
  invalidateCookies,
  putCookies,
  validateNetscapeCookies,
} from "@/lib/cookies";
import { DELETE, GET, PUT } from "./route";

const mockGetCookieStatus = vi.mocked(getCookieStatus);
const mockPutCookies = vi.mocked(putCookies);
const mockDeleteCookies = vi.mocked(deleteCookies);
const mockInvalidateCookies = vi.mocked(invalidateCookies);
const mockValidate = vi.mocked(validateNetscapeCookies);

function req(
  method: string,
  body?: unknown,
  headers: Record<string, string> = { "x-user-groups": "Admins" },
) {
  const init: RequestInit = { method, headers };
  if (typeof body === "string") init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  return new Request("http://localhost/api/admin/cookies", init);
}

beforeEach(() => {
  mockGetCookieStatus.mockReset();
  mockPutCookies.mockReset().mockResolvedValue(undefined);
  mockDeleteCookies.mockReset().mockResolvedValue(undefined);
  mockInvalidateCookies.mockReset();
  mockValidate.mockReset().mockReturnValue(undefined);
});

describe("admin authorization", () => {
  it("403s GET without the Admins group", async () => {
    const res = await GET(req("GET", undefined, {}));
    expect(res.status).toBe(403);
  });

  it("403s PUT without the Admins group", async () => {
    const res = await PUT(req("PUT", { cookies: "x" }, {}));
    expect(res.status).toBe(403);
  });

  it("403s DELETE without the Admins group", async () => {
    const res = await DELETE(req("DELETE", undefined, {}));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/cookies", () => {
  it("returns the cookie status", async () => {
    mockGetCookieStatus.mockResolvedValue({
      present: true,
      lastModified: "2026-01-01T00:00:00.000Z",
      size: 100,
      uploadedBy: "paul@example.com",
    });

    const res = await GET(req("GET"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      present: true,
      lastModified: "2026-01-01T00:00:00.000Z",
      size: 100,
      uploadedBy: "paul@example.com",
    });
  });

  it("500s when the status lookup throws", async () => {
    mockGetCookieStatus.mockRejectedValue(new Error("boom"));
    const res = await GET(req("GET"));
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/admin/cookies", () => {
  it("400s on an unparseable body", async () => {
    const res = await PUT(req("PUT", "not json"));
    expect(res.status).toBe(400);
    expect(mockPutCookies).not.toHaveBeenCalled();
  });

  it("400s when cookies is missing or blank", async () => {
    const res = await PUT(req("PUT", { cookies: "   " }));
    expect(res.status).toBe(400);
    expect(mockPutCookies).not.toHaveBeenCalled();
  });

  it("413s when content-length exceeds the max", async () => {
    const res = await PUT(
      req("PUT", { cookies: "x" }, { "x-user-groups": "Admins", "content-length": "9999999" }),
    );
    expect(res.status).toBe(413);
    expect(mockPutCookies).not.toHaveBeenCalled();
  });

  it("413s when the actual byte length exceeds the max, even with no content-length header", async () => {
    const big = "a".repeat(512 * 1024 + 1);
    const res = await PUT(req("PUT", { cookies: big }));
    expect(res.status).toBe(413);
    expect(mockPutCookies).not.toHaveBeenCalled();
  });

  it("400s with the validation message when the format is invalid", async () => {
    mockValidate.mockReturnValue("Lines must be tab-separated (7 fields).");
    const res = await PUT(req("PUT", { cookies: "garbage" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Lines must be tab-separated (7 fields).");
    expect(mockPutCookies).not.toHaveBeenCalled();
  });

  it("saves the normalized cookies with the uploader's email and invalidates the cache", async () => {
    const res = await PUT(
      req("PUT", { cookies: "raw-cookies" }, {
        "x-user-groups": "Admins",
        "x-user-email": "paul@example.com",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockPutCookies).toHaveBeenCalledWith("NORMALIZED:raw-cookies", "paul@example.com");
    expect(mockInvalidateCookies).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'unknown' when there's no x-user-email header", async () => {
    await PUT(req("PUT", { cookies: "raw-cookies" }));
    expect(mockPutCookies).toHaveBeenCalledWith("NORMALIZED:raw-cookies", "unknown");
  });

  it("500s when the save fails", async () => {
    mockPutCookies.mockRejectedValue(new Error("boom"));
    const res = await PUT(req("PUT", { cookies: "raw-cookies" }));
    expect(res.status).toBe(500);
    expect(mockInvalidateCookies).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/cookies", () => {
  it("deletes and invalidates the cache", async () => {
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(200);
    expect(mockDeleteCookies).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCookies).toHaveBeenCalledTimes(1);
  });

  it("500s when the delete fails", async () => {
    mockDeleteCookies.mockRejectedValue(new Error("boom"));
    const res = await DELETE(req("DELETE"));
    expect(res.status).toBe(500);
  });
});
