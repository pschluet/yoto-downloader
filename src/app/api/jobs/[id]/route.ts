import { NextResponse } from "next/server";
import { deleteJob, getSnapshot } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const snapshot = await getSnapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}

/** Cancels the job (if running) and deletes its temp files. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const ok = await deleteJob(id);
  if (!ok) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
