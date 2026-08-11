import { NextResponse, type NextRequest } from "next/server";
import {
  CognitoError,
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  clearSessionCookies,
  refreshTokens,
  setSessionCookies,
  verifyIdToken,
} from "@/lib/auth";

function loginRedirect(request: NextRequest): NextResponse {
  const url = new URL("/login", request.url);
  url.searchParams.set("next", request.nextUrl.pathname);
  // Clear anything stale so the login page doesn't loop back through here.
  return clearSessionCookies(NextResponse.redirect(url));
}

export async function proxy(request: NextRequest) {
  const idToken = request.cookies.get(ID_TOKEN_COOKIE)?.value;

  if (idToken) {
    const claims = await verifyIdToken(idToken);
    if (claims) {
      const headers = new Headers(request.headers);
      headers.set("x-user-email", claims.email);
      headers.set("x-user-groups", claims.groups.join(","));
      return NextResponse.next({ request: { headers } });
    }
  }

  // No valid id token — try to mint a new one from the refresh token before
  // giving up and sending the user back to /login.
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) return loginRedirect(request);

  try {
    const result = await refreshTokens(refreshToken);
    const tokens = result.AuthenticationResult;
    if (!tokens) return loginRedirect(request);

    const claims = await verifyIdToken(tokens.IdToken);
    if (!claims) return loginRedirect(request);

    const headers = new Headers(request.headers);
    headers.set("x-user-email", claims.email);
    headers.set("x-user-groups", claims.groups.join(","));

    // Cognito doesn't return a new refresh token on REFRESH_TOKEN_AUTH by
    // default, so setSessionCookies leaves the existing refresh_token cookie
    // alone (it only overwrites cookies for tokens actually present).
    return setSessionCookies(NextResponse.next({ request: { headers } }), tokens);
  } catch (err) {
    if (err instanceof CognitoError) return loginRedirect(request);
    throw err;
  }
}

export const config = {
  matcher: [
    /*
     * Everything except:
     * - /login (the sign-in page itself)
     * - /api/auth/* (login/challenge/logout — must be reachable while signed out)
     * - Next.js internals and static assets
     */
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
