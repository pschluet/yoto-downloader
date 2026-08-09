import { ZipArchive } from "archiver";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { contentDisposition, dedupeFilenames, sanitizeFilename } from "@/lib/format";
import { getJob, trackFilePath } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Single video → the one mp3. Playlist → a zip of every completed track. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = getJob(id);
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
    const nodeStream = createReadStream(trackFilePath(job.tmpDir, track.id));
    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": contentDisposition(filename),
        ...(track.fileSize ? { "Content-Length": String(track.fileSize) } : {}),
      },
    });
  }

  const filenames = dedupeFilenames(doneTracks.map((t) => sanitizeFilename(t.title)));
  const archive = new ZipArchive({ store: true });
  archive.on("error", (err: Error) => {
    console.error("zip archive error:", err);
  });
  doneTracks.forEach((track, i) => {
    archive.file(trackFilePath(job.tmpDir, track.id), { name: `${filenames[i]}.mp3` });
  });
  void archive.finalize();

  const zipName = `${sanitizeFilename(job.title)}.zip`;
  return new Response(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(zipName),
    },
  });
}
