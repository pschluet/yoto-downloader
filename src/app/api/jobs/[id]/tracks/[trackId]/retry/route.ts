import { NextResponse } from "next/server";
import { retryTrack } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manually retry a single track that failed after exhausting its automatic retries. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; trackId: string }> },
) {
  const { id, trackId } = await context.params;
  const result = await retryTrack(id, trackId);

  if (result === "not-found") {
    return NextResponse.json({ error: "Job or track not found." }, { status: 404 });
  }
  if (result === "not-retryable") {
    return NextResponse.json({ error: "This track isn't in a failed state." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
