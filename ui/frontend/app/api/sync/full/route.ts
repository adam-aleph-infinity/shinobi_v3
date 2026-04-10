import { NextRequest } from "next/server";

const BACKEND = "http://127.0.0.1:8000";

/**
 * Streaming SSE passthrough — forwards the full-sync progress stream
 * from the FastAPI backend directly to the browser without buffering.
 */
export async function POST(_req: NextRequest) {
  const res = await fetch(`${BACKEND}/sync/full`, { method: "POST" });

  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
