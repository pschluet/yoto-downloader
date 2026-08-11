import { getSnapshot } from "@/lib/jobs";
import type { JobSnapshot } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1000;
// Bounded well under both Lambda's 15-minute invocation cap and (much more
// tightly) CloudFront's default ~60s origin response timeout in front of
// the custom domain. The client's EventSource auto-reconnects on a
// server-closed connection by default, so a short-lived stream that
// reopens often is more robust here than one long-held connection.
const MAX_STREAM_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Server-Sent Events stream of job progress. There's no in-process job
 * store to subscribe to anymore (state lives in DynamoDB, written by a
 * separate worker Lambda) — so this polls on an interval and re-emits
 * `data: {...}\n\n` whenever it reads a snapshot, closing once the job
 * reaches a terminal state or the time budget above runs out.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const initial = await getSnapshot(id);
  if (!initial) {
    return new Response("Job not found.", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (snapshot: JobSnapshot) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          // Controller already closed.
        }
      };

      send(initial);
      let lastStatus = initial.status;
      const startedAt = Date.now();

      while (!request.signal.aborted && Date.now() - startedAt < MAX_STREAM_MS) {
        if (lastStatus !== "running") break;
        await sleep(POLL_INTERVAL_MS);
        if (request.signal.aborted) break;

        const snapshot = await getSnapshot(id);
        if (!snapshot) break; // job was deleted mid-stream
        send(snapshot);
        lastStatus = snapshot.status;
      }

      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
