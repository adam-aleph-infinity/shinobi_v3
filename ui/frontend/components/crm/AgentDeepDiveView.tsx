"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useAppCtx } from "@/lib/app-context";
import { cn, formatDuration } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import {
  BarChart3,
  Bot,
  ChevronRight,
  FileText,
  Loader2,
  PhoneCall,
  ShieldCheck,
  StickyNote,
  User,
  Users,
  Workflow,
  X,
} from "lucide-react";

type AgentDeepDiveViewProps = {
  title?: string;
  subtitle?: string;
};

type PipelineLite = { id: string; name: string };
type PipelineDef = {
  id: string;
  name?: string;
  steps?: Array<Record<string, any>>;
  canvas?: Record<string, any>;
};

type CallDatesMap = Record<string, { date?: string; has_audio?: boolean }>;
type CRMCallLite = {
  call_id: string;
  date?: string;
  duration?: number;
};
type FinalTranscriptCall = {
  call_id: string;
  has_llm_voted?: boolean;
  has_llm_smoothed?: boolean;
  has_pipeline_final?: boolean;
  pipeline_final_files?: Array<{ path?: string }>;
  voted_path?: string | null;
  smoothed_path?: string | null;
  final_path?: string | null;
  started_at?: string | null;
  duration_s?: number | null;
};

type PipelineArtifactState = {
  artifact_types?: string[];
};

type PipelineArtifactStatus = {
  calls: Record<string, PipelineArtifactState>;
};

type PipelineRunLite = {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  sales_agent: string;
  customer: string;
  call_id: string;
  started_at?: string | null;
  status: string;
  steps_json: string;
};

type ScopeAgg = {
  scope: string;
  key: string;
  runs: number;
  done: number;
  running: number;
  error: number;
  notes: number;
  personas: number;
  scores: number;
  compliance: number;
  other: number;
  totalArtifacts: number;
  lastRunAt: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function normalizeCallId(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase();
}

function classifyArtifactType(rawType: string): keyof Omit<ScopeAgg, "scope" | "key" | "runs" | "done" | "running" | "error" | "totalArtifacts" | "lastRunAt"> {
  const t = String(rawType || "").trim().toLowerCase();
  if (!t) return "other";
  if ((t.includes("notes") || t.includes("note")) && !t.includes("compliance")) return "notes";
  if (t.includes("persona") && !t.includes("score")) return "personas";
  if (t.includes("score")) return "scores";
  if (t.includes("compliance") || t.includes("violation")) return "compliance";
  return "other";
}

function normalizeArtifactType(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

function getArtifactIconMeta(type: string): {
  label: string;
  icon: any;
  className: string;
} {
  const key = normalizeArtifactType(type);
  if (key === "persona") {
    return { label: "Persona artifact", icon: User, className: "border-fuchsia-700/60 bg-fuchsia-900/35 text-fuchsia-300" };
  }
  if (key === "persona_score") {
    return { label: "Score artifact", icon: BarChart3, className: "border-amber-700/60 bg-amber-900/35 text-amber-300" };
  }
  if (key === "notes") {
    return { label: "Notes artifact", icon: StickyNote, className: "border-indigo-700/60 bg-indigo-900/35 text-indigo-300" };
  }
  if (key === "notes_compliance") {
    return { label: "Compliance artifact", icon: ShieldCheck, className: "border-emerald-700/60 bg-emerald-900/35 text-emerald-300" };
  }
  return { label: "Artifact", icon: Bot, className: "border-violet-700/60 bg-violet-900/35 text-violet-300" };
}

function formatDateLabel(raw?: string): string {
  const dt = raw ? new Date(raw) : null;
  if (!dt || Number.isNaN(dt.getTime())) return "Unknown date";
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export default function AgentDeepDiveView({
  title = "Agent Deep Dive",
  subtitle = "Artifact matrix by context scope",
}: AgentDeepDiveViewProps) {
  const {
    salesAgent,
    customer,
    callId,
    activePipelineId,
    activePipelineName,
    setCustomer,
    setCallId,
    setActivePipeline,
  } = useAppCtx();

  const [showCrmPanel, setShowCrmPanel] = useState(false);
  const [showCallsPanel, setShowCallsPanel] = useState(false);
  const [callTranscriptText, setCallTranscriptText] = useState("");
  const [callTranscriptLoading, setCallTranscriptLoading] = useState(false);
  const [callTranscriptError, setCallTranscriptError] = useState("");

  const { data: pipelines } = useSWR<PipelineLite[]>("/api/pipelines", fetcher);
  const { data: pipelineDef } = useSWR<PipelineDef>(
    activePipelineId ? `/api/pipelines/${encodeURIComponent(activePipelineId)}` : null,
    fetcher,
  );
  const { data: pipelineRuns } = useSWR<PipelineRunLite[]>(
    activePipelineId ? `/api/pipelines/${encodeURIComponent(activePipelineId)}/runs?limit=500` : null,
    fetcher,
    { refreshInterval: 10000 },
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

  const callIdsForStatus = useMemo(() => {
    const byNorm = new Map<string, string>();
    (crmCalls ?? []).forEach((c) => {
      const raw = String(c.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, raw);
    });
    (transcriptCalls ?? []).forEach((t) => {
      const raw = String(t.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, raw);
    });
    return Array.from(byNorm.values()).join(",");
  }, [crmCalls, transcriptCalls]);

  const { data: pipelineArtifactStatus } = useSWR<PipelineArtifactStatus>(
    activePipelineId && salesAgent && customer
      ? `/api/pipelines/${encodeURIComponent(activePipelineId)}/artifact-status?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}${callIdsForStatus ? `&call_ids=${encodeURIComponent(callIdsForStatus)}` : ""}`
      : null,
    fetcher,
    { refreshInterval: 10000 },
  );

  const crmPanelUrl = useMemo(() => {
    const qp = new URLSearchParams({ embedded: "1", mode: "pick_pair" });
    if (salesAgent) qp.set("agent", salesAgent);
    if (customer) qp.set("customer", customer);
    return `/crm?${qp.toString()}`;
  }, [salesAgent, customer]);

  const callsMerged = useMemo(() => {
    const byNorm = new Map<
      string,
      { call_id: string; date: string; duration_s: number }
    >();
    (crmCalls ?? []).forEach((c) => {
      const raw = String(c.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (!norm) return;
      byNorm.set(norm, {
        call_id: raw,
        date: String(c.date || ""),
        duration_s: Number(c.duration || 0),
      });
    });
    (transcriptCalls ?? []).forEach((t) => {
      const raw = String(t.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (!norm || byNorm.has(norm)) return;
      byNorm.set(norm, {
        call_id: raw,
        date: String(t.started_at || ""),
        duration_s: Number(t.duration_s || 0),
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
  }, [crmCalls, transcriptCalls, callDates]);

  const transcriptCallMapByNorm = useMemo(() => {
    const out = new Map<string, FinalTranscriptCall>();
    for (const c of transcriptCalls ?? []) {
      const key = normalizeCallId(c.call_id);
      if (!key || out.has(key)) continue;
      out.set(key, c);
    }
    return out;
  }, [transcriptCalls]);

  const pipelineCallMapByNorm = useMemo(() => {
    const out: Record<string, PipelineArtifactState> = {};
    Object.entries(pipelineArtifactStatus?.calls ?? {}).forEach(([k, v]) => {
      const norm = normalizeCallId(k);
      if (!norm || out[norm]) return;
      out[norm] = v;
    });
    return out;
  }, [pipelineArtifactStatus?.calls]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as {
        type?: string;
        agent?: string;
        customer?: string;
        call_id?: string;
      } | null;
      if (!payload?.type) return;

      if (payload.type === "shinobi:select-pair") {
        const nextAgent = String(payload.agent || "").trim();
        const nextCustomer = String(payload.customer || "").trim();
        if (!nextAgent || !nextCustomer) return;
        setCustomer(nextCustomer, nextAgent);
        setShowCrmPanel(false);
        return;
      }

      if (payload.type === "shinobi:calls-context") {
        const nextAgent = String(payload.agent || "").trim();
        const nextCustomer = String(payload.customer || "").trim();
        const nextCallId = String(payload.call_id || "").trim();
        if (nextAgent && nextCustomer && (nextAgent !== salesAgent || nextCustomer !== customer)) {
          setCustomer(nextCustomer, nextAgent);
        }
        setCallId(nextCallId);
        if (nextCallId) setShowCallsPanel(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [customer, salesAgent, setCallId, setCustomer]);

  useEffect(() => {
    if (!callId) {
      setCallTranscriptText("");
      setCallTranscriptError("");
      return;
    }
    const selected = transcriptCallMapByNorm.get(normalizeCallId(callId));
    const path =
      selected?.final_path
      || selected?.smoothed_path
      || selected?.voted_path
      || selected?.pipeline_final_files?.[0]?.path
      || "";
    if (!path) {
      setCallTranscriptText("");
      setCallTranscriptError("No transcript available for selected call.");
      return;
    }

    let cancelled = false;
    setCallTranscriptLoading(true);
    setCallTranscriptError("");
    fetch(`/api/final-transcript/content?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        const txt = await res.text();
        if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
        if (!cancelled) setCallTranscriptText(txt);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setCallTranscriptText("");
          setCallTranscriptError(String(e?.message || "Failed to load transcript"));
        }
      })
      .finally(() => {
        if (!cancelled) setCallTranscriptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId, transcriptCallMapByNorm]);

  const stepArtifactTypes = useMemo(() => {
    const steps = Array.isArray(pipelineDef?.steps) ? pipelineDef!.steps! : [];
    const canvas = (pipelineDef?.canvas ?? {}) as any;
    const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
    const edges = Array.isArray(canvas?.edges) ? canvas.edges : [];

    const nodeById = new Map<string, any>();
    nodes.forEach((n: any) => nodeById.set(String(n?.id || ""), n));

    const outputTypeByProcessingNode = new Map<string, string>();
    edges.forEach((e: any) => {
      const src = String(e?.source || "");
      const dst = String(e?.target || "");
      if (!src || !dst) return;
      const srcNode = nodeById.get(src);
      const dstNode = nodeById.get(dst);
      if (!srcNode || !dstNode) return;
      if (String(srcNode?.type || "") !== "processing") return;
      if (String(dstNode?.type || "") !== "output") return;
      const sub = String(dstNode?.data?.subType || "").trim().toLowerCase();
      if (sub && !outputTypeByProcessingNode.has(src)) {
        outputTypeByProcessingNode.set(src, sub);
      }
    });

    const outputTypeByAgent = new Map<string, string>();
    nodes.forEach((n: any) => {
      if (String(n?.type || "") !== "processing") return;
      const aid = String(n?.data?.agentId || "").trim();
      if (!aid || outputTypeByAgent.has(aid)) return;
      const sub = outputTypeByProcessingNode.get(String(n?.id || ""));
      if (sub) outputTypeByAgent.set(aid, sub);
    });

    return steps.map((s: any) => {
      const overrideType = String(s?.output_contract_override?.artifact_type || "").trim().toLowerCase();
      const overrideClass = String(s?.output_contract_override?.artifact_class || "").trim().toLowerCase();
      const byAgent = outputTypeByAgent.get(String(s?.agent_id || "").trim()) || "";
      return overrideType || byAgent || overrideClass || "unknown";
    });
  }, [pipelineDef]);

  const runsComputed = useMemo(() => {
    const rows = pipelineRuns ?? [];
    return rows.map((run) => {
      let steps: any[] = [];
      try {
        const parsed = JSON.parse(String(run.steps_json || "[]"));
        if (Array.isArray(parsed)) steps = parsed;
      } catch {
        steps = [];
      }

      const artifactCounters = {
        notes: 0,
        personas: 0,
        scores: 0,
        compliance: 0,
        other: 0,
        totalArtifacts: 0,
      };

      steps.forEach((step: any, idx: number) => {
        const st = String(step?.state || "").trim().toLowerCase();
        if (!["completed", "cached", "done"].includes(st)) return;
        const artType = stepArtifactTypes[idx] || "unknown";
        const key = classifyArtifactType(artType);
        artifactCounters[key] += 1;
        artifactCounters.totalArtifacts += 1;
      });

      return {
        run,
        ...artifactCounters,
      };
    });
  }, [pipelineRuns, stepArtifactTypes]);

  const matrixRows = useMemo<ScopeAgg[]>(() => {
    const normalize = (v: string) => String(v || "").trim().toLowerCase();
    const runs = runsComputed;

    const scopes = [
      {
        scope: "Sales Agent",
        key: salesAgent || "All",
        match: (r: PipelineRunLite) => !salesAgent || normalize(r.sales_agent) === normalize(salesAgent),
      },
      {
        scope: "Customer",
        key: customer || "All",
        match: (r: PipelineRunLite) => !customer || normalize(r.customer) === normalize(customer),
      },
      {
        scope: "Pipeline",
        key: activePipelineName || activePipelineId || "None",
        match: (_r: PipelineRunLite) => true,
      },
      {
        scope: "Agent-Customer",
        key: salesAgent && customer ? `${salesAgent} · ${customer}` : "Select agent + customer",
        match: (r: PipelineRunLite) =>
          (!salesAgent || normalize(r.sales_agent) === normalize(salesAgent))
          && (!customer || normalize(r.customer) === normalize(customer)),
      },
      {
        scope: "Agent-Pipeline",
        key: salesAgent && activePipelineId ? `${salesAgent} · ${activePipelineName || activePipelineId}` : "Select agent + pipeline",
        match: (r: PipelineRunLite) => !salesAgent || normalize(r.sales_agent) === normalize(salesAgent),
      },
      {
        scope: "Customer-Pipeline",
        key: customer && activePipelineId ? `${customer} · ${activePipelineName || activePipelineId}` : "Select customer + pipeline",
        match: (r: PipelineRunLite) => !customer || normalize(r.customer) === normalize(customer),
      },
    ];

    return scopes.map((scope) => {
      const base: ScopeAgg = {
        scope: scope.scope,
        key: scope.key,
        runs: 0,
        done: 0,
        running: 0,
        error: 0,
        notes: 0,
        personas: 0,
        scores: 0,
        compliance: 0,
        other: 0,
        totalArtifacts: 0,
        lastRunAt: "",
      };

      runs.forEach((x) => {
        if (!scope.match(x.run)) return;
        base.runs += 1;
        const rs = String(x.run.status || "").trim().toLowerCase();
        if (rs === "done" || rs === "completed" || rs === "success") base.done += 1;
        else if (rs === "running") base.running += 1;
        else base.error += 1;
        base.notes += x.notes;
        base.personas += x.personas;
        base.scores += x.scores;
        base.compliance += x.compliance;
        base.other += x.other;
        base.totalArtifacts += x.totalArtifacts;
        const started = String(x.run.started_at || "");
        if (started && (!base.lastRunAt || started > base.lastRunAt)) base.lastRunAt = started;
      });

      return base;
    });
  }, [runsComputed, salesAgent, customer, activePipelineId, activePipelineName]);

  const openCrmOverlay = () => {
    setShowCrmPanel(true);
    setShowCallsPanel(false);
  };

  const openCallsOverlay = () => {
    if (!salesAgent || !customer) return;
    setShowCallsPanel(true);
    setShowCrmPanel(false);
  };

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-gray-950">
      <div className="flex flex-nowrap items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900 shrink-0 overflow-x-auto">
        <Workflow className="w-4 h-4 text-indigo-400 shrink-0" />
        <span className="text-sm font-bold text-white shrink-0">{title}</span>
        <span className="text-[10px] text-gray-500 shrink-0">{subtitle}</span>

        <button
          type="button"
          onClick={openCrmOverlay}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-800 bg-gray-950/40 hover:bg-gray-900 transition-colors min-w-[170px]"
          title="Pick sales agent + customer from CRM"
        >
          <Users className="w-3 h-3 text-indigo-400 shrink-0" />
          <span className="text-[11px] text-gray-200 truncate">{salesAgent || "Sales agent…"}</span>
        </button>

        <button
          type="button"
          onClick={openCrmOverlay}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-800 bg-gray-950/40 hover:bg-gray-900 transition-colors min-w-[170px]"
          title="Pick customer from CRM"
        >
          <User className="w-3 h-3 text-cyan-400 shrink-0" />
          <span className="text-[11px] text-gray-200 truncate">
            {customer || (salesAgent ? "Customer…" : "Select agent first")}
          </span>
        </button>

        <button
          type="button"
          onClick={openCallsOverlay}
          disabled={!salesAgent || !customer}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors min-w-[190px]",
            (!salesAgent || !customer)
              ? "border-gray-800 bg-gray-950/20 text-gray-600 cursor-not-allowed"
              : "border-gray-800 bg-gray-950/40 hover:bg-gray-900",
          )}
          title="Open calls browser"
        >
          <PhoneCall className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="text-[11px] text-gray-200 truncate">
            {callId ? `Call ${callId}` : "Call ID…"}
          </span>
          <ChevronRight className="w-3 h-3 text-gray-500 ml-auto" />
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Pipeline</span>
          <select
            value={activePipelineId || ""}
            onChange={(e) => {
              const id = String(e.target.value || "");
              const p = (pipelines ?? []).find((x) => x.id === id);
              setActivePipeline(id, p?.name || "");
            }}
            className="h-7 rounded border border-gray-700 bg-gray-900 px-2 text-[11px] text-gray-200 min-w-[210px] max-w-[300px] truncate"
          >
            <option value="">Select pipeline…</option>
            {(pipelines ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-gray-800 border-t-0 bg-gray-900 overflow-hidden">
        <div className="h-full overflow-auto">
          {!activePipelineId ? (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">
              Select a pipeline to view artifact cross-tab analytics.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-900 z-10 border-b border-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Scope</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Context Key</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-gray-400">Runs</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-gray-400">Done</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-gray-400">Running</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-gray-400">Error</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-indigo-300">Notes</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-fuchsia-300">Personas</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-amber-300">Scores</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-emerald-300">Compliance</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-violet-300">Other</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-white">Total Artifacts</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-gray-400">Last Run</th>
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((row) => (
                  <tr key={row.scope} className="border-b border-gray-800/60 hover:bg-gray-800/35">
                    <td className="px-3 py-2 text-gray-100 font-medium">{row.scope}</td>
                    <td className="px-3 py-2 text-gray-300 text-xs">{row.key}</td>
                    <td className="px-3 py-2 text-right text-gray-300 font-mono text-xs">{row.runs}</td>
                    <td className="px-3 py-2 text-right text-emerald-300 font-mono text-xs">{row.done}</td>
                    <td className="px-3 py-2 text-right text-amber-300 font-mono text-xs">{row.running}</td>
                    <td className="px-3 py-2 text-right text-red-300 font-mono text-xs">{row.error}</td>
                    <td className="px-3 py-2 text-right text-indigo-300 font-mono text-xs">{row.notes}</td>
                    <td className="px-3 py-2 text-right text-fuchsia-300 font-mono text-xs">{row.personas}</td>
                    <td className="px-3 py-2 text-right text-amber-300 font-mono text-xs">{row.scores}</td>
                    <td className="px-3 py-2 text-right text-emerald-300 font-mono text-xs">{row.compliance}</td>
                    <td className="px-3 py-2 text-right text-violet-300 font-mono text-xs">{row.other}</td>
                    <td className="px-3 py-2 text-right text-white font-mono text-xs">{row.totalArtifacts}</td>
                    <td className="px-3 py-2 text-right text-gray-400 text-xs">{formatDateLabel(row.lastRunAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showCallsPanel && (
        <div className="absolute inset-0 z-40 bg-black p-3 flex items-center justify-center">
          <div
            className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-indigo-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible"
          >
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
                      const callArtifacts = pipelineCallMapByNorm[normalizeCallId(cid)];
                      const artifactTypes = Array.from(
                        new Set((callArtifacts?.artifact_types ?? []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)),
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
                            {artifactTypes.map((tp) => {
                              const meta = getArtifactIconMeta(tp);
                              const Icon = meta.icon;
                              return (
                                <span
                                  key={`${cid}-${tp}`}
                                  title={meta.label}
                                  className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md border", meta.className)}
                                >
                                  <Icon className="h-3 w-3" />
                                </span>
                              );
                            })}
                          </div>
                          <p className="text-[10px] text-gray-500 truncate">
                            {formatDateLabel(row.date)}
                            {row.duration_s ? ` · ${formatDuration(row.duration_s)}` : ""}
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
        <div className="absolute inset-0 z-40 bg-black p-3 flex items-center justify-center">
          <div
            className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-cyan-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible"
          >
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
