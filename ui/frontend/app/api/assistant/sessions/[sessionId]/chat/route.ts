import http from "http";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { sessionId: string } }
) {
  const body = await req.text();

  return new Promise<Response>((resolve) => {
    const upstreamReq = http.request(
      `http://127.0.0.1:8000/assistant/sessions/${encodeURIComponent(params.sessionId)}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (upstream) => {
        const readable = new ReadableStream({
          start(controller) {
            upstream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
            upstream.on("end", () => controller.close());
            upstream.on("error", (e) => controller.error(e));
          },
          cancel() {
            upstreamReq.destroy();
          },
        });

        resolve(
          new Response(readable, {
            status: upstream.statusCode || 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
            },
          })
        );
      }
    );

    upstreamReq.on("error", () => resolve(new Response(null, { status: 502 })));

    if (body) upstreamReq.write(body);
    upstreamReq.end();
  });
}
