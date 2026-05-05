"use client";

import { useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, Clock, Loader2,
  RefreshCw, ChevronRight, Workflow, User, Building2, Phone,
  TrendingUp, AlertCircle,
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

interface OpsSummary {
  stalled_runs: number;
  pending_reviews: number;
  failure_rate_24h: number;
  failure_rate_1h: number;
}

interface RunRow {
  id: string;
  pipeline_name: string;
  sales_agent: string;
  customer: string;
  call_id: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  run_origin: string;
  note_sent: boolean;
  review_required: boolean;
  review_status: string | null;
}

const SUCCESS_STATUSES = new Set(["done", "completed", "success", "ok", "finished", "cached"]);
const INFLIGHT_STATUSES = new Set(["queued", "running", "retrying", "preparing"]);

function statusChip(status: string) {
  if (SUCCESS_STATUSES.has(status))
    return (
      <span className="flex items-center gap-1 text-green-400 text-xs">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {status}
      </span>
    );
  if (INFLIGHT_STATUSES.has(status))
    return (
      <span className="flex items-center gap-1 text-blue-400 text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {status}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-red-400 text-xs">
      <XCircle className="w-3.5 h-3.5" />
      {status}
    </span>
  );
}

function MetricCard({
  label,
  value,
  unit,
  alert,
}: {
  label: string;
  value: number;
  unit?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-zinc-900 border rounded-xl p-5 flex flex-col gap-1",
        alert && value > 0 ? "border-yellow-600/60" : "border-zinc-800",
      )}
    >
      <span className="text-xs text-zinc-500 uppercase tracking-wider">{label}</span>
      <span
        className={cn(
          "text-3xl font-bold tabular-nums",
          alert && value > 0 ? "text-yellow-300" : "text-zinc-100",
        )}
      >
        {value}
        {unit && <span className="text-base font-normal text-zinc-400 ml-1">{unit}</span>}
      </span>
    </div>
  );
}

export default function OpsPage() {
  const router = useRouter();
  const [runLimit, setRunLimit] = useState(50);

  const {
    data: summary,
    error: summaryErr,
    isLoading: summaryLoading,
    mutate: mutateSummary,
  } = useSWR<OpsSummary>("/api/ops/summary", fetcher, { refreshInterval: 30_000 });

  const {
    data: recentData,
    error: recentErr,
    isLoading: recentLoading,
    mutate: mutateRecent,
  } = useSWR<{ runs: RunRow[] }>(
    `/api/ops/recent-runs?limit=${runLimit}`,
    fetcher,
    { refreshInterval: 15_000 },
  );

  function refresh() {
    mutateSummary();
    mutateRecent();
  }

  const runs = recentData?.runs ?? [];

  function durationStr(r: RunRow) {
    if (!r.started_at) return "—";
    const start = new Date(r.started_at).getTime();
    const end = r.finished_at ? new Date(r.finished_at).getTime() : Date.now();
    const s = Math.round((end - start) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Activity className="text-blue-400 w-6 h-6" />
          <h1 className="text-xl font-semibold">Run Control Center</h1>
        </div>
        <button
          onClick={refresh}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Health metric strip */}
      {summaryLoading ? (
        <div className="flex items-center gap-2 text-zinc-500 mb-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading metrics…
        </div>
      ) : summaryErr ? (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm mb-6">
          {summaryErr.message}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <MetricCard
            label="Stalled Runs"
            value={summary.stalled_runs}
            alert
          />
          <MetricCard
            label="Pending Review"
            value={summary.pending_reviews}
            alert
          />
          <MetricCard
            label="Failure Rate (1h)"
            value={summary.failure_rate_1h}
            unit="%"
            alert
          />
          <MetricCard
            label="Failure Rate (24h)"
            value={summary.failure_rate_24h}
            unit="%"
          />
        </div>
      ) : null}

      {/* Shortcut: go to review queue if there are pending items */}
      {summary && summary.pending_reviews > 0 && (
        <div className="mb-6 flex items-center gap-3 bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-4">
          <AlertCircle className="w-5 h-5 text-yellow-400 shrink-0" />
          <span className="text-sm text-yellow-200">
            {summary.pending_reviews} note{summary.pending_reviews !== 1 ? "s" : ""} waiting for review before CRM push.
          </span>
          <button
            onClick={() => router.push("/review-queue")}
            className="ml-auto flex items-center gap-1 text-sm text-yellow-300 hover:text-yellow-100"
          >
            Review now
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Recent runs table */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
          Recent Runs
        </h2>
        <select
          value={runLimit}
          onChange={(e) => setRunLimit(Number(e.target.value))}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-300 focus:outline-none"
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              Last {n}
            </option>
          ))}
        </select>
      </div>

      {recentLoading && (
        <div className="flex items-center gap-2 text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading runs…
        </div>
      )}

      {recentErr && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm">
          {recentErr.message}
        </div>
      )}

      {!recentLoading && !recentErr && runs.length === 0 && (
        <p className="text-zinc-600 text-sm py-8 text-center">No runs yet.</p>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60">
                {["Status", "Agent", "Customer", "Pipeline", "Origin", "Duration", "Note", ""].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr
                  key={r.id}
                  className={cn(
                    "border-b border-zinc-800/50 hover:bg-zinc-900/40 transition-colors",
                    i % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900/20",
                  )}
                >
                  <td className="px-4 py-2.5 whitespace-nowrap">{statusChip(r.status)}</td>
                  <td className="px-4 py-2.5 text-zinc-300 whitespace-nowrap">
                    {r.sales_agent || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">
                    {r.customer || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap max-w-[180px] truncate">
                    {r.pipeline_name}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "text-xs px-1.5 py-0.5 rounded font-mono",
                        r.run_origin === "webhook"
                          ? "bg-blue-900/40 text-blue-300"
                          : "bg-zinc-800 text-zinc-400",
                      )}
                    >
                      {r.run_origin || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 font-mono text-xs whitespace-nowrap">
                    {durationStr(r)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {r.review_required && !r.review_status && (
                      <span className="text-xs text-yellow-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        review
                      </span>
                    )}
                    {r.note_sent && (
                      <span className="text-xs text-green-500 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        sent
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => {
                        localStorage.setItem("shinobi.pipeline.open_run", r.id);
                        router.push("/pipeline");
                      }}
                      className="text-blue-500 hover:text-blue-300 transition-colors"
                      title="Open in Pipeline Canvas"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
