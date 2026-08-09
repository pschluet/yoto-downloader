import { NextResponse } from "next/server";
import { isYoutubeUrl, resolve, YtdlpError } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const url = (body as { url?: unknown })?.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return NextResponse.json({ error: "Enter a YouTube URL." }, { status: 400 });
  }
  if (!isYoutubeUrl(url)) {
    return NextResponse.json({ error: "That doesn't look like a YouTube URL." }, { status: 400 });
  }

  try {
    const result = await resolve(url.trim());
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof YtdlpError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json({ error: "Failed to resolve that URL." }, { status: 502 });
  }
}
