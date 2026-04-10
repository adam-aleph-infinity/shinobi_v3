"use client";
import { useState } from "react";
import useSWR from "swr";
import { AgentCustomerPair } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import { RefreshCw, Search, ExternalLink, Loader2, ChevronUp, ChevronDown, ChevronsUpDown, X } from "lucide-react";
import Link from "next/link";
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

export default function CRMPage() {
  const [agentFilter, setAgentFilter]     = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [crmFilter, setCrmFilter]         = useState("");
  const [minCalls, setMinCalls]           = useState("");
  const [minDuration, setMinDuration]     = useState("");
  const [minDeposits, setMinDeposits]     = useState("");
  const [sortKey, setSortKey]             = useState<SortKey>("agent");
  const [sortDir, setSortDir]             = useState<SortDir>("asc");
  const [refreshing, setRefreshing]       = useState(false);

  // All pairs (unfiltered) — only for building the CRM dropdown
  const { data: allPairs } = useSWR<AgentCustomerPair[]>(`/crm/pairs?sort=agent&dir=asc`, fetcher);
  const crms = allPairs ? Array.from(new Set(allPairs.map(p => p.crm_url))).sort() : [];

  // Filtered + sorted pairs — query params drive server-side SQL
  const params = new URLSearchParams({ sort: sortKey, dir: sortDir });
  if (agentFilter)    params.set("agent", agentFilter);
  if (customerFilter) params.set("customer", customerFilter);
  if (crmFilter)      params.set("crm", crmFilter);
  if (minCalls)       params.set("min_calls", minCalls);
  if (minDuration)    params.set("min_duration", minDuration);
  if (minDeposits)    params.set("min_deposits", minDeposits);
  const qstr = params.toString();

  const { data: pairs, isLoading, error, mutate } = useSWR<AgentCustomerPair[]>(
    `/crm/pairs?${qstr}`, fetcher, { refreshInterval: 0 }
  );

  const hasFilter = !!(agentFilter || customerFilter || crmFilter || minCalls || minDuration || minDeposits);

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir("asc"); }
  }

  function ThBtn({ col, label, align = "left" }: { col: SortKey; label: string; align?: "left" | "right" }) {
    const active = sortKey === col;
    return (
      <th className={`px-4 py-3 font-medium text-${align}`}>
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

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col overflow-hidden">
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

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-500" />
          <input
            className="pl-8 pr-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-40"
            placeholder="Agent…"
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-500" />
          <input
            className="pl-8 pr-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-40"
            placeholder="Customer…"
            value={customerFilter}
            onChange={e => setCustomerFilter(e.target.value)}
          />
        </div>
        <select
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500"
          value={crmFilter}
          onChange={e => setCrmFilter(e.target.value)}
        >
          <option value="">All CRMs</option>
          {crms.map(c => <option key={c} value={c}>{c.replace(/https?:\/\//, "")}</option>)}
        </select>
        <input
          type="number" min={0}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-28"
          placeholder="Min calls…"
          value={minCalls}
          onChange={e => setMinCalls(e.target.value)}
        />
        <input
          type="number" min={0} step={0.5}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-32"
          placeholder="Min hours…"
          value={minDuration}
          onChange={e => setMinDuration(e.target.value)}
        />
        <input
          type="number" min={0} step={100}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-36"
          placeholder="Min net deposit…"
          value={minDeposits}
          onChange={e => setMinDeposits(e.target.value)}
        />
        {hasFilter && (
          <button
            onClick={() => { setAgentFilter(""); setCustomerFilter(""); setCrmFilter(""); setMinCalls(""); setMinDuration(""); setMinDeposits(""); }}
            className="flex items-center gap-1 px-2.5 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 flex flex-col">
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="overflow-y-auto flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900 z-10">
            <tr className="border-b border-gray-800">
              <ThBtn col="agent"    label="Agent" />
              <ThBtn col="customer" label="Customer" />
              <ThBtn col="crm"      label="CRM" />
              <ThBtn col="calls"    label="Calls"    align="right" />
              <ThBtn col="duration" label="Duration" align="right" />
              <ThBtn col="deposits" label="Net Dep."  align="right" />
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={7} className="text-center py-12 text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
              </td></tr>
            )}
            {error && (
              <tr><td colSpan={7} className="text-center py-12 text-red-400">Error: {error.message}</td></tr>
            )}
            {!isLoading && pairs?.map((pair) => (
              <tr key={pair.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                <td className="px-4 py-3 text-white font-medium">{pair.agent}</td>
                <td className="px-4 py-3 text-gray-300">{pair.customer}</td>
                <td className="px-4 py-3">
                  <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                    {pair.crm_url.replace(/https?:\/\//, "")}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-300">{pair.call_count || "—"}</td>
                <td className="px-4 py-3 text-right text-gray-400">{formatDuration(pair.total_duration)}</td>
                <td className="px-4 py-3 text-right">
                  {pair.net_deposits != null ? (
                    <span className={pair.net_deposits >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pair.net_deposits)}
                    </span>
                  ) : <span className="text-gray-600">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/audio?crm=${encodeURIComponent(pair.crm_url)}&account=${pair.account_id}&agent=${encodeURIComponent(pair.agent)}&customer=${encodeURIComponent(pair.customer)}`}
                    className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 text-xs ml-auto w-fit"
                  >
                    Open <ExternalLink className="w-3 h-3" />
                  </Link>
                </td>
              </tr>
            ))}
            {!isLoading && pairs?.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-gray-500">No pairs found</td></tr>
            )}
          </tbody>
        </table>
        </div>
        {pairs && allPairs && (
          <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-500 shrink-0">
            {pairs.length}{hasFilter ? ` of ${allPairs.length}` : ""} pair{pairs.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
