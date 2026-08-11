import { NextResponse } from "next/server";
import { adminAddUserToGroup, adminCreateUser } from "@/lib/auth-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Creates a new Cognito user. Gated to the "Admins" group — re-checked here, never trusted from the client alone. */
export async function POST(request: Request) {
  const groups = request.headers.get("x-user-groups")?.split(",") ?? [];
  if (!groups.includes("Admins")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { email?: unknown; makeAdmin?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }

  try {
    await adminCreateUser(email);
    await adminAddUserToGroup(email, "Users");
    if (body.makeAdmin === true) {
      await adminAddUserToGroup(email, "Admins");
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create user:", err);
    return NextResponse.json({ error: "Failed to create user." }, { status: 500 });
  }
}
