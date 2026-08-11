import { existsSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCookies, validateNetscapeCookies } from "@/lib/cookies";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>(
    "@aws-sdk/client-s3",
  );
  return {
    ...actual,
    S3Client: vi.fn(function S3ClientMock() {
      return { send: mockSend };
    }),
  };
});

function fakeBody(text: string) {
  return { transformToString: vi.fn().mockResolvedValue(text) };
}

const VALID_COOKIES = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123",
  "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1999999999\tHSID\tdef456",
].join("\n");

describe("validateNetscapeCookies", () => {
  it("accepts a realistic export including #HttpOnly_ lines", () => {
    expect(validateNetscapeCookies(VALID_COOKIES)).toBeUndefined();
  });

  it("accepts CRLF line endings", () => {
    expect(validateNetscapeCookies(VALID_COOKIES.replace(/\n/g, "\r\n"))).toBeUndefined();
  });

  it("rejects an empty/comments-only file", () => {
    expect(validateNetscapeCookies("# Netscape HTTP Cookie File\n# just a comment\n")).toMatch(
      /no cookies found/i,
    );
  });

  it("rejects space-separated lines", () => {
    const spaced = "# Netscape HTTP Cookie File\n.youtube.com TRUE / TRUE 1999999999 SID abc123\n";
    expect(validateNetscapeCookies(spaced)).toMatch(/tab-separated/i);
  });

  it("rejects lines with the wrong field count", () => {
    const bad = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\n";
    expect(validateNetscapeCookies(bad)).toMatch(/tab-separated/i);
  });

  it("rejects a jar with no youtube.com or google.com domain", () => {
    const other = "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123\n";
    expect(validateNetscapeCookies(other)).toMatch(/no youtube\.com or google\.com/i);
  });
});

describe("normalizeCookies", () => {
  it("prepends the magic header when absent", () => {
    const result = normalizeCookies(".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc123");
    expect(result).toMatch(/^# Netscape HTTP Cookie File\n/);
  });

  it("leaves the header alone when already present", () => {
    expect(normalizeCookies(VALID_COOKIES)).toBe(VALID_COOKIES);
  });

  it("normalizes CRLF to LF", () => {
    expect(normalizeCookies("a\r\nb\r\n")).toBe("# Netscape HTTP Cookie File\na\nb\n");
  });
});

describe("S3-backed cookie storage", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useRealTimers();
    mockSend.mockReset();
    process.env.FILES_BUCKET_NAME = "test-bucket";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns [] and never calls S3 when FILES_BUCKET_NAME is unset", async () => {
    delete process.env.FILES_BUCKET_NAME;
    const { withCookieArgs } = await import("@/lib/cookies");

    const result = await withCookieArgs(async (args) => args);

    expect(result).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("writes a 0600 tmp file and passes --cookies <path>, deleting it after fn resolves", async () => {
    mockSend.mockResolvedValueOnce({ Body: fakeBody(VALID_COOKIES) });
    const { withCookieArgs } = await import("@/lib/cookies");

    let capturedPath = "";
    const result = await withCookieArgs(async (args) => {
      capturedPath = args[1];
      expect(args[0]).toBe("--cookies");
      expect(existsSync(capturedPath)).toBe(true);
      expect(statSync(capturedPath).mode & 0o777).toBe(0o600);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("deletes the tmp file even when fn rejects", async () => {
    mockSend.mockResolvedValueOnce({ Body: fakeBody(VALID_COOKIES) });
    const { withCookieArgs } = await import("@/lib/cookies");

    let capturedPath = "";
    await expect(
      withCookieArgs(async (args) => {
        capturedPath = args[1];
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(capturedPath)).toBe(false);
  });

  it("shares one GetObject across two calls within the TTL", async () => {
    mockSend.mockResolvedValue({ Body: fakeBody(VALID_COOKIES) });
    const { withCookieArgs } = await import("@/lib/cookies");

    await withCookieArgs(async (args) => args);
    await withCookieArgs(async (args) => args);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("shares one GetObject across concurrent calls but gives each a distinct file", async () => {
    mockSend.mockResolvedValue({ Body: fakeBody(VALID_COOKIES) });
    const { withCookieArgs } = await import("@/lib/cookies");

    const paths: string[] = [];
    await Promise.all([
      withCookieArgs(async (args) => {
        paths.push(args[1]);
      }),
      withCookieArgs(async (args) => {
        paths.push(args[1]);
      }),
    ]);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it("re-fetches after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1));
    mockSend.mockResolvedValue({ Body: fakeBody(VALID_COOKIES) });
    const { withCookieArgs } = await import("@/lib/cookies");

    await withCookieArgs(async (args) => args);
    vi.setSystemTime(new Date(2030, 0, 1, 0, 1, 1)); // +61s
    await withCookieArgs(async (args) => args);

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after invalidateCookies()", async () => {
    mockSend.mockResolvedValue({ Body: fakeBody(VALID_COOKIES) });
    const { withCookieArgs, invalidateCookies } = await import("@/lib/cookies");

    await withCookieArgs(async (args) => args);
    invalidateCookies();
    await withCookieArgs(async (args) => args);

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("treats NoSuchKey as 'no cookies', caching that for the full TTL", async () => {
    mockSend.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));
    const { withCookieArgs } = await import("@/lib/cookies");

    const result1 = await withCookieArgs(async (args) => args);
    const result2 = await withCookieArgs(async (args) => args);

    expect(result1).toEqual([]);
    expect(result2).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("treats AccessDenied as 'no cookies' without throwing, cached only briefly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1));
    mockSend.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const { withCookieArgs } = await import("@/lib/cookies");

    const result1 = await withCookieArgs(async (args) => args);
    vi.setSystemTime(new Date(2030, 0, 1, 0, 0, 6)); // +6s, past the 5s error TTL
    const result2 = await withCookieArgs(async (args) => args);

    expect(result1).toEqual([]);
    expect(result2).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("getCookieStatus maps a HeadObject response, including uploaded-by metadata", async () => {
    mockSend.mockResolvedValueOnce({
      LastModified: new Date("2026-01-01T00:00:00Z"),
      ContentLength: 1234,
      Metadata: { "uploaded-by": "paul@example.com" },
    });
    const { getCookieStatus } = await import("@/lib/cookies");

    expect(await getCookieStatus()).toEqual({
      present: true,
      lastModified: "2026-01-01T00:00:00.000Z",
      size: 1234,
      uploadedBy: "paul@example.com",
    });
  });

  it("getCookieStatus reports absent on NotFound", async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "NotFound" }));
    const { getCookieStatus } = await import("@/lib/cookies");

    expect(await getCookieStatus()).toEqual({
      present: false,
      lastModified: null,
      size: null,
      uploadedBy: null,
    });
  });

  it("putCookies sends the normalized body with content type and uploader metadata", async () => {
    mockSend.mockResolvedValueOnce({});
    const { putCookies } = await import("@/lib/cookies");

    await putCookies(VALID_COOKIES, "paul@example.com");

    const input = mockSend.mock.calls[0][0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("config/cookies.txt");
    expect(input.Body).toBe(VALID_COOKIES);
    expect(input.ContentType).toBe("text/plain");
    expect(input.Metadata).toEqual({ "uploaded-by": "paul@example.com" });
  });

  it("deleteCookies sends a DeleteObject for the cookies key", async () => {
    mockSend.mockResolvedValueOnce({});
    const { deleteCookies } = await import("@/lib/cookies");

    await deleteCookies();

    const input = mockSend.mock.calls[0][0].input;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("config/cookies.txt");
  });
});
