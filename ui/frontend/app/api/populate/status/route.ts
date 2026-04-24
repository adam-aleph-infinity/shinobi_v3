import { NextRequest } from "next/server";

const BACKEND = "http://127.0.0.1:8000";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(_req: NextRequest) {
  const res = await fetch(`${BACKEND}/populate/status`);
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
