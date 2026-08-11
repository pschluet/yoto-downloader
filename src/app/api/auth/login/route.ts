import { NextResponse } from "next/server";
import { CognitoError, initiateUserPasswordAuth, setSessionCookies } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function friendlyMessage(err: CognitoError): string {
  if (err.type === "NotAuthorizedException" || err.type === "UserNotFoundException") {
    return "Incorrect email or password.";
  }
  if (err.type === "UserNotConfirmedException") {
    return "This account hasn't been confirmed yet.";
  }
  return "Sign-in failed.";
}

export async function POST(request: Request) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }

  try {
    const result = await initiateUserPasswordAuth(email, password);

    if (result.ChallengeName === "NEW_PASSWORD_REQUIRED") {
      return NextResponse.json({ challenge: "NEW_PASSWORD_REQUIRED", session: result.Session });
    }

    const tokens = result.AuthenticationResult;
    if (!tokens) {
      return NextResponse.json({ error: "Sign-in failed." }, { status: 401 });
    }

    return setSessionCookies(NextResponse.json({ ok: true }), tokens);
  } catch (err) {
    if (err instanceof CognitoError) {
      return NextResponse.json({ error: friendlyMessage(err) }, { status: 401 });
    }
    return NextResponse.json({ error: "Sign-in failed." }, { status: 500 });
  }
}
