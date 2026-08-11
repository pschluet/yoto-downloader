import { NextResponse } from "next/server";
import { CognitoError, respondToNewPasswordChallenge, setSessionCookies } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Completes Cognito's NEW_PASSWORD_REQUIRED challenge (forced on admin-created users). */
export async function POST(request: Request) {
  let body: { email?: unknown; newPassword?: unknown; session?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const session = typeof body.session === "string" ? body.session : "";
  if (!email || !newPassword || !session) {
    return NextResponse.json(
      { error: "Email, new password, and session are required." },
      { status: 400 },
    );
  }

  try {
    const result = await respondToNewPasswordChallenge(email, newPassword, session);
    const tokens = result.AuthenticationResult;
    if (!tokens) {
      return NextResponse.json({ error: "Could not set new password." }, { status: 401 });
    }
    return setSessionCookies(NextResponse.json({ ok: true }), tokens);
  } catch (err) {
    if (err instanceof CognitoError) {
      const message =
        err.type === "InvalidPasswordException"
          ? "That password doesn't meet the requirements."
          : "Could not set new password. Try signing in again.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not set new password." }, { status: 500 });
  }
}
