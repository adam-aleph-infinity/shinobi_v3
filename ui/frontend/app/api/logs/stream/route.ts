export const dynamic = "force-dynamic";

export async function GET() {
  const upstream = await fetch("http://127.0.0.1:8000/logs/stream", {
    // @ts-expect-error: Node 18+ fetch supports duplex
    duplex: "half",
  });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
