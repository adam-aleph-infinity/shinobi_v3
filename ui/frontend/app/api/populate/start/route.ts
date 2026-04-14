import { NextRequest } from "next/server";

const BACKEND = "http://127.0.0.1:8000";

/**
 * Streaming SSE passthrough — forwards the populate pipeline progress stream
 * from the FastAPI backend directly to the browser without buffering.
 * The Next.js rewrite proxy buffers SSE and causes GCP LB 30s timeouts;
 * this custom handler passes the body through as a raw stream.
 */
export async function POST(_req: NextRequest) {
  const res = await fetch(`${BACKEND}/populate/start`, { method: "POST" });

  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
