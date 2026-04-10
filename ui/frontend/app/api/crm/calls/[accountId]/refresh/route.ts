import { NextRequest, NextResponse } from "next/server";

const BACKEND = "http://127.0.0.1:8000";

// POST /api/crm/calls/:accountId/refresh — long-running CRM API call
export async function POST(
  req: NextRequest,
  { params }: { params: { accountId: string } }
) {
  const url = new URL(req.url);
  const query = url.search; // forward ?crm_url=...&agent=...&customer=...
  const res = await fetch(
    `${BACKEND}/crm/calls/${params.accountId}/refresh${query}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(120_000), // 2 min — CRM API can be slow
    }
  );
  const data = await res.text();
  return new NextResponse(data, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
