"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  BarChart3,
  Filter,
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppCtx } from "@/lib/app-context";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
  return r.json();
};

type PipelineRunMeta = {
  id: string;
  pipeline_name: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
};

type AnalyticsRow = {
  metric_type: "score" | "violation";
  metric_key: string;
  metric_value: number;
  run_id: string;
  run_started_at: string;
  run_finished_at: string | null;
  run_status: string;
  step_index: number;
  step_done: boolean;
  step_state: string;
  step_agent_id: string;
  step_agent_name: string;
  step_model: string;
  step_sub_type: string;
};

type PipelineAnalytics = {
  pipeline_id: string;
  pipeline_name: string;
  sales_agent: string;
  customer: string;
  selected_run_id: string;
  runs: PipelineRunMeta[];
  rows: AnalyticsRow[];
  score_by_section: Array<{ section: string; average: number; count: number }>;
  violation_by_type: Array<{ type: string; total: number }>;
};

type AgentStats = {
  agent: string;
  total_calls: number;
  unique_customers: number;
  net_deposits: number;
  total_deposits: number;
  total_withdrawals: number;
  avg_call_duration_s: number;
};

function fmtVmDateTime(value?: string | null) {
  if (!value) return "—";
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  try {
    return new Date(s).toISOString().slice(0, 19).replace("T", " ");
  } catch {
    return s;
  }
}

function fmtCurrency(n?: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function StatCard({
  label,
  value,
  tone = "text-white",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={cn("text-lg font-semibold", tone)}>{value}</p>
    </div>
  );
}

export default function AgentDashboardPage() {
  const {
    salesAgent,
    customer,
    activePipelineId,
    activePipelineName,
  } = useAppCtx();

  const hasContext = !!(salesAgent && customer && activePipelineId);

  const { data: stats } = useSWR<AgentStats>(
    salesAgent ? `/api/agent-stats/${encodeURIComponent(salesAgent)}` : null,
    fetcher,
  );

  const analyticsUrl = hasContext
    ? `/api/pipelines/${encodeURIComponent(activePipelineId)}/analytics?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&limit=120`
    : null;
  const { data: analytics, isLoading, error, mutate } = useSWR<PipelineAnalytics>(
    analyticsUrl,
    fetcher,
    { revalidateOnFocus: false },
  );

  const [selectedRunId, setSelectedRunId] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [scoreSection, setScoreSection] = useState("all");
  const [violationType, setViolationType] = useState("all");
  const [sortBy, setSortBy] = useState<"metric_asc" | "metric_desc" | "value_desc" | "value_asc" | "recent_desc" | "recent_asc">("value_desc");

  useEffect(() => {
    if (!analytics?.runs?.length) {
      setSelectedRunId("all");
      return;
    }
    if (selectedRunId === "all") {
      setSelectedRunId(analytics.runs[0].id);
      return;
    }
    if (!analytics.runs.some(r => r.id === selectedRunId)) {
      setSelectedRunId(analytics.runs[0].id);
    }
  }, [analytics?.runs, selectedRunId]);

  const rows = analytics?.rows ?? [];
  const scoreSections = useMemo(
    () => [...new Set(rows.filter(r => r.metric_type === "score").map(r => r.metric_key))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const violationTypes = useMemo(
    () => [...new Set(rows.filter(r => r.metric_type === "violation").map(r => r.metric_key))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const filteredRows = useMemo(() => {
    return rows.filter(r => {
      if (selectedRunId !== "all" && r.run_id !== selectedRunId) return false;
      const d = (r.run_started_at || "").slice(0, 10);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      if (scoreSection !== "all" && r.metric_type === "score" && r.metric_key !== scoreSection) return false;
      if (violationType !== "all" && r.metric_type === "violation" && r.metric_key !== violationType) return false;
      return true;
    });
  }, [rows, selectedRunId, dateFrom, dateTo, scoreSection, violationType]);

  const tableRows = useMemo(() => {
    const map = new Map<string, {
      metric_type: "score" | "violation";
      metric_key: string;
      values: number[];
      runIds: Set<string>;
      latestAt: string;
    }>();

    for (const r of filteredRows) {
      const key = `${r.metric_type}::${r.metric_key}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          metric_type: r.metric_type,
          metric_key: r.metric_key,
          values: [Number(r.metric_value || 0)],
          runIds: new Set([r.run_id]),
          latestAt: r.run_started_at || "",
        });
      } else {
        existing.values.push(Number(r.metric_value || 0));
        existing.runIds.add(r.run_id);
        if ((r.run_started_at || "") > existing.latestAt) existing.latestAt = r.run_started_at || "";
      }
    }

    const out = [...map.values()].map(g => {
      const total = g.values.reduce((a, b) => a + b, 0);
      const avg = g.values.length ? total / g.values.length : 0;
      return {
        metric_type: g.metric_type,
        metric_key: g.metric_key,
        value: g.metric_type === "score" ? avg : total,
        samples: g.values.length,
        runs: g.runIds.size,
        latestAt: g.latestAt,
      };
    });

    out.sort((a, b) => {
      if (sortBy === "metric_asc") return a.metric_key.localeCompare(b.metric_key);
      if (sortBy === "metric_desc") return b.metric_key.localeCompare(a.metric_key);
      if (sortBy === "value_asc") return a.value - b.value;
      if (sortBy === "value_desc") return b.value - a.value;
      if (sortBy === "recent_asc") return a.latestAt.localeCompare(b.latestAt);
      return b.latestAt.localeCompare(a.latestAt);
    });
    return out;
  }, [filteredRows, sortBy]);

  const scoreRows = tableRows.filter(r => r.metric_type === "score");
  const violationRows = tableRows.filter(r => r.metric_type === "violation");
  const overallAvgScore = scoreRows.length
    ? scoreRows.reduce((s, r) => s + r.value, 0) / scoreRows.length
    : 0;
  const totalViolations = violationRows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-bold text-white">Agent Dashboard</h1>
        <p className="text-xs text-gray-500 mt-0.5">Pipeline metrics from selected context</p>
      </div>

      {!hasContext && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-500">
          <BarChart3 className="w-6 h-6 mx-auto mb-2 text-gray-700" />
          Select `Sales Agent` + `Customer` + `Pipeline` in the top context bar.
        </div>
      )}

      {hasContext && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Agent" value={salesAgent} />
            <StatCard label="Customer" value={customer} />
            <StatCard label="Pipeline" value={activePipelineName || "Selected"} />
            <StatCard
              label="Net Deposits"
              value={fmtCurrency(stats?.net_deposits)}
              tone={(stats?.net_deposits || 0) >= 0 ? "text-emerald-400" : "text-red-400"}
            />
            <StatCard label="Total Calls" value={String(stats?.total_calls ?? "—")} />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Filter className="w-3.5 h-3.5" />
                Metrics Filters
              </div>
              <button
                onClick={() => mutate()}
                className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
              <label className="text-[10px] text-gray-500 space-y-1">
                <span className="block uppercase tracking-wide">Run</span>
                <select
                  value={selectedRunId}
                  onChange={e => setSelectedRunId(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                >
                  <option value="all">All Runs</option>
                  {(analytics?.runs ?? []).map(r => (
                    <option key={r.id} value={r.id}>
                      {fmtVmDateTime(r.started_at)} · {r.id.slice(0, 8)} · {r.status}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-[10px] text-gray-500 space-y-1">
                <span className="block uppercase tracking-wide">Date From</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                />
              </label>

              <label className="text-[10px] text-gray-500 space-y-1">
                <span className="block uppercase tracking-wide">Date To</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                />
              </label>

              <label className="text-[10px] text-gray-500 space-y-1">
                <span className="block uppercase tracking-wide">Score Section</span>
                <select
                  value={scoreSection}
                  onChange={e => setScoreSection(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                >
                  <option value="all">All Sections</option>
                  {scoreSections.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <label className="text-[10px] text-gray-500 space-y-1">
                <span className="block uppercase tracking-wide">Violation Type</span>
                <select
                  value={violationType}
                  onChange={e => setViolationType(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                >
                  <option value="all">All Violations</option>
                  {violationTypes.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>

              <label className="text-[10px] text-gray-500 space-y-1">
                <span className="block uppercase tracking-wide">Sort</span>
                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value as typeof sortBy)}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300"
                >
                  <option value="value_desc">Value high → low</option>
                  <option value="value_asc">Value low → high</option>
                  <option value="metric_asc">Metric A → Z</option>
                  <option value="metric_desc">Metric Z → A</option>
                  <option value="recent_desc">Latest run first</option>
                  <option value="recent_asc">Oldest run first</option>
                </select>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <StatCard label="Score Sections" value={String(scoreRows.length)} tone="text-indigo-300" />
            <StatCard label="Avg Score (sections)" value={scoreRows.length ? `${overallAvgScore.toFixed(1)}` : "—"} tone="text-emerald-300" />
            <StatCard label="Violation Types" value={String(violationRows.length)} tone="text-amber-300" />
            <StatCard label="Total Violations" value={String(totalViolations)} tone="text-red-300" />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Scores & Violations Table</p>
            </div>

            {isLoading && (
              <div className="py-8 flex items-center justify-center text-gray-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading metrics…
              </div>
            )}

            {error && !isLoading && (
              <div className="py-8 px-4 text-sm text-red-400 flex items-center justify-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                Failed to load pipeline analytics.
              </div>
            )}

            {!isLoading && !error && tableRows.length === 0 && (
              <div className="py-8 px-4 text-sm text-gray-500 text-center">
                No score/violation metrics found for this filter selection.
              </div>
            )}

            {!isLoading && !error && tableRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-950/70 border-b border-gray-800 text-gray-500">
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Metric</th>
                      <th className="px-3 py-2 text-right font-medium">Value</th>
                      <th className="px-3 py-2 text-right font-medium">Samples</th>
                      <th className="px-3 py-2 text-right font-medium">Runs</th>
                      <th className="px-3 py-2 text-left font-medium">Latest Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((r) => (
                      <tr key={`${r.metric_type}:${r.metric_key}`} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                        <td className="px-3 py-2">
                          <span className={cn(
                            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px]",
                            r.metric_type === "score"
                              ? "bg-indigo-900/30 border-indigo-700/50 text-indigo-300"
                              : "bg-red-900/20 border-red-700/50 text-red-300",
                          )}>
                            {r.metric_type === "score" ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                            {r.metric_type}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-200">{r.metric_key}</td>
                        <td className={cn(
                          "px-3 py-2 text-right font-mono",
                          r.metric_type === "score" ? "text-emerald-400" : "text-red-400",
                        )}>
                          {r.metric_type === "score" ? r.value.toFixed(1) : Math.round(r.value)}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-400 font-mono">{r.samples}</td>
                        <td className="px-3 py-2 text-right text-gray-400 font-mono">{r.runs}</td>
                        <td className="px-3 py-2 text-gray-500">{fmtVmDateTime(r.latestAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

