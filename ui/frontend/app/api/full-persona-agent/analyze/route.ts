import http from "http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const bodyText = await req.text();
  const bodyBuf = Buffer.from(bodyText, "utf-8");

  return new Promise<Response>((resolve) => {
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: 8000,
        path: "/full-persona-agent/analyze",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": bodyBuf.length,
        },
      },
      (res) => {
        const readable = new ReadableStream({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(chunk));
            res.on("end", () => controller.close());
            res.on("error", (e) => controller.error(e));
          },
          cancel() {
            upstream.destroy();
          },
        });
        resolve(
          new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
            },
          })
        );
      }
    );
    upstream.on("error", () => resolve(new Response(null, { status: 502 })));
    upstream.write(bodyBuf);
    upstream.end();
  });
}
