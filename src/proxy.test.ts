import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return { ...actual, verifyIdToken: vi.fn(), refreshTokens: vi.fn() };
});

import { CognitoError, ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, refreshTokens, verifyIdToken } from "@/lib/auth";
import { proxy } from "./proxy";

const mockVerifyIdToken = vi.mocked(verifyIdToken);
const mockRefreshTokens = vi.mocked(refreshTokens);

function requestWithCookies(cookies: Record<string, string>) {
  const req = new NextRequest("https://example.com/some/path");
  for (const [key, value] of Object.entries(cookies)) req.cookies.set(key, value);
  return req;
}

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockRefreshTokens.mockReset();
});

describe("proxy", () => {
  it("passes the request through with verified-user headers when the id token is valid", async () => {
    mockVerifyIdToken.mockResolvedValue({ email: "a@b.com", groups: ["Admins"] });
    const req = requestWithCookies({ [ID_TOKEN_COOKIE]: "valid" });

    const res = await proxy(req);

    expect(res.headers.get("x-middleware-request-x-user-email")).toBe("a@b.com");
    expect(res.headers.get("x-middleware-request-x-user-groups")).toBe("Admins");
    expect(res.status).not.toBe(307);
    expect(mockRefreshTokens).not.toHaveBeenCalled();
  });

  it("redirects to /login when there's no id token and no refresh token", async () => {
    const res = await proxy(requestWithCookies({}));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects to /login when the id token is invalid and there's no refresh token", async () => {
    mockVerifyIdToken.mockResolvedValue(null);
    const res = await proxy(requestWithCookies({ [ID_TOKEN_COOKIE]: "garbage" }));
    expect(res.status).toBe(307);
  });

  it("refreshes and passes through when the id token is invalid but the refresh token works", async () => {
    mockVerifyIdToken
      .mockResolvedValueOnce(null) // the original (expired) id token
      .mockResolvedValueOnce({ email: "a@b.com", groups: [] }); // the freshly-minted one
    mockRefreshTokens.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: "a",
        IdToken: "new-id",
        ExpiresIn: 3600,
        TokenType: "Bearer",
      },
    });

    const req = requestWithCookies({
      [ID_TOKEN_COOKIE]: "expired",
      [REFRESH_TOKEN_COOKIE]: "refresh-abc",
    });
    const res = await proxy(req);

    expect(res.headers.get("x-middleware-request-x-user-email")).toBe("a@b.com");
    expect(res.cookies.get(ID_TOKEN_COOKIE)?.value).toBe("new-id");
    expect(res.status).not.toBe(307);
  });

  it("redirects to /login when the refresh token is rejected by Cognito", async () => {
    mockVerifyIdToken.mockResolvedValue(null);
    mockRefreshTokens.mockRejectedValue(new CognitoError("expired", "NotAuthorizedException"));

    const res = await proxy(requestWithCookies({ [REFRESH_TOKEN_COOKIE]: "expired-refresh" }));
    expect(res.status).toBe(307);
  });

  it("redirects to /login when refresh succeeds but returns no usable tokens", async () => {
    mockVerifyIdToken.mockResolvedValue(null);
    mockRefreshTokens.mockResolvedValue({});
    const res = await proxy(requestWithCookies({ [REFRESH_TOKEN_COOKIE]: "whatever" }));
    expect(res.status).toBe(307);
  });

  it("propagates an unexpected (non-Cognito) error rather than silently redirecting", async () => {
    mockVerifyIdToken.mockResolvedValue(null);
    mockRefreshTokens.mockRejectedValue(new Error("network down"));
    await expect(proxy(requestWithCookies({ [REFRESH_TOKEN_COOKIE]: "x" }))).rejects.toThrow(
      "network down",
    );
  });
});
