import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "jwks-instance"),
  jwtVerify: vi.fn(),
}));

import { jwtVerify } from "jose";
import {
  CognitoError,
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  clearSessionCookies,
  globalSignOut,
  initiateUserPasswordAuth,
  isAdmin,
  refreshTokens,
  respondToNewPasswordChallenge,
  setSessionCookies,
  verifyIdToken,
} from "@/lib/auth";

const mockJwtVerify = vi.mocked(jwtVerify);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AWS_REGION = "us-east-2";
  process.env.COGNITO_CLIENT_ID = "client-123";
  process.env.COGNITO_USER_POOL_ID = "pool-123";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mockJwtVerify.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("initiateUserPasswordAuth", () => {
  it("posts USER_PASSWORD_AUTH with the right target header and body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ AuthenticationResult: { IdToken: "x" } }));
    await initiateUserPasswordAuth("a@b.com", "pw");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cognito-idp.us-east-2.amazonaws.com/");
    expect(init.headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "client-123",
      AuthParameters: { USERNAME: "a@b.com", PASSWORD: "pw" },
    });
  });

  it("throws a CognitoError with the response's __type on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ __type: "NotAuthorizedException", message: "Incorrect username or password." }, false),
    );
    await expect(initiateUserPasswordAuth("a@b.com", "wrong")).rejects.toMatchObject({
      name: "CognitoError",
      type: "NotAuthorizedException",
    });
  });
});

describe("respondToNewPasswordChallenge", () => {
  it("posts RespondToAuthChallenge with the NEW_PASSWORD_REQUIRED shape", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ AuthenticationResult: {} }));
    await respondToNewPasswordChallenge("a@b.com", "newpw", "session-token");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    );
    expect(JSON.parse(init.body)).toEqual({
      ClientId: "client-123",
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: "session-token",
      ChallengeResponses: { USERNAME: "a@b.com", NEW_PASSWORD: "newpw" },
    });
  });
});

describe("refreshTokens", () => {
  it("posts REFRESH_TOKEN_AUTH", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ AuthenticationResult: {} }));
    await refreshTokens("refresh-abc");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: "client-123",
      AuthParameters: { REFRESH_TOKEN: "refresh-abc" },
    });
  });
});

describe("globalSignOut", () => {
  it("never throws, even if the Cognito call fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ __type: "NotAuthorizedException" }, false));
    await expect(globalSignOut("expired-token")).resolves.toBeUndefined();
  });
});

describe("verifyIdToken", () => {
  it("returns email + groups for a valid id token", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { token_use: "id", email: "a@b.com", "cognito:groups": ["Admins", "Users"] },
    } as never);

    const claims = await verifyIdToken("a.b.c");
    expect(claims).toEqual({ email: "a@b.com", groups: ["Admins", "Users"] });
  });

  it("rejects a token that isn't an id token (e.g. an access token)", async () => {
    mockJwtVerify.mockResolvedValue({ payload: { token_use: "access" } } as never);
    expect(await verifyIdToken("a.b.c")).toBeNull();
  });

  it("returns null on any verification failure (bad signature, expired, wrong issuer, ...)", async () => {
    mockJwtVerify.mockRejectedValue(new Error("signature verification failed"));
    expect(await verifyIdToken("garbage")).toBeNull();
  });

  it("defaults groups to an empty array when the claim is missing", async () => {
    mockJwtVerify.mockResolvedValue({ payload: { token_use: "id", email: "a@b.com" } } as never);
    expect(await verifyIdToken("a.b.c")).toEqual({ email: "a@b.com", groups: [] });
  });
});

describe("isAdmin", () => {
  it("is true only when 'Admins' is among the claims' groups", () => {
    expect(isAdmin({ email: "a", groups: ["Admins"] })).toBe(true);
    expect(isAdmin({ email: "a", groups: ["Users"] })).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});

describe("session cookies", () => {
  it("sets id/access/refresh cookies with httpOnly on a successful auth result", () => {
    const res = setSessionCookies(NextResponse.json({ ok: true }), {
      AccessToken: "access",
      IdToken: "id",
      RefreshToken: "refresh",
      ExpiresIn: 3600,
      TokenType: "Bearer",
    });

    expect(res.cookies.get(ID_TOKEN_COOKIE)?.value).toBe("id");
    expect(res.cookies.get(REFRESH_TOKEN_COOKIE)?.value).toBe("refresh");
    expect(res.cookies.get(ID_TOKEN_COOKIE)?.httpOnly).toBe(true);
  });

  it("leaves the refresh cookie untouched when no refresh token is present (e.g. a refresh response)", () => {
    const res = setSessionCookies(NextResponse.json({ ok: true }), {
      AccessToken: "access",
      IdToken: "id",
      ExpiresIn: 3600,
      TokenType: "Bearer",
    });
    expect(res.cookies.get(REFRESH_TOKEN_COOKIE)).toBeUndefined();
  });

  it("clearSessionCookies expires all three cookies", () => {
    const res = clearSessionCookies(NextResponse.json({ ok: true }));
    for (const name of [ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]) {
      const cookie = res.cookies.get(name);
      expect(cookie?.value).toBe("");
      expect(cookie?.expires).toEqual(new Date(0));
    }
  });
});

describe("CognitoError", () => {
  it("carries the Cognito __type through", () => {
    const err = new CognitoError("nope", "SomeException");
    expect(err.name).toBe("CognitoError");
    expect(err.type).toBe("SomeException");
  });
});
