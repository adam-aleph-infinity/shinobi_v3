"use client";

import { useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, CheckCircle2, XCircle, Clock, User, Building2,
  Phone, Workflow, Loader2, RefreshCw, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error("Invalid JSON");
  }
  if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
  return data;
};

interface ReviewItem {
  id: string;
  pipeline_name: string;
  sales_agent: string;
  customer: string;
  call_id: string;
  started_at: string | null;
  status: string;
  review_status: string | null;
  steps_json: string;
}

function ScoreBadge({ stepsJson }: { stepsJson: string }) {
  try {
    const steps: any[] = JSON.parse(stepsJson || "[]");
    for (const s of steps) {
      if (s.score_json || s.compliance_score) {
        const score = s.compliance_score ?? s.score_json?._overall;
        if (typeof score === "number") {
          const color =
            score >= 70 ? "text-green-400" : score >= 50 ? "text-yellow-400" : "text-red-400";
          return <span className={cn("font-mono text-sm font-semibold", color)}>{score}</span>;
        }
      }
    }
  } catch {}
  return <span className="text-zinc-500 text-sm">—</span>;
}

export default function ReviewQueuePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data, error, isLoading, mutate } = useSWR<{ items: ReviewItem[]; count: number }>(
    "/api/notes/review-queue",
    fetcher,
    { refreshInterval: 30_000 },
  );

  const items = data?.items ?? [];

  async function decide(runId: string, action: "approve" | "reject") {
    setSubmitting((s) => ({ ...s, [runId]: true }));
    setErrors((e) => ({ ...e, [runId]: "" }));
    try {
      const res = await fetch(`/api/notes/review/${runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reasons[runId] ?? "" }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(String(d?.detail || d?.error || `HTTP ${res.status}`));
      }
      mutate();
    } catch (err: any) {
      setErrors((e) => ({ ...e, [runId]: err.message ?? "Failed" }));
    } finally {
      setSubmitting((s) => ({ ...s, [runId]: false }));
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <AlertTriangle className="text-yellow-400 w-6 h-6" />
          <h1 className="text-xl font-semibold">Review Queue</h1>
          {data && (
            <span className="bg-yellow-500/20 text-yellow-300 text-xs font-semibold px-2 py-0.5 rounded-full">
              {data.count} pending
            </span>
          )}
        </div>
        <button
          onClick={() => mutate()}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <p className="text-zinc-400 text-sm mb-6 max-w-2xl">
        These runs have notes that were flagged by the confidence gate and held back from automatic
        CRM push. Approve to push the note to CRM, or reject to discard.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm">
          {error.message}
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
          <CheckCircle2 className="w-10 h-10 text-green-600" />
          <p className="text-base font-medium text-zinc-400">Queue is clear</p>
          <p className="text-sm">No notes are waiting for review.</p>
        </div>
      )}

      <div className="space-y-4">
        {items.map((item) => (
          <div
            key={item.id}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition-colors"
          >
            {/* Row 1: identifiers */}
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <span className="flex items-center gap-1.5 text-sm text-zinc-300">
                <User className="w-3.5 h-3.5 text-zinc-500" />
                {item.sales_agent || "—"}
              </span>
              <span className="flex items-center gap-1.5 text-sm text-zinc-300">
                <Building2 className="w-3.5 h-3.5 text-zinc-500" />
                {item.customer || "—"}
              </span>
              {item.call_id && (
                <span className="flex items-center gap-1.5 text-sm text-zinc-500 font-mono">
                  <Phone className="w-3.5 h-3.5" />
                  {item.call_id}
                </span>
              )}
              <span className="flex items-center gap-1.5 text-sm text-zinc-500">
                <Workflow className="w-3.5 h-3.5" />
                {item.pipeline_name}
              </span>
              {item.started_at && (
                <span className="flex items-center gap-1.5 text-xs text-zinc-600">
                  <Clock className="w-3 h-3" />
                  {new Date(item.started_at).toLocaleString()}
                </span>
              )}
              <ScoreBadge stepsJson={item.steps_json} />
            </div>

            {/* Deep link */}
            <button
              onClick={() => {
                localStorage.setItem("shinobi.pipeline.open_run", item.id);
                router.push("/pipeline");
              }}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 mb-3"
            >
              View in Pipeline Canvas
              <ChevronRight className="w-3 h-3" />
            </button>

            {/* Reason field + actions */}
            <div className="flex flex-wrap items-end gap-3 mt-2">
              <input
                type="text"
                placeholder="Reason (optional)"
                value={reasons[item.id] ?? ""}
                onChange={(e) => setReasons((r) => ({ ...r, [item.id]: e.target.value }))}
                className="flex-1 min-w-[220px] bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button
                disabled={submitting[item.id]}
                onClick={() => decide(item.id, "approve")}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                {submitting[item.id] ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                Approve & Push
              </button>
              <button
                disabled={submitting[item.id]}
                onClick={() => decide(item.id, "reject")}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                <XCircle className="w-4 h-4" />
                Reject
              </button>
            </div>

            {errors[item.id] && (
              <p className="mt-2 text-red-400 text-xs">{errors[item.id]}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
