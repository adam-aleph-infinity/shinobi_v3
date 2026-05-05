"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { cn } from "@/lib/utils";
import { formatLocalDate } from "@/lib/time";
import {
  AlertTriangle,
  BarChart3,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Minus,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type TaxonomyGroup = {
  id: string;
  label: string;
  color: string;
  sections: string[];
  artifact_types: string[];
  agent_names: string[];
};

type TaxonomyConfig = {
  pipeline_id: string;
  groups: TaxonomyGroup[];
  unclustered_sections: string[];
  total_agents_analyzed: number;
};

type CallArtifactItem = {
  call_id: string;
  run_id: string;
  run_status: string;
  run_started_at: string;
  result_id: string;
  artifact_type: string;
  step_idx: number;
  agent_name: string;
  content: string;
};

type CallArtifactRow = {
  call_id: string;
  date: string;
  duration_s: number;
  artifacts: CallArtifactItem[];
};

// ── Score extraction ──────────────────────────────────────────────────────────

function extractScoreSections(content: string): Record<string, number> {
  const txt = (content || "").trim();
  if (!txt) return {};

  const fromObj = (obj: Record<string, unknown>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("_")) continue;
      let score: number | null = null;
      if (typeof v === "number") score = v;
      else if (v && typeof v === "object" && "score" in v) score = Number((v as Record<string, unknown>).score);
      if (score !== null && !isNaN(score)) out[k] = Math.min(100, Math.max(0, score));
    }
    return out;
  };

  try {
    const obj = JSON.parse(txt) as Record<string, unknown>;
    const got = fromObj(obj);
    if (Object.keys(got).length) return got;
  } catch {}

  try {
    const m = txt.match(/\{[\s\S]+\}/);
    if (m) {
      const obj = JSON.parse(m[0]) as Record<string, unknown>;
      const got = fromObj(obj);
      if (Object.keys(got).length) return got;
    }
  } catch {}

  // Markdown pattern: "## Section Name\nScore: 85/100"
  const out: Record<string, number> = {};
  const scoreLines = txt.matchAll(/^(?:#{1,3}\s+)?(.+?)\s*\n.*?[Ss]core[:\s]+(\d+)/gm);
  for (const m of scoreLines) {
    const key = m[1].replace(/^#+\s*/, "").trim();
    const val = parseInt(m[2], 10);
    if (key && !isNaN(val)) out[key] = Math.min(100, Math.max(0, val));
  }
  return out;
}

function extractViolations(content: string): string[] {
  const txt = (content || "").trim();
  if (!txt) return [];
  try {
    const obj = JSON.parse(txt) as Record<string, unknown>;
    const v = obj._violations;
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
  } catch {}
  return [];
}

// ── Aggregation ───────────────────────────────────────────────────────────────

type GroupStats = {
  avg: number | null;
  trend: number | null;
  call_count: number;
  scored_count: number;
  violation_count: number;
  call_scores: Array<{ call_id: string; date: string; score: number | null; violations: number }>;
};

function computeGroupStats(
  group: TaxonomyGroup,
  callRows: CallArtifactRow[],
): GroupStats {
  const sectionSet = new Set(group.sections.map((s) => s.toLowerCase()));

  const callScores: GroupStats["call_scores"] = [];
  let totalViolations = 0;

  for (const row of callRows) {
    const relArtifacts = row.artifacts.filter((a) =>
      group.artifact_types.length === 0 || group.artifact_types.includes(a.artifact_type),
    );

    let callScore: number | null = null;
    let callViolations = 0;

    for (const artifact of relArtifacts) {
      const secs = extractScoreSections(artifact.content);
      const matched = Object.entries(secs).filter(([k]) => {
        const kl = k.toLowerCase();
        return sectionSet.size === 0 || Array.from(sectionSet).some((s) => kl.includes(s) || s.includes(kl));
      });
      if (matched.length) {
        const avg = matched.reduce((s, [, v]) => s + v, 0) / matched.length;
        callScore = callScore === null ? avg : (callScore + avg) / 2;
      }
      const viols = extractViolations(artifact.content);
      callViolations += viols.length;
    }
    totalViolations += callViolations;
    callScores.push({ call_id: row.call_id, date: row.date, score: callScore, violations: callViolations });
  }

  const scored = callScores.filter((c) => c.score !== null);
  const avg = scored.length ? scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length : null;

  let trend: number | null = null;
  if (scored.length >= 2) {
    const recent = scored.slice(-3);
    const older = scored.slice(0, Math.max(1, scored.length - 3));
    const recentAvg = recent.reduce((s, c) => s + (c.score ?? 0), 0) / recent.length;
    const olderAvg = older.reduce((s, c) => s + (c.score ?? 0), 0) / older.length;
    trend = recentAvg - olderAvg;
  }

  return {
    avg: avg !== null ? Math.round(avg) : null,
    trend: trend !== null ? Math.round(trend) : null,
    call_count: callRows.length,
    scored_count: scored.length,
    violation_count: totalViolations,
    call_scores: callScores,
  };
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ scores, color }: { scores: Array<number | null>; color: string }) {
  const vals = scores.filter((s): s is number => s !== null);
  if (vals.length < 2) return null;

  const W = 80, H = 28, PAD = 2;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;

  const pts = vals.map((v, i) => {
    const x = PAD + (i / (vals.length - 1)) * (W - PAD * 2);
    const y = PAD + ((max - v) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const strokeColor = {
    red: "#f87171",
    green: "#4ade80",
    blue: "#60a5fa",
    purple: "#a78bfa",
    amber: "#fbbf24",
    gray: "#9ca3af",
  }[color] ?? "#9ca3af";

  return (
    <svg width={W} height={H} className="shrink-0 opacity-70">
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Color helpers ─────────────────────────────────────────────────────────────

const COLOR_CLASSES: Record<string, { card: string; badge: string; text: string; border: string }> = {
  red:    { card: "bg-red-950/40 border-red-800/50",    badge: "bg-red-900/60 text-red-200",    text: "text-red-300",    border: "border-red-700/50" },
  green:  { card: "bg-green-950/40 border-green-800/50", badge: "bg-green-900/60 text-green-200", text: "text-green-300",  border: "border-green-700/50" },
  blue:   { card: "bg-blue-950/40 border-blue-800/50",   badge: "bg-blue-900/60 text-blue-200",   text: "text-blue-300",   border: "border-blue-700/50" },
  purple: { card: "bg-purple-950/40 border-purple-800/50", badge: "bg-purple-900/60 text-purple-200", text: "text-purple-300", border: "border-purple-700/50" },
  amber:  { card: "bg-amber-950/40 border-amber-800/50", badge: "bg-amber-900/60 text-amber-200", text: "text-amber-300",  border: "border-amber-700/50" },
  gray:   { card: "bg-gray-800/40 border-gray-700/50",   badge: "bg-gray-700/60 text-gray-300",   text: "text-gray-400",   border: "border-gray-600/50" },
};
function cc(color: string) { return COLOR_CLASSES[color] ?? COLOR_CLASSES.gray; }

function scoreClass(score: number | null): string {
  if (score === null) return "text-gray-500";
  if (score >= 80) return "text-green-300";
  if (score >= 60) return "text-amber-300";
  return "text-red-300";
}

// ── Fetcher ───────────────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// ── Main component ────────────────────────────────────────────────────────────

type Props = {
  pipelineId: string;
  salesAgent: string;
  customer: string;
  callArtifactRows: CallArtifactRow[];
};

export default function TaxonomyInsightPanel({ pipelineId, salesAgent, customer, callArtifactRows }: Props) {
  const { data: taxonomy, isLoading } = useSWR<TaxonomyConfig>(
    pipelineId ? `/api/pipelines/${encodeURIComponent(pipelineId)}/taxonomy` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const groupStats = useMemo(() => {
    if (!taxonomy?.groups) return {};
    const out: Record<string, GroupStats> = {};
    for (const g of taxonomy.groups) {
      out[g.id] = computeGroupStats(g, callArtifactRows);
    }
    return out;
  }, [taxonomy, callArtifactRows]);

  const callCount = callArtifactRows.length;

  if (!pipelineId) return null;

  if (isLoading) {
    return (
      <div className="px-4 py-3 flex items-center gap-2 text-gray-500 text-xs border-b border-gray-800">
        <Loader2 className="w-3 h-3 animate-spin" />
        Discovering taxonomy…
      </div>
    );
  }

  if (!taxonomy?.groups?.length) {
    return (
      <div className="px-4 py-3 text-gray-600 text-xs border-b border-gray-800">
        No taxonomy sections found for this pipeline.
      </div>
    );
  }

  const groups = taxonomy.groups;

  return (
    <div className="border-b border-gray-800 bg-gray-900/50">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-800/60">
        <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
        <span className="text-[11px] font-semibold text-gray-300 uppercase tracking-wide">Insights</span>
        <span className="text-[10px] text-gray-600">
          {callCount} call{callCount !== 1 ? "s" : ""}
          {salesAgent && customer ? ` · ${salesAgent} → ${customer}` : ""}
        </span>
        {taxonomy.total_agents_analyzed > 0 && (
          <span className="ml-auto text-[10px] text-gray-600">
            {taxonomy.total_agents_analyzed} agent{taxonomy.total_agents_analyzed !== 1 ? "s" : ""} analyzed
          </span>
        )}
      </div>

      {/* Aggregated cards row */}
      <div className="flex gap-2 px-3 py-2.5 overflow-x-auto">
        {groups.map((group) => {
          const stats = groupStats[group.id];
          const c = cc(group.color);
          const sparkScores = stats?.call_scores.map((cs) => cs.score) ?? [];
          return (
            <div
              key={group.id}
              className={cn(
                "shrink-0 rounded-lg border p-3 min-w-[160px] max-w-[200px] flex flex-col gap-1.5",
                c.card,
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className={cn("text-[11px] font-semibold leading-tight", c.text)}>{group.label}</span>
                {group.id === "compliance" && stats && stats.violation_count > 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded border border-red-700/50 bg-red-900/40 px-1.5 py-0.5 text-[9px] font-bold text-red-300">
                    <ShieldAlert className="w-2.5 h-2.5" />
                    {stats.violation_count}
                  </span>
                )}
              </div>

              {stats && stats.avg !== null ? (
                <div className="flex items-end gap-1.5">
                  <span className={cn("text-2xl font-bold tabular-nums leading-none", scoreClass(stats.avg))}>
                    {stats.avg}
                  </span>
                  <span className="text-[10px] text-gray-500 mb-0.5">/100</span>
                  {stats.trend !== null && (
                    <span
                      className={cn(
                        "ml-auto flex items-center gap-0.5 text-[10px] font-medium mb-0.5",
                        stats.trend > 0 ? "text-green-400" : stats.trend < 0 ? "text-red-400" : "text-gray-500",
                      )}
                    >
                      {stats.trend > 0 ? (
                        <TrendingUp className="w-3 h-3" />
                      ) : stats.trend < 0 ? (
                        <TrendingDown className="w-3 h-3" />
                      ) : (
                        <Minus className="w-3 h-3" />
                      )}
                      {stats.trend > 0 ? "+" : ""}
                      {stats.trend}
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-[11px] text-gray-600 italic">No scores yet</span>
              )}

              {sparkScores.some((s) => s !== null) && (
                <Sparkline scores={sparkScores} color={group.color} />
              )}

              <div className="text-[10px] text-gray-600 mt-auto">
                {stats?.scored_count ?? 0}/{stats?.call_count ?? 0} calls scored
              </div>
            </div>
          );
        })}
      </div>

      {/* Per-call breakdown */}
      {callCount > 0 && (
        <details className="group" open>
          <summary className="px-3 py-1.5 flex items-center gap-1.5 cursor-pointer select-none list-none border-t border-gray-800/60 text-[11px] text-gray-500 hover:text-gray-300 transition-colors">
            <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
            Per-call breakdown
          </summary>
          <div className="divide-y divide-gray-800/50 max-h-64 overflow-y-auto">
            {callArtifactRows.map((row) => {
              const dateStr = row.date ? formatLocalDate(row.date) : "Unknown date";
              const rowGroupScores = groups.map((group) => {
                const stats = groupStats[group.id];
                const cs = stats?.call_scores.find((c) => c.call_id === row.call_id);
                return { group, score: cs?.score ?? null, violations: cs?.violations ?? 0 };
              });
              return (
                <div key={row.call_id} className="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[11px] text-gray-400 font-mono shrink-0">{dateStr}</span>
                  <span className="text-[10px] text-gray-600 font-mono shrink-0">#{row.call_id}</span>
                  <div className="flex flex-wrap gap-1.5 ml-auto">
                    {rowGroupScores.map(({ group, score, violations }) => {
                      const c = cc(group.color);
                      return (
                        <span
                          key={group.id}
                          className={cn(
                            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
                            c.border,
                            score !== null ? c.badge : "bg-gray-800/40 text-gray-600 border-gray-700/40",
                          )}
                          title={group.label}
                        >
                          <span className={cn("text-[9px] uppercase tracking-wide", c.text)}>
                            {group.label.split(" ")[0]}
                          </span>
                          {score !== null ? (
                            <span className={scoreClass(score)}>{score}</span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                          {group.id === "compliance" && violations > 0 && (
                            <AlertTriangle className="w-2.5 h-2.5 text-red-400" />
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
