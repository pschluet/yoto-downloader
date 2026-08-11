import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextResponse } from "next/server";

// These Cognito operations (InitiateAuth, RespondToAuthChallenge,
// GlobalSignOut) authorize using the app client / the user's own tokens,
// not IAM credentials — Cognito's public API lets them be called with a
// plain HTTPS request, no AWS SigV4 signing needed. That's deliberate here:
// it lets this run in Next.js Middleware on the Edge runtime, not just in
// Node.js route handlers. (AdminCreateUser and friends, in src/lib/auth-admin.ts,
// are privileged and do need real AWS credentials — those stay server-only.)

export class CognitoError extends Error {
  constructor(
    message: string,
    public readonly type: string | undefined,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

function region(): string {
  const r = process.env.AWS_REGION;
  if (!r) throw new Error("AWS_REGION is not set.");
  return r;
}

function clientId(): string {
  const id = process.env.COGNITO_CLIENT_ID;
  if (!id) throw new Error("COGNITO_CLIENT_ID is not set.");
  return id;
}

function userPoolId(): string {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) throw new Error("COGNITO_USER_POOL_ID is not set.");
  return id;
}

function issuer(): string {
  return `https://cognito-idp.${region()}.amazonaws.com/${userPoolId()}`;
}

async function cognitoRequest<T>(target: string, body: object): Promise<T> {
  const res = await fetch(`https://cognito-idp.${region()}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new CognitoError(data?.message ?? "Cognito request failed.", data?.__type);
  }
  return data as T;
}

export type AuthenticationResult = {
  AccessToken: string;
  IdToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
  TokenType: string;
};

export type InitiateAuthResponse = {
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
  AuthenticationResult?: AuthenticationResult;
};

export function initiateUserPasswordAuth(
  email: string,
  password: string,
): Promise<InitiateAuthResponse> {
  return cognitoRequest("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId(),
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
}

/** Responds to Cognito's NEW_PASSWORD_REQUIRED challenge (forced on admin-created users). */
export function respondToNewPasswordChallenge(
  email: string,
  newPassword: string,
  session: string,
): Promise<InitiateAuthResponse> {
  return cognitoRequest("RespondToAuthChallenge", {
    ClientId: clientId(),
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    Session: session,
    ChallengeResponses: { USERNAME: email, NEW_PASSWORD: newPassword },
  });
}

export function refreshTokens(refreshToken: string): Promise<InitiateAuthResponse> {
  return cognitoRequest("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: clientId(),
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
}

/** Invalidates every token issued to this user (best-effort; ignored if it fails). */
export async function globalSignOut(accessToken: string): Promise<void> {
  try {
    await cognitoRequest("GlobalSignOut", { AccessToken: accessToken });
  } catch {
    // Logging out should never fail the request just because the token was
    // already expired/revoked.
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer()}/.well-known/jwks.json`));
  }
  return jwks;
}

export type SessionClaims = {
  email: string;
  groups: string[];
};

/** Verifies a Cognito ID token's signature/issuer/audience/expiry and extracts session claims. */
export async function verifyIdToken(idToken: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(idToken, getJwks(), {
      issuer: issuer(),
      audience: clientId(),
    });
    if (payload.token_use !== "id") return null;
    const groups = Array.isArray(payload["cognito:groups"])
      ? (payload["cognito:groups"] as string[])
      : [];
    const email = typeof payload.email === "string" ? payload.email : "";
    return { email, groups };
  } catch {
    return null;
  }
}

export function isAdmin(claims: SessionClaims | null): boolean {
  return claims?.groups.includes("Admins") ?? false;
}

export const ID_TOKEN_COOKIE = "id_token";
export const ACCESS_TOKEN_COOKIE = "access_token";
export const REFRESH_TOKEN_COOKIE = "refresh_token";

// Matches the CDK-configured Cognito refresh token validity (30 days).
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/** Sets the three session cookies on a response from a successful sign-in/refresh. */
export function setSessionCookies(
  response: NextResponse,
  tokens: AuthenticationResult,
): NextResponse {
  response.cookies.set(ID_TOKEN_COOKIE, tokens.IdToken, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: tokens.ExpiresIn,
  });
  response.cookies.set(ACCESS_TOKEN_COOKIE, tokens.AccessToken, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: tokens.ExpiresIn,
  });
  if (tokens.RefreshToken) {
    response.cookies.set(REFRESH_TOKEN_COOKIE, tokens.RefreshToken, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
    });
  }
  return response;
}

export function clearSessionCookies(response: NextResponse): NextResponse {
  response.cookies.delete(ID_TOKEN_COOKIE);
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
  return response;
}
