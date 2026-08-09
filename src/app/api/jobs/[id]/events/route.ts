import { getSnapshot, subscribe } from "@/lib/jobs";
import type { JobSnapshot } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15000;

/**
 * Server-Sent Events stream of job progress. Sends the current snapshot
 * immediately, then again on every change. Stays open through terminal
 * states (done/failed/canceled) — the client closes the EventSource once it
 * sees a terminal status, so we never race a server-initiated close against
 * the browser's auto-reconnect.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getSnapshot(id)) {
    return new Response("Job not found.", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (snapshot: JobSnapshot) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          // Controller already closed; subscriber will be removed on abort.
        }
      };

      unsubscribe = subscribe(id, send);
      const current = getSnapshot(id);
      if (current) send(current);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // ignore
        }
      }, HEARTBEAT_MS);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      cleanup();
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
