import { NextRequest, NextResponse } from "next/server";

const BACKEND = "http://127.0.0.1:8000";

// POST /api/personas/[personaId]/regenerate — long-running LLM call
export async function POST(
  req: NextRequest,
  { params }: { params: { personaId: string } }
) {
  const body = await req.text();
  const res = await fetch(`${BACKEND}/personas/${params.personaId}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(600_000), // 10 min
  });
  const data = await res.text();
  return new NextResponse(data, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
