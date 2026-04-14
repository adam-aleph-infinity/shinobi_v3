import { NextRequest } from "next/server";

const BACKEND = "http://127.0.0.1:8000";

export async function POST(_req: NextRequest) {
  const res = await fetch(`${BACKEND}/populate/reset`, { method: "POST" });
  const data = await res.json();
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
