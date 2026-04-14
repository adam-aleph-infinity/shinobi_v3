"use client";
import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BarChart3, ChevronRight, Loader2, Search, BarChart2, Brain, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

const ALL_MODELS = [
  "gpt-5.4", "gpt-4.1", "gpt-4.1-mini",
  "claude-opus-4-6", "claude-sonnet-4-6",
  "gemini-2.5-pro", "gemini-2.5-flash",
  "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
];

const DEFAULT_ROLLUP_SYSTEM = `You are a senior compliance analyst reviewing a complete series of call notes for a single agent-customer relationship.

Produce a comprehensive roll-up report with EXACTLY these sections (each preceded by ##):

## Compliance Aggregate
For each compliance procedure, show totals across ALL calls:
- Format each line: "<Procedure Name>: X compliant, Y violations (Z% violation rate)"
- Final line: "TOTAL: X violations across Y procedure checks"

## Call Progression Summary
A concise timeline of how the relationship evolved across calls: key milestones, stages reached, current status, outcomes.

## Key Patterns & Persistent Issues
Recurring violations, consistent behaviours, issues that appear in multiple calls.

## Consolidated Next Steps
Top 5–8 priority actions based on ALL notes, ranked by urgency.

## Overall Risk Assessment
Overall compliance risk (Low / Medium / High) with justification from aggregate data.

Rules:
- Use exact ## headings above
- Extract exact numbers from the notes — do not estimate
- Reference specific call numbers where relevant
- Keep each section focused and data-driven`;

const DEFAULT_ROLLUP_PROMPT = "Summarize and aggregate all notes for this agent-customer relationship:";

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

  // Roll-up state
  const [rollupCustomer, setRollupCustomer] = useState("");
  const [rollupModel, setRollupModel]       = useState("gpt-5.4");
  const [rollupSystem, setRollupSystem]     = useState(DEFAULT_ROLLUP_SYSTEM);
  const [rollupPrompt, setRollupPrompt]     = useState(DEFAULT_ROLLUP_PROMPT);
  const [rollupRunning, setRollupRunning]   = useState(false);
  const [rollupResult, setRollupResult]     = useState<string | null>(null);
  const [rollupError, setRollupError]       = useState<string | null>(null);
  const [rollupThinking, setRollupThinking] = useState("");
  const [showRollupConfig, setShowRollupConfig] = useState(false);
  const rollupThinkScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rollupThinkScroll.current) rollupThinkScroll.current.scrollTop = rollupThinkScroll.current.scrollHeight;
  }, [rollupThinking]);

  // Reset roll-up when agent changes
  useEffect(() => {
    setRollupCustomer("");
    setRollupResult(null);
    setRollupError(null);
    setRollupThinking("");
  }, [selected]);

  const runRollup = async () => {
    if (!selected || !rollupCustomer) return;
    setRollupRunning(true);
    setRollupResult(null);
    setRollupError(null);
    setRollupThinking("");
    try {
      const r = await fetch(`${API}/notes/rollup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: selected,
          customer: rollupCustomer,
          model: rollupModel,
          temperature: 0,
          system_prompt: rollupSystem,
          user_prompt: rollupPrompt,
        }),
      });
      if (!r.ok || !r.body) throw new Error(await r.text());
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
            else if (event === "done")  setRollupResult(data.content_md);
            else if (event === "error") setRollupError(data.msg ?? "Roll-up failed");
          } catch {}
        }
      }
    } catch (e: any) {
      setRollupError(e.message ?? "Roll-up failed");
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
                  <span className="text-xs font-semibold text-gray-300 flex-1">Notes Roll-up Analysis</span>
                  <button
                    onClick={() => setShowRollupConfig(v => !v)}
                    className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    {showRollupConfig ? "▲ Hide config" : "▼ Config"}
                  </button>
                </div>

                <div className="p-4 space-y-3">
                  {/* Customer selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 shrink-0">Customer</span>
                    <select
                      value={rollupCustomer}
                      onChange={e => { setRollupCustomer(e.target.value); setRollupResult(null); setRollupError(null); }}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300"
                    >
                      <option value="">— select customer —</option>
                      {noteCustomers.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>

                  {/* Collapsible config */}
                  {showRollupConfig && (
                    <div className="space-y-2 border border-gray-800 rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-500 w-12 shrink-0">Model</span>
                        <select
                          value={rollupModel} onChange={e => setRollupModel(e.target.value)}
                          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-300"
                        >
                          {ALL_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] text-gray-500">System prompt</p>
                        <textarea
                          value={rollupSystem} onChange={e => setRollupSystem(e.target.value)}
                          rows={5}
                          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-300 resize-y font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] text-gray-500">User prompt</p>
                        <textarea
                          value={rollupPrompt} onChange={e => setRollupPrompt(e.target.value)}
                          rows={1}
                          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-300 resize-y"
                        />
                      </div>
                    </div>
                  )}

                  {/* Run button */}
                  <button
                    onClick={runRollup}
                    disabled={rollupRunning || !rollupCustomer}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors",
                      rollupRunning || !rollupCustomer
                        ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                        : "bg-teal-700 hover:bg-teal-600 text-white"
                    )}
                  >
                    {rollupRunning
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Summarizing…</>
                      : <><BarChart2 className="w-3.5 h-3.5" /> Summarize All Notes</>}
                  </button>

                  {/* Thinking */}
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

                  {/* Result */}
                  {rollupResult && (
                    <div className="border border-gray-700/50 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-gray-800 border-b border-gray-700/50 flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-teal-400" />
                        <span className="text-xs font-semibold text-teal-300">{rollupCustomer} — Summary</span>
                        <button onClick={() => setRollupResult(null)} className="ml-auto text-[10px] text-gray-600 hover:text-gray-400">✕ Clear</button>
                      </div>
                      <div className="p-4 max-h-[600px] overflow-y-auto prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{rollupResult}</ReactMarkdown>
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
