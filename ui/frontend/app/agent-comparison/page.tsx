"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import useSWR from "swr";
import { cn } from "@/lib/utils";
import {
  Upload, Trash2, Send, Loader2, CheckCircle2, AlertCircle, RefreshCw,
  ChevronDown, ChevronUp, Bookmark, Star, X, Search, Play, FileText, Map, Wand2,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";

// ── Interactive sortable table ───────────────────────────────────────────────

function SortableTable({ children }: { children: React.ReactNode }) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Extract thead and tbody from children
  const childArray = Array.isArray(children) ? children : [children];
  const theadEl = childArray.find((c: any) => c?.type === "thead" || c?.props?.node?.tagName === "thead") as any;
  const tbodyEl = childArray.find((c: any) => c?.type === "tbody" || c?.props?.node?.tagName === "tbody") as any;

  // Extract header cells text
  const headerRow = theadEl?.props?.children;
  const headerCells: string[] = [];
  try {
    const cells = headerRow?.props?.children ?? [];
    (Array.isArray(cells) ? cells : [cells]).forEach((cell: any) => {
      headerCells.push(String(cell?.props?.children ?? "").trim());
    });
  } catch {}

  // Extract and optionally sort body rows
  let bodyRows: React.ReactNode[] = [];
  try {
    const raw = tbodyEl?.props?.children ?? [];
    bodyRows = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
  } catch {}

  const sorted = sortCol === null ? bodyRows : [...bodyRows].sort((a: any, b: any) => {
    try {
      const getCellText = (row: any, idx: number) => {
        const cells = row?.props?.children ?? [];
        const cell = (Array.isArray(cells) ? cells : [cells])[idx];
        return String(cell?.props?.children ?? "").trim();
      };
      const av = getCellText(a, sortCol);
      const bv = getCellText(b, sortCol);
      const numA = parseFloat(av.replace(/[^0-9.\-]/g, ""));
      const numB = parseFloat(bv.replace(/[^0-9.\-]/g, ""));
      const cmp = (!isNaN(numA) && !isNaN(numB)) ? numA - numB : av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    } catch { return 0; }
  });

  const toggleSort = (idx: number) => {
    if (sortCol === idx) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(idx); setSortDir("asc"); }
  };

  return (
    <div className="overflow-x-auto my-4 rounded-xl border border-gray-700 shadow-lg">
      <table className="w-full text-sm border-collapse">
        {theadEl && (
          <thead className="bg-gray-700/80 sticky top-0">
            <tr>
              {headerCells.map((h, i) => (
                <th key={i}
                  onClick={() => toggleSort(i)}
                  className="text-left px-3 py-2.5 text-xs font-semibold text-gray-200 whitespace-nowrap cursor-pointer select-none hover:bg-gray-600/60 transition-colors group"
                >
                  <div className="flex items-center gap-1.5">
                    <span>{h}</span>
                    <span className="text-gray-500 group-hover:text-gray-300 transition-colors">
                      {sortCol === i
                        ? sortDir === "asc" ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                        : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody className="divide-y divide-gray-700/50">
          {sorted.map((row: any, i) => (
            <tr key={i} className={cn("transition-colors hover:bg-gray-700/30", i % 2 === 0 ? "bg-gray-800/20" : "bg-gray-800/40")}>
              {(() => {
                try {
                  const cells = row?.props?.children ?? [];
                  return (Array.isArray(cells) ? cells : [cells]).map((cell: any, j: number) => (
                    <td key={j} className="px-3 py-2.5 text-gray-300 text-xs align-top border-r border-gray-700/30 last:border-r-0">
                      {cell?.props?.children}
                    </td>
                  ));
                } catch { return null; }
              })()}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Markdown components ──────────────────────────────────────────────────────

const MD_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="text-xl font-bold text-white mt-6 mb-3 pb-1 border-b border-gray-700">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold text-white mt-5 mb-2 pb-1 border-b border-gray-700/50">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-indigo-300 mt-4 mb-1.5">{children}</h3>,
  p:  ({ children }) => <p className="text-gray-300 text-sm leading-relaxed mb-3">{children}</p>,
  strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
  em: ({ children }) => <em className="text-gray-300 italic">{children}</em>,
  ul: ({ children }) => <ul className="my-2 space-y-1 pl-5 list-disc marker:text-indigo-400">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 space-y-1 pl-5 list-decimal marker:text-indigo-400">{children}</ol>,
  li: ({ children }) => <li className="text-gray-300 text-sm leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-indigo-500 pl-4 my-3 text-gray-400 italic text-sm">{children}</blockquote>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    return isBlock
      ? <code className="block bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs text-indigo-300 overflow-x-auto my-3 whitespace-pre">{children}</code>
      : <code className="bg-gray-700/60 text-indigo-300 px-1.5 py-0.5 rounded text-xs">{children}</code>;
  },
  hr: () => <hr className="border-gray-700 my-5" />,
  table: ({ children }) => <SortableTable>{children}</SortableTable>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
};

const fetcher = (url: string) => fetch(url).then(r => r.json());

const GROK_MODELS = [
  { value: "grok-4.20-0309-reasoning",     label: "Grok 4.20 Reasoning" },
  { value: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Fast" },
  { value: "grok-4-1-fast-reasoning",      label: "Grok 4.1 Fast Reasoning" },
  { value: "grok-4-1-fast-non-reasoning",  label: "Grok 4.1 Fastest" },
];

const SMOOTH_MODELS = [
  { value: "gpt-5.4",    label: "GPT-5.4" },
  { value: "gpt-4.1",   label: "GPT-4.1" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
];

const LANDMARK_MODELS = [
  { value: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Fast" },
  { value: "gpt-4.1",                      label: "GPT-4.1" },
  { value: "gpt-5.4",                      label: "GPT-5.4" },
];

interface PairStatus {
  total: number;
  transcripts: number;
  landmarks: number;
  calls: { call_id: string; has_transcript: boolean; has_landmarks: boolean }[];
}

interface UploadedPair {
  agent: string;
  customer: string;
  transcript?: { xai_file_id: string; filename: string; uploaded_at: string };
  landmarks?: { xai_file_id: string; filename: string; uploaded_at: string };
}

interface ComparisonPreset {
  name: string;
  model: string;
  system_prompt: string;
  user_prompt: string;
  temperature: number;
  is_default: boolean;
}

interface AgentStat {
  agent: string;
  customers: number;
  customers_with_data: number;
  total_calls: number;
  total_transcripts: number;
  total_landmarks: number;
}

interface CustomerStat {
  customer: string;
  total_calls: number;
  transcripts: number;
  landmarks: number;
}

// ── Stat pill ───────────────────────────────────────────────────────────────

function StatPill({ value, total, label, icon: Icon }: { value: number; total: number; label: string; icon: React.ElementType }) {
  const pct = total > 0 ? value / total : 0;
  const color = pct === 1 ? "text-emerald-400" : pct > 0 ? "text-amber-400" : "text-gray-600";
  return (
    <span className={cn("flex items-center gap-1 text-xs", color)} title={label}>
      <Icon className="w-3 h-3 flex-shrink-0" />
      <span>{value}<span className="text-gray-600">/{total}</span></span>
    </span>
  );
}

// ── Agent Slot ──────────────────────────────────────────────────────────────

function AgentSlot({
  slotLabel,
  agents,
  agent,
  setAgent,
  customers,
  selected,
  toggleCustomer,
  pairStatuses,
  uploadedMap,
  onPrepare,
  onUpload,
  preparing,
  uploading,
  forceUpload,
  agentStats,
  customerStats,
  uploadedAgents,
}: {
  slotLabel: string;
  agents: string[];
  agent: string;
  setAgent: (a: string) => void;
  customers: string[];
  selected: string[];
  toggleCustomer: (c: string) => void;
  pairStatuses: Record<string, PairStatus | null>;
  uploadedMap: Record<string, UploadedPair>;
  onPrepare: (agent: string, customer: string) => void;
  onUpload: (agent: string, customer: string) => void;
  preparing: Set<string>;
  uploading: Set<string>;
  forceUpload: boolean;
  agentStats: AgentStat[];
  customerStats: CustomerStat[];
  uploadedAgents: Set<string>;
}) {
  const [search, setSearch] = useState("");

  const agentStat = agentStats.find(s => s.agent === agent);
  const custStatMap: Record<string, CustomerStat> = {};
  for (const cs of customerStats) custStatMap[cs.customer] = cs;

  const filtered = customers
    .filter(c => c.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const sa = custStatMap[a];
      const sb = custStatMap[b];
      const scoreA = sa ? (sa.transcripts > 0 ? 1 : 0) + (sa.landmarks > 0 ? 1 : 0) : 0;
      const scoreB = sb ? (sb.transcripts > 0 ? 1 : 0) + (sb.landmarks > 0 ? 1 : 0) : 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      const tA = sa?.transcripts ?? 0;
      const tB = sb?.transcripts ?? 0;
      if (tB !== tA) return tB - tA;
      const lA = sa?.landmarks ?? 0;
      const lB = sb?.landmarks ?? 0;
      return lB - lA;
    });

  return (
    <div className="flex-1 bg-gray-800/50 border border-gray-700 rounded-xl p-4 min-w-0 flex flex-col">
      <p className="text-xs font-semibold text-gray-500 tracking-widest mb-3">{slotLabel}</p>

      {/* Agent selector with inline stats per option */}
      <select
        value={agent}
        onChange={e => { setAgent(e.target.value); }}
        className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white mb-1 focus:outline-none focus:border-indigo-500"
      >
        <option value="">— select agent —</option>
        {agents.map(a => {
          const s = agentStats.find(x => x.agent === a);
          const hasGrok = uploadedAgents.has(a);
          const grokTag = hasGrok ? " ✦ Grok" : "";
          const label = s
            ? `${a}${grokTag}  (${s.customers} customers · ${s.total_transcripts}/${s.total_calls} transcripts · ${s.total_landmarks}/${s.total_calls} landmarks)`
            : `${a}${grokTag}`;
          return <option key={a} value={a}>{label}</option>;
        })}
      </select>

      {/* Agent-level summary bar */}
      {agentStat && (
        <div className="flex items-center gap-3 px-1 mb-2 mt-0.5">
          <span className="text-xs text-gray-600">{agentStat.customers} customers</span>
          <StatPill value={agentStat.total_transcripts} total={agentStat.total_calls} label="Transcripts" icon={FileText} />
          <StatPill value={agentStat.total_landmarks} total={agentStat.total_calls} label="Landmarks" icon={Map} />
          {agentStat.customers_with_data > 0 && (
            <span className="text-xs text-gray-600 ml-auto">{agentStat.customers_with_data} with data</span>
          )}
        </div>
      )}

      {/* Search */}
      {agent && customers.length > 0 && (
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${customers.length} customers…`}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-gray-600"
          />
        </div>
      )}

      {agent && filtered.length === 0 && (
        <p className="text-xs text-gray-600 px-1">{search ? "No matches" : "No customers found"}</p>
      )}

      <div className="space-y-1.5 flex-1 overflow-y-auto max-h-[460px] pr-1">
        {filtered.map(c => {
          const key = `${agent}||${c}`;
          const status = pairStatuses[key];
          const cStat = custStatMap[c];
          const uploaded = uploadedMap[key];
          const isSelected = selected.includes(c);
          const isPrep = preparing.has(key);
          const isUpl = uploading.has(key);

          // Prefer live pairStatus if loaded, fall back to customerStats
          const totalCalls = status?.total ?? cStat?.total_calls ?? 0;
          const numT = status?.transcripts ?? cStat?.transcripts ?? 0;
          const numL = status?.landmarks ?? cStat?.landmarks ?? 0;

          const allT = totalCalls > 0 && numT === totalCalls;
          const allL = totalCalls > 0 && numL === totalCalls;
          const missingL = numT > 0 && numL < numT;
          const hasUpload = uploaded?.transcript || uploaded?.landmarks;

          return (
            <div
              key={c}
              onClick={() => toggleCustomer(c)}
              className={cn(
                "rounded-lg border p-3 cursor-pointer transition-colors",
                isSelected ? "border-indigo-500/60 bg-indigo-900/20" : "border-gray-700 bg-gray-800/30 hover:border-gray-600",
              )}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleCustomer(c)}
                  onClick={e => e.stopPropagation()}
                  className="mt-0.5 rounded border-gray-600 accent-indigo-500 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  {/* Name + quick stats on same row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm text-white font-medium truncate flex-1 min-w-0">{c}</p>
                    {totalCalls > 0 && (
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <StatPill value={numT} total={totalCalls} label="Transcripts" icon={FileText} />
                        <StatPill value={numL} total={totalCalls} label="Landmarks" icon={Map} />
                      </div>
                    )}
                    {totalCalls === 0 && (
                      <span className="text-xs text-gray-700 flex-shrink-0">no calls</span>
                    )}
                  </div>

                  {/* Actions (only shown when relevant) */}
                  <div className="mt-1.5 space-y-1.5">
                      {/* Annotate missing landmarks */}
                      {missingL && (
                        <button
                          onClick={e => { e.stopPropagation(); onPrepare(agent, c); }}
                          disabled={isPrep}
                          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-amber-800/40 border border-amber-600/40 text-amber-300 hover:bg-amber-800/60 disabled:opacity-50 transition-colors"
                        >
                          {isPrep ? <Loader2 className="w-3 h-3 animate-spin" /> : <Map className="w-3 h-3" />}
                          {isPrep ? "Running…" : `Annotate ${numT - numL} missing`}
                        </button>
                      )}
                      {totalCalls > 0 && numT === 0 && (
                        <p className="text-xs text-red-400/60">No transcripts — use Quick Run or Pipeline</p>
                      )}

                      {/* Upload status */}
                      {hasUpload ? (
                        <div className="space-y-1">
                          {uploaded.transcript && (
                            <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                              <FileText className="w-3 h-3 flex-shrink-0" />
                              <span className="font-mono truncate max-w-[130px]">{uploaded.transcript.xai_file_id}</span>
                            </div>
                          )}
                          {uploaded.landmarks && (
                            <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                              <Map className="w-3 h-3 flex-shrink-0" />
                              <span className="font-mono truncate max-w-[130px]">{uploaded.landmarks.xai_file_id}</span>
                            </div>
                          )}
                          <button
                            onClick={e => { e.stopPropagation(); onUpload(agent, c); }}
                            disabled={isUpl}
                            className="flex items-center gap-1 text-xs text-gray-600 hover:text-white transition-colors"
                          >
                            {isUpl ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Re-upload
                          </button>
                        </div>
                      ) : isSelected && numT > 0 ? (
                        <button
                          onClick={e => { e.stopPropagation(); onUpload(agent, c); }}
                          disabled={isUpl}
                          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-indigo-800/40 border border-indigo-600/40 text-indigo-300 hover:bg-indigo-800/60 disabled:opacity-50 transition-colors"
                        >
                          {isUpl ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                          {isUpl ? "Uploading…" : "Upload to Grok"}
                        </button>
                      ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function AgentComparisonPage() {
  const { data: agents = [] } = useSWR<string[]>("/api/agent-comparison/agents", fetcher);
  const { data: filesData = [], mutate: mutateFiles } = useSWR<UploadedPair[]>("/api/agent-comparison/files", fetcher, { refreshInterval: 0 });
  const { data: presetsData = [], mutate: mutatePresets } = useSWR<ComparisonPreset[]>("/api/agent-comparison/presets", fetcher);
  const { data: agentStats = [] } = useSWR<AgentStat[]>("/api/agent-comparison/agent-stats", fetcher);

  const [agent1, setAgent1] = useState("Ron Silver");
  const [agent2, setAgent2] = useState("Adam Blum");
  const [selected1, setSelected1] = useState<string[]>([]);
  const [selected2, setSelected2] = useState<string[]>([]);

  const { data: customers1 = [] } = useSWR<string[]>(agent1 ? `/api/agent-comparison/customers?agent=${encodeURIComponent(agent1)}` : null, fetcher);
  const { data: customers2 = [] } = useSWR<string[]>(agent2 ? `/api/agent-comparison/customers?agent=${encodeURIComponent(agent2)}` : null, fetcher);
  const { data: customerStats1 = [] } = useSWR<CustomerStat[]>(agent1 ? `/api/agent-comparison/customer-stats?agent=${encodeURIComponent(agent1)}` : null, fetcher);
  const { data: customerStats2 = [] } = useSWR<CustomerStat[]>(agent2 ? `/api/agent-comparison/customer-stats?agent=${encodeURIComponent(agent2)}` : null, fetcher);

  const [pairStatuses, setPairStatuses] = useState<Record<string, PairStatus | null>>({});
  const [preparing, setPreparing] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<Set<string>>(new Set());

  // Quick Run state
  const [showQuickRun, setShowQuickRun] = useState(false);
  const [smoothModel, setSmoothModel] = useState("gpt-5.4");
  const [landmarksModel, setLandmarksModel] = useState("grok-4.20-0309-non-reasoning");
  const [landmarksPrompt, setLandmarksPrompt] = useState("");
  const [runLandmarks, setRunLandmarks] = useState(true);
  const [forceQuick, setForceQuick] = useState(false);
  const [forceLandmarks, setForceLandmarks] = useState(false);
  const [quickRunId, setQuickRunId] = useState<string | null>(null);
  const [quickRunStatus, setQuickRunStatus] = useState<{ done: number; total: number; current: string; errors: string[]; complete: boolean } | null>(null);
  const [runningQuick, setRunningQuick] = useState(false);

  // Upload
  const [forceUpload, setForceUpload] = useState(false);

  // Query
  const [queryModel, setQueryModel] = useState("grok-4.20-0309-reasoning");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [temperature, setTemperature] = useState(0.0);
  const [querying, setQuerying] = useState(false);
  const [response, setResponse] = useState("");
  const [displayResponse, setDisplayResponse] = useState("");  // may be reformatted
  const [queryError, setQueryError] = useState("");
  const [reformatting, setReformatting] = useState(false);
  const [reformatModel, setReformatModel] = useState("gpt-4.1");

  // Presets
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  // ── Auto-select customers with uploaded Grok files ────────────────────────

  const autoSelected1 = useRef(false);
  const autoSelected2 = useRef(false);

  useEffect(() => {
    if (autoSelected1.current || !agent1 || customers1.length === 0 || filesData.length === 0) return;
    const withUploads = customers1.filter(c => filesData.some(f => f.agent === agent1 && f.customer === c));
    if (withUploads.length > 0) { setSelected1(withUploads); autoSelected1.current = true; }
  }, [agent1, customers1, filesData]);

  useEffect(() => {
    if (autoSelected2.current || !agent2 || customers2.length === 0 || filesData.length === 0) return;
    const withUploads = customers2.filter(c => filesData.some(f => f.agent === agent2 && f.customer === c));
    if (withUploads.length > 0) { setSelected2(withUploads); autoSelected2.current = true; }
  }, [agent2, customers2, filesData]);

  // ── Fetch pair statuses ────────────────────────────────────────────────────

  const fetchStatus = useCallback((agent: string, customer: string) => {
    const key = `${agent}||${customer}`;
    setPairStatuses(prev => ({ ...prev, [key]: null }));
    fetch(`/api/agent-comparison/status?agent=${encodeURIComponent(agent)}&customer=${encodeURIComponent(customer)}`)
      .then(r => r.json())
      .then(data => setPairStatuses(prev => ({ ...prev, [key]: data })))
      .catch(() => {});
  }, []);

  useEffect(() => {
    [...customers1.map(c => ({ agent: agent1, customer: c })),
     ...customers2.map(c => ({ agent: agent2, customer: c }))]
      .filter(({ agent, customer }) => agent && customer)
      .forEach(({ agent, customer }) => {
        const key = `${agent}||${customer}`;
        if (pairStatuses[key] === undefined) fetchStatus(agent, customer);
      });
  }, [customers1, customers2, agent1, agent2]);

  const refreshSelectedStatuses = () => {
    [...selected1.map(c => ({ agent: agent1, customer: c })),
     ...selected2.map(c => ({ agent: agent2, customer: c }))]
      .filter(({ agent }) => agent)
      .forEach(({ agent, customer }) => fetchStatus(agent, customer));
  };

  // ── Quick Run polling ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!quickRunId || !runningQuick) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/api/agent-comparison/quick-run/status?run_id=${quickRunId}`);
        const data = await r.json();
        setQuickRunStatus(data);
        if (data.complete) {
          setRunningQuick(false);
          clearInterval(id);
          refreshSelectedStatuses();
        }
      } catch {}
    }, 2500);
    return () => clearInterval(id);
  }, [quickRunId, runningQuick]);

  // ── Uploaded files map ─────────────────────────────────────────────────────

  const uploadedMap: Record<string, UploadedPair> = {};
  for (const f of filesData) {
    uploadedMap[`${f.agent}||${f.customer}`] = f;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const toggle1 = (c: string) =>
    setSelected1(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);
  const toggle2 = (c: string) =>
    setSelected2(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  const selectedPairs = [
    ...selected1.filter(Boolean).map(c => ({ agent: agent1, customer: c })),
    ...selected2.filter(Boolean).map(c => ({ agent: agent2, customer: c })),
  ].filter(p => p.agent);

  // ── Prepare (landmarks only) ───────────────────────────────────────────────

  const handlePrepare = async (agent: string, customer: string) => {
    const key = `${agent}||${customer}`;
    setPreparing(prev => new Set(prev).add(key));
    try {
      await fetch("/api/agent-comparison/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, customer, model: landmarksModel, extra_prompt: landmarksPrompt }),
      });
      setTimeout(() => {
        fetchStatus(agent, customer);
        setPreparing(prev => { const s = new Set(prev); s.delete(key); return s; });
      }, 8000);
    } catch {
      setPreparing(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  };

  // ── Quick Run ──────────────────────────────────────────────────────────────

  const handleQuickRun = async () => {
    if (selectedPairs.length === 0) return;
    setRunningQuick(true);
    setQuickRunStatus(null);
    try {
      const r = await fetch("/api/agent-comparison/quick-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: selectedPairs,
          smooth_model: smoothModel,
          run_landmarks: runLandmarks,
          landmarks_model: landmarksModel,
          landmarks_prompt: landmarksPrompt,
          force: forceQuick,
          force_landmarks: forceLandmarks,
        }),
      });
      const data = await r.json();
      if (data.run_id) {
        setQuickRunId(data.run_id);
        setQuickRunStatus({ done: 0, total: data.total, current: "", errors: [], complete: false });
      }
    } catch (e: any) {
      setRunningQuick(false);
      alert(`Quick run failed: ${e.message}`);
    }
  };

  // ── Upload ─────────────────────────────────────────────────────────────────

  const handleUpload = async (agent: string, customer: string) => {
    const key = `${agent}||${customer}`;
    setUploading(prev => new Set(prev).add(key));
    try {
      const r = await fetch("/api/agent-comparison/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, customer, force: forceUpload }),
      });
      if (!r.ok) {
        const errText = await r.text();
        let err: any;
        try { err = JSON.parse(errText); } catch { err = { detail: errText }; }
        alert(`Upload failed: ${err.detail || "unknown error"}`);
      } else {
        await mutateFiles();
      }
    } catch (e: any) {
      alert(`Upload error: ${e.message}`);
    } finally {
      setUploading(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  };

  const handleUploadAll = async () => {
    for (const { agent, customer } of selectedPairs) {
      const status = pairStatuses[`${agent}||${customer}`];
      if (status && status.transcripts > 0) await handleUpload(agent, customer);
    }
  };

  // ── Query ──────────────────────────────────────────────────────────────────

  const handleQuery = async () => {
    if (!userPrompt.trim()) return;
    const pairsWithFiles = selectedPairs.filter(p => uploadedMap[`${p.agent}||${p.customer}`]);
    if (pairsWithFiles.length === 0) {
      setQueryError("No uploaded files for selected pairs. Upload files first.");
      return;
    }
    setQuerying(true);
    setResponse("");
    setQueryError("");
    try {
      const r = await fetch("/api/agent-comparison/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairs: pairsWithFiles, system_prompt: systemPrompt, user_prompt: userPrompt, model: queryModel, temperature }),
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { detail: text }; }
      if (!r.ok) setQueryError(data.detail || "Query failed");
      else { setResponse(data.response); setDisplayResponse(data.response); }
    } catch (e: any) {
      setQueryError(e.message);
    } finally {
      setQuerying(false);
    }
  };

  // ── Presets ────────────────────────────────────────────────────────────────

  const savePreset = async () => {
    if (!presetName.trim()) return;
    setSavingPreset(true);
    try {
      await fetch("/api/agent-comparison/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: presetName, model: queryModel, system_prompt: systemPrompt, user_prompt: userPrompt, temperature }),
      });
      await mutatePresets();
      setPresetName("");
    } finally {
      setSavingPreset(false);
    }
  };

  const handleReformat = async () => {
    if (!response) return;
    setReformatting(true);
    try {
      const r = await fetch("/api/agent-comparison/reformat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: response, model: reformatModel }),
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { detail: text }; }
      if (r.ok) setDisplayResponse(data.result);
      else setQueryError(data.detail || "Reformat failed");
    } catch (e: any) {
      setQueryError(e.message);
    } finally {
      setReformatting(false);
    }
  };

  // ── Agents with any Grok file uploaded ───────────────────────────────────────
  const uploadedAgents = new Set(filesData.map(f => f.agent));

  // ── Sort agents: grok uploads first, then transcripts, then nothing ──────────
  const sortedAgents = [...agents].sort((a, b) => {
    const grokA = filesData.some(f => f.agent === a) ? 2 : 0;
    const grokB = filesData.some(f => f.agent === b) ? 2 : 0;
    const statA = agentStats.find(s => s.agent === a);
    const statB = agentStats.find(s => s.agent === b);
    const txA = statA && statA.total_transcripts > 0 ? 1 : 0;
    const txB = statB && statB.total_transcripts > 0 ? 1 : 0;
    const scoreA = grokA + txA;
    const scoreB = grokB + txB;
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Within same tier: more total transcripts first
    return (statB?.total_transcripts ?? 0) - (statA?.total_transcripts ?? 0);
  });

  const uploadedCount = selectedPairs.filter(p => uploadedMap[`${p.agent}||${p.customer}`]).length;
  const quickPct = quickRunStatus ? Math.round((quickRunStatus.done / Math.max(1, quickRunStatus.total)) * 100) : 0;

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Agent Comparison</h1>
          <p className="text-sm text-gray-500 mt-1">
            Select agents &amp; customers → prepare data → upload to Grok → query
          </p>
        </div>

        {/* ── Step 1: Select ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 tracking-widest">STEP 1 — SELECT AGENTS &amp; CUSTOMERS</h2>
          <div className="flex gap-4">
            <AgentSlot slotLabel="AGENT 1" agents={sortedAgents}
              agent={agent1} setAgent={a => { setAgent1(a); setSelected1([]); autoSelected1.current = false; }}
              customers={customers1} selected={selected1} toggleCustomer={toggle1}
              pairStatuses={pairStatuses} uploadedMap={uploadedMap}
              onPrepare={handlePrepare} onUpload={handleUpload}
              preparing={preparing} uploading={uploading} forceUpload={forceUpload}
              agentStats={agentStats} customerStats={customerStats1} uploadedAgents={uploadedAgents}
            />
            <AgentSlot slotLabel="AGENT 2" agents={sortedAgents}
              agent={agent2} setAgent={a => { setAgent2(a); setSelected2([]); autoSelected2.current = false; }}
              customers={customers2} selected={selected2} toggleCustomer={toggle2}
              pairStatuses={pairStatuses} uploadedMap={uploadedMap}
              onPrepare={handlePrepare} onUpload={handleUpload}
              preparing={preparing} uploading={uploading} forceUpload={forceUpload}
              agentStats={agentStats} customerStats={customerStats2} uploadedAgents={uploadedAgents}
            />
          </div>
        </section>

        {/* ── Step 2: Quick Run ── */}
        {selectedPairs.length > 0 && (
          <section className="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowQuickRun(v => !v)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-800/40 transition-colors"
            >
              <div className="flex items-center gap-3">
                <h2 className="text-xs font-semibold text-gray-400 tracking-widest">STEP 2 — QUICK RUN</h2>
                <span className="text-xs text-gray-600">
                  EL transcription + smooth + landmarks for {selectedPairs.length} pair{selectedPairs.length > 1 ? "s" : ""}
                </span>
              </div>
              {showQuickRun ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
            </button>

            {showQuickRun && (
              <div className="px-5 pb-5 space-y-4 border-t border-gray-700/50">
                {/* Options */}
                <div className="flex flex-wrap gap-3 pt-4 items-end">
                  <div className="min-w-40">
                    <label className="block text-xs text-gray-500 mb-1">Smooth model</label>
                    <select value={smoothModel} onChange={e => setSmoothModel(e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                      {SMOOTH_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                  <div className="min-w-40">
                    <label className="block text-xs text-gray-500 mb-1">Landmarks model</label>
                    <select value={landmarksModel} onChange={e => setLandmarksModel(e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                      {LANDMARK_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                  <div className="flex-1 min-w-48">
                    <label className="block text-xs text-gray-500 mb-1">Landmarks extra prompt (optional)</label>
                    <input value={landmarksPrompt} onChange={e => setLandmarksPrompt(e.target.value)}
                      placeholder="e.g. Focus on deposit discussions"
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 items-center">
                  <label className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs transition-colors",
                    runLandmarks ? "border-indigo-600/50 bg-indigo-900/20 text-indigo-300" : "border-gray-700 text-gray-500")}>
                    <input type="checkbox" checked={runLandmarks} onChange={e => setRunLandmarks(e.target.checked)}
                      className="rounded border-gray-600 accent-indigo-500" />
                    Run landmarks
                  </label>
                  <label className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs transition-colors",
                    forceQuick ? "border-amber-600/50 bg-amber-900/20 text-amber-300" : "border-gray-700 text-gray-500")}>
                    <input type="checkbox" checked={forceQuick} onChange={e => setForceQuick(e.target.checked)}
                      className="rounded border-gray-600 accent-amber-500" />
                    Force re-transcribe
                  </label>
                  <label className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer text-xs transition-colors",
                    forceLandmarks ? "border-amber-600/50 bg-amber-900/20 text-amber-300" : "border-gray-700 text-gray-500")}>
                    <input type="checkbox" checked={forceLandmarks} onChange={e => setForceLandmarks(e.target.checked)}
                      className="rounded border-gray-600 accent-amber-500" />
                    Force re-annotate
                  </label>

                  <button
                    onClick={handleQuickRun}
                    disabled={runningQuick || selectedPairs.length === 0}
                    className="ml-auto flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                  >
                    {runningQuick ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    {runningQuick ? "Running…" : `Quick Run ${selectedPairs.length} pair${selectedPairs.length > 1 ? "s" : ""}`}
                  </button>
                </div>

                {/* Progress */}
                {quickRunStatus && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span>{quickRunStatus.complete ? "Complete" : quickRunStatus.current ? `Processing: ${quickRunStatus.current}` : "Starting…"}</span>
                      <span>{quickRunStatus.done} / {quickRunStatus.total}</span>
                    </div>
                    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all duration-500", quickRunStatus.complete ? "bg-emerald-500" : "bg-indigo-500")}
                        style={{ width: `${quickPct}%` }}
                      />
                    </div>
                    {quickRunStatus.errors.length > 0 && (
                      <div className="text-xs text-red-400 space-y-0.5">
                        {quickRunStatus.errors.map((e, i) => <p key={i}>{e}</p>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── Step 3: Upload ── */}
        {selectedPairs.length > 0 && (
          <section className="bg-gray-800/50 border border-gray-700 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-gray-400 tracking-widest">STEP 3 — UPLOAD TO GROK</h2>
              <div className="flex items-center gap-3">
                <label className={cn("flex items-center gap-2 px-2.5 py-1.5 rounded-lg border cursor-pointer text-xs transition-colors",
                  forceUpload ? "bg-amber-900/20 border-amber-600/50 text-amber-300" : "bg-gray-800 border-gray-700 text-gray-500")}>
                  <input type="checkbox" checked={forceUpload} onChange={e => setForceUpload(e.target.checked)}
                    className="rounded border-gray-600 accent-amber-500" />
                  Force re-upload
                </label>
                <button onClick={handleUploadAll}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors">
                  <Upload className="w-3.5 h-3.5" /> Upload All
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {selectedPairs.map(({ agent, customer }) => {
                const key = `${agent}||${customer}`;
                const uploaded = uploadedMap[key];
                const status = pairStatuses[key];
                const isUpl = uploading.has(key);
                return (
                  <div key={key} className="bg-gray-800 rounded-lg px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm text-white font-medium truncate">{agent}</p>
                        <p className="text-xs text-gray-400 truncate">{customer}</p>
                      </div>
                      {!uploaded && (
                        <button onClick={() => handleUpload(agent, customer)}
                          disabled={isUpl || !status || status.transcripts === 0}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-700/50 border border-indigo-600/50 text-indigo-300 text-xs hover:bg-indigo-700 disabled:opacity-40 transition-colors ml-2">
                          {isUpl ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                          {isUpl ? "…" : "Upload"}
                        </button>
                      )}
                      {uploaded && (
                        <button onClick={() => handleUpload(agent, customer)} disabled={isUpl}
                          title="Re-upload" className="text-gray-600 hover:text-white transition-colors ml-2">
                          {isUpl ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>

                    {uploaded ? (
                      <div className="space-y-1">
                        {uploaded.transcript && (
                          <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                            <FileText className="w-3 h-3 flex-shrink-0" />
                            <span className="text-gray-500">transcript</span>
                            <span className="font-mono truncate">{uploaded.transcript.xai_file_id}</span>
                          </div>
                        )}
                        {uploaded.landmarks && (
                          <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                            <Map className="w-3 h-3 flex-shrink-0" />
                            <span className="text-gray-500">landmarks</span>
                            <span className="font-mono truncate">{uploaded.landmarks.xai_file_id}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-gray-600">Not uploaded</p>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-gray-600">{uploadedCount} / {selectedPairs.length} pairs uploaded to Grok</p>
          </section>
        )}

        {/* ── Step 4: Query ── */}
        <section className="bg-gray-800/50 border border-gray-700 rounded-xl p-5 space-y-4">
          <h2 className="text-xs font-semibold text-gray-400 tracking-widest">STEP 4 — QUERY GROK</h2>

          <div className="flex flex-wrap gap-3 items-end">
            {/* Model */}
            <div className="min-w-48">
              <label className="block text-xs text-gray-500 mb-1">Model</label>
              <select value={queryModel} onChange={e => setQueryModel(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                {GROK_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>

            {/* Temperature */}
            <div className="w-32">
              <label className="block text-xs text-gray-500 mb-1">Temperature — {temperature.toFixed(1)}</label>
              <input
                type="range" min={0} max={1} step={0.1}
                value={temperature}
                onChange={e => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>

            {/* Presets */}
            <div className="flex items-end gap-2 flex-1 min-w-0">
              <div className="relative flex-1 min-w-40">
                <label className="block text-xs text-gray-500 mb-1">Presets</label>
                <button onClick={() => setShowPresets(v => !v)}
                  className="w-full flex items-center justify-between bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white hover:border-indigo-500 transition-colors">
                  <span className="text-gray-400">Select preset…</span>
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                </button>
                {showPresets && (
                  <div className="absolute top-full left-0 mt-1 w-72 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-50 overflow-hidden">
                    {presetsData.length === 0 ? (
                      <p className="px-3 py-3 text-xs text-gray-500">No presets saved yet</p>
                    ) : (
                      presetsData.map(p => (
                        <div key={p.name} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 group">
                          <button onClick={() => { setQueryModel(p.model); setSystemPrompt(p.system_prompt); setUserPrompt(p.user_prompt ?? ""); setTemperature(p.temperature ?? 0.0); setShowPresets(false); }}
                            className="flex-1 text-left text-sm text-white truncate">{p.name}</button>
                          {p.is_default && <Star className="w-3 h-3 text-yellow-400 flex-shrink-0" />}
                          <button onClick={async () => {
                            await fetch(`/api/agent-comparison/presets/${encodeURIComponent(p.name)}/default`, { method: "PATCH" });
                            mutatePresets();
                          }} title="Set default" className="text-gray-600 hover:text-yellow-400 transition-colors opacity-0 group-hover:opacity-100">
                            <Star className="w-3 h-3" />
                          </button>
                          <button onClick={async () => {
                            await fetch(`/api/agent-comparison/presets/${encodeURIComponent(p.name)}`, { method: "DELETE" });
                            mutatePresets();
                          }} title="Delete" className="text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-1.5 items-end pb-px">
                <input value={presetName} onChange={e => setPresetName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && savePreset()}
                  placeholder="Preset name…"
                  className="bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 w-36" />
                <button onClick={savePreset} disabled={!presetName.trim() || savingPreset}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-700 border border-gray-600 text-xs text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-40 transition-colors">
                  {savingPreset ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bookmark className="w-3.5 h-3.5" />}
                  Save
                </button>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">System prompt (optional)</label>
            <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={3}
              placeholder="You are a financial compliance analyst comparing two sales agents…"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 resize-y placeholder:text-gray-600" />
          </div>

          <div>
            <label className="block text-xs text-gray-500 mb-1">Your question / prompt</label>
            <textarea value={userPrompt} onChange={e => setUserPrompt(e.target.value)} rows={5}
              placeholder="Compare the sales tactics and compliance behaviour of these two agents across their customer interactions…"
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 resize-y placeholder:text-gray-600" />
          </div>

          <div className="flex items-center gap-3">
            <button onClick={handleQuery}
              disabled={querying || !userPrompt.trim() || uploadedCount === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-medium text-sm transition-colors">
              {querying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {querying ? "Querying Grok…" : "Send to Grok"}
            </button>
            {uploadedCount === 0 && selectedPairs.length > 0 && (
              <p className="text-xs text-amber-400">Upload files first (Step 3)</p>
            )}
            {selectedPairs.length === 0 && (
              <p className="text-xs text-gray-600">Select customers in Step 1</p>
            )}
          </div>

          {queryError && (
            <div className="flex items-start gap-2 bg-red-900/20 border border-red-600/30 rounded-lg px-4 py-3 text-sm text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {queryError}
            </div>
          )}
        </section>

        {/* Response */}
        {response && (
          <section className="bg-gray-800/50 border border-gray-700 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-xs font-semibold text-gray-400 tracking-widest">GROK RESPONSE</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Reformat model selector */}
                <select
                  value={reformatModel}
                  onChange={e => setReformatModel(e.target.value)}
                  className="bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="gpt-4.1">GPT-4.1</option>
                  <option value="gpt-5.4">GPT-5.4</option>
                  <option value="claude-opus-4-6">Claude Opus 4.6</option>
                  <option value="grok-4.20-0309-non-reasoning">Grok 4.20 Fast</option>
                </select>
                <button
                  onClick={handleReformat}
                  disabled={reformatting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-700/60 border border-violet-600/50 text-violet-200 text-xs hover:bg-violet-700 disabled:opacity-50 transition-colors"
                >
                  {reformatting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  {reformatting ? "Reformatting…" : "Nice View"}
                </button>
                {displayResponse !== response && (
                  <button
                    onClick={() => setDisplayResponse(response)}
                    className="text-xs text-gray-600 hover:text-gray-300 transition-colors"
                  >
                    Raw
                  </button>
                )}
                <button onClick={() => navigator.clipboard.writeText(displayResponse)}
                  className="text-xs text-gray-600 hover:text-white transition-colors">Copy</button>
              </div>
            </div>
            <div className="min-w-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{displayResponse}</ReactMarkdown>
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
