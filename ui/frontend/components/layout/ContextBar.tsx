"use client";
import { useAppCtx } from "@/lib/app-context";
import useSWR from "swr";
import { X, ChevronDown, Bot, Workflow, Loader2, PhoneCall, FileText } from "lucide-react";
import { useRef, useState, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import ContextTopBar from "@/components/shared/ContextTopBar";

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface UniversalAgent {
  id: string;
  name: string;
  agent_class: string;
  is_default: boolean;
}

interface Pipeline {
  id: string;
  name: string;
  scope: string;
  steps: { agent_id: string }[];
}

interface NavCustomerOption {
  customer: string;
  call_count: number;
}

type CallDatesMap = Record<string, { date: string; has_audio: boolean }>;
interface CRMCallLite {
  call_id: string;
  date?: string;
  duration?: number;
}
interface FinalTranscriptCall {
  call_id: string;
  has_llm_voted?: boolean;
  has_llm_smoothed?: boolean;
  has_pipeline_final?: boolean;
  pipeline_final_files?: Array<{ path?: string }>;
  voted_path?: string | null;
  smoothed_path?: string | null;
  final_path?: string | null;
  started_at?: string | null;
}

function normalizeCallId(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase();
}

// ── Universal Agent Picker ─────────────────────────────────────────────────────
function AgentPicker({
  activeId,
  activeName,
  agents,
  onSelect,
  onClear,
}: {
  activeId: string;
  activeName: string;
  agents: UniversalAgent[] | undefined;
  onSelect: (agent: UniversalAgent) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Determine display state
  const loaded = agents !== undefined;
  const notFound = loaded && activeId && !agents.find(a => a.id === activeId);
  const label = notFound ? "not found" : (activeName || "none");

  // Group agents by agent_class
  const grouped: Record<string, UniversalAgent[]> = {};
  for (const a of agents ?? []) {
    const cls = a.agent_class || "general";
    if (!grouped[cls]) grouped[cls] = [];
    grouped[cls].push(a);
  }
  const classes = Object.keys(grouped).sort();

  return (
    <div className="relative shrink-0 flex items-center gap-1" ref={ref}>
      <span className="text-[10px] text-gray-600 font-medium">Agent</span>
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors",
          notFound
            ? "bg-red-950/40 border-red-800/60 text-red-400 hover:bg-red-950/60"
            : activeId
            ? "bg-violet-900/50 border-violet-700/60 text-violet-300 hover:bg-violet-900/70"
            : "bg-gray-800/60 border-gray-700/60 text-gray-500 hover:text-gray-300 hover:bg-gray-800"
        )}
      >
        <Bot className="w-2.5 h-2.5 shrink-0" />
        <span className="max-w-[130px] truncate">{label}</span>
        <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-60" />
      </button>
      {activeId && (
        <button onClick={onClear} className="text-gray-600 hover:text-gray-400 transition-colors -ml-0.5">
          <X className="w-2.5 h-2.5" />
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden max-h-80 overflow-y-auto">
          <p className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800 sticky top-0 bg-gray-900">
            Active Agent
          </p>
          {activeId && (
            <button
              onClick={() => { onClear(); setOpen(false); }}
              className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
            >
              — Clear
            </button>
          )}
          {loaded && (agents ?? []).length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-600 text-center">
              No agents yet. Create one in <span className="text-violet-400">Pipelines</span>.
            </p>
          )}
          {!loaded && (
            <p className="px-3 py-3 text-xs text-gray-600 text-center">Loading…</p>
          )}
          {classes.map(cls => (
            <div key={cls}>
              <p className="px-3 pt-2 pb-0.5 text-[9px] text-gray-600 uppercase tracking-widest font-bold">
                {cls}
              </p>
              {grouped[cls].map(agent => (
                <button
                  key={agent.id}
                  onClick={() => { onSelect(agent); setOpen(false); }}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-xs flex items-center justify-between transition-colors",
                    activeId === agent.id
                      ? "bg-violet-900/40 text-violet-300"
                      : "text-gray-300 hover:bg-gray-800 hover:text-white"
                  )}
                >
                  <span className="truncate">{agent.name}</span>
                  {agent.is_default && (
                    <span className="text-[10px] text-gray-600 shrink-0 ml-1">default</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pipeline Picker ────────────────────────────────────────────────────────────
function PipelinePicker({
  activeId,
  activeName,
  pipelines,
  onSelect,
  onClear,
}: {
  activeId: string;
  activeName: string;
  pipelines: Pipeline[] | undefined;
  onSelect: (p: Pipeline) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const loaded = pipelines !== undefined;
  const notFound = loaded && activeId && !pipelines.find(p => p.id === activeId);
  const label = notFound ? "not found" : (activeName || "none");

  return (
    <div className="relative shrink-0 flex items-center gap-1" ref={ref}>
      <span className="text-[10px] text-gray-600 font-medium">Pipeline</span>
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors",
          notFound
            ? "bg-red-950/40 border-red-800/60 text-red-400 hover:bg-red-950/60"
            : activeId
            ? "bg-teal-900/50 border-teal-700/60 text-teal-300 hover:bg-teal-900/70"
            : "bg-gray-800/60 border-gray-700/60 text-gray-500 hover:text-gray-300 hover:bg-gray-800"
        )}
      >
        <Workflow className="w-2.5 h-2.5 shrink-0" />
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-60" />
      </button>
      {activeId && (
        <button onClick={onClear} className="text-gray-600 hover:text-gray-400 transition-colors -ml-0.5">
          <X className="w-2.5 h-2.5" />
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden max-h-72 overflow-y-auto">
          <p className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800 sticky top-0 bg-gray-900">
            Active Pipeline
          </p>
          {activeId && (
            <button
              onClick={() => { onClear(); setOpen(false); }}
              className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
            >
              — Clear
            </button>
          )}
          {loaded && (pipelines ?? []).length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-600 text-center">
              No pipelines yet. Create one in <span className="text-teal-400">Pipelines</span>.
            </p>
          )}
          {!loaded && (
            <p className="px-3 py-3 text-xs text-gray-600 text-center">Loading…</p>
          )}
          {(pipelines ?? []).map(p => (
            <button
              key={p.id}
              onClick={() => { onSelect(p); setOpen(false); }}
              className={cn(
                "w-full px-3 py-1.5 text-left text-xs flex items-center justify-between transition-colors",
                activeId === p.id
                  ? "bg-teal-900/40 text-teal-300"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              )}
            >
              <span className="truncate">{p.name}</span>
              <span className="text-[9px] text-gray-600 shrink-0 ml-1">{p.steps?.length ?? 0}s</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ContextBar ─────────────────────────────────────────────────────────────────
export function ContextBar() {
  const {
    salesAgent, customer, callId,
    activeAgentId, activeAgentName,
    activePipelineId, activePipelineName,
    setCustomer, setCallId,
    setActiveAgent, setActivePipeline,
  } = useAppCtx();
  const [showCrmPanel, setShowCrmPanel] = useState(false);
  const [showCallsPanel, setShowCallsPanel] = useState(false);
  const [callTranscriptText, setCallTranscriptText] = useState("");
  const [callTranscriptLoading, setCallTranscriptLoading] = useState(false);
  const [callTranscriptError, setCallTranscriptError] = useState("");

  const { data: agents }    = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);
  const { data: pipelines } = useSWR<Pipeline[]>("/api/pipelines", fetcher);
  const { data: navCustomers } = useSWR<NavCustomerOption[]>(
    salesAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(salesAgent)}` : null,
    fetcher,
  );
  const { data: callDates } = useSWR<CallDatesMap>(
    salesAgent && customer
      ? `/api/crm/call-dates?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
  );
  const { data: crmCalls } = useSWR<CRMCallLite[]>(
    salesAgent && customer
      ? `/api/crm/calls-by-pair?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
  );
  const { data: transcriptCalls } = useSWR<FinalTranscriptCall[]>(
    salesAgent && customer
      ? `/api/final-transcript/calls?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
  );

  const crmPanelUrl = useMemo(() => {
    const qp = new URLSearchParams({ embedded: "1", mode: "pick_pair" });
    if (salesAgent) qp.set("agent", salesAgent);
    if (customer) qp.set("customer", customer);
    return `/crm?${qp.toString()}`;
  }, [salesAgent, customer]);

  const crmCallsSafe: CRMCallLite[] = Array.isArray(crmCalls) ? crmCalls : [];
  const transcriptCallsSafe: FinalTranscriptCall[] = Array.isArray(transcriptCalls) ? transcriptCalls : [];

  const callsMerged = useMemo(() => {
    const byNorm = new Map<string, { call_id: string; date: string; duration_s: number }>();
    crmCallsSafe.forEach((c) => {
      const raw = String(c.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (!norm) return;
      byNorm.set(norm, {
        call_id: raw,
        date: String(c.date || ""),
        duration_s: Number(c.duration || 0),
      });
    });
    transcriptCallsSafe.forEach((t) => {
      const raw = String(t.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (!norm || byNorm.has(norm)) return;
      byNorm.set(norm, {
        call_id: raw,
        date: String(t.started_at || ""),
        duration_s: 0,
      });
    });
    const list = Array.from(byNorm.values()).map((row) => {
      const fromDates = callDates?.[row.call_id];
      return {
        ...row,
        date: String(fromDates?.date || row.date || ""),
      };
    });
    list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return list;
  }, [crmCallsSafe, transcriptCallsSafe, callDates]);

  const transcriptCallMapByNorm = useMemo(() => {
    const out = new Map<string, FinalTranscriptCall>();
    for (const c of transcriptCallsSafe) {
      const key = normalizeCallId(c.call_id);
      if (!key || out.has(key)) continue;
      out.set(key, c);
    }
    return out;
  }, [transcriptCallsSafe]);

  const openCrmOverlay = () => {
    setShowCrmPanel(true);
    setShowCallsPanel(false);
  };

  const openCallsOverlay = () => {
    if (!salesAgent || !customer) return;
    setShowCallsPanel(true);
    setShowCrmPanel(false);
  };

  useEffect(() => {
    if (agents && activeAgentId && !agents.find(a => a.id === activeAgentId)) {
      setActiveAgent("", "", "");
    }
  }, [agents, activeAgentId, setActiveAgent]);

  useEffect(() => {
    if (pipelines && activePipelineId && !pipelines.find(p => p.id === activePipelineId)) {
      setActivePipeline("", "");
    }
  }, [pipelines, activePipelineId, setActivePipeline]);

  useEffect(() => {
    if (!salesAgent || !customer || !navCustomers) return;
    if (!navCustomers.some(c => c.customer === customer)) setCustomer("");
  }, [salesAgent, customer, navCustomers, setCustomer]);

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      const payload = ev?.data;
      if (!payload || typeof payload !== "object") return;
      const type = String((payload as any).type || "");
      if (type === "crm:pair-selected") {
        const nextAgent = String((payload as any).agent || "").trim();
        const nextCustomer = String((payload as any).customer || "").trim();
        if (!nextAgent || !nextCustomer) return;
        setCustomer(nextCustomer, nextAgent);
        setShowCrmPanel(false);
        setShowCallsPanel(false);
        return;
      }
      if (type === "crm:call-selected") {
        const nextAgent = String((payload as any).agent || "").trim();
        const nextCustomer = String((payload as any).customer || "").trim();
        const nextCallId = String((payload as any).call_id || "").trim();
        if (nextAgent && nextCustomer && (nextAgent !== salesAgent || nextCustomer !== customer)) {
          setCustomer(nextCustomer, nextAgent);
        }
        setCallId(nextCallId);
        if (nextCallId) setShowCallsPanel(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [customer, salesAgent, setCallId, setCustomer]);

  useEffect(() => {
    if (!showCallsPanel) return;
    if (!salesAgent || !customer || !callId) {
      setCallTranscriptText("");
      setCallTranscriptError("");
      setCallTranscriptLoading(false);
      return;
    }
    const txCall = transcriptCallMapByNorm.get(normalizeCallId(callId));
    const txPath =
      txCall?.final_path
      || txCall?.smoothed_path
      || txCall?.voted_path
      || txCall?.pipeline_final_files?.[0]?.path
      || "";
    if (!txPath) {
      setCallTranscriptText("");
      setCallTranscriptError("No transcript found for this call.");
      setCallTranscriptLoading(false);
      return;
    }
    let cancelled = false;
    setCallTranscriptLoading(true);
    setCallTranscriptError("");
    fetch(`/api/final-transcript/by-path?path=${encodeURIComponent(txPath)}`)
      .then((r) => r.text())
      .then((txt) => {
        if (cancelled) return;
        setCallTranscriptText(String(txt || ""));
      })
      .catch(() => {
        if (cancelled) return;
        setCallTranscriptText("");
        setCallTranscriptError("Error loading transcript.");
      })
      .finally(() => {
        if (!cancelled) setCallTranscriptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showCallsPanel, salesAgent, customer, callId, transcriptCallMapByNorm]);

  return (
    <div className="border-b border-gray-800 bg-gray-900/90 shrink-0">
      <ContextTopBar
        salesAgent={salesAgent}
        customer={customer}
        callId={callId}
        onOpenCrm={openCrmOverlay}
        onOpenCalls={openCallsOverlay}
      />
      <div className="px-4 py-1.5 flex items-center gap-3 text-xs border-t border-gray-800/60">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide shrink-0">Execution</span>
        {!activePipelineId && (
          <AgentPicker
            activeId={activeAgentId}
            activeName={activeAgentName}
            agents={agents}
            onSelect={a => setActiveAgent(a.id, a.name, a.agent_class)}
            onClear={() => setActiveAgent("", "", "")}
          />
        )}
        <PipelinePicker
          activeId={activePipelineId}
          activeName={activePipelineName}
          pipelines={pipelines}
          onSelect={p => setActivePipeline(p.id, p.name)}
          onClear={() => setActivePipeline("", "")}
        />
      </div>

      {showCallsPanel && (
        <div className="fixed inset-0 z-[80] bg-black p-3 flex items-center justify-center">
          <div className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-indigo-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible">
            <button
              onClick={() => setShowCallsPanel(false)}
              className="absolute -top-6 left-1/2 -translate-x-1/2 z-40 h-12 w-12 rounded-full border-2 border-red-300/80 bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center shadow-2xl"
              title="Close Calls panel"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="h-full w-full rounded-[inherit] overflow-hidden">
              <div className="h-12 px-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
                <PhoneCall className="w-4 h-4 text-amber-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-white font-semibold truncate">Calls</p>
                  <p className="text-[10px] text-gray-500 truncate">
                    {salesAgent || "Agent"} · {customer || "Customer"} · {callId ? `Call ${callId}` : "No call selected"}
                  </p>
                </div>
              </div>
              <div className="h-[calc(100%-3rem)] min-h-0 grid grid-cols-1 lg:grid-cols-12">
                <section className="lg:col-span-4 border-r border-gray-800 min-h-0 flex flex-col">
                  <div className="h-10 px-3 border-b border-gray-800 flex items-center">
                    <p className="text-[11px] font-semibold text-gray-200">Call IDs</p>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {callsMerged.length === 0 && (
                      <p className="text-xs text-gray-500 italic px-1 py-2">
                        Select sales agent + customer to load calls.
                      </p>
                    )}
                    {callsMerged.map((row) => {
                      const cid = row.call_id;
                      const selected = normalizeCallId(cid) === normalizeCallId(callId);
                      const txCall = transcriptCallMapByNorm.get(normalizeCallId(cid));
                      const hasTranscript = !!(
                        txCall?.final_path
                        || txCall?.smoothed_path
                        || txCall?.voted_path
                        || txCall?.pipeline_final_files?.[0]?.path
                      );
                      return (
                        <button
                          key={cid}
                          onClick={() => setCallId(cid)}
                          className={cn(
                            "w-full text-left px-2.5 py-2 rounded-lg border transition-colors",
                            selected
                              ? "border-amber-600/70 bg-amber-900/30"
                              : "border-gray-800 bg-gray-900 hover:bg-gray-800",
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs font-mono text-gray-100 truncate flex-1">{cid}</p>
                            {hasTranscript && (
                              <span
                                title="Transcript available"
                                className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-teal-700/60 bg-teal-900/35 text-teal-300"
                              >
                                <FileText className="h-3 w-3" />
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-gray-500 truncate">
                            {row.date ? String(row.date).slice(0, 10) : "Unknown date"}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section className="lg:col-span-8 min-h-0 flex flex-col">
                  <div className="h-10 px-3 border-b border-gray-800 flex items-center">
                    <p className="text-[11px] font-semibold text-gray-200">Transcript</p>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {!callId ? (
                      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                        Select a Call ID to preview transcript.
                      </div>
                    ) : callTranscriptLoading ? (
                      <div className="h-full flex items-center justify-center gap-2 text-gray-400 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading transcript…
                      </div>
                    ) : callTranscriptError ? (
                      <div className="h-full flex items-center justify-center text-red-300 text-sm px-4 text-center">
                        {callTranscriptError}
                      </div>
                    ) : callTranscriptText ? (
                      <div className="h-full p-2">
                        <TranscriptViewer content={callTranscriptText} format="txt" className="h-full" />
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                        No transcript content.
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCrmPanel && (
        <div className="fixed inset-0 z-[80] bg-black p-3 flex items-center justify-center">
          <div className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-cyan-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible">
            <button
              onClick={() => setShowCrmPanel(false)}
              className="absolute -top-6 left-1/2 -translate-x-1/2 z-40 h-12 w-12 rounded-full border-2 border-red-300/80 bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center shadow-2xl"
              title="Close CRM panel"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="h-full w-full rounded-[inherit] overflow-hidden">
              <iframe
                title="CRM Browser"
                src={crmPanelUrl}
                className="w-full h-full border-0 bg-gray-900"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
