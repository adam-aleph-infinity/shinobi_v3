"use client";
import { useState } from "react";
import useSWR from "swr";
import { Users, Phone, Clock, DollarSign, BarChart3, ChevronRight, Loader2, Search } from "lucide-react";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

function fmt(n: number | null, prefix = "") {
  if (n == null) return "—";
  return prefix + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}
function fmtMoney(n: number | null) {
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}
function fmtDur(s: number) {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  return `${m}m`;
}

function StatCard({ label, value, sub, color = "text-white" }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function TopicBar({ label, count, max }: { label: string; count: number; max: number }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-44 text-gray-400 truncate shrink-0">{label}</span>
      <div className="flex-1 h-2.5 bg-gray-800 rounded-sm overflow-hidden">
        <div className="h-full bg-indigo-600 rounded-sm transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-gray-500 w-5 text-right shrink-0">{count}</span>
    </div>
  );
}

function _dss(k: string) { try { return sessionStorage.getItem(`dash_${k}`) ?? ""; } catch { return ""; } }
function _dssSet(k: string, v: string) { try { sessionStorage.setItem(`dash_${k}`, v); } catch {} }

export default function AgentDashboardPage() {
  const [selected, _setSelected] = useState<string | null>(() => _dss("selected") || null);
  const [agentSearch, _setAgentSearch] = useState(() => _dss("agentSearch"));

  const setSelected    = (v: string | null) => { _setSelected(v);    _dssSet("selected",    v ?? ""); };
  const setAgentSearch = (v: string)        => { _setAgentSearch(v); _dssSet("agentSearch", v); };

  const { data: agents, isLoading } = useSWR<any[]>(`${API}/agent-stats`, fetcher);
  const { data: detail } = useSWR<any>(
    selected ? `${API}/agent-stats/${encodeURIComponent(selected)}` : null,
    fetcher
  );

  const maxDeposits = Math.max(...(agents ?? []).map((a: any) => a.net_deposits || 0), 1);
  const filteredAgents = (agents ?? []).filter((a: any) =>
    !agentSearch || a.agent.toLowerCase().includes(agentSearch.toLowerCase())
  );

  return (
    <div className="flex gap-6 h-[calc(100vh-3rem)] overflow-hidden">
      {/* ── Agent list ── */}
      <div className="w-72 shrink-0 flex flex-col">
        <div className="mb-3">
          <h1 className="text-base font-bold text-white">Agent Dashboard</h1>
          <p className="text-xs text-gray-500 mt-0.5">Performance summary across all CRMs</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col flex-1 min-h-0">
          <div className="px-3 py-2 border-b border-gray-800">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
              <input
                type="text"
                value={agentSearch}
                onChange={e => setAgentSearch(e.target.value)}
                placeholder="Search agents…"
                className="w-full pl-8 pr-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div className="px-4 py-2 border-b border-gray-800 text-xs text-gray-500 grid grid-cols-[1fr_auto_auto] gap-2">
            <span>Agent</span>
            <span className="text-right">Calls</span>
            <span className="text-right">Net Dep.</span>
          </div>
          <div className="overflow-y-auto flex-1">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
              </div>
            )}
            {filteredAgents.map((a: any) => (
              <button
                key={a.agent}
                onClick={() => setSelected(a.agent)}
                className={`w-full text-left px-4 py-2.5 border-b border-gray-800/50 last:border-0 hover:bg-gray-800/40 transition-colors ${selected === a.agent ? "bg-indigo-900/20 border-l-2 border-l-indigo-500" : ""}`}
              >
                <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                  <span className="text-xs font-medium text-white truncate">{a.agent}</span>
                  <span className="text-xs text-gray-400">{fmt(a.total_calls)}</span>
                  <span className={`text-xs font-mono ${(a.net_deposits || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {a.net_deposits != null ? `$${Math.round((a.net_deposits || 0) / 1000)}k` : "—"}
                  </span>
                </div>
                {/* Deposit bar */}
                <div className="mt-1.5 h-1 bg-gray-800 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-emerald-700/60 rounded-sm"
                    style={{ width: `${Math.max(((a.net_deposits || 0) / maxDeposits) * 100, 0)}%` }}
                  />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Detail panel ── */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {!selected && (
          <div className="flex flex-col items-center justify-center h-full text-gray-600">
            <BarChart3 className="w-8 h-8 mb-2" />
            <p className="text-sm">Select an agent to see details</p>
          </div>
        )}
        {selected && !detail && (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
          </div>
        )}
        {detail && !detail.not_found && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-bold text-white">{detail.agent}</h2>
              <p className="text-xs text-gray-500 mt-0.5">Full performance summary</p>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total Calls" value={fmt(detail.total_calls)} />
              <StatCard label="Customers" value={fmt(detail.unique_customers)} />
              <StatCard
                label="Avg Call (2m+)"
                value={fmtDur(detail.avg_call_duration_s)}
                sub={`${detail.avg_call_duration_s}s`}
              />
              <StatCard
                label="Net Deposits"
                value={fmtMoney(detail.net_deposits)}
                color={(detail.net_deposits || 0) >= 0 ? "text-emerald-400" : "text-red-400"}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total Deposits" value={fmtMoney(detail.total_deposits)} color="text-emerald-400" />
              <StatCard label="Total Withdrawals" value={fmtMoney(detail.total_withdrawals)} color="text-red-400" />
              <StatCard label="Session Analyses" value={fmt(detail.session_analysis_count)} />
              <StatCard
                label="Avg Session Score"
                value={detail.avg_score ? `${detail.avg_score}%` : "—"}
                color={detail.avg_score >= 75 ? "text-emerald-400" : detail.avg_score >= 50 ? "text-amber-400" : "text-red-400"}
              />
            </div>

            {/* Topic frequency */}
            {detail.topic_counts && Object.keys(detail.topic_counts).length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Session Analysis Topics
                </h3>
                <div className="space-y-2">
                  {(() => {
                    const entries = Object.entries(detail.topic_counts) as [string, number][];
                    const maxVal = Math.max(...entries.map(([, v]) => v), 1);
                    return entries.map(([topic, count]) => (
                      <TopicBar key={topic} label={topic} count={count} max={maxVal} />
                    ));
                  })()}
                </div>
              </div>
            )}

            {/* Top improvements */}
            {detail.top_improvements?.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  Top Improvement Areas
                </h3>
                <ul className="space-y-1.5">
                  {detail.top_improvements.map((item: string, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                      <ChevronRight className="w-3 h-3 mt-0.5 text-amber-500 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
