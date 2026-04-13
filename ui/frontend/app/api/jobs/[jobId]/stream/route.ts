import http from "http";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { jobId: string } }
) {
  return new Promise<Response>((resolve) => {
    const req = http.get(
      `http://127.0.0.1:8000/jobs/${params.jobId}/stream`,
      (upstream) => {
        const readable = new ReadableStream({
          start(controller) {
            upstream.on("data", (chunk: Buffer) => controller.enqueue(chunk));
            upstream.on("end", () => controller.close());
            upstream.on("error", (e) => controller.error(e));
          },
          cancel() {
            req.destroy();
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
    req.on("error", () => resolve(new Response(null, { status: 502 })));
  });
}
