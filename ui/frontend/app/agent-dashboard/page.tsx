"use client";
import { useState, useEffect, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import { BarChart3, ChevronRight, Loader2, Search, BarChart2, Brain, CheckCircle2, AlertTriangle, RefreshCw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

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

// ── Roll-up dashboard components ─────────────────────────────────────────────

function RiskBadge({ risk }: { risk?: string }) {
  const color =
    risk === "High"   ? "bg-red-900/60 text-red-300 border-red-700" :
    risk === "Medium" ? "bg-amber-900/60 text-amber-300 border-amber-700" :
    risk === "Low"    ? "bg-emerald-900/60 text-emerald-300 border-emerald-700" :
                        "bg-gray-800 text-gray-400 border-gray-700";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${color}`}>
      {risk ?? "—"} Risk
    </span>
  );
}

function RollupDashboard({ data, customer, persona, onRerun, running }: {
  data: any; customer: string; persona: string;
  onRerun: () => void; running: boolean;
}) {
  const procs: { name: string; compliant: number; violations: number }[] =
    data?.compliance_aggregate?.procedures ?? [];

  const savedAt: string | undefined = data?._saved_at;
  const fmtSavedAt = savedAt
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(savedAt + "Z"))
    : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <RiskBadge risk={data?.overall_risk} />
        <p className="flex-1 text-sm text-gray-300 leading-snug min-w-0">{data?.summary ?? ""}</p>
        <div className="flex items-center gap-2 shrink-0">
          {fmtSavedAt && (
            <span className="flex items-center gap-1 text-[10px] text-gray-600">
              <Clock className="w-3 h-3" />{fmtSavedAt}
            </span>
          )}
          <button onClick={onRerun} disabled={running}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-300 disabled:opacity-50 transition-colors">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Re-run
          </button>
        </div>
      </div>

      {/* Compliance table */}
      {procs.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Compliance Aggregate</p>
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60 text-left">
                  <th className="px-3 py-2 font-medium text-gray-400">Procedure</th>
                  <th className="px-3 py-2 font-medium text-emerald-500 w-20 text-right">OK</th>
                  <th className="px-3 py-2 font-medium text-red-400 w-20 text-right">Viol.</th>
                  <th className="px-3 py-2 w-28">Rate</th>
                </tr>
              </thead>
              <tbody>
                {procs.map((p, i) => {
                  const total = p.compliant + p.violations;
                  const violPct = total > 0 ? (p.violations / total) * 100 : 0;
                  const isViolated = p.violations > 0;
                  return (
                    <tr key={i} className={cn("border-b border-gray-800/50 last:border-0", isViolated && "bg-red-950/10")}>
                      <td className={cn("px-3 py-2", isViolated ? "text-red-300" : "text-gray-300")}>{p.name}</td>
                      <td className="px-3 py-2 text-right text-emerald-400 font-mono">{p.compliant}</td>
                      <td className="px-3 py-2 text-right text-red-400 font-mono">{p.violations}</td>
                      <td className="px-3 py-2">
                        <div className="h-2 bg-gray-800 rounded-sm overflow-hidden">
                          <div className="h-full bg-red-600 rounded-sm" style={{ width: `${violPct}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {(data?.compliance_aggregate?.total_violations != null) && (
                <tfoot>
                  <tr className="bg-gray-900/40 border-t border-gray-700">
                    <td className="px-3 py-2 text-[10px] text-gray-500 font-semibold uppercase">Total</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-400">
                      {(data.compliance_aggregate.total_checks ?? 0) - (data.compliance_aggregate.total_violations ?? 0)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-red-400 font-semibold">
                      {data.compliance_aggregate.total_violations}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Key Patterns + Next Steps — side by side */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {(data?.key_patterns ?? []).length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Key Patterns</p>
            <ul className="space-y-1.5">
              {data.key_patterns.map((p: string, i: number) => (
                <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                  <AlertTriangle className="w-3 h-3 mt-0.5 text-amber-500 shrink-0" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(data?.next_steps ?? []).length > 0 && (
          <div>
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Next Steps</p>
            <ol className="space-y-1.5">
              {data.next_steps.map((s: string, i: number) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="shrink-0 w-4 h-4 rounded-full bg-indigo-700 text-white text-[9px] font-bold flex items-center justify-center mt-0.5">{i + 1}</span>
                  <span className={cn("text-gray-300", i === 0 && "font-medium text-white")}>{s}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* Call Progression */}
      {(data?.call_progression ?? []).length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Call Progression</p>
          <div className="space-y-0.5">
            {data.call_progression.map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs text-gray-400 py-1.5 border-b border-gray-800/40 last:border-0">
                <span className="font-mono text-gray-600 w-20 shrink-0 truncate">{c.call_id}</span>
                <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />
                <span className="text-indigo-400 shrink-0 truncate max-w-[120px]">{c.stage}</span>
                <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />
                <span className="text-gray-300 truncate">{c.outcome}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fallback: raw text if JSON parse failed */}
      {data?._raw_text && (
        <pre className="text-xs text-gray-400 whitespace-pre-wrap font-mono bg-gray-950 rounded p-3 max-h-80 overflow-y-auto">{data._raw_text}</pre>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function _dss(k: string) { try { return sessionStorage.getItem(`dash_${k}`) ?? ""; } catch { return ""; } }
function _dssSet(k: string, v: string) { try { sessionStorage.setItem(`dash_${k}`, v); } catch {} }

export default function AgentDashboardPage() {
  // Start from safe defaults; restored from sessionStorage post-mount
  const [selected, _setSelected] = useState<string | null>(null);
  const [agentSearch, _setAgentSearch] = useState("");

  const setSelected    = (v: string | null) => { _setSelected(v);    _dssSet("selected",    v ?? ""); };
  const setAgentSearch = (v: string)        => { _setAgentSearch(v); _dssSet("agentSearch", v); };

  useEffect(() => {
    _setSelected(_dss("selected") || null);
    _setAgentSearch(_dss("agentSearch"));
  }, []);

  const { data: agents, isLoading } = useSWR<any[]>(`${API}/agent-stats`, fetcher);
  const { data: detail } = useSWR<any>(
    selected ? `${API}/agent-stats/${encodeURIComponent(selected)}` : null,
    fetcher
  );

  // Fetch customers who have notes for the selected agent
  const { data: agentNotes } = useSWR<any[]>(
    selected ? `${API}/notes?agent=${encodeURIComponent(selected)}` : null,
    fetcher
  );
  const noteCustomers: string[] = agentNotes
    ? [...new Set(agentNotes.map((n: any) => n.customer as string))].sort()
    : [];

  // Fetch saved notes-agent presets (used as "personas" for the roll-up)
  const { data: notesPersonas } = useSWR<any[]>(`${API}/notes/agents`, fetcher);

  const { mutate } = useSWRConfig();

  // Roll-up state
  const [rollupCustomer, setRollupCustomer] = useState("");
  const [rollupPersona, setRollupPersona]   = useState(""); // name of selected notes agent preset
  const [rollupRunning, setRollupRunning]   = useState(false);
  const [rollupResult, setRollupResult]     = useState<any>(null);
  const [rollupError, setRollupError]       = useState<string | null>(null);
  const [rollupThinking, setRollupThinking] = useState("");
  const rollupThinkScroll = useRef<HTMLDivElement>(null);
  const rollupAbort = useRef(false);

  // Persisted rollup (null = 404 not yet run; object = saved result)
  const savedRollupKey = selected && rollupCustomer
    ? `${API}/notes/rollup?agent=${encodeURIComponent(selected)}&customer=${encodeURIComponent(rollupCustomer)}`
    : null;
  const { data: savedRollup, isLoading: savedRollupLoading } = useSWR<any>(
    savedRollupKey,
    (url: string) => fetch(url).then(r => r.status === 404 ? null : r.json()),
    { revalidateOnFocus: false }
  );
  useEffect(() => {
    if (rollupThinkScroll.current) rollupThinkScroll.current.scrollTop = rollupThinkScroll.current.scrollHeight;
  }, [rollupThinking]);

  // Auto-select defaults when agent changes
  useEffect(() => {
    setRollupCustomer("");
    setRollupResult(null);
    setRollupError(null);
    setRollupThinking("");
  }, [selected]);

  // Auto-select first customer when list loads
  useEffect(() => {
    if (noteCustomers.length > 0 && !rollupCustomer) {
      setRollupCustomer(noteCustomers[0]);
    }
  }, [noteCustomers.join(",")]);

  // Auto-select default persona when presets load
  useEffect(() => {
    if (notesPersonas && notesPersonas.length > 0 && !rollupPersona) {
      const def = notesPersonas.find((p: any) => p.is_default) ?? notesPersonas[0];
      setRollupPersona(def.name);
    }
  }, [notesPersonas]);

  // Auto-run whenever customer / persona changes — but only if no saved result exists
  useEffect(() => {
    if (!selected || !rollupCustomer || !rollupPersona) return;
    if (savedRollupLoading) return;   // wait for cache check to complete
    if (savedRollup) return;          // already have a persisted result — display it
    triggerRollup(selected, rollupCustomer, "gemini-2.5-flash");
  }, [rollupCustomer, rollupPersona, savedRollupLoading]);

  const triggerRollup = async (agent: string, customer: string, model: string) => {
    rollupAbort.current = false;
    setRollupRunning(true);
    setRollupResult(null);
    setRollupError(null);
    setRollupThinking("");
    try {
      const r = await fetch(`${API}/notes/rollup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, customer, model, temperature: 0 }),
      });
      if (!r.ok || !r.body) throw new Error(await r.text());
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (rollupAbort.current) { reader.cancel(); break; }
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const evLine   = part.split("\n").find(l => l.startsWith("event:"));
          const dataLine = part.split("\n").find(l => l.startsWith("data:"));
          if (!dataLine) continue;
          const event = evLine?.replace("event:", "").trim() ?? "message";
          try {
            const data = JSON.parse(dataLine.replace("data:", "").trim());
            if (event === "thinking") setRollupThinking(prev => prev + data.text);
            else if (event === "done") {
              setRollupResult(data.result_json);
              if (data.result_json && savedRollupKey) {
                mutate(savedRollupKey, data.result_json, { revalidate: false });
              }
            }
            else if (event === "error") setRollupError(data.msg ?? "Roll-up failed");
          } catch {}
        }
      }
    } catch (e: any) {
      if (!rollupAbort.current) setRollupError(e.message ?? "Roll-up failed");
    } finally {
      setRollupRunning(false);
    }
  };

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

            {/* Notes Roll-up */}
            {noteCustomers.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
                  <BarChart2 className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                  <span className="text-xs font-semibold text-gray-300">Notes Roll-up Analysis</span>
                  {rollupRunning && <Loader2 className="w-3 h-3 animate-spin text-teal-400 ml-1" />}
                </div>

                <div className="p-4 space-y-3">
                  {/* Two selectors — customer + persona */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wide">Customer</p>
                      <select
                        value={rollupCustomer}
                        onChange={e => setRollupCustomer(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300"
                      >
                        {noteCustomers.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wide">Notes Persona</p>
                      <select
                        value={rollupPersona}
                        onChange={e => setRollupPersona(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300"
                      >
                        {!notesPersonas?.length && <option value="">— no presets saved —</option>}
                        {(notesPersonas ?? []).map((p: any) => (
                          <option key={p.name} value={p.name}>{p.name}{p.is_default ? " ★" : ""}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Running indicator */}
                  {rollupRunning && (
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      <span>Analysing notes for {rollupCustomer}…</span>
                    </div>
                  )}

                  {/* Thinking stream */}
                  {rollupRunning && rollupThinking && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide flex items-center gap-1">
                        <Brain className="w-2.5 h-2.5" /> Reasoning
                      </p>
                      <div ref={rollupThinkScroll}
                        className="bg-gray-950 border border-purple-900/30 rounded p-2 max-h-24 overflow-y-auto font-mono text-[10px] text-purple-300/70 whitespace-pre-wrap leading-relaxed">
                        {rollupThinking}
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {rollupError && (
                    <div className="p-2 bg-red-950/30 border border-red-800/40 rounded text-xs text-red-400">{rollupError}</div>
                  )}

                  {/* Saved result loading */}
                  {savedRollupLoading && !rollupRunning && (
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      <span>Loading saved analysis…</span>
                    </div>
                  )}

                  {/* Result — live or persisted */}
                  {(rollupResult ?? savedRollup) && (
                    <div className="border border-gray-700/50 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-gray-800 border-b border-gray-700/50 flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-teal-400" />
                        <span className="text-xs font-semibold text-teal-300">{rollupCustomer}</span>
                        <span className="text-[10px] text-gray-600 ml-1">via {rollupPersona}</span>
                      </div>
                      <div className="p-4 max-h-[600px] overflow-y-auto">
                        <RollupDashboard
                          data={rollupResult ?? savedRollup}
                          customer={rollupCustomer}
                          persona={rollupPersona}
                          running={rollupRunning}
                          onRerun={() => {
                            triggerRollup(selected!, rollupCustomer, "gemini-2.5-flash");
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
