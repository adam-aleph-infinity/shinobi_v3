"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import useSWR from "swr";
import { AgentCustomerPair, TxStats } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import {
  RefreshCw, Search, Loader2, ChevronUp, ChevronDown, ChevronsUpDown,
  X, Mic2, CheckSquare, Square, CheckCircle2, CalendarDays, Target,
} from "lucide-react";
import { refreshCache } from "@/lib/api";
import { useAppCtx } from "@/lib/app-context";
import { logClientExecutionEvent } from "@/lib/execution-log";

const API = "/api";
const fetcher = (url: string) => fetch(`${API}${url}`).then(r => r.json());

// ── sessionStorage helpers ─────────────────────────────────────────────────────
const SS_KEY = "crm_filters";

function ssLoad(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(SS_KEY) || "{}"); } catch { return {}; }
}
function ssSave(updates: Record<string, string>) {
  try {
    const current = ssLoad();
    sessionStorage.setItem(SS_KEY, JSON.stringify({ ...current, ...updates }));
  } catch { /* SSR/private */ }
}

type SortKey =
  | "agent"
  | "customer"
  | "account_id"
  | "crm"
  | "calls"
  | "duration"
  | "deposits"
  | "tx"
  | "artifact_pair_avg_score"
  | "artifact_pair_total_violations"
  | "artifact_agent_avg_score"
  | "artifact_agent_total_violations";
type SortDir = "asc" | "desc";

type ArtifactPairMetric = {
  sales_agent: string;
  customer: string;
  run_count: number;
  avg_score_all_sections: number | null;
  total_violations: number;
  avg_violations_per_run: number | null;
  score_by_section: Record<string, number>;
  violations_by_type: Record<string, number>;
  latest_run_at?: string | null;
};

type ArtifactAgentMetric = {
  sales_agent: string;
  customer_count: number;
  run_count: number;
  avg_score_all_sections: number | null;
  total_violations: number;
  avg_violations_per_run: number | null;
  avg_violations_per_customer: number | null;
  score_by_section: Record<string, number>;
  violations_by_type: Record<string, number>;
};

type ArtifactMetricsIndex = {
  pipeline_id: string;
  pipeline_name: string;
  run_count: number;
  run_from?: string;
  run_to?: string;
  score_sections: string[];
  violation_types: string[];
  pairs: ArtifactPairMetric[];
  agents: ArtifactAgentMetric[];
};

type ScoreAggregateMode = "avg" | "sum";
type PairViolationAggregateMode = "sum" | "avg_per_run";
type AgentViolationAggregateMode = "sum" | "avg_per_run" | "avg_per_customer";
type ArtifactSectionScope = "pair" | "agent";

const ARTIFACT_SORT_KEYS: SortKey[] = [
  "artifact_pair_avg_score",
  "artifact_pair_total_violations",
  "artifact_agent_avg_score",
  "artifact_agent_total_violations",
];

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

export type CRMBrowserPageProps = {
  artifactMode?: boolean;
  title?: string;
  subtitle?: string;
};

export default function CRMBrowserPage({
  artifactMode = false,
  title = "CRM Browser",
  subtitle = "Browse agent-customer pairs across all CRMs",
}: CRMBrowserPageProps) {
  const ctx = useAppCtx();
  const artifactsEnabled = !!artifactMode;

  // ── Filters (persisted to sessionStorage) — start from safe defaults; restored post-mount
  const [agentFilter, _setAgentFilter]         = useState("");
  const [customerFilter, _setCustomerFilter]   = useState("");
  const [accountIdFilter, _setAccountIdFilter] = useState("");
  const [crmFilter, _setCrmFilter]             = useState("");
  const [minCalls, _setMinCalls]             = useState("");
  const [minDuration, _setMinDuration]       = useState("");
  const [minTx, _setMinTx]                   = useState("");
  const [minDeposits, _setMinDeposits]       = useState("");
  const [maxDeposits, _setMaxDeposits]       = useState("");
  const [minAgentDep, _setMinAgentDep]       = useState("");
  const [maxAgentDep, _setMaxAgentDep]       = useState("");
  const [ftdAfter, _setFtdAfter]             = useState("");
  const [ftdBefore, _setFtdBefore]           = useState("");
  const [showArtifactOptions, _setShowArtifactOptions] = useState(false);
  const [artifactRunFrom, _setArtifactRunFrom] = useState("");
  const [artifactRunTo, _setArtifactRunTo] = useState("");
  const [pairScoreAgg, _setPairScoreAgg] = useState<ScoreAggregateMode>("avg");
  const [pairViolationAgg, _setPairViolationAgg] = useState<PairViolationAggregateMode>("sum");
  const [agentScoreAgg, _setAgentScoreAgg] = useState<ScoreAggregateMode>("avg");
  const [agentViolationAgg, _setAgentViolationAgg] = useState<AgentViolationAggregateMode>("sum");
  const [artifactSectionScope, _setArtifactSectionScope] = useState<ArtifactSectionScope>("pair");
  const [expandScoreColumns, setExpandScoreColumns] = useState(false);
  const [expandViolationColumns, setExpandViolationColumns] = useState(false);
  const [minArtifactAvgScore, _setMinArtifactAvgScore] = useState("");
  const [maxArtifactAvgScore, _setMaxArtifactAvgScore] = useState("");
  const [minArtifactTotalViolations, _setMinArtifactTotalViolations] = useState("");
  const [maxArtifactTotalViolations, _setMaxArtifactTotalViolations] = useState("");
  const [artifactScoreSection, _setArtifactScoreSection] = useState("all");
  const [minArtifactScoreSectionValue, _setMinArtifactScoreSectionValue] = useState("");
  const [artifactViolationType, _setArtifactViolationType] = useState("all");
  const [minArtifactViolationTypeValue, _setMinArtifactViolationTypeValue] = useState("");
  const [minArtifactAgentAvgScore, _setMinArtifactAgentAvgScore] = useState("");
  const [maxArtifactAgentAvgScore, _setMaxArtifactAgentAvgScore] = useState("");
  const [minArtifactAgentTotalViolations, _setMinArtifactAgentTotalViolations] = useState("");
  const [maxArtifactAgentTotalViolations, _setMaxArtifactAgentTotalViolations] = useState("");
  const ftdAfterRef  = useRef<HTMLInputElement>(null);
  const ftdBeforeRef = useRef<HTMLInputElement>(null);
  const artifactRunFromRef = useRef<HTMLInputElement>(null);
  const artifactRunToRef = useRef<HTMLInputElement>(null);

  function setAgentFilter(v: string)      { _setAgentFilter(v);      ssSave({ agentFilter: v }); }
  function setCustomerFilter(v: string)   { _setCustomerFilter(v);   ssSave({ customerFilter: v }); }
  function setAccountIdFilter(v: string)  { _setAccountIdFilter(v);  ssSave({ accountIdFilter: v }); }
  function setCrmFilter(v: string)        { _setCrmFilter(v);        ssSave({ crmFilter: v }); }
  function setMinCalls(v: string)       { _setMinCalls(v);       ssSave({ minCalls: v }); }
  function setMinDuration(v: string)    { _setMinDuration(v);    ssSave({ minDuration: v }); }
  function setMinTx(v: string)          { _setMinTx(v);          ssSave({ minTx: v }); }
  function setMinDeposits(v: string)    { _setMinDeposits(v);    ssSave({ minDeposits: v }); }
  function setMaxDeposits(v: string)    { _setMaxDeposits(v);    ssSave({ maxDeposits: v }); }
  function setMinAgentDep(v: string)    { _setMinAgentDep(v);    ssSave({ minAgentDep: v }); }
  function setMaxAgentDep(v: string)    { _setMaxAgentDep(v);    ssSave({ maxAgentDep: v }); }
  function setFtdAfter(v: string)       { _setFtdAfter(v);       ssSave({ ftdAfter: v }); }
  function setFtdBefore(v: string)      { _setFtdBefore(v);      ssSave({ ftdBefore: v }); }
  function setShowArtifactOptions(v: boolean) { _setShowArtifactOptions(v); ssSave({ showArtifactOptions: v ? "1" : "0" }); }
  function setArtifactRunFrom(v: string) { _setArtifactRunFrom(v); ssSave({ artifactRunFrom: v }); }
  function setArtifactRunTo(v: string) { _setArtifactRunTo(v); ssSave({ artifactRunTo: v }); }
  function setPairScoreAgg(v: ScoreAggregateMode) { _setPairScoreAgg(v); ssSave({ pairScoreAgg: v }); }
  function setPairViolationAgg(v: PairViolationAggregateMode) { _setPairViolationAgg(v); ssSave({ pairViolationAgg: v }); }
  function setAgentScoreAgg(v: ScoreAggregateMode) { _setAgentScoreAgg(v); ssSave({ agentScoreAgg: v }); }
  function setAgentViolationAgg(v: AgentViolationAggregateMode) { _setAgentViolationAgg(v); ssSave({ agentViolationAgg: v }); }
  function setArtifactSectionScope(v: ArtifactSectionScope) { _setArtifactSectionScope(v); ssSave({ artifactSectionScope: v }); }
  function setMinArtifactAvgScore(v: string) { _setMinArtifactAvgScore(v); ssSave({ minArtifactAvgScore: v }); }
  function setMaxArtifactAvgScore(v: string) { _setMaxArtifactAvgScore(v); ssSave({ maxArtifactAvgScore: v }); }
  function setMinArtifactTotalViolations(v: string) { _setMinArtifactTotalViolations(v); ssSave({ minArtifactTotalViolations: v }); }
  function setMaxArtifactTotalViolations(v: string) { _setMaxArtifactTotalViolations(v); ssSave({ maxArtifactTotalViolations: v }); }
  function setArtifactScoreSection(v: string) { _setArtifactScoreSection(v); ssSave({ artifactScoreSection: v }); }
  function setMinArtifactScoreSectionValue(v: string) { _setMinArtifactScoreSectionValue(v); ssSave({ minArtifactScoreSectionValue: v }); }
  function setArtifactViolationType(v: string) { _setArtifactViolationType(v); ssSave({ artifactViolationType: v }); }
  function setMinArtifactViolationTypeValue(v: string) { _setMinArtifactViolationTypeValue(v); ssSave({ minArtifactViolationTypeValue: v }); }
  function setMinArtifactAgentAvgScore(v: string) { _setMinArtifactAgentAvgScore(v); ssSave({ minArtifactAgentAvgScore: v }); }
  function setMaxArtifactAgentAvgScore(v: string) { _setMaxArtifactAgentAvgScore(v); ssSave({ maxArtifactAgentAvgScore: v }); }
  function setMinArtifactAgentTotalViolations(v: string) { _setMinArtifactAgentTotalViolations(v); ssSave({ minArtifactAgentTotalViolations: v }); }
  function setMaxArtifactAgentTotalViolations(v: string) { _setMaxArtifactAgentTotalViolations(v); ssSave({ maxArtifactAgentTotalViolations: v }); }

  // ── Sort / selection (persisted) — start from safe defaults; restored post-mount
  const [sortKey, _setSortKey] = useState<SortKey>("agent");
  const [sortDir, _setSortDir] = useState<SortDir>("asc");

  // Restore all persisted filter + sort state after mount
  useEffect(() => {
    const s = ssLoad();
    if (s.agentFilter)     _setAgentFilter(s.agentFilter);
    if (s.customerFilter)  _setCustomerFilter(s.customerFilter);
    if (s.accountIdFilter) _setAccountIdFilter(s.accountIdFilter);
    if (s.crmFilter)       _setCrmFilter(s.crmFilter);
    if (s.minCalls)       _setMinCalls(s.minCalls);
    if (s.minDuration)    _setMinDuration(s.minDuration);
    if (s.minTx)          _setMinTx(s.minTx);
    if (s.minDeposits)    _setMinDeposits(s.minDeposits);
    if (s.maxDeposits)    _setMaxDeposits(s.maxDeposits);
    if (s.minAgentDep)    _setMinAgentDep(s.minAgentDep);
    if (s.maxAgentDep)    _setMaxAgentDep(s.maxAgentDep);
    if (s.ftdAfter)       _setFtdAfter(s.ftdAfter);
    if (s.ftdBefore)      _setFtdBefore(s.ftdBefore);
    if (s.showArtifactOptions) _setShowArtifactOptions(s.showArtifactOptions === "1");
    if (s.artifactRunFrom) _setArtifactRunFrom(s.artifactRunFrom);
    if (s.artifactRunTo) _setArtifactRunTo(s.artifactRunTo);
    if (s.pairScoreAgg === "avg" || s.pairScoreAgg === "sum") _setPairScoreAgg(s.pairScoreAgg);
    if (s.pairViolationAgg === "sum" || s.pairViolationAgg === "avg_per_run") _setPairViolationAgg(s.pairViolationAgg);
    if (s.agentScoreAgg === "avg" || s.agentScoreAgg === "sum") _setAgentScoreAgg(s.agentScoreAgg);
    if (s.agentViolationAgg === "sum" || s.agentViolationAgg === "avg_per_run" || s.agentViolationAgg === "avg_per_customer") {
      _setAgentViolationAgg(s.agentViolationAgg);
    }
    if (s.artifactSectionScope === "pair" || s.artifactSectionScope === "agent") _setArtifactSectionScope(s.artifactSectionScope);
    if (s.minArtifactAvgScore) _setMinArtifactAvgScore(s.minArtifactAvgScore);
    if (s.maxArtifactAvgScore) _setMaxArtifactAvgScore(s.maxArtifactAvgScore);
    if (s.minArtifactTotalViolations) _setMinArtifactTotalViolations(s.minArtifactTotalViolations);
    if (s.maxArtifactTotalViolations) _setMaxArtifactTotalViolations(s.maxArtifactTotalViolations);
    if (s.artifactScoreSection) _setArtifactScoreSection(s.artifactScoreSection);
    if (s.minArtifactScoreSectionValue) _setMinArtifactScoreSectionValue(s.minArtifactScoreSectionValue);
    if (s.artifactViolationType) _setArtifactViolationType(s.artifactViolationType);
    if (s.minArtifactViolationTypeValue) _setMinArtifactViolationTypeValue(s.minArtifactViolationTypeValue);
    if (s.minArtifactAgentAvgScore) _setMinArtifactAgentAvgScore(s.minArtifactAgentAvgScore);
    if (s.maxArtifactAgentAvgScore) _setMaxArtifactAgentAvgScore(s.maxArtifactAgentAvgScore);
    if (s.minArtifactAgentTotalViolations) _setMinArtifactAgentTotalViolations(s.minArtifactAgentTotalViolations);
    if (s.maxArtifactAgentTotalViolations) _setMaxArtifactAgentTotalViolations(s.maxArtifactAgentTotalViolations);
    if (s.sortKey)        _setSortKey(s.sortKey as SortKey);
    if (s.sortDir)        _setSortDir(s.sortDir as SortDir);
  }, []);

  function setSortKey(k: SortKey) { _setSortKey(k); ssSave({ sortKey: k }); }
  function setSortDir(d: SortDir) { _setSortDir(d); ssSave({ sortDir: d }); }
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── UI state ───────────────────────────────────────────────────────────────
  const [refreshing, setRefreshing]           = useState(false);
  const [refreshError, setRefreshError]       = useState("");
  const [transcribing, setTranscribing]       = useState(false);
  const [transcribeResult, setTranscribeResult] = useState<{ submitted: number; skipped: number } | null>(null);
  const [txingPairId, setTxingPairId]         = useState<string | null>(null);
  const [txPairResult, setTxPairResult]       = useState<Record<string, { submitted: number; skipped: number }>>({});

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: allPairs } = useSWR<AgentCustomerPair[]>(`/crm/pairs?sort=agent&dir=asc`, fetcher);
  const crms = allPairs ? Array.from(new Set(allPairs.map(p => p.crm_url))).sort() : [];

  // Client-side-only sort modes use a stable server base sort.
  const clientOnlySort = new Set<SortKey>([
    "tx",
    "account_id",
    ...(artifactsEnabled ? ARTIFACT_SORT_KEYS : []),
  ]);
  const serverSortKey = clientOnlySort.has(sortKey) ? "agent" : sortKey;
  const serverSortDir = clientOnlySort.has(sortKey) ? "asc" : sortDir;
  const params = new URLSearchParams({ sort: serverSortKey, dir: serverSortDir });
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

  const artifactMetricsPath = useMemo(() => {
    if (!artifactsEnabled || !ctx.activePipelineId) return null;
    const qp = new URLSearchParams({ limit: "10000" });
    if (artifactRunFrom) qp.set("run_from", artifactRunFrom);
    if (artifactRunTo) qp.set("run_to", artifactRunTo);
    return `/pipelines/${encodeURIComponent(ctx.activePipelineId)}/metrics-index?${qp.toString()}`;
  }, [artifactsEnabled, ctx.activePipelineId, artifactRunFrom, artifactRunTo]);

  const { data: artifactIndex } = useSWR<ArtifactMetricsIndex>(
    artifactMetricsPath,
    fetcher,
    { revalidateOnFocus: false },
  );

  const artifactPairMap = useMemo(() => {
    const m = new Map<string, ArtifactPairMetric>();
    for (const p of artifactIndex?.pairs ?? []) {
      m.set(`${p.sales_agent}::${p.customer}`, p);
    }
    return m;
  }, [artifactIndex?.pairs]);

  const artifactAgentMap = useMemo(() => {
    const m = new Map<string, ArtifactAgentMetric>();
    for (const a of artifactIndex?.agents ?? []) {
      m.set(a.sales_agent, a);
    }
    return m;
  }, [artifactIndex?.agents]);

  const scoreSections = artifactIndex?.score_sections ?? [];
  const violationTypes = artifactIndex?.violation_types ?? [];

  function pairScoreMetric(row?: ArtifactPairMetric): number | null {
    if (!row || row.avg_score_all_sections == null) return null;
    if (pairScoreAgg === "sum") return Number((row.avg_score_all_sections * Math.max(0, row.run_count || 0)).toFixed(2));
    return row.avg_score_all_sections;
  }

  function pairViolationMetric(row?: ArtifactPairMetric): number | null {
    if (!row) return null;
    if (pairViolationAgg === "avg_per_run") return row.avg_violations_per_run;
    return row.total_violations;
  }

  function pairSectionScoreMetric(row: ArtifactPairMetric | undefined, section: string): number | null {
    if (!row) return null;
    const raw = row.score_by_section?.[section];
    if (raw == null) return null;
    if (pairScoreAgg === "sum") {
      return Number((Number(raw) * Math.max(0, row.run_count || 0)).toFixed(2));
    }
    return Number(raw);
  }

  function pairViolationTypeMetric(row: ArtifactPairMetric | undefined, vType: string): number | null {
    if (!row) return null;
    const raw = Number(row.violations_by_type?.[vType] ?? 0);
    if (pairViolationAgg === "avg_per_run") {
      const denom = Math.max(0, row.run_count || 0);
      if (denom <= 0) return null;
      return Number((raw / denom).toFixed(3));
    }
    return raw;
  }

  function agentScoreMetric(row?: ArtifactAgentMetric): number | null {
    if (!row || row.avg_score_all_sections == null) return null;
    if (agentScoreAgg === "sum") return Number((row.avg_score_all_sections * Math.max(0, row.run_count || 0)).toFixed(2));
    return row.avg_score_all_sections;
  }

  function agentViolationMetric(row?: ArtifactAgentMetric): number | null {
    if (!row) return null;
    if (agentViolationAgg === "avg_per_run") return row.avg_violations_per_run;
    if (agentViolationAgg === "avg_per_customer") return row.avg_violations_per_customer;
    return row.total_violations;
  }

  function agentSectionScoreMetric(row: ArtifactAgentMetric | undefined, section: string): number | null {
    if (!row) return null;
    const raw = row.score_by_section?.[section];
    if (raw == null) return null;
    if (agentScoreAgg === "sum") {
      return Number((Number(raw) * Math.max(0, row.run_count || 0)).toFixed(2));
    }
    return Number(raw);
  }

  function agentViolationTypeMetric(row: ArtifactAgentMetric | undefined, vType: string): number | null {
    if (!row) return null;
    const raw = Number(row.violations_by_type?.[vType] ?? 0);
    if (agentViolationAgg === "avg_per_run") {
      const denom = Math.max(0, row.run_count || 0);
      if (denom <= 0) return null;
      return Number((raw / denom).toFixed(3));
    }
    if (agentViolationAgg === "avg_per_customer") {
      const denom = Math.max(0, row.customer_count || 0);
      if (denom <= 0) return null;
      return Number((raw / denom).toFixed(3));
    }
    return raw;
  }

  function sectionScoreMetric(pairRow: ArtifactPairMetric | undefined, agentRow: ArtifactAgentMetric | undefined, section: string): number | null {
    return artifactSectionScope === "agent"
      ? agentSectionScoreMetric(agentRow, section)
      : pairSectionScoreMetric(pairRow, section);
  }

  function sectionViolationMetric(pairRow: ArtifactPairMetric | undefined, agentRow: ArtifactAgentMetric | undefined, vType: string): number | null {
    return artifactSectionScope === "agent"
      ? agentViolationTypeMetric(agentRow, vType)
      : pairViolationTypeMetric(pairRow, vType);
  }

  const sectionScoreLabel = artifactSectionScope === "agent"
    ? `Agent ${agentScoreAgg === "sum" ? "score sum" : "score avg"}`
    : `Pair ${pairScoreAgg === "sum" ? "score sum" : "score avg"}`;
  const sectionViolationLabel = artifactSectionScope === "agent"
    ? `Agent ${agentViolationAgg === "avg_per_run" ? "viol avg/run" : agentViolationAgg === "avg_per_customer" ? "viol avg/cust" : "viol sum"}`
    : `Pair ${pairViolationAgg === "avg_per_run" ? "viol avg/run" : "viol sum"}`;

  const hasArtifactFilter = artifactsEnabled && !!(
    artifactRunFrom ||
    artifactRunTo ||
    minArtifactAvgScore ||
    maxArtifactAvgScore ||
    minArtifactTotalViolations ||
    maxArtifactTotalViolations ||
    (artifactScoreSection && artifactScoreSection !== "all") ||
    minArtifactScoreSectionValue ||
    (artifactViolationType && artifactViolationType !== "all") ||
    minArtifactViolationTypeValue ||
    minArtifactAgentAvgScore ||
    maxArtifactAgentAvgScore ||
    minArtifactAgentTotalViolations ||
    maxArtifactAgentTotalViolations
  );

  const hasFilter = !!(agentFilter || customerFilter || accountIdFilter || crmFilter || minCalls || minDuration || minTx ||
    minDeposits || maxDeposits || minAgentDep || maxAgentDep || ftdAfter || ftdBefore || hasArtifactFilter);

  const showArtifactColumns = artifactsEnabled && !!ctx.activePipelineId;
  const showArtifactScoreColumns = showArtifactColumns && expandScoreColumns && scoreSections.length > 0;
  const showArtifactViolationColumns = showArtifactColumns && expandViolationColumns && violationTypes.length > 0;
  const artifactColumnCount =
    (showArtifactColumns ? 4 : 0)
    + (showArtifactScoreColumns ? scoreSections.length : 0)
    + (showArtifactViolationColumns ? violationTypes.length : 0);
  const tableColSpan = 11 + artifactColumnCount;

  function clearFilters() {
    setAgentFilter(""); setCustomerFilter(""); setAccountIdFilter(""); setCrmFilter("");
    setMinCalls(""); setMinDuration(""); setMinTx(""); setMinDeposits(""); setMaxDeposits("");
    setMinAgentDep(""); setMaxAgentDep(""); setFtdAfter(""); setFtdBefore("");
    if (artifactsEnabled) {
      setArtifactRunFrom(""); setArtifactRunTo("");
      setMinArtifactAvgScore(""); setMaxArtifactAvgScore("");
      setMinArtifactTotalViolations(""); setMaxArtifactTotalViolations("");
      setArtifactScoreSection("all"); setMinArtifactScoreSectionValue("");
      setArtifactViolationType("all"); setMinArtifactViolationTypeValue("");
      setMinArtifactAgentAvgScore(""); setMaxArtifactAgentAvgScore("");
      setMinArtifactAgentTotalViolations(""); setMaxArtifactAgentTotalViolations("");
    }
  }

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir("asc"); }
  }

  // ── Client-side Tx sort + filter (txStats is fetched separately) ──────────
  const displayPairs = useMemo(() => {
    let result = pairs ?? [];
    if (accountIdFilter) {
      const q = accountIdFilter.trim().toLowerCase();
      result = result.filter(p => p.account_id?.toLowerCase().includes(q));
    }
    if (minTx) {
      const threshold = parseInt(minTx, 10) || 0;
      result = result.filter(p => {
        const slug = `${p.agent}/${p.customer}`;
        const tx = txStats?.[slug];
        return tx ? tx.transcribed >= threshold : false;
      });
    }

    if (hasArtifactFilter) {
      result = result.filter((p) => {
        const pairMetric = artifactPairMap.get(`${p.agent}::${p.customer}`);
        const agentMetric = artifactAgentMap.get(p.agent);
        const pairScore = pairScoreMetric(pairMetric);
        const pairViolations = pairViolationMetric(pairMetric);
        const agentScore = agentScoreMetric(agentMetric);
        const agentViolations = agentViolationMetric(agentMetric);

        if (minArtifactAvgScore) {
          const min = Number(minArtifactAvgScore) || 0;
          if (pairScore == null || pairScore < min) return false;
        }
        if (maxArtifactAvgScore) {
          const max = Number(maxArtifactAvgScore) || 0;
          if (pairScore == null || pairScore > max) return false;
        }
        if (minArtifactTotalViolations) {
          const min = Number(minArtifactTotalViolations) || 0;
          if ((pairViolations ?? -1) < min) return false;
        }
        if (maxArtifactTotalViolations) {
          const max = Number(maxArtifactTotalViolations) || 0;
          if ((pairViolations ?? 0) > max) return false;
        }

        if (artifactScoreSection !== "all") {
          const secValue = sectionScoreMetric(pairMetric, agentMetric, artifactScoreSection);
          if (secValue == null) return false;
          if (minArtifactScoreSectionValue) {
            const min = Number(minArtifactScoreSectionValue) || 0;
            if (secValue < min) return false;
          }
        }

        if (artifactViolationType !== "all") {
          const violValue = sectionViolationMetric(pairMetric, agentMetric, artifactViolationType) ?? 0;
          if (minArtifactViolationTypeValue) {
            const min = Number(minArtifactViolationTypeValue) || 0;
            if (violValue < min) return false;
          }
        }

        if (minArtifactAgentAvgScore) {
          const min = Number(minArtifactAgentAvgScore) || 0;
          if (agentScore == null || agentScore < min) return false;
        }
        if (maxArtifactAgentAvgScore) {
          const max = Number(maxArtifactAgentAvgScore) || 0;
          if (agentScore == null || agentScore > max) return false;
        }
        if (minArtifactAgentTotalViolations) {
          const min = Number(minArtifactAgentTotalViolations) || 0;
          if ((agentViolations ?? -1) < min) return false;
        }
        if (maxArtifactAgentTotalViolations) {
          const max = Number(maxArtifactAgentTotalViolations) || 0;
          if ((agentViolations ?? 0) > max) return false;
        }
        return true;
      });
    }

    if (sortKey === "account_id") {
      result = [...result].sort((a, b) =>
        sortDir === "asc"
          ? (a.account_id ?? "").localeCompare(b.account_id ?? "")
          : (b.account_id ?? "").localeCompare(a.account_id ?? "")
      );
    } else if (sortKey === "tx" && txStats) {
      result = [...result].sort((a, b) => {
        const aTx = txStats[`${a.agent}/${a.customer}`]?.transcribed ?? 0;
        const bTx = txStats[`${b.agent}/${b.customer}`]?.transcribed ?? 0;
        return sortDir === "asc" ? aTx - bTx : bTx - aTx;
      });
    } else if (sortKey === "artifact_pair_avg_score") {
      result = [...result].sort((a, b) => {
        const av = pairScoreMetric(artifactPairMap.get(`${a.agent}::${a.customer}`)) ?? -1;
        const bv = pairScoreMetric(artifactPairMap.get(`${b.agent}::${b.customer}`)) ?? -1;
        return sortDir === "asc" ? av - bv : bv - av;
      });
    } else if (sortKey === "artifact_pair_total_violations") {
      result = [...result].sort((a, b) => {
        const av = pairViolationMetric(artifactPairMap.get(`${a.agent}::${a.customer}`)) ?? -1;
        const bv = pairViolationMetric(artifactPairMap.get(`${b.agent}::${b.customer}`)) ?? -1;
        return sortDir === "asc" ? av - bv : bv - av;
      });
    } else if (sortKey === "artifact_agent_avg_score") {
      result = [...result].sort((a, b) => {
        const av = agentScoreMetric(artifactAgentMap.get(a.agent)) ?? -1;
        const bv = agentScoreMetric(artifactAgentMap.get(b.agent)) ?? -1;
        return sortDir === "asc" ? av - bv : bv - av;
      });
    } else if (sortKey === "artifact_agent_total_violations") {
      result = [...result].sort((a, b) => {
        const av = agentViolationMetric(artifactAgentMap.get(a.agent)) ?? -1;
        const bv = agentViolationMetric(artifactAgentMap.get(b.agent)) ?? -1;
        return sortDir === "asc" ? av - bv : bv - av;
      });
    }
    return result;
  }, [
    pairs, txStats, sortKey, sortDir, minTx, accountIdFilter,
    hasArtifactFilter, artifactPairMap, artifactAgentMap,
    minArtifactAvgScore, maxArtifactAvgScore,
    minArtifactTotalViolations, maxArtifactTotalViolations,
    artifactScoreSection, minArtifactScoreSectionValue,
    artifactViolationType, minArtifactViolationTypeValue,
    minArtifactAgentAvgScore, maxArtifactAgentAvgScore,
    minArtifactAgentTotalViolations, maxArtifactAgentTotalViolations,
    pairScoreAgg, pairViolationAgg, agentScoreAgg, agentViolationAgg, artifactSectionScope,
  ]); // eslint-disable-line

  // ── Selection helpers ──────────────────────────────────────────────────────
  const visibleIds  = displayPairs.map(p => p.id);
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

  // ── Single-pair transcription (from Tx cell click) ────────────────────────
  async function handleTranscribePair(pair: AgentCustomerPair) {
    if (txingPairId) return; // one at a time
    setTxingPairId(pair.id);
    setTxPairResult(prev => { const n = { ...prev }; delete n[pair.id]; return n; });
    try {
      const res = await fetch(`${API}/transcription/batch-for-pairs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: [{ crm_url: pair.crm_url, account_id: pair.account_id, agent: pair.agent, customer: pair.customer }],
        }),
      });
      const data = await res.json();
      setTxPairResult(prev => ({ ...prev, [pair.id]: { submitted: data.submitted ?? 0, skipped: data.skipped ?? 0 } }));
    } catch {
      setTxPairResult(prev => ({ ...prev, [pair.id]: { submitted: -1, skipped: 0 } }));
    } finally {
      setTxingPairId(null);
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

  useEffect(() => {
    if (artifactsEnabled) return;
    if (showArtifactOptions) {
      _setShowArtifactOptions(false);
      ssSave({ showArtifactOptions: "0" });
    }
    if (ARTIFACT_SORT_KEYS.includes(sortKey)) {
      _setSortKey("agent");
      _setSortDir("asc");
      ssSave({ sortKey: "agent", sortDir: "asc" });
    }
  }, [artifactsEnabled, showArtifactOptions, sortKey]);

  const fmtDate = (s?: string | null) => s ? s.slice(0, 10) : "—";

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-white">{title}</h1>
          <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
        </div>
        <button
          onClick={async () => {
            setRefreshing(true);
            setRefreshError("");
            try {
              const refreshRes: any = await refreshCache();
              const executionSessionId = String(refreshRes?.execution_session_id || "");
              void logClientExecutionEvent({
                session_id: executionSessionId,
                action: "crm_refresh_triggered",
                status: "running",
                level: "stage",
                message: "CRM full refresh triggered from UI",
                finish: false,
              });
              for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 5000));
                await mutate();
              }
            } catch (e: any) {
              const msg = e?.message || "Failed to refresh CRMs";
              setRefreshError(msg);
              void logClientExecutionEvent({
                action: "crm_refresh_request_failed",
                status: "failed",
                level: "error",
                message: "CRM refresh request failed in UI",
                error: String(msg),
                finish: true,
              });
            } finally {
              setRefreshing(false);
            }
          }}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {refreshing ? "Fetching from CRMs..." : "Refresh from CRMs"}
        </button>
      </div>
      {refreshError && (
        <p className="text-xs text-red-400 mb-2">{refreshError}</p>
      )}

      {/* Filters — row 1: text/dropdown */}
      <div className="flex flex-wrap gap-2 mb-2 shrink-0">
        <FilterInput label="Agent…"      value={agentFilter}      onChange={setAgentFilter} />
        <FilterInput label="Customer…"   value={customerFilter}   onChange={setCustomerFilter} />
        <FilterInput label="Account ID…" value={accountIdFilter}  onChange={setAccountIdFilter} />
        <select
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500"
          value={crmFilter} onChange={e => setCrmFilter(e.target.value)}
        >
          <option value="">All CRMs</option>
          {crms.map(c => <option key={c} value={c}>{c.replace(/https?:\/\//, "")}</option>)}
        </select>
        <FilterInput label="Min calls…"  value={minCalls}    onChange={setMinCalls}    type="number" />
        <FilterInput label="Min hours…"  value={minDuration} onChange={setMinDuration} type="number" step="0.5" />
        <FilterInput label="Min Tx…"     value={minTx}       onChange={setMinTx}       type="number" />
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
          <div className="relative flex items-center">
            <input ref={ftdAfterRef} type="date" value={ftdAfter} onChange={e => setFtdAfter(e.target.value)}
              className="pl-2 pr-7 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500 [color-scheme:dark]" />
            <button onClick={() => ftdAfterRef.current?.showPicker()}
              className="absolute right-1.5 text-gray-500 hover:text-gray-300 transition-colors">
              <CalendarDays className="w-3.5 h-3.5" />
            </button>
          </div>
          <span className="text-[10px] text-gray-700">–</span>
          <div className="relative flex items-center">
            <input ref={ftdBeforeRef} type="date" value={ftdBefore} onChange={e => setFtdBefore(e.target.value)}
              className="pl-2 pr-7 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500 [color-scheme:dark]" />
            <button onClick={() => ftdBeforeRef.current?.showPicker()}
              className="absolute right-1.5 text-gray-500 hover:text-gray-300 transition-colors">
              <CalendarDays className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Extra artifact filters/sorts */}
      {artifactsEnabled && (
      <div className="mb-3 shrink-0">
        <button
          onClick={() => setShowArtifactOptions(!showArtifactOptions)}
          className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
        >
          Extra Artifact Options {showArtifactOptions ? "▾" : "▸"}
        </button>

        {showArtifactOptions && (
          <div className="mt-2 p-3 bg-gray-900 border border-gray-800 rounded-xl space-y-3">
            {!ctx.activePipelineId && (
              <p className="text-xs text-amber-400">
                Select a pipeline in the top context bar to enable artifact metrics.
              </p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Run date:</span>
                <div className="relative flex items-center">
                  <input
                    ref={artifactRunFromRef}
                    type="date"
                    value={artifactRunFrom}
                    onChange={e => setArtifactRunFrom(e.target.value)}
                    className="pl-2 pr-7 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
                  />
                  <button
                    onClick={() => artifactRunFromRef.current?.showPicker()}
                    className="absolute right-1.5 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    <CalendarDays className="w-3.5 h-3.5" />
                  </button>
                </div>
                <span className="text-[10px] text-gray-700">–</span>
                <div className="relative flex items-center">
                  <input
                    ref={artifactRunToRef}
                    type="date"
                    value={artifactRunTo}
                    onChange={e => setArtifactRunTo(e.target.value)}
                    className="pl-2 pr-7 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-indigo-500 [color-scheme:dark]"
                  />
                  <button
                    onClick={() => artifactRunToRef.current?.showPicker()}
                    className="absolute right-1.5 text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    <CalendarDays className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Pair agg:</span>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={pairScoreAgg}
                  onChange={e => setPairScoreAgg(e.target.value as ScoreAggregateMode)}
                >
                  <option value="avg">Score avg</option>
                  <option value="sum">Score sum</option>
                </select>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={pairViolationAgg}
                  onChange={e => setPairViolationAgg(e.target.value as PairViolationAggregateMode)}
                >
                  <option value="sum">Violations sum</option>
                  <option value="avg_per_run">Violations avg/run</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Agent agg:</span>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={agentScoreAgg}
                  onChange={e => setAgentScoreAgg(e.target.value as ScoreAggregateMode)}
                >
                  <option value="avg">Score avg</option>
                  <option value="sum">Score sum</option>
                </select>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={agentViolationAgg}
                  onChange={e => setAgentViolationAgg(e.target.value as AgentViolationAggregateMode)}
                >
                  <option value="sum">Violations sum</option>
                  <option value="avg_per_run">Violations avg/run</option>
                  <option value="avg_per_customer">Violations avg/customer</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Columns:</span>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={artifactSectionScope}
                  onChange={e => setArtifactSectionScope(e.target.value as ArtifactSectionScope)}
                >
                  <option value="pair">Section cols by pair</option>
                  <option value="agent">Section cols by agent avg</option>
                </select>
                <button
                  onClick={() => setExpandScoreColumns(v => !v)}
                  className="px-2 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  {expandScoreColumns ? "Hide" : "Show"} Score Sections
                </button>
                <button
                  onClick={() => setExpandViolationColumns(v => !v)}
                  className="px-2 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  {expandViolationColumns ? "Hide" : "Show"} Compliance Violations
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">
                  Pair {pairScoreAgg === "sum" ? "score sum" : "score avg"}:
                </span>
                <FilterInput label="Min…" value={minArtifactAvgScore} onChange={setMinArtifactAvgScore} type="number" step="1" />
                <span className="text-[10px] text-gray-700">–</span>
                <FilterInput label="Max…" value={maxArtifactAvgScore} onChange={setMaxArtifactAvgScore} type="number" step="1" />
              </div>

              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">
                  Pair {pairViolationAgg === "avg_per_run" ? "viol avg/run" : "viol sum"}:
                </span>
                <FilterInput label="Min…" value={minArtifactTotalViolations} onChange={setMinArtifactTotalViolations} type="number" step="1" />
                <span className="text-[10px] text-gray-700">–</span>
                <FilterInput label="Max…" value={maxArtifactTotalViolations} onChange={setMaxArtifactTotalViolations} type="number" step="1" />
              </div>

              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">
                  Agent {agentScoreAgg === "sum" ? "score sum" : "score avg"}:
                </span>
                <FilterInput label="Min…" value={minArtifactAgentAvgScore} onChange={setMinArtifactAgentAvgScore} type="number" step="1" />
                <span className="text-[10px] text-gray-700">–</span>
                <FilterInput label="Max…" value={maxArtifactAgentAvgScore} onChange={setMaxArtifactAgentAvgScore} type="number" step="1" />
              </div>

              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">
                  Agent {agentViolationAgg === "avg_per_run" ? "viol avg/run" : agentViolationAgg === "avg_per_customer" ? "viol avg/cust" : "viol sum"}:
                </span>
                <FilterInput label="Min…" value={minArtifactAgentTotalViolations} onChange={setMinArtifactAgentTotalViolations} type="number" step="1" />
                <span className="text-[10px] text-gray-700">–</span>
                <FilterInput label="Max…" value={maxArtifactAgentTotalViolations} onChange={setMaxArtifactAgentTotalViolations} type="number" step="1" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Score section ({artifactSectionScope}):</span>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={artifactScoreSection}
                  onChange={e => setArtifactScoreSection(e.target.value)}
                >
                  <option value="all">All</option>
                  {scoreSections.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <FilterInput
                  label={`Min ${sectionScoreLabel}…`}
                  value={minArtifactScoreSectionValue}
                  onChange={setMinArtifactScoreSectionValue}
                  type="number"
                  step="1"
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Violation type ({artifactSectionScope}):</span>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={artifactViolationType}
                  onChange={e => setArtifactViolationType(e.target.value)}
                >
                  <option value="all">All</option>
                  {violationTypes.map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                <FilterInput
                  label={`Min ${sectionViolationLabel}…`}
                  value={minArtifactViolationTypeValue}
                  onChange={setMinArtifactViolationTypeValue}
                  type="number"
                  step="1"
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-600 whitespace-nowrap">Artifact sort:</span>
                <select
                  className="px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300"
                  value={`${sortKey}:${sortDir}`}
                  onChange={(e) => {
                    const [k, d] = e.target.value.split(":");
                    setSortKey(k as SortKey);
                    setSortDir(d as SortDir);
                  }}
                >
                  <option value={`${sortKey}:${sortDir}`}>Keep current</option>
                  <option value="artifact_pair_avg_score:desc">Pair avg score (high → low)</option>
                  <option value="artifact_pair_avg_score:asc">Pair avg score (low → high)</option>
                  <option value="artifact_pair_total_violations:desc">Pair violations (high → low)</option>
                  <option value="artifact_pair_total_violations:asc">Pair violations (low → high)</option>
                  <option value="artifact_agent_avg_score:desc">Agent avg score (high → low)</option>
                  <option value="artifact_agent_avg_score:asc">Agent avg score (low → high)</option>
                  <option value="artifact_agent_total_violations:desc">Agent violations (high → low)</option>
                  <option value="artifact_agent_total_violations:asc">Agent violations (low → high)</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      {showArtifactColumns && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-400 shrink-0">
          <span className="text-gray-500">
            Pipeline metrics: {artifactIndex?.pipeline_name || "selected pipeline"} · runs {artifactIndex?.run_count ?? 0}
          </span>
          <button
            onClick={() => setExpandScoreColumns(v => !v)}
            className="px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
          >
            {expandScoreColumns ? "Hide" : "Show"} Score Sections ({scoreSections.length})
          </button>
          <button
            onClick={() => setExpandViolationColumns(v => !v)}
            className="px-2 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors"
          >
            {expandViolationColumns ? "Hide" : "Show"} Compliance Violations ({violationTypes.length})
          </button>
          <span className="px-2 py-1 rounded border border-gray-700 text-gray-300">
            Section columns: {artifactSectionScope === "agent" ? "Agent aggregate" : "Pair aggregate"}
          </span>
        </div>
      )}

      {/* Table */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col flex-1 min-h-0">
          <div className="overflow-auto flex-1">
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
                  <ThBtn col="agent"      label="Agent" />
                  <ThBtn col="customer"   label="Customer" />
                  <ThBtn col="account_id" label="Account ID" />
                  <ThBtn col="crm"        label="CRM" />
                  <ThBtn col="calls"    label="Calls"    align="right" />
                  <ThBtn col="tx" label="Tx" align="right" />
                  <ThBtn col="duration" label="Duration" align="right" />
                  <ThBtn col="deposits" label="Net Dep."  align="right" />
                  <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">FTD</th>
                  {showArtifactColumns && (
                    <>
                      <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">
                        Pair {pairScoreAgg === "sum" ? "Score Σ" : "Score Avg"}
                      </th>
                      <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">
                        Pair {pairViolationAgg === "avg_per_run" ? "Viol Avg/Run" : "Viol Σ"}
                      </th>
                      {showArtifactScoreColumns && scoreSections.map((sec) => (
                        <th key={`score-col-${sec}`} className="px-3 py-3 text-right font-medium text-gray-400 text-xs whitespace-nowrap">
                          {artifactSectionScope === "agent" ? "Agent Score" : "Pair Score"} · {sec}
                        </th>
                      ))}
                      {showArtifactViolationColumns && violationTypes.map((v) => (
                        <th key={`viol-col-${v}`} className="px-3 py-3 text-right font-medium text-gray-400 text-xs whitespace-nowrap">
                          {artifactSectionScope === "agent" ? "Agent Compliance" : "Pair Compliance"} · {v}
                        </th>
                      ))}
                      <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">
                        Agent {agentScoreAgg === "sum" ? "Score Σ" : "Score Avg"}
                      </th>
                      <th className="px-3 py-3 text-right font-medium text-gray-400 text-xs">
                        Agent {agentViolationAgg === "avg_per_run" ? "Viol Avg/Run" : agentViolationAgg === "avg_per_customer" ? "Viol Avg/Cust" : "Viol Σ"}
                      </th>
                    </>
                  )}
                  <th className="w-8 px-2 py-3" />
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={tableColSpan} className="text-center py-12 text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
                  </td></tr>
                )}
                {error && (
                  <tr><td colSpan={tableColSpan} className="text-center py-12 text-red-400">Error: {error.message}</td></tr>
                )}
                {!isLoading && displayPairs.map((pair) => {
                  const isSelected = selectedIds.has(pair.id);
                  const slug = `${pair.agent}/${pair.customer}`;
                  const tx = txStats?.[slug];
                  const artifactPair = artifactPairMap.get(`${pair.agent}::${pair.customer}`);
                  const artifactAgent = artifactAgentMap.get(pair.agent);
                  const pairScoreValue = pairScoreMetric(artifactPair);
                  const pairViolationValue = pairViolationMetric(artifactPair);
                  const agentScoreValue = agentScoreMetric(artifactAgent);
                  const agentViolationValue = agentViolationMetric(artifactAgent);
                  return (
                    <tr
                      key={pair.id}
                      onClick={() => ctx.setCustomer(pair.customer, pair.agent)}
                      className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${isSelected ? "bg-indigo-900/10" : ""}`}
                    >
                      <td className="px-3 py-3 w-8">
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleRow(pair.id); }}
                          className="text-gray-500 hover:text-white transition-colors"
                        >
                          {isSelected
                            ? <CheckSquare className="w-4 h-4 text-indigo-400" />
                            : <Square className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-3 text-white font-medium">{pair.agent}</td>
                      <td className="px-3 py-3 text-gray-300">{pair.customer}</td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-400">{pair.account_id || "—"}</td>
                      <td className="px-3 py-3">
                        <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
                          {pair.crm_url.replace(/https?:\/\//, "")}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-300">{pair.call_count || "—"}</td>
                      <td className="px-3 py-3 text-right">
                        {(tx || pair.call_count > 0) ? (() => {
                          const txDone  = tx?.transcribed ?? 0;
                          const txTotal = tx?.total ?? pair.call_count ?? 0;
                          const allDone = txDone > 0 && txDone >= txTotal;
                          return (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleTranscribePair(pair); }}
                              disabled={txingPairId === pair.id || allDone}
                              title={allDone ? "All calls transcribed" : "Click to transcribe all calls for this pair"}
                              className={`text-xs flex items-center justify-end gap-1 transition-colors rounded px-1 -mx-1
                                ${txingPairId === pair.id ? "opacity-50 cursor-wait" :
                                  allDone ? "text-teal-400 cursor-default" :
                                  txDone > 0 ? "text-teal-500 hover:text-teal-300 hover:bg-teal-900/30 cursor-pointer" :
                                  "text-gray-500 hover:text-teal-400 hover:bg-teal-900/20 cursor-pointer"}`}
                            >
                              {txingPairId === pair.id
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : allDone
                                  ? <CheckCircle2 className="w-3 h-3" />
                                  : <Mic2 className={`w-3 h-3 ${txDone > 0 ? "" : "opacity-50"}`} />}
                              {txPairResult[pair.id]
                                ? txPairResult[pair.id].submitted >= 0
                                  ? <span className="text-indigo-400">{txPairResult[pair.id].submitted}↑</span>
                                  : <span className="text-red-400">err</span>
                                : `${txDone}/${txTotal}`}
                            </button>
                          );
                        })() : <span className="text-gray-700 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-400">{formatDuration(pair.total_duration)}</td>
                      <td className="px-3 py-3 text-right">
                        {pair.net_deposits != null ? (
                          <span className={pair.net_deposits >= 0 ? "text-emerald-400" : "text-red-400"}>
                            {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(pair.net_deposits)}
                          </span>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-300 text-xs">{fmtDate(pair.ftd_at)}</td>
                      {showArtifactColumns && (
                        <>
                          <td className="px-3 py-3 text-right text-indigo-300 font-mono text-xs">
                            {pairScoreValue != null ? pairScoreValue.toFixed(1) : "—"}
                          </td>
                          <td className="px-3 py-3 text-right text-red-300 font-mono text-xs">
                            {pairViolationValue != null ? Number(pairViolationValue).toFixed(pairViolationAgg === "avg_per_run" ? 2 : 0) : "—"}
                          </td>
                          {showArtifactScoreColumns && scoreSections.map((sec) => (
                            <td key={`score-${pair.id}-${sec}`} className="px-3 py-3 text-right text-emerald-300 font-mono text-xs">
                              {(() => {
                                const val = sectionScoreMetric(artifactPair, artifactAgent, sec);
                                return val != null ? Number(val).toFixed(1) : "—";
                              })()}
                            </td>
                          ))}
                          {showArtifactViolationColumns && violationTypes.map((v) => (
                            <td key={`viol-${pair.id}-${v}`} className="px-3 py-3 text-right text-amber-300 font-mono text-xs">
                              {(() => {
                                const val = sectionViolationMetric(artifactPair, artifactAgent, v);
                                if (val == null) return "—";
                                const decimals = artifactSectionScope === "agent"
                                  ? (agentViolationAgg === "sum" ? 0 : 2)
                                  : (pairViolationAgg === "sum" ? 0 : 2);
                                return Number(val).toFixed(decimals);
                              })()}
                            </td>
                          ))}
                          <td className="px-3 py-3 text-right text-indigo-300 font-mono text-xs">
                            {agentScoreValue != null ? agentScoreValue.toFixed(1) : "—"}
                          </td>
                          <td className="px-3 py-3 text-right text-red-300 font-mono text-xs">
                            {agentViolationValue != null ? Number(agentViolationValue).toFixed(agentViolationAgg === "sum" ? 0 : 2) : "—"}
                          </td>
                        </>
                      )}
                      <td className="px-2 py-3 text-center">
                        <button
                          onClick={(e) => { e.stopPropagation(); ctx.setCustomer(pair.customer, pair.agent); }}
                          title={`Set context: ${pair.agent} / ${pair.customer}`}
                          className={`p-1 rounded transition-colors ${
                            ctx.salesAgent === pair.agent && ctx.customer === pair.customer
                              ? "text-indigo-400"
                              : "text-gray-700 hover:text-indigo-400"
                          }`}
                        >
                          <Target className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!isLoading && displayPairs.length === 0 && (
                  <tr><td colSpan={tableColSpan} className="text-center py-12 text-gray-500">No pairs found</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer: count + transcribe button */}
          <div className="px-4 py-2 border-t border-gray-800 flex items-center gap-3 shrink-0">
            <span className="text-xs text-gray-500 flex-1">
              {pairs && allPairs
                ? `${displayPairs.length}${hasFilter ? ` of ${allPairs.length}` : ""} pair${displayPairs.length !== 1 ? "s" : ""}`
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
