import { NextResponse } from "next/server";
import { sanitizeFilename } from "@/lib/format";
import { getJob } from "@/lib/jobs";
import { getPresignedDownloadUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download a single track's mp3 out of a job — a redirect to a presigned S3 URL. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; trackId: string }> },
) {
  const { id, trackId } = await context.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const track = job.tracks.find((t) => t.id === trackId);
  if (!track || track.status !== "done") {
    return NextResponse.json({ error: "Track not ready." }, { status: 409 });
  }

  const filename = `${sanitizeFilename(track.title)}.mp3`;
  const url = await getPresignedDownloadUrl(id, track.id, filename);
  return NextResponse.redirect(url, 302);
}
