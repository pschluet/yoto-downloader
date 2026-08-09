import { NextResponse } from "next/server";
import { createJob } from "@/lib/jobs";
import type { Track } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JobRequestBody = {
  kind?: unknown;
  title?: unknown;
  tracks?: unknown;
};

// YouTube video IDs are always 11 chars from this alphabet. Enforcing that
// here — not just "is a string" — keeps unvalidated client input from ever
// reaching a filesystem path join in trackFilePath().
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function isValidTrack(t: unknown): t is Track {
  if (!t || typeof t !== "object") return false;
  const track = t as Record<string, unknown>;
  return (
    typeof track.id === "string" &&
    VIDEO_ID_RE.test(track.id) &&
    typeof track.title === "string"
  );
}

export async function POST(request: Request) {
  let body: JobRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const kind = body.kind === "playlist" ? "playlist" : body.kind === "video" ? "video" : undefined;
  const title = typeof body.title === "string" ? body.title : "";
  const tracks = Array.isArray(body.tracks) ? body.tracks.filter(isValidTrack) : [];

  if (!kind) {
    return NextResponse.json({ error: "Missing or invalid 'kind'." }, { status: 400 });
  }
  if (tracks.length === 0) {
    return NextResponse.json({ error: "Select at least one track to download." }, { status: 400 });
  }

  const id = await createJob(kind, title || "Download", tracks);
  return NextResponse.json({ jobId: id });
}
