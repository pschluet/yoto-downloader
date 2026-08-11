import { ZipArchive } from "archiver";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { contentDisposition, dedupeFilenames, sanitizeFilename } from "@/lib/format";
import { getJob } from "@/lib/jobs";
import { getObjectReadStream, getPresignedDownloadUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single video → redirect to a presigned S3 URL (cheaper and faster than
 * proxying the bytes back through this Lambda). Playlist → a zip has to be
 * built server-side; each track streams in from S3 the same way the
 * local/Docker version read it from local disk.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const doneTracks = job.tracks.filter((t) => t.status === "done");
  if (doneTracks.length === 0) {
    return NextResponse.json({ error: "No completed tracks yet." }, { status: 409 });
  }

  if (job.kind === "video") {
    const track = doneTracks[0];
    const filename = `${sanitizeFilename(track.title)}.mp3`;
    const url = await getPresignedDownloadUrl(id, track.id, filename);
    return NextResponse.redirect(url, 302);
  }

  const filenames = dedupeFilenames(doneTracks.map((t) => sanitizeFilename(t.title)));
  const archive = new ZipArchive({ store: true });
  archive.on("error", (err: Error) => {
    console.error("zip archive error:", err);
  });

  // Sequential, not Promise.all: keeps zip entry order matching
  // doneTracks/filenames deterministically, and S3 GetObject's own latency
  // (returning a stream handle, not the full body) is small enough that
  // this doesn't meaningfully slow down a personal-scale playlist.
  for (let i = 0; i < doneTracks.length; i++) {
    const track = doneTracks[i];
    const stream = await getObjectReadStream(id, track.id);
    archive.append(stream, { name: `${filenames[i]}.mp3` });
  }
  void archive.finalize();

  const zipName = `${sanitizeFilename(job.title)}.zip`;
  return new Response(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(zipName),
    },
  });
}
