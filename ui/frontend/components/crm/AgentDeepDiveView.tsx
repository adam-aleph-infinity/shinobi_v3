"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useAppCtx } from "@/lib/app-context";
import { cn, formatDuration } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import { SectionContent } from "@/components/shared/SectionCards";
import ContextTopBar from "@/components/shared/ContextTopBar";
import {
  BarChart3,
  Bot,
  FileText,
  Loader2,
  PhoneCall,
  ShieldCheck,
  StickyNote,
  User,
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
  log_json?: string;
};

type ParsedPipelineRun = PipelineRunLite & {
  parsed_steps: Array<Record<string, any>>;
  inferred_call_id: string;
  is_success: boolean;
  started_key: number;
};

type CallArtifactItem = {
  call_id: string;
  run_id: string;
  run_status: string;
  run_started_at: string;
  result_id: string;
  result_created_at: string;
  step_idx: number;
  artifact_type: string;
  artifact_label: string;
  agent_name: string;
  model: string;
  state: string;
  content: string;
};

type CallArtifactRow = {
  call_id: string;
  date: string;
  duration_s: number;
  final_run: ParsedPipelineRun | null;
  artifacts: CallArtifactItem[];
};

type ArtifactViewerState = {
  open: boolean;
  call_id: string;
  artifact_type: string;
  items: CallArtifactItem[];
  selected_idx: number;
};

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error("Invalid JSON response");
  }
  if (!res.ok) {
    const msg = String(data?.detail || data?.error || data?.message || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return data;
};

function normalizeCallId(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase();
}

function normalizeArtifactType(raw: string): string {
  return String(raw || "").trim().toLowerCase();
}

function inferRunCallId(run: PipelineRunLite, parsedSteps: Array<Record<string, any>>): string {
  const direct = String(run.call_id || "").trim();
  if (direct) return direct;
  for (const step of parsedSteps) {
    if (!step || typeof step !== "object") continue;
    const candidates = [
      step.call_id,
      step.context_call_id,
      step.input_scope_call_id,
      step.merged_until_call_id,
    ];
    for (const c of candidates) {
      const v = String(c || "").trim();
      if (v) return v;
    }
    const inputSources = Array.isArray(step.input_sources) ? step.input_sources : [];
    for (const src of inputSources) {
      if (!src || typeof src !== "object") continue;
      const v = String((src as Record<string, any>).call_id || "").trim();
      if (v) return v;
    }
  }
  const raw = String(run.log_json || "").trim();
  if (!raw) return "";
  const detect = (txt: string) => {
    const m1 = txt.match(/input\s+scope\s+call\s+context\s*:\s*([A-Za-z0-9_-]{3,})/i);
    if (m1 && m1[1]) return String(m1[1]).trim();
    const m2 = txt.match(/\bcall[_\s-]?id\s*[:=]\s*([A-Za-z0-9_-]{3,})\b/i);
    if (m2 && m2[1]) return String(m2[1]).trim();
    const m3 = txt.match(/\bcall\s+([A-Za-z0-9_-]{3,})\b/i);
    if (m3 && m3[1]) return String(m3[1]).trim();
    return "";
  };
  try {
    const parsed = JSON.parse(raw);
    const lines = Array.isArray(parsed) ? parsed : [];
    for (const item of lines) {
      const txt = typeof item === "string"
        ? item
        : String((item && (item.text || item.msg || item.message)) || "");
      const found = detect(txt);
      if (found) return found;
    }
  } catch {
    const found = detect(raw);
    if (found) return found;
  }
  return "";
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

function runStatusClass(statusRaw: string): string {
  const s = String(statusRaw || "").trim().toLowerCase();
  if (["done", "completed", "success", "pass"].includes(s)) return "text-emerald-300";
  if (s === "running") return "text-amber-300";
  if (s) return "text-red-300";
  return "text-gray-500";
}

function isCompletedStepState(stateRaw: string): boolean {
  const s = String(stateRaw || "").trim().toLowerCase();
  return ["completed", "cached", "done"].includes(s);
}

function getArtifactTypeOrder(t: string): number {
  const key = normalizeArtifactType(t);
  if (key === "persona") return 1;
  if (key === "persona_score") return 2;
  if (key === "notes") return 3;
  if (key === "notes_compliance") return 4;
  return 100;
}

function normalizeRunStatus(run: PipelineRunLite | null | undefined): string {
  return String(run?.status || "").trim().toLowerCase();
}

function pickRenderableArtifactText(raw: string): string {
  let text = String(raw || "").trim();
  if (!text) return "";
  for (let i = 0; i < 3; i += 1) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") break;
      const obj = parsed as Record<string, any>;
      const candidate =
        (typeof obj.response === "string" && obj.response.trim())
        || (typeof obj.results === "string" && obj.results.trim())
        || (typeof obj.content === "string" && obj.content.trim())
        || "";
      if (!candidate) break;
      text = candidate.trim();
    } catch {
      break;
    }
  }
  return text;
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
    setCustomer,
    setCallId,
    setActivePipeline,
  } = useAppCtx();

  const [showCrmPanel, setShowCrmPanel] = useState(false);
  const [showCallsPanel, setShowCallsPanel] = useState(false);
  const [callTranscriptText, setCallTranscriptText] = useState("");
  const [callTranscriptLoading, setCallTranscriptLoading] = useState(false);
  const [callTranscriptError, setCallTranscriptError] = useState("");
  const [artifactViewer, setArtifactViewer] = useState<ArtifactViewerState>({
    open: false,
    call_id: "",
    artifact_type: "",
    items: [],
    selected_idx: 0,
  });
  const [artifactViewerMode, setArtifactViewerMode] = useState<"rendered" | "raw">("rendered");
  const [fallbackArtifactsByCall, setFallbackArtifactsByCall] = useState<Record<string, CallArtifactItem[]>>({});

  const { data: pipelines } = useSWR<PipelineLite[]>("/api/pipelines", fetcher);
  const { data: pipelineDef } = useSWR<PipelineDef>(
    activePipelineId ? `/api/pipelines/${encodeURIComponent(activePipelineId)}` : null,
    fetcher,
  );
  const { data: pipelineRuns } = useSWR<PipelineRunLite[]>(
    activePipelineId && salesAgent && customer
      ? `/api/pipelines/${encodeURIComponent(activePipelineId)}/runs?limit=2500&sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
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
  const pipelinesSafe: PipelineLite[] = Array.isArray(pipelines) ? pipelines : [];
  const pipelineRunsSafe: PipelineRunLite[] = Array.isArray(pipelineRuns) ? pipelineRuns : [];
  const crmCallsSafe: CRMCallLite[] = Array.isArray(crmCalls) ? crmCalls : [];
  const transcriptCallsSafe: FinalTranscriptCall[] = Array.isArray(transcriptCalls) ? transcriptCalls : [];

  const callIdsForStatus = useMemo(() => {
    const byNorm = new Map<string, string>();
    crmCallsSafe.forEach((c) => {
      const raw = String(c.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, raw);
    });
    transcriptCallsSafe.forEach((t) => {
      const raw = String(t.call_id || "").trim();
      const norm = normalizeCallId(raw);
      if (norm && !byNorm.has(norm)) byNorm.set(norm, raw);
    });
    return Array.from(byNorm.values()).join(",");
  }, [crmCallsSafe, transcriptCallsSafe]);

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

  const parsedRuns = useMemo<ParsedPipelineRun[]>(() => {
    const rows = pipelineRunsSafe;
    return rows.map((run) => {
      let parsedSteps: Array<Record<string, any>> = [];
      try {
        const parsed = JSON.parse(String(run.steps_json || "[]"));
        if (Array.isArray(parsed)) {
          parsedSteps = parsed.filter((s) => !!s && typeof s === "object") as Array<Record<string, any>>;
        }
      } catch {
        parsedSteps = [];
      }
      const s = normalizeRunStatus(run);
      const startedKey = run.started_at ? new Date(run.started_at).getTime() : 0;
      const inferredCallId = inferRunCallId(run, parsedSteps);
      return {
        ...run,
        parsed_steps: parsedSteps,
        inferred_call_id: inferredCallId,
        is_success: ["done", "completed", "success", "pass"].includes(s),
        started_key: Number.isFinite(startedKey) ? startedKey : 0,
      };
    });
  }, [pipelineRunsSafe]);

  const finalRunsByCall = useMemo(() => {
    const byCall = new Map<string, ParsedPipelineRun[]>();
    parsedRuns.forEach((run) => {
      const norm = normalizeCallId(run.inferred_call_id || run.call_id);
      if (!norm) return;
      const bucket = byCall.get(norm) || [];
      bucket.push(run);
      byCall.set(norm, bucket);
    });

    const picked = new Map<string, ParsedPipelineRun>();
    byCall.forEach((runs, key) => {
      const sorted = [...runs].sort((a, b) => b.started_key - a.started_key);
      const success = sorted.find((r) => r.is_success);
      picked.set(key, success || sorted[0]);
    });
    return picked;
  }, [parsedRuns]);

  const runById = useMemo(() => {
    const out = new Map<string, ParsedPipelineRun>();
    parsedRuns.forEach((run) => {
      const rid = String(run.id || "").trim();
      if (!rid) return;
      out.set(rid, run);
    });
    return out;
  }, [parsedRuns]);

  const resultIdToRun = useMemo(() => {
    const out = new Map<string, ParsedPipelineRun>();
    const shouldReplace = (prev: ParsedPipelineRun | undefined, next: ParsedPipelineRun) => {
      if (!prev) return true;
      if (!!next.is_success !== !!prev.is_success) return !!next.is_success;
      return next.started_key > prev.started_key;
    };
    parsedRuns.forEach((run) => {
      run.parsed_steps.forEach((step) => {
        const ids = new Set<string>();
        const direct = String((step as any)?.agent_result_id || (step as any)?.result_id || "").trim();
        if (direct) ids.add(direct);
        const cached = Array.isArray((step as any)?.cached_locations) ? ((step as any).cached_locations as any[]) : [];
        cached.forEach((loc) => {
          if (!loc || typeof loc !== "object") return;
          const locType = String((loc as Record<string, any>).type || "").trim().toLowerCase();
          if (locType && locType !== "agent_result") return;
          const locId = String((loc as Record<string, any>).id || "").trim();
          if (locId) ids.add(locId);
        });
        ids.forEach((id) => {
          if (shouldReplace(out.get(id), run)) out.set(id, run);
        });
      });
    });
    return out;
  }, [parsedRuns]);

  const callMetaByNorm = useMemo(() => {
    const map = new Map<string, { call_id: string; date: string; duration_s: number }>();
    callsMerged.forEach((c) => {
      const norm = normalizeCallId(c.call_id);
      if (!norm || map.has(norm)) return;
      map.set(norm, c);
    });
    return map;
  }, [callsMerged]);

  const baseCallArtifactRows = useMemo<CallArtifactRow[]>(() => {
    const normCallSet = new Set<string>();
    callMetaByNorm.forEach((_v, key) => normCallSet.add(key));
    finalRunsByCall.forEach((_v, key) => normCallSet.add(key));

    const rows: CallArtifactRow[] = [];
    normCallSet.forEach((norm) => {
      const meta = callMetaByNorm.get(norm);
      const run = finalRunsByCall.get(norm) || null;
      const runCallId = String(run?.inferred_call_id || run?.call_id || norm);
      const artifacts: CallArtifactItem[] = [];

      if (run) {
        run.parsed_steps.forEach((step, idx) => {
          const state = String(step?.state || step?.status || "").trim().toLowerCase();
          const content = String(step?.content || "");
          if (!isCompletedStepState(state)) return;
          if (!content.trim()) return;
          const cached = Array.isArray((step as any)?.cached_locations) ? ((step as any).cached_locations as any[]) : [];
          let cachedResultId = "";
          let cachedCreatedAt = "";
          for (const loc of cached) {
            if (!loc || typeof loc !== "object") continue;
            const locType = String((loc as Record<string, any>).type || "").trim().toLowerCase();
            if (locType && locType !== "agent_result") continue;
            const locId = String((loc as Record<string, any>).id || "").trim();
            if (locId && !cachedResultId) cachedResultId = locId;
            const locCreated = String((loc as Record<string, any>).created_at || "").trim();
            if (locCreated && !cachedCreatedAt) cachedCreatedAt = locCreated;
            if (cachedResultId && cachedCreatedAt) break;
          }
          const stepResultId = String((step as any)?.agent_result_id || (step as any)?.result_id || cachedResultId || "").trim();
          const artifactType = stepArtifactTypes[idx] || "unknown";
          artifacts.push({
            call_id: runCallId,
            run_id: run.id,
            run_status: run.status,
            run_started_at: String(run.started_at || ""),
            result_id: stepResultId,
            result_created_at: cachedCreatedAt,
            step_idx: idx,
            artifact_type: artifactType,
            artifact_label: getArtifactIconMeta(artifactType).label,
            agent_name: String(step?.agent_name || step?.agent_id || ""),
            model: String(step?.model || ""),
            state,
            content,
          });
        });
      }

      artifacts.sort((a, b) => {
        const typeDelta = getArtifactTypeOrder(a.artifact_type) - getArtifactTypeOrder(b.artifact_type);
        if (typeDelta !== 0) return typeDelta;
        return a.step_idx - b.step_idx;
      });

      rows.push({
        call_id: meta?.call_id || runCallId || norm,
        date: String(meta?.date || run?.started_at || ""),
        duration_s: Number(meta?.duration_s || 0),
        final_run: run,
        artifacts,
      });
    });

    rows.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return rows;
  }, [callMetaByNorm, finalRunsByCall, stepArtifactTypes]);

  useEffect(() => {
    setFallbackArtifactsByCall({});
  }, [activePipelineId, salesAgent, customer]);

  const callsNeedingFallback = useMemo(() => {
    const expectedArtifacts = Math.max(1, stepArtifactTypes.length);
    const out: string[] = [];
    for (const row of baseCallArtifactRows) {
      const norm = normalizeCallId(row.call_id);
      if (!norm) continue;
      if (fallbackArtifactsByCall[norm] != null) continue;
      if (row.artifacts.length >= expectedArtifacts) continue;
      out.push(row.call_id);
    }
    return out;
  }, [baseCallArtifactRows, fallbackArtifactsByCall, stepArtifactTypes.length]);

  useEffect(() => {
    if (!activePipelineId || !salesAgent || !customer) return;
    if (!callsNeedingFallback.length) return;
    let cancelled = false;

    const run = async () => {
      const chunk = callsNeedingFallback.slice(0, 12);
      const fetched: Array<{ cid: string; items: CallArtifactItem[] }> = [];
      const concurrency = 4;

      const fetchOne = async (cid: string) => {
        const qs = new URLSearchParams({
          sales_agent: salesAgent,
          customer,
          call_id: String(cid || ""),
        });
        try {
          const res = await fetch(`/api/pipelines/${encodeURIComponent(activePipelineId)}/call-artifacts?${qs.toString()}`);
          if (!res.ok) return { cid, items: [] as CallArtifactItem[] };
          const data = await res.json();
          const list = Array.isArray(data?.artifacts) ? data.artifacts : [];
          const items: CallArtifactItem[] = list.map((a: any, idx: number): CallArtifactItem => ({
            call_id: String(cid || ""),
            run_id: "",
            run_status: "",
            run_started_at: String(a?.created_at || ""),
            result_id: String(a?.result_id || ""),
            result_created_at: String(a?.created_at || ""),
            step_idx: Number.isFinite(Number(a?.step_index)) ? Number(a.step_index) : idx,
            artifact_type: String(a?.artifact_type || "unknown"),
            artifact_label: String(a?.artifact_label || getArtifactIconMeta(String(a?.artifact_type || "")).label),
            agent_name: String(a?.agent_name || ""),
            model: String(a?.model || ""),
            state: "completed",
            content: String(a?.content || ""),
          }))
          .filter((x: CallArtifactItem) => String(x.content || "").trim().length > 0)
          .sort((l: CallArtifactItem, r: CallArtifactItem) => {
            const typeDelta = getArtifactTypeOrder(l.artifact_type) - getArtifactTypeOrder(r.artifact_type);
            if (typeDelta !== 0) return typeDelta;
            return l.step_idx - r.step_idx;
          });
          return { cid, items };
        } catch {
          return { cid, items: [] as CallArtifactItem[] };
        }
      };

      for (let i = 0; i < chunk.length; i += concurrency) {
        const batch = chunk.slice(i, i + concurrency);
        const rows = await Promise.all(batch.map((cid) => fetchOne(cid)));
        fetched.push(...rows);
        if (cancelled) return;
      }

      if (cancelled) return;
      setFallbackArtifactsByCall((prev) => {
        const next = { ...prev };
        for (const row of fetched) {
          next[normalizeCallId(row.cid)] = row.items;
        }
        return next;
      });
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [activePipelineId, salesAgent, customer, callsNeedingFallback]);

  const callArtifactRows = useMemo<CallArtifactRow[]>(() => {
    return baseCallArtifactRows.map((row) => {
      const fallback = fallbackArtifactsByCall[normalizeCallId(row.call_id)] || [];
      if (!fallback.length) return row;
      let effectiveRun: ParsedPipelineRun | null = row.final_run;
      if (!effectiveRun) {
        for (const it of fallback) {
          const fallbackRunId = String(it.run_id || "").trim();
          if (fallbackRunId) {
            const fromRunId = runById.get(fallbackRunId) || null;
            if (fromRunId) {
              effectiveRun = fromRunId;
              break;
            }
          }
          const resultId = String(it.result_id || "").trim();
          if (!resultId) continue;
          const fromResult = resultIdToRun.get(resultId) || null;
          if (fromResult) {
            effectiveRun = fromResult;
            break;
          }
        }
      }
      const runId = String(effectiveRun?.id || row.final_run?.id || "");
      const runStatus = String(effectiveRun?.status || row.final_run?.status || "");
      const runStartedAt = String(effectiveRun?.started_at || row.final_run?.started_at || "");
      const merged = [...row.artifacts];
      const seen = new Set<string>(
        merged.map((it) => `${normalizeArtifactType(it.artifact_type)}:${it.step_idx}:${String(it.content || "").trim().slice(0, 64)}`),
      );
      fallback.forEach((it) => {
        const key = `${normalizeArtifactType(it.artifact_type)}:${it.step_idx}:${String(it.content || "").trim().slice(0, 64)}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({
          ...it,
          run_id: runId || it.run_id,
          run_status: runStatus || it.run_status,
          run_started_at: runStartedAt || it.run_started_at,
        });
      });
      merged.sort((a, b) => {
        const typeDelta = getArtifactTypeOrder(a.artifact_type) - getArtifactTypeOrder(b.artifact_type);
        if (typeDelta !== 0) return typeDelta;
        return a.step_idx - b.step_idx;
      });
      return {
        ...row,
        final_run: effectiveRun || row.final_run,
        artifacts: merged,
      };
    });
  }, [baseCallArtifactRows, fallbackArtifactsByCall, resultIdToRun, runById]);

  const artifactColumns = useMemo<string[]>(() => {
    const seen = new Set<string>();
    callArtifactRows.forEach((row) => {
      row.artifacts.forEach((a) => {
        const key = normalizeArtifactType(a.artifact_type);
        if (key) seen.add(key);
      });
    });
    return Array.from(seen).sort((a, b) => {
      const orderDelta = getArtifactTypeOrder(a) - getArtifactTypeOrder(b);
      if (orderDelta !== 0) return orderDelta;
      return a.localeCompare(b);
    });
  }, [callArtifactRows]);

  const selectedArtifact = useMemo(() => {
    if (!artifactViewer.open) return null;
    if (artifactViewer.selected_idx < 0) return null;
    return artifactViewer.items[artifactViewer.selected_idx] || null;
  }, [artifactViewer]);

  const openArtifactViewer = (callIdValue: string, artifactType: string, items: CallArtifactItem[]) => {
    if (!items.length) return;
    setArtifactViewer({
      open: true,
      call_id: callIdValue,
      artifact_type: artifactType,
      items,
      selected_idx: 0,
    });
    setArtifactViewerMode("rendered");
  };

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
      <div className="shrink-0 border-b border-gray-800 bg-gray-900">
        <ContextTopBar
          salesAgent={salesAgent}
          customer={customer}
          callId={callId}
          onOpenCrm={openCrmOverlay}
          onOpenCalls={openCallsOverlay}
        />
        <div className="flex flex-nowrap items-center gap-2 px-3 py-2 overflow-x-auto">
          <Workflow className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-sm font-bold text-white shrink-0">{title}</span>
          <span className="text-[10px] text-gray-500 shrink-0">{subtitle}</span>
          <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Pipeline</span>
          <select
            value={activePipelineId || ""}
            onChange={(e) => {
              const id = String(e.target.value || "");
              const p = pipelinesSafe.find((x) => x.id === id);
              setActivePipeline(id, p?.name || "");
            }}
            className="h-7 rounded border border-gray-700 bg-gray-900 px-2 text-[11px] text-gray-200 min-w-[210px] max-w-[300px] truncate"
          >
            <option value="">Select pipeline…</option>
            {pipelinesSafe.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-gray-800 border-t-0 bg-gray-900 overflow-hidden">
        <div className="h-full overflow-auto">
          {!activePipelineId ? (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">
              Select a pipeline to view per-call artifacts from final successful runs.
            </div>
          ) : (
            <div className="h-full flex flex-col">
              <div className="px-3 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-3">
                <span className="text-[11px] text-gray-300">
                  Showing <span className="text-white font-semibold">{callArtifactRows.length}</span> calls.
                </span>
                <span className="text-[11px] text-gray-500">
                  Each row uses the latest successful run for that call (fallback: latest run).
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-900 z-10 border-b border-gray-800">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Call ID</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Date</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Duration</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Final Run</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-400">Run Status</th>
                      {artifactColumns.map((col) => {
                        const meta = getArtifactIconMeta(col);
                        const Icon = meta.icon;
                        return (
                          <th key={col} className="px-3 py-2 text-left text-xs font-semibold text-gray-400">
                            <span className="inline-flex items-center gap-1">
                              <Icon className="w-3 h-3" />
                              {meta.label.replace(" artifact", "")}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {callArtifactRows.map((row) => (
                      <tr key={row.call_id} className="border-b border-gray-800/60 hover:bg-gray-800/35">
                        <td className="px-3 py-2 text-gray-100 font-mono text-xs">{row.call_id}</td>
                        <td className="px-3 py-2 text-gray-300 text-xs">{formatDateLabel(row.date)}</td>
                        <td className="px-3 py-2 text-gray-300 text-xs">
                          {row.duration_s ? formatDuration(row.duration_s) : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {row.final_run ? (
                            <button
                              type="button"
                              onClick={() => setCallId(row.call_id)}
                              className="font-mono text-indigo-300 hover:text-indigo-200 transition-colors"
                              title="Set active call"
                            >
                              {row.final_run.id.slice(0, 8)}
                            </button>
                          ) : row.artifacts.length ? (
                            <span className="inline-flex items-center rounded border border-amber-700/60 bg-amber-900/35 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                              artifact-only
                            </span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </td>
                        <td className={cn("px-3 py-2 text-xs font-medium", runStatusClass(row.final_run?.status || ""))}>
                          {row.final_run?.status || (row.artifacts.length ? "artifact_only" : "no run")}
                        </td>
                        {artifactColumns.map((col) => {
                          const items = row.artifacts.filter((a) => normalizeArtifactType(a.artifact_type) === normalizeArtifactType(col));
                          const meta = getArtifactIconMeta(col);
                          const Icon = meta.icon;
                          return (
                            <td key={`${row.call_id}:${col}`} className="px-3 py-2 text-xs">
                              {items.length ? (
                                <button
                                  type="button"
                                  onClick={() => openArtifactViewer(row.call_id, col, items)}
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium hover:brightness-110 transition-all",
                                    meta.className,
                                  )}
                                  title={`View ${items.length} artifact(s)`}
                                >
                                  <Icon className="w-3 h-3" />
                                  {items.length}
                                </button>
                              ) : (
                                <span className="text-gray-600">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {callArtifactRows.length === 0 && (
                      <tr>
                        <td colSpan={5 + Math.max(artifactColumns.length, 1)} className="px-3 py-8 text-center text-gray-500 text-sm">
                          No call-level runs found for this pipeline and pair.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {artifactViewer.open && (
        <div className="absolute inset-0 z-40 bg-black p-3 flex items-center justify-center">
          <div className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-violet-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible">
            <button
              onClick={() => setArtifactViewer((prev) => ({ ...prev, open: false }))}
              className="absolute -top-6 left-1/2 -translate-x-1/2 z-40 h-12 w-12 rounded-full border-2 border-red-300/80 bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center shadow-2xl"
              title="Close Artifact panel"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="h-full w-full rounded-[inherit] overflow-hidden">
              <div className="h-12 px-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
                <Bot className="w-4 h-4 text-violet-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-white font-semibold truncate">
                    Artifacts · Call {artifactViewer.call_id}
                  </p>
                  <p className="text-[10px] text-gray-500 truncate">
                    {getArtifactIconMeta(artifactViewer.artifact_type).label} · {artifactViewer.items.length} item(s)
                  </p>
                </div>
                <div className="inline-flex rounded-md border border-gray-800 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setArtifactViewerMode("rendered")}
                    className={cn(
                      "px-2.5 py-1 text-[10px] transition-colors",
                      artifactViewerMode === "rendered" ? "bg-indigo-900/50 text-indigo-200" : "bg-gray-900 text-gray-400 hover:text-gray-200",
                    )}
                  >
                    Rendered
                  </button>
                  <button
                    type="button"
                    onClick={() => setArtifactViewerMode("raw")}
                    className={cn(
                      "px-2.5 py-1 text-[10px] border-l border-gray-800 transition-colors",
                      artifactViewerMode === "raw" ? "bg-indigo-900/50 text-indigo-200" : "bg-gray-900 text-gray-400 hover:text-gray-200",
                    )}
                  >
                    Raw
                  </button>
                </div>
              </div>

              <div className="h-[calc(100%-3rem)] min-h-0 grid grid-cols-1 lg:grid-cols-12">
                <section className="lg:col-span-4 border-r border-gray-800 min-h-0 flex flex-col">
                  <div className="h-10 px-3 border-b border-gray-800 flex items-center">
                    <p className="text-[11px] font-semibold text-gray-200">Artifacts in Final Run</p>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {artifactViewer.items.map((item, idx) => {
                      const selected = idx === artifactViewer.selected_idx;
                      const iconMeta = getArtifactIconMeta(item.artifact_type);
                      const Icon = iconMeta.icon;
                      return (
                        <button
                          key={`${item.run_id}:${item.step_idx}:${idx}`}
                          type="button"
                          onClick={() => setArtifactViewer((prev) => ({ ...prev, selected_idx: idx }))}
                          className={cn(
                            "w-full text-left px-2.5 py-2 rounded-lg border transition-colors",
                            selected ? "border-indigo-600/70 bg-indigo-900/30" : "border-gray-800 bg-gray-900 hover:bg-gray-800",
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md border", iconMeta.className)}>
                              <Icon className="h-3 w-3" />
                            </span>
                            <p className="text-xs text-gray-100 font-medium truncate flex-1">Step {item.step_idx + 1}</p>
                          </div>
                          <p className="text-[10px] text-gray-500 mt-1 truncate">
                            {item.agent_name || "Unknown agent"}{item.model ? ` · ${item.model}` : ""} · {item.state}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="lg:col-span-8 min-h-0 flex flex-col">
                  <div className="h-10 px-3 border-b border-gray-800 flex items-center gap-2">
                    <p className="text-[11px] font-semibold text-gray-200">Artifact Output</p>
                    {selectedArtifact && (
                      <p className="text-[10px] text-gray-500 truncate">
                        Run {selectedArtifact.run_id.slice(0, 8)} · {selectedArtifact.run_status}
                      </p>
                    )}
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto p-3">
                    {!selectedArtifact ? (
                      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                        Select an artifact from the list.
                      </div>
                    ) : artifactViewerMode === "raw" ? (
                      <pre className="w-full h-full whitespace-pre-wrap break-words rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-[11px] text-gray-200 overflow-auto">
                        {String(selectedArtifact.content || "")}
                      </pre>
                    ) : (
                      <SectionContent
                        content={pickRenderableArtifactText(selectedArtifact.content)}
                        format="markdown"
                      />
                    )}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      )}

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
