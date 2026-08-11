import { NextResponse } from "next/server";
import {
  MAX_COOKIES_BYTES,
  deleteCookies,
  getCookieStatus,
  invalidateCookies,
  normalizeCookies,
  putCookies,
  validateNetscapeCookies,
} from "@/lib/cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireAdmin(request: Request): NextResponse | undefined {
  const groups = request.headers.get("x-user-groups")?.split(",") ?? [];
  if (!groups.includes("Admins")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return undefined;
}

/** Whether an admin-managed YouTube cookies.txt is configured, and metadata about it — never the contents. */
export async function GET(request: Request) {
  const forbidden = requireAdmin(request);
  if (forbidden) return forbidden;

  try {
    const status = await getCookieStatus();
    return NextResponse.json(status);
  } catch (err) {
    console.error("Failed to read cookie status:", err);
    return NextResponse.json({ error: "Failed to read cookie status." }, { status: 500 });
  }
}

/** Replaces the stored cookies.txt that both Lambdas pass to yt-dlp. */
export async function PUT(request: Request) {
  const forbidden = requireAdmin(request);
  if (forbidden) return forbidden;

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_COOKIES_BYTES) {
    return NextResponse.json({ error: "Cookie file is too large (max 512 KB)." }, { status: 413 });
  }

  let body: { cookies?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const cookies = typeof body.cookies === "string" ? body.cookies : "";
  if (!cookies.trim()) {
    return NextResponse.json(
      { error: "Paste or choose a cookies.txt file first." },
      { status: 400 },
    );
  }
  // content-length may be absent (or wrong) — re-check the real byte length.
  if (Buffer.byteLength(cookies, "utf8") > MAX_COOKIES_BYTES) {
    return NextResponse.json({ error: "Cookie file is too large (max 512 KB)." }, { status: 413 });
  }

  const validationError = validateNetscapeCookies(cookies);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const uploadedBy = request.headers.get("x-user-email") ?? "unknown";
    await putCookies(normalizeCookies(cookies), uploadedBy);
    invalidateCookies();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to save cookies:", err);
    return NextResponse.json({ error: "Failed to save cookies." }, { status: 500 });
  }
}

/** Removes the stored cookies.txt — a one-click way to revoke a leaked/wrong upload without a deploy. */
export async function DELETE(request: Request) {
  const forbidden = requireAdmin(request);
  if (forbidden) return forbidden;

  try {
    await deleteCookies();
    invalidateCookies();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete cookies:", err);
    return NextResponse.json({ error: "Failed to delete cookies." }, { status: 500 });
  }
}
