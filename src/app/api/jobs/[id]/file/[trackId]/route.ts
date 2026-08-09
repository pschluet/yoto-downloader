import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { contentDisposition, sanitizeFilename } from "@/lib/format";
import { getJob, trackFilePath } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download a single track's mp3 out of a job, e.g. to retry one file from a playlist. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; trackId: string }> },
) {
  const { id, trackId } = await context.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const track = job.tracks.find((t) => t.id === trackId);
  if (!track || track.status !== "done") {
    return NextResponse.json({ error: "Track not ready." }, { status: 409 });
  }

  const filename = `${sanitizeFilename(track.title)}.mp3`;
  const nodeStream = createReadStream(trackFilePath(job.tmpDir, track.id));
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": contentDisposition(filename),
      ...(track.fileSize ? { "Content-Length": String(track.fileSize) } : {}),
    },
  });
}
