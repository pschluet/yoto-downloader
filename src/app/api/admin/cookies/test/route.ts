import { NextResponse } from "next/server";
import { getCookieStatus, invalidateCookies } from "@/lib/cookies";
import { isYoutubeUrl, resolve, YtdlpError } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A stable, always-available video — the default probe so an admin doesn't
// need a failing URL on hand to sanity-check a fresh cookie upload.
const TEST_VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/**
 * Runs a real yt-dlp resolve against a known-good (or admin-supplied)
 * YouTube URL using whatever cookies are currently in S3, to verify they
 * satisfy YouTube's bot check.
 *
 * This runs in the web Lambda: a green result proves the cookies work, but
 * NOT that the worker Lambda can read them too (config/* is a separate IAM
 * grant — see infra/lib/worker-stack.ts) — only a real track download
 * exercises that path.
 */
export async function POST(request: Request) {
  const groups = request.headers.get("x-user-groups")?.split(",") ?? [];
  if (!groups.includes("Admins")) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let url = TEST_VIDEO_URL;
  try {
    const body = (await request.json()) as { url?: unknown };
    if (typeof body?.url === "string" && body.url.trim()) {
      url = body.url.trim();
    }
  } catch {
    // No body (or an unparseable one) just means "use the default probe".
  }

  if (!isYoutubeUrl(url)) {
    return NextResponse.json({ error: "That doesn't look like a YouTube URL." }, { status: 400 });
  }

  // Never trust a cached jar here — the whole point of Test is to reflect
  // whatever is in S3 right now, in case an admin just re-uploaded.
  invalidateCookies();

  try {
    const [status, result] = await Promise.all([getCookieStatus(), resolve(url)]);
    const title = result.kind === "video" ? result.track.title : result.title;
    return NextResponse.json({ ok: true, title, usedCookies: status.present });
  } catch (err) {
    if (err instanceof YtdlpError) {
      // yt-dlp's own stderr, not the cookie contents — safe to log, and the
      // only way to diagnose *why* a cookie jar didn't satisfy YouTube.
      console.error("Cookie test failed:", err.message, "\nstderr tail:\n" + err.stderrTail);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("Cookie test failed with an unexpected error:", err);
    return NextResponse.json({ error: "Test failed." }, { status: 502 });
  }
}
