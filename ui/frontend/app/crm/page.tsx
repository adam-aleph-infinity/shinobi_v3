"use client";
import { useState } from "react";
import useSWR from "swr";
import { AgentCustomerPair, TxStats } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import {
  RefreshCw, Search, Loader2, ChevronUp, ChevronDown, ChevronsUpDown,
  X, Mic2, CheckSquare, Square, CheckCircle2,
} from "lucide-react";
import { refreshCache } from "@/lib/api";

const API = "/api";
const fetcher = (url: string) => fetch(`${API}${url}`).then(r => r.json());

type SortKey = "agent" | "customer" | "crm" | "calls" | "duration" | "deposits";
type SortDir = "asc" | "desc";

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="w-3.5 h-3.5 text-gray-600" />;
  return dir === "asc"
    ? <ChevronUp className="w-3.5 h-3.5 text-indigo-400" />
    : <ChevronDown className="w-3.5 h-3.5 text-indigo-400" />;
}

function FilterInput({ label, value, onChange, type = "text", step, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; step?: string; placeholder?: string;
}) {
  return (
    <div className="relative">
      {type === "text" && <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-500" />}
      <input
        type={type} step={step}
        className={`${type === "text" ? "pl-8" : "pl-3"} pr-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-36`}
        placeholder={placeholder ?? label}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

export default function CRMPage() {
  // ── Filters ────────────────────────────────────────────────────────────────
  const [agentFilter, setAgentFilter]       = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [crmFilter, setCrmFilter]           = useState("");
  const [minCalls, setMinCalls]             = useState("");
  const [minDuration, setMinDuration]       = useState("");
  const [minDeposits, setMinDeposits]       = useState("");
  const [maxDeposits, setMaxDeposits]       = useState("");
  const [minAgentDep, setMinAgentDep]       = useState("");
  const [maxAgentDep, setMaxAgentDep]       = useState("");
  const [ftdAfter, setFtdAfter]             = useState("");
  const [ftdBefore, setFtdBefore]           = useState("");

  // ── Sort / selection ───────────────────────────────────────────────────────
  const [sortKey, setSortKey]   = useState<SortKey>("agent");
  const [sortDir, setSortDir]   = useState<SortDir>("asc");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── UI state ───────────────────────────────────────────────────────────────
  const [refreshing, setRefreshing]           = useState(false);
  const [transcribing, setTranscribing]       = useState(false);
  const [transcribeResult, setTranscribeResult] = useState<{ submitted: number; skipped: number } | null>(null);

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: allPairs } = useSWR<AgentCustomerPair[]>(`/crm/pairs?sort=agent&dir=asc`, fetcher);
  const crms = allPairs ? Array.from(new Set(allPairs.map(p => p.crm_url))).sort() : [];

  const params = new URLSearchParams({ sort: sortKey, dir: sortDir });
  if (agentFilter)    params.set("agent",               agentFilter);
  if (customerFilter) params.set("customer",            customerFilter);
  if (crmFilter)      params.set("crm",                 crmFilter);
  if (minCalls)       params.set("min_calls",           minCalls);
  if (minDuration)    params.set("min_duration",        minDuration);
  if (minDeposits)    params.set("min_deposits",        minDeposits);
  if (maxDeposits)    params.set("max_deposits",        maxDeposits);
  if (minAgentDep)    params.set("min_agent_deposits",  minAgentDep);
  if (maxAgentDep)    params.set("max_agent_deposits",  maxAgentDep);
  if (ftdAfter)       params.set("ftd_after",           ftdAfter);
  if (ftdBefore)      params.set("ftd_before",          ftdBefore);

  const { data: pairs, isLoading, error, mutate } = useSWR<AgentCustomerPair[]>(
    `/crm/pairs?${params.toString()}`, fetcher, { refreshInterval: 0 }
  );

  const { data: txStats } = useSWR<TxStats>(`/final-transcript/tx-stats`, fetcher, { refreshInterval: 30000 });

  const hasFilter = !!(agentFilter || customerFilter || crmFilter || minCalls || minDuration ||
    minDeposits || maxDeposits || minAgentDep || maxAgentDep || ftdAfter || ftdBefore);

  function clearFilters() {
    setAgentFilter(""); setCustomerFilter(""); setCrmFilter("");
    setMinCalls(""); setMinDuration(""); setMinDeposits(""); setMaxDeposits("");
    setMinAgentDep(""); setMaxAgentDep(""); setFtdAfter(""); setFtdBefore("");
  }

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir("asc"); }
  }

  // ── Selection helpers ──────────────────────────────────────────────────────
  const visibleIds  = (pairs ?? []).map(p => p.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(prev => { const next = new Set(prev); visibleIds.forEach(id => next.delete(id)); return next; });
    } else {
      setSelectedIds(prev => new Set([...prev, ...visibleIds]));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  // ── Batch transcription ────────────────────────────────────────────────────
  async function handleTranscribe() {
    if (!pairs || selectedIds.size === 0) return;
    const selectedPairs = pairs.filter(p => selectedIds.has(p.id));
    setTranscribing(true);
    setTranscribeResult(null);
    try {
      const res = await fetch(`${API}/transcription/batch-for-pairs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: selectedPairs.map(p => ({
            crm_url:    p.crm_url,
            account_id: p.account_id,
            agent:      p.agent,
            customer:   p.customer,
          })),
        }),
      });
      const data = await res.json();
      setTranscribeResult({ submitted: data.submitted ?? 0, skipped: data.skipped ?? 0 });
    } catch {
      setTranscribeResult({ submitted: 0, skipped: -1 });
    } finally {
      setTranscribing(false);
    }
  }

  // ── Table header button ────────────────────────────────────────────────────
  function ThBtn({ col, label, align = "left" }: { col: SortKey; label: string; align?: "left" | "right" }) {
    const active = sortKey === col;
    return (
      <th className={`px-3 py-3 font-medium text-${align}`}>
        <button
          onClick={() => toggleSort(col)}
          className={`inline-flex items-center gap-1 transition-colors ${active ? "text-white" : "text-gray-400 hover:text-gray-200"}`}
        >
          {align === "right" && <SortIcon active={active} dir={sortDir} />}
          {label}
          {align !== "right" && <SortIcon active={active} dir={sortDir} />}
        </button>
      </th>
    );
  }

  const fmtDate = (s?: string | null) => s ? s.slice(0, 10) : "—";

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-white">CRM Browser</h1>
          <p className="text-xs text-gray-500 mt-0.5">Browse agent-customer pairs across all CRMs</p>
        </div>
        <button
          onClick={async () => {
            setRefreshing(true);
            await refreshCache();
            for (let i = 0; i < 12; i++) {
              await new Promise(r => setTimeout(r, 5000));
              await mutate();
            }
            setRefreshing(false);
          }}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {refreshing ? "Fetching from CRMs..." : "Refresh from CRMs"}
        </button>
      </div>

      {/* Filters — row 1: text/dropdown */}
      <div className="flex flex-wrap gap-2 mb-2 shrink-0">
        <FilterInput label="Agent…"    value={agentFilter}    onChange={setAgentFilter} />
        <FilterInput label="Customer…" value={customerFilter} onChange={setCustomerFilter} />
        <select
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500"
          value={crmFilter} onChange={e => setCrmFilter(e.target.value)}
        >
          <option value="">All CRMs</option>
          {crms.map(c => <option key={c} value={c}>{c.replace(/https?:\/\//, "")}</option>)}
        </select>
        <FilterInput label="Min calls…"  value={minCalls}    onChange={setMinCalls}    type="number" />
        <FilterInput label="Min hours…"  value={minDuration} onChange={setMinDuration} type="number" step="0.5" />
        {hasFilter && (
          <button onClick={clearFilters} className="flex items-center gap-1 px-2.5 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors">
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Filters — row 2: deposit + date */}
      <div className="flex flex-wrap gap-2 mb-3 shrink-0">
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-600 whitespace-nowrap">Cust dep:</span>
          <FilterInput label="Min…" value={minDeposits} onChange={setMinDeposits} type="number" step="100" />
          <span className="text-[10px] text-gray-700">–</span>
          <FilterInput label="Max…" value={maxDeposits} onChange={setMaxDeposits} type="number" step="100" />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-600 whitespace-nowrap">Agent dep:</span>
          <FilterInput label="Min…" value={minAgentDep} onChange={setMinAgentDep} type="number" step="1000" />
          <span className="text-[10px] text-gray-700">–</span>
          <FilterInput label="Max…" value={maxAgentDep} onChange={setMaxAgentDep} type="number" step="1000" />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-600 whitespace-nowrap">FTD:</span>
          <input type="date" value={ftdAfter}  onChange={e => setFtdAfter(e.target.value)}
            className="px-2 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500" />
          <span className="text-[10px] text-gray-700">–</span>
          <input type="date" value={ftdBefore} onChange={e => setFtdBefore(e.target.value)}
            className="px-2 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500" />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col flex-1 min-h-0">
          <div className="overflow-y-auto flex-1">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-900 z-10">
                <tr className="border-b border-gray-800">
                  {/* Select-all checkbox */}
                  <th className="w-8 px-3 py-3">
                    <button onClick={toggleSelectAll} className="text-gray-500 hover:text-white transition-colors">
                      {allSelected
                        ? <CheckSquare className="w-4 h-4 text-indigo-400" />
                        : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                  <ThBtn col="agent"    label="Agent" />
                  <ThBtn col="customer" label="Customer" />
                  <ThBtn col="crm"      label="CRM" />
                  <ThBtn col="calls"    label="Calls"    align="right" />
                  <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">Tx</th>
                  <ThBtn col="duration" label="Duration" align="right" />
                  <ThBtn col="deposits" label="Net Dep."  align="right" />
                  <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">FTD</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
                  </td></tr>
                )}
                {error && (
                  <tr><td colSpan={9} className="text-center py-12 text-red-400">Error: {error.message}</td></tr>
                )}
                {!isLoading && pairs?.map((pair) => {
                  const isSelected = selectedIds.has(pair.id);
                  const slug = `${pair.agent}/${pair.customer}`;
                  const tx = txStats?.[slug];
                  return (
                    <tr
                      key={pair.id}
                      className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${isSelected ? "bg-indigo-900/10" : ""}`}
                    >
                      <td className="px-3 py-3 w-8">
                        <button onClick={() => toggleRow(pair.id)} className="text-gray-500 hover:text-white transition-colors">
                          {isSelected
                            ? <CheckSquare className="w-4 h-4 text-indigo-400" />
                            : <Square className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-3 text-white font-medium">{pair.agent}</td>
                      <td className="px-3 py-3 text-gray-300">{pair.customer}</td>
                      <td className="px-3 py-3">
                        <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                          {pair.crm_url.replace(/https?:\/\//, "")}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-300">{pair.call_count || "—"}</td>
                      <td className="px-3 py-3 text-right">
                        {tx ? (
                          <span className={`text-xs flex items-center justify-end gap-1 ${tx.transcribed > 0 ? "text-teal-400" : "text-gray-600"}`}>
                            {tx.transcribed > 0 && <CheckCircle2 className="w-3 h-3" />}
                            {tx.transcribed}/{tx.total}
                          </span>
                        ) : <span className="text-gray-700 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-400">{formatDuration(pair.total_duration)}</td>
                      <td className="px-3 py-3 text-right">
                        {pair.net_deposits != null ? (
                          <span className={pair.net_deposits >= 0 ? "text-emerald-400" : "text-red-400"}>
                            {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pair.net_deposits)}
                          </span>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-500 text-xs">{fmtDate(pair.ftd_at)}</td>
                    </tr>
                  );
                })}
                {!isLoading && pairs?.length === 0 && (
                  <tr><td colSpan={9} className="text-center py-12 text-gray-500">No pairs found</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer: count + transcribe button */}
          <div className="px-4 py-2 border-t border-gray-800 flex items-center gap-3 shrink-0">
            <span className="text-xs text-gray-500 flex-1">
              {pairs && allPairs
                ? `${pairs.length}${hasFilter ? ` of ${allPairs.length}` : ""} pair${pairs.length !== 1 ? "s" : ""}`
                : ""}
              {someSelected && ` · ${selectedIds.size} selected`}
            </span>

            {transcribeResult && (
              <span className={`text-xs ${transcribeResult.skipped === -1 ? "text-red-400" : "text-teal-400"}`}>
                {transcribeResult.skipped === -1
                  ? "Error starting transcription"
                  : `${transcribeResult.submitted} job${transcribeResult.submitted !== 1 ? "s" : ""} queued, ${transcribeResult.skipped} skipped`}
              </span>
            )}

            {someSelected && (
              <button
                onClick={handleTranscribe}
                disabled={transcribing}
                className="flex items-center gap-2 px-3 py-1.5 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {transcribing
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Mic2 className="w-3.5 h-3.5" />}
                {transcribing
                  ? "Queuing…"
                  : `Transcribe ${selectedIds.size} pair${selectedIds.size !== 1 ? "s" : ""}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
