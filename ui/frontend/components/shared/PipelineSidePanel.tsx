"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import useSWR from "swr";
import {
  Workflow, Play, Loader2, AlertCircle,
  ChevronDown, ChevronUp, CheckCircle2, SkipForward,
  Download, Eye, EyeOff, ChevronLeft, ChevronRight, X,
  Mic2, FileText, Bot, StickyNote, Layers, BookOpen,
  GitBranch, PenLine, Clock, Zap, Cpu,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { SectionContent } from "./SectionCards";

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) { const e: any = new Error(r.statusText || String(r.status)); e.status = r.status; throw e; }
  return r.json();
});

interface PipelineStep { agent_id: string; input_overrides: Record<string, string>; }
interface Pipeline {
  id: string; name: string; scope: string;
  steps: PipelineStep[]; created_at: string;
  canvas?: { nodes: CanvasNode[]; edges: { id: string; source: string; target: string }[]; stages: string[] };
}
interface UniversalAgent {
  id: string; name: string; agent_class?: string; model?: string;
  inputs?: { key: string; source: string }[];
}
interface UploadedFileInfo {
  id: string; provider: string; provider_file_id: string;
  source: string; chars: number; created_at: string;
}
interface CachedStepResult {
  agent_id: string;
  result: { id: string; content: string; agent_name: string; created_at: string; } | null;
}


type StepStatus    = "pending" | "loading" | "cached" | "done" | "error";
type CallRunStatus = "queued"  | "running" | "cached" | "done" | "error";

interface StepState {
  agentName: string; status: StepStatus;
  content: string; stream: string; expanded: boolean;
  errorMsg?: string;
  thinking?: string;
  execTimeS?: number;
  inputTokenEst?: number;
  outputTokenEst?: number;
  model?: string;
  stepStartTs?: number;  // Date.now() when step_start received (for live timing)
}
interface CallResult {
  callId: string; date: string;
  steps: StepState[];
  expanded: boolean;
  done: boolean; error: string;
  runStatus: CallRunStatus;
}

function initStepsFor(pipeline: Pipeline, agents: UniversalAgent[]): StepState[] {
  return pipeline.steps.map(s => {
    const a = agents.find(x => x.id === s.agent_id);
    return { agentName: a?.name ?? s.agent_id, status: "pending", content: "", stream: "", expanded: false };
  });
}

// ── Source metadata for flow diagram ─────────────────────────────────────────

const SOURCE_META: Record<string, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string; bg: string; border: string;
}> = {
  transcript:        { label: "Transcript",        icon: Mic2,      color: "text-blue-400",   bg: "bg-blue-950/30",   border: "border-blue-700/50" },
  merged_transcript: { label: "Merged Transcript", icon: Layers,    color: "text-cyan-400",   bg: "bg-cyan-950/30",   border: "border-cyan-700/50" },
  notes:             { label: "Notes",             icon: StickyNote, color: "text-green-400", bg: "bg-green-950/30",  border: "border-green-700/50" },
  merged_notes:      { label: "Merged Notes",      icon: BookOpen,  color: "text-teal-400",   bg: "bg-teal-950/30",   border: "border-teal-700/50" },
  agent_output:      { label: "Agent Output",      icon: Bot,       color: "text-purple-400", bg: "bg-purple-950/30", border: "border-purple-700/50" },
  chain_previous:    { label: "Previous Step",     icon: GitBranch, color: "text-amber-400",  bg: "bg-amber-950/30",  border: "border-amber-700/50" },
  manual:            { label: "Manual Input",      icon: PenLine,   color: "text-gray-400",   bg: "bg-gray-800/40",   border: "border-gray-700/50" },
};
const GENERIC_SOURCE = SOURCE_META.transcript; // fallback

// Artifact output node styling
const ARTIFACT_NODE_META: Record<string, { color: string; bg: string; border: string }> = {
  persona:          { color: "text-violet-400",  bg: "bg-violet-950/20",  border: "border-violet-700/40" },
  persona_score:    { color: "text-violet-300",  bg: "bg-violet-950/15",  border: "border-violet-800/40" },
  notes:            { color: "text-amber-400",   bg: "bg-amber-950/20",   border: "border-amber-700/40" },
  notes_compliance: { color: "text-emerald-400", bg: "bg-emerald-950/20", border: "border-emerald-700/40" },
};
const DEFAULT_ARTIFACT_STYLE = { color: "text-gray-400", bg: "bg-gray-800/40", border: "border-gray-700/50" };

interface CanvasNode {
  id: string;
  type: string; // "input" | "processing" | "output"
  position: { x: number; y: number };
  data: {
    label: string;
    subType: string;
    stageIndex: number;
    agentId?: string;
    agentName?: string;
    inputSource?: string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function utcHmsToIsrael(hms: string): string {
  const [h, m, s] = hms.split(":").map(Number);
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, s ?? 0));
  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Mini pipeline canvas ─────────────────────────────────────────────────────

function MiniCanvas({
  stages, nodes, edges, procStepIdx, outputProcId, inputProcIds, flowSteps, selectedKey, onNodeClick,
}: {
  stages: string[];
  nodes: CanvasNode[];
  edges: { id: string; source: string; target: string }[];
  procStepIdx: Map<string, number>;
  outputProcId: Map<string, string>;
  inputProcIds: Map<string, string[]>;
  flowSteps: StepState[];
  selectedKey: string | null;
  onNodeClick: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(280);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const fn = () => setCw(el.getBoundingClientRect().width || 280);
    fn();
    const ro = new ResizeObserver(fn); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!nodes.length) return null;

  // Layout constants matching pipeline/page.tsx
  const SLEEVE_H = 180, Y_INIT = 20, NW = 200, NH = 52;
  const minX = Math.min(...nodes.map(n => n.position.x));
  const maxX = Math.max(...nodes.map(n => n.position.x)) + NW;
  const totalH_unscaled = Y_INIT + stages.length * SLEEVE_H;
  const scaleByW = (cw - 8) / (maxX - minX);
  const scaleByH = 190 / totalH_unscaled;
  const scale = Math.max(0.12, Math.min(scaleByW, scaleByH));
  const totalH = totalH_unscaled * scale;
  const nw = NW * scale, nh = NH * scale;
  const fs = Math.max(7, Math.round(10 * scale));

  const nx = (n: CanvasNode) => (n.position.x - minX) * scale;
  const ny = (n: CanvasNode) => n.position.y * scale;

  function stepSt(cn: CanvasNode): StepStatus {
    const nodeId = cn.id;
    if (cn.type === "processing") {
      const i = procStepIdx.get(nodeId); return i != null ? (flowSteps[i]?.status ?? "pending") : "pending";
    }
    if (cn.type === "output") {
      const pid = outputProcId.get(nodeId);
      const i = pid ? procStepIdx.get(pid) : undefined;
      if (i == null) return "pending";
      const st = flowSteps[i]?.status ?? "pending";
      return st === "loading" ? "pending" : st; // output stays dim while agent runs
    }
    if (cn.type === "input") {
      const procIds = inputProcIds.get(nodeId) ?? [];
      if (procIds.length === 0) return "pending";
      const statuses = procIds.map(pid => {
        const i = procStepIdx.get(pid);
        return (i != null ? (flowSteps[i]?.status ?? "pending") : "pending") as StepStatus;
      });
      if (statuses.some(s => s === "error"))   return "error";
      if (statuses.some(s => s === "loading")) return "loading";
      if (statuses.some(s => s === "done" || s === "cached")) {
        const src = cn.data.inputSource ?? "";
        // External file sources (pre-existing data) always yellow; internal (agent_output, chain_previous) can be green
        return !["agent_output", "chain_previous"].includes(src) ? "cached"
          : statuses.some(s => s === "done") ? "done" : "cached";
      }
      return "pending";
    }
    return "pending";
  }

  function nkey(n: CanvasNode) {
    return n.type === "processing" ? `proc:${n.id}` : n.type === "output" ? `out:${n.id}` : `input:${n.id}`;
  }

  function nstyle(n: CanvasNode, st: StepStatus): { bg: string; border: string; text: string; glow: string } {
    if (st === "done")    return { bg: "#052e16", border: "#16a34a", text: "#86efac", glow: "0 0 10px rgba(34,197,94,0.35)" };
    if (st === "cached")  return { bg: "#1c1400", border: "#ca8a04", text: "#fde68a", glow: "0 0 10px rgba(234,179,8,0.30)" };
    if (st === "loading") return { bg: "#1c0a00", border: "#ea580c", text: "#fed7aa", glow: "0 0 12px rgba(249,115,22,0.45)" };
    if (st === "error")   return { bg: "#2d0a0a", border: "#b91c1c", text: "#fca5a5", glow: "0 0 10px rgba(239,68,68,0.30)" };
    if (n.type === "input")      return { bg: "#0d1f3c", border: "#1e40af", text: "#93c5fd", glow: "" };
    if (n.type === "processing") return { bg: "#0f0e1f", border: "#3730a3", text: "#a5b4fc", glow: "" };
    return                              { bg: "#150b2e", border: "#6d28d9", text: "#c4b5fd", glow: "" };
  }

  return (
    <div ref={ref} className="w-full px-2 py-2">
      <div className="relative overflow-hidden rounded-xl border border-gray-800/60 bg-gray-950" style={{ height: totalH }}>

        {/* Lane backgrounds */}
        {stages.map((kind, i) => (
          <div key={i} className="absolute left-0 right-0" style={{
            top: (Y_INIT + i * SLEEVE_H) * scale,
            height: SLEEVE_H * scale,
            backgroundColor: kind === "input" ? "rgba(30,58,138,0.10)" : kind === "processing" ? "rgba(30,27,75,0.13)" : "rgba(46,16,101,0.10)",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
          }}>
            <span style={{ position: "absolute", left: 4, top: 2, fontSize: Math.max(5, 7 * scale), fontWeight: 700, opacity: 0.22, letterSpacing: "0.08em", textTransform: "uppercase",
              color: kind === "input" ? "#60a5fa" : kind === "processing" ? "#818cf8" : "#a78bfa" }}>
              {kind}
            </span>
          </div>
        ))}

        {/* Edges */}
        <svg className="absolute inset-0 pointer-events-none" width="100%" height={totalH} style={{ overflow: "visible" }}>
          {edges.map(e => {
            const s = nodes.find(n => n.id === e.source);
            const t = nodes.find(n => n.id === e.target);
            if (!s || !t) return null;
            const sx = nx(s) + nw / 2, sy = ny(s) + nh;
            const tx = nx(t) + nw / 2, ty = ny(t);
            const cy = (sy + ty) / 2;
            const st = stepSt(s);
            const stroke = st === "done" ? "#22c55e" : st === "cached" ? "#ca8a04" : st === "loading" ? "#ea580c" : st === "error" ? "#b91c1c" : "#374151";
            const aw = Math.max(3, 4.5 * scale);
            return (
              <g key={e.id}>
                <path d={`M${sx},${sy} C${sx},${cy} ${tx},${cy} ${tx},${ty}`}
                  fill="none" stroke={stroke} strokeWidth={Math.max(1, 1.5 * scale)} opacity={0.55} />
                <polygon points={`${tx},${ty} ${tx - aw},${ty - aw * 1.5} ${tx + aw},${ty - aw * 1.5}`}
                  fill={stroke} opacity={0.6} />
              </g>
            );
          })}
        </svg>

        {/* Nodes */}
        {nodes.map(n => {
          const st  = stepSt(n);
          const c   = nstyle(n, st);
          const k   = nkey(n);
          const sel = selectedKey === k;
          const lbl = n.type === "input"
            ? (SOURCE_META[n.data.inputSource ?? ""]?.label ?? n.data.label)
            : n.type === "output" ? "Output"
            : (n.data.agentName || n.data.label);

          return (
            <div key={n.id} onClick={() => onNodeClick(k)}
              className="absolute cursor-pointer rounded-md transition-colors select-none"
              style={{
                left: nx(n), top: ny(n), width: nw, height: nh,
                background: c.bg,
                border: `${st !== "pending" ? Math.max(1.5, 2 * scale) : Math.max(1, 1.2 * scale)}px solid ${c.border}`,
                outline: sel ? `2px solid ${c.border}` : undefined,
                outlineOffset: sel ? 2 : undefined,
                boxShadow: c.glow || undefined,
              }}
            >
              <div className="flex items-center h-full overflow-hidden"
                style={{ padding: `2px ${Math.max(3, 7 * scale)}px`, gap: Math.max(2, 4 * scale) }}>
                {(n.type !== "input" || st !== "pending") && (
                  <span className="shrink-0" style={{ fontSize: fs, lineHeight: 1 }}>
                    {st === "done"    ? <span style={{ color: "#22c55e" }}>✓</span> :
                     st === "cached"  ? <span style={{ color: "#eab308" }}>◎</span> :
                     st === "loading" ? <span style={{ color: "#f97316" }}>⟳</span> :
                     st === "error"   ? <span style={{ color: "#ef4444" }}>✕</span> :
                                        <span style={{ color: c.border, opacity: 0.5 }}>●</span>}
                  </span>
                )}
                <span className="truncate" style={{ fontSize: fs, color: c.text, fontWeight: 600, lineHeight: 1.2 }}>{lbl}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PipelineSidePanel({
  showTranscript,
  onToggleTranscript,
  selectedCallIds,
}: {
  showTranscript?: boolean;
  onToggleTranscript?: () => void;
  selectedCallIds?: string[];
} = {}) {
  const { salesAgent, customer, callId, activePipelineId, activePipelineName, setActivePipeline } = useAppCtx();

  const { data: pipeline, error: pipelineError } = useSWR<Pipeline>(
    activePipelineId ? `/api/pipelines/${activePipelineId}` : null, fetcher,
  );
  const { data: agents } = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);

  const isPerCall = pipeline?.scope === "per_call" || !!(selectedCallIds && selectedCallIds.length > 0);
  const hasPair   = !!(salesAgent && customer);
  const contextOk = hasPair;

  // ── view state ───────────────────────────────────────────────────────────────
  const [panelView, setPanelView] = useState<"flow" | "steps">("flow");
  const [flowSelectedKey, setFlowSelectedKey] = useState<string | null>(null);
  const [inputPreview, setInputPreview] = useState<{ loading: boolean; content: string; error: string }>(
    { loading: false, content: "", error: "" }
  );
  const [nodeFileInfo, setNodeFileInfo] = useState<{ loading: boolean; files: UploadedFileInfo[] }>(
    { loading: false, files: [] }
  );
  const [logLines, setLogLines] = useState<{ ts: string; text: string; level: string }[]>([]);
  const [flowCallIdx, setFlowCallIdx] = useState(0);

  // ── per_pair state ───────────────────────────────────────────────────────────
  const [steps,    setSteps]    = useState<StepState[]>([]);
  const [running,  setRunning]  = useState(false);
  const [runError, setRunError] = useState("");
  const [done,     setDone]     = useState(false);
  const [loaded,   setLoaded]   = useState(false);

  // ── per_call state ───────────────────────────────────────────────────────────
  const [callResults,   setCallResults]   = useState<CallResult[]>([]);
  const [callsRunning,  setCallsRunning]  = useState(false);
  const [callsRunError, setCallsRunError] = useState("");
  const [callsLoaded,   setCallsLoaded]   = useState(false);

  const streamEndRef = useRef<HTMLDivElement>(null);

  // Fetch all call dates for per_call scope
  const callDatesUrl = isPerCall && hasPair
    ? `/api/crm/call-dates?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
    : null;
  const { data: callDates } = useSWR<Record<string, { date: string; has_audio: boolean }>>(callDatesUrl, fetcher);

  // Reset on context change
  const selKey = selectedCallIds?.slice().sort().join(",") ?? "";
  const contextKey = `${activePipelineId}:${salesAgent}:${customer}:${callId}:${selKey}`;
  const prevContextKey = useRef("");
  useEffect(() => {
    if (contextKey === prevContextKey.current) return;
    prevContextKey.current = contextKey;
    setFlowSelectedKey(null);
    setInputPreview({ loading: false, content: "", error: "" });
    setFlowCallIdx(0);
    if (!running && !callsRunning) {
      setSteps([]); setDone(false); setRunError(""); setLoaded(false);
      setCallResults([]); setCallsRunError(""); setCallsLoaded(false);
    }
  }, [contextKey, running, callsRunning]);

  // ── Live backend log tail ────────────────────────────────────────────────────
  const anyRunning = running || callsRunning;
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anyRunning) return;
    setLogLines([]);
    const es = new EventSource("/api/logs/stream");
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.heartbeat) return;
        setLogLines(prev => [...prev.slice(-49), d]);
      } catch { /* ignore malformed */ }
    };
    return () => es.close();
  }, [anyRunning]);
  useEffect(() => {
    if (logLines.length) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  // ── per_pair: fetch cached results ──────────────────────────────────────────
  const cacheUrl = !isPerCall && activePipelineId && hasPair
    ? `/api/pipelines/${activePipelineId}/results?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(callId)}`
    : null;
  const { data: cachedResults, mutate: mutateCache } = useSWR<CachedStepResult[]>(cacheUrl, fetcher);

  // ── per_pair: latest run — poll while running so refresh restores live state ─
  const latestRunUrl = !isPerCall && activePipelineId && hasPair
    ? `/api/pipelines/${activePipelineId}/runs?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(callId)}&limit=1`
    : null;
  const { data: latestRunData } = useSWR<any[]>(latestRunUrl, fetcher, {
    refreshInterval: (data) => (data?.[0]?.status === "running" ? 3000 : 0),
  });
  const latestRun = latestRunData?.[0] ?? null;

  // ── per_pair: restore step state from latest run or cached results ───────────
  useEffect(() => {
    if (isPerCall || running || !pipeline || !agents) return;

    const runSteps: any[] = (() => {
      try { return latestRun?.steps_json ? JSON.parse(latestRun.steps_json) : []; } catch { return []; }
    })();
    const hasProgress = runSteps.some((s: any) => s.status && s.status !== "pending");

    // While a run is in progress, keep updating steps from the polled run record
    if (latestRun?.status === "running" && hasProgress) {
      setSteps(prev => runSteps.map((s: any, i: number) => {
        const a = agents.find(x => x.id === pipeline.steps[i]?.agent_id);
        return {
          agentName: s.agent_name || a?.name || "",
          status: s.status as StepStatus,
          content: s.content || "",
          stream: "",
          expanded: prev[i]?.expanded ?? false,
          errorMsg: s.error_msg || undefined,
          model: s.model || undefined,
          execTimeS: s.execution_time_s ?? undefined,
          inputTokenEst: s.input_token_est ?? undefined,
          outputTokenEst: s.output_token_est ?? undefined,
        };
      }));
      setLoaded(true);
      return;
    }

    // Past this point: only apply once (on initial load)
    if (loaded) return;

    // Completed/errored run with step data — restore exact run state
    if (latestRun && hasProgress) {
      setLoaded(true);
      setSteps(runSteps.map((s: any, i: number) => {
        const a = agents.find(x => x.id === pipeline.steps[i]?.agent_id);
        return {
          agentName: s.agent_name || a?.name || "",
          status: s.status as StepStatus,
          content: s.content || "",
          stream: "",
          expanded: false,
          errorMsg: s.error_msg || undefined,
          model: s.model || undefined,
          execTimeS: s.execution_time_s ?? undefined,
          inputTokenEst: s.input_token_est ?? undefined,
          outputTokenEst: s.output_token_est ?? undefined,
        };
      }));
      setDone(latestRun.status !== "running");
      return;
    }

    // No run data yet — wait for latestRunData fetch before showing cached results
    // (avoids a flash of old cache before the run record arrives)
    if (latestRunData === undefined) return;

    // Fall back to AgentResult cache
    if (!cachedResults) return;
    const initialSteps = pipeline.steps.map((s, i) => {
      const a = agents.find(x => x.id === s.agent_id);
      const cr = cachedResults[i];
      return {
        agentName: cr?.result?.agent_name ?? a?.name ?? s.agent_id,
        status: (cr?.result ? "cached" : "pending") as StepStatus,
        content: cr?.result?.content ?? "",
        stream: "", expanded: false,
      };
    });
    if (initialSteps.some(st => st.status === "cached")) {
      setSteps(initialSteps); setDone(true); setLoaded(true);
    }
  }, [latestRunData, cachedResults, latestRun, pipeline, agents, running, loaded, isPerCall]);

  // ── per_call: load cached results for each call ──────────────────────────────
  useEffect(() => {
    if (!isPerCall || callsLoaded || callsRunning || !pipeline || !agents) return;
    const hasSelection = selectedCallIds && selectedCallIds.length > 0;
    if (!hasSelection && !callDates) return;
    setCallsLoaded(true);

    const sorted: [string, string][] = hasSelection
      ? selectedCallIds!.map(cid => [cid, callDates?.[cid]?.date ?? ""] as [string, string])
      : Object.entries(callDates!).map(([cid, v]) => [cid, v.date] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));

    if (sorted.length === 0) return;

    setCallResults(sorted.map(([cid, date]) => ({
      callId: cid, date,
      steps: initStepsFor(pipeline, agents),
      expanded: false, done: false, error: "", runStatus: "queued" as CallRunStatus,
    })));

    let cancelled = false;
    (async () => {
      for (let idx = 0; idx < sorted.length; idx++) {
        if (cancelled) break;
        const [cid] = sorted[idx];
        try {
          const url = `/api/pipelines/${activePipelineId}/results?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(cid)}`;
          const cached: CachedStepResult[] = await fetch(url).then(r => r.ok ? r.json() : []);
          const stepStates = pipeline.steps.map((s, i) => {
            const a = agents.find(x => x.id === s.agent_id);
            const cr = cached[i];
            return {
              agentName: cr?.result?.agent_name ?? a?.name ?? s.agent_id,
              status: (cr?.result ? "cached" : "pending") as StepStatus,
              content: cr?.result?.content ?? "",
              stream: "", expanded: false,
            };
          });
          const allCached = stepStates.length > 0 && stepStates.every(s => s.status === "cached");
          if (!cancelled) setCallResults(p => p.map((cr, i) => i === idx
            ? { ...cr, steps: stepStates, done: allCached, runStatus: allCached ? "cached" : "queued" }
            : cr));
        } catch { /* leave as queued */ }
      }
    })();
    return () => { cancelled = true; };
  }, [callDates, pipeline, agents, callsRunning, callsLoaded, isPerCall, activePipelineId, salesAgent, customer]);

  // ── flow computed values ─────────────────────────────────────────────────────

  // Unique data sources shown at the top of the flow diagram.
  // Prefer canvas nodes (lossless — exactly what was designed on the canvas),
  // fall back to deriving from agent inputs for old pipelines without canvas data.
  const flowInputSources = useMemo(() => {
    if (!pipeline) return [];

    // Use saved canvas nodes if available
    if (pipeline.canvas?.nodes?.length) {
      const seen = new Set<string>();
      const sources: string[] = [];
      for (const n of pipeline.canvas.nodes) {
        if (n.type === "input" && n.data?.inputSource && !seen.has(n.data.inputSource)) {
          seen.add(n.data.inputSource);
          sources.push(n.data.inputSource);
        }
      }
      if (sources.length > 0) return sources;
    }

    // Legacy fallback: derive from agent inputs + overrides
    if (!agents) return [];
    const sources = new Set<string>();
    pipeline.steps.forEach(step => {
      const agent = agents.find(a => a.id === step.agent_id);
      if (agent?.inputs?.length) {
        agent.inputs.forEach(inp => {
          const src = step.input_overrides?.[inp.key] ?? inp.source;
          if (src && src !== "agent_output" && src !== "chain_previous") sources.add(src);
        });
      } else {
        sources.add("transcript");
      }
    });
    return [...sources];
  }, [pipeline, agents]);

  // Active call for the flow view (in per_call mode)
  const safeFlowCallIdx = Math.min(flowCallIdx, Math.max(0, callResults.length - 1));
  const flowCall  = isPerCall && callResults.length > 0 ? callResults[safeFlowCallIdx] : null;
  const flowSteps = flowCall ? flowCall.steps : steps;
  const flowCallId = flowCall ? flowCall.callId : callId;

  // ── Canvas-based flow nodes ──────────────────────────────────────────────────

  // All canvas nodes sorted by stageIndex asc, then x asc
  const canvasNodes = useMemo((): CanvasNode[] | null => {
    if (!pipeline?.canvas?.nodes?.length) return null;
    return [...pipeline.canvas.nodes].sort((a, b) => {
      const si = (a.data?.stageIndex ?? 0) - (b.data?.stageIndex ?? 0);
      return si !== 0 ? si : (a.position?.x ?? 0) - (b.position?.x ?? 0);
    });
  }, [pipeline]);

  // Processing node id → pipeline step index (sorted order = step order)
  const procStepIdx = useMemo(() => {
    const map = new Map<string, number>();
    if (!canvasNodes) return map;
    let idx = 0;
    for (const n of canvasNodes) {
      if (n.type === "processing") map.set(n.id, idx++);
    }
    return map;
  }, [canvasNodes]);

  // Output node id → upstream processing node id (via canvas edges)
  const outputProcId = useMemo(() => {
    const map = new Map<string, string>();
    if (!canvasNodes || !pipeline?.canvas?.edges) return map;
    const procSet = new Set(canvasNodes.filter(n => n.type === "processing").map(n => n.id));
    for (const e of pipeline.canvas.edges) {
      if (procSet.has(e.source)) map.set(e.target, e.source);
    }
    return map;
  }, [canvasNodes, pipeline]);

  // Input node id → connected processing node ids (to derive input status)
  const inputProcIds = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!canvasNodes || !pipeline?.canvas?.edges) return map;
    const inputSet = new Set(canvasNodes.filter(n => n.type === "input").map(n => n.id));
    for (const e of pipeline.canvas.edges) {
      if (inputSet.has(e.source)) {
        const list = map.get(e.source) ?? [];
        list.push(e.target);
        map.set(e.source, list);
      }
    }
    return map;
  }, [canvasNodes, pipeline]);

  // Nodes grouped by stageIndex for staged rendering with arrows between groups
  const canvasStageGroups = useMemo((): CanvasNode[][] | null => {
    if (!canvasNodes) return null;
    const groups: CanvasNode[][] = [];
    let curStage = -1;
    for (const n of canvasNodes) {
      const si = n.data?.stageIndex ?? 0;
      if (si !== curStage) { groups.push([]); curStage = si; }
      groups[groups.length - 1].push(n);
    }
    return groups;
  }, [canvasNodes]);

  // ── input preview fetch ──────────────────────────────────────────────────────
  async function fetchInputPreview(source: string) {
    if (!salesAgent || !customer) {
      setInputPreview({ loading: false, content: "", error: "No agent + customer selected" });
      return;
    }
    setInputPreview({ loading: true, content: "", error: "" });
    try {
      let content = "";
      if (source === "transcript") {
        const url = `/api/notes/transcript?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(flowCallId)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        content = data.transcript ?? data.text ?? JSON.stringify(data, null, 2);
      } else if (source === "merged_transcript") {
        const url = `/api/full-persona-agent/transcript?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        content = await res.text();
      } else {
        content = `(Source "${source}" is resolved at pipeline execution time)`;
      }
      setInputPreview({ loading: false, content, error: "" });
    } catch (e: any) {
      setInputPreview({ loading: false, content: "", error: `Could not load preview: ${e.message ?? "fetch failed"}` });
    }
  }

  // ── file info fetch (for node detail panels) ──────────────────────────────────
  async function fetchNodeFiles(sources: string[]) {
    setNodeFileInfo({ loading: true, files: [] });
    try {
      const all: UploadedFileInfo[] = [];
      await Promise.all(sources.map(async src => {
        const params = new URLSearchParams({ source: src, sales_agent: salesAgent, customer });
        if (flowCallId) params.set("call_id", flowCallId);
        const files: UploadedFileInfo[] = await fetch(`/api/universal-agents/uploaded-files?${params}`).then(r => r.ok ? r.json() : []);
        all.push(...files.slice(0, 2));
      }));
      setNodeFileInfo({ loading: false, files: all });
    } catch {
      setNodeFileInfo({ loading: false, files: [] });
    }
  }

  // ── early returns ─────────────────────────────────────────────────────────────
  if (!activePipelineId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 p-4 text-center">
        <Workflow className="w-8 h-8 opacity-20" />
        <p className="text-xs">Select a pipeline in the context bar</p>
      </div>
    );
  }
  if (pipelineError?.status === 404) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
        <AlertCircle className="w-8 h-8 text-red-500/40" />
        <p className="text-xs text-red-400">Pipeline not found — it may have been deleted.</p>
        <button onClick={() => setActivePipeline("", "")} className="text-[10px] text-gray-500 hover:text-white underline transition-colors">
          Clear active pipeline
        </button>
      </div>
    );
  }

  const hasResults     = steps.length > 0 && steps.some(s => s.content);
  const hasCallResults = callResults.some(cr => cr.done);

  // ── download ──────────────────────────────────────────────────────────────────
  function download() {
    if (isPerCall) {
      const text = callResults.filter(cr => cr.done).map(cr => {
        const body = cr.steps.filter(s => s.content).map((s, i) => `### Step ${i + 1}: ${s.agentName}\n\n${s.content}`).join("\n\n");
        return `## ${cr.callId} (${cr.date.slice(0, 10)})\n\n${body}`;
      }).join("\n\n---\n\n");
      const slug = [activePipelineName, salesAgent, customer].filter(Boolean).join("_").replace(/[^a-z0-9_\-]/gi, "_");
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${slug}.md`; a.click();
      URL.revokeObjectURL(url);
    } else {
      const text = steps.filter(s => s.content).map((s, i) => `# Step ${i + 1}: ${s.agentName}\n\n${s.content}`).join("\n\n---\n\n");
      const slug = [activePipelineName, salesAgent, customer, callId].filter(Boolean).join("_").replace(/[^a-z0-9_\-]/gi, "_");
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${slug}.md`; a.click();
      URL.revokeObjectURL(url);
    }
  }

  // ── per_pair run ──────────────────────────────────────────────────────────────
  async function run(force = false) {
    if (!activePipelineId || !contextOk || running || !pipeline || !agents) return;
    setFlowSelectedKey(null); // close detail panel so canvas is fully visible
    setInputPreview({ loading: false, content: "", error: "" });
    setRunning(true); setRunError(""); setDone(false); setLoaded(true);
    setSteps(initStepsFor(pipeline, agents));
    try {
      const res = await fetch(`/api/pipelines/${activePipelineId}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sales_agent: salesAgent, customer, call_id: callId, force }),
      });
      if (!res.body) throw new Error("No response body");
      let hadLLM = false;
      await readPipelineSSE(res,
        (type, evt, s) => {
          if (type === "step_start")  setSteps(p => p.map((st, i) => i === s ? { ...st, status: "loading", agentName: evt.agent_name, model: evt.model, stepStartTs: Date.now() } : st));
          if (type === "step_cached") setSteps(p => p.map((st, i) => i === s ? { ...st, status: "cached", content: evt.content, model: evt.model } : st));
          if (type === "stream")      setSteps(p => { const n = p.map((st, i) => i === s ? { ...st, stream: st.stream + (evt.text ?? "") } : st); setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 0); return n; });
          if (type === "thinking")    setSteps(p => p.map((st, i) => i === s ? { ...st, thinking: evt.content ?? "" } : st));
          if (type === "step_done")   { hadLLM = true; setSteps(p => p.map((st, i) => i === s ? { ...st, status: "done", content: evt.content, stream: "", model: evt.model, execTimeS: evt.execution_time_s, inputTokenEst: evt.input_token_est, outputTokenEst: evt.output_token_est } : st)); }
          if (type === "error" && evt.step != null) setSteps(p => p.map((st, i) => i === evt.step ? { ...st, status: "error", errorMsg: evt.msg ?? "" } : st));
          if (type === "pipeline_done") { setDone(true); mutateCache(); }
        },
      );
    } catch (e: any) {
      if (e.name !== "AbortError") setRunError(e.message ?? "Unexpected error");
    } finally { setRunning(false); }
  }

  // ── per_call parallel run ─────────────────────────────────────────────────────
  async function runAllCalls(force = false) {
    if (!activePipelineId || !hasPair || callsRunning || !pipeline || !agents) return;
    const hasSelection = selectedCallIds && selectedCallIds.length > 0;
    if (!hasSelection && !callDates) return;
    const sorted: [string, string][] = hasSelection
      ? selectedCallIds!.map(cid => [cid, callDates?.[cid]?.date ?? ""] as [string, string])
      : Object.entries(callDates!).map(([cid, v]) => [cid, v.date] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
    if (sorted.length === 0) { setCallsRunError("No calls found for this pair"); return; }

    setFlowSelectedKey(null); // close detail panel so canvas is fully visible
    setInputPreview({ loading: false, content: "", error: "" });
    setFlowCallIdx(0); // start watching from call 0
    setCallsRunning(true); setCallsRunError(""); setCallsLoaded(true);
    setCallResults(sorted.map(([cid, date]) => ({
      callId: cid, date,
      steps: initStepsFor(pipeline!, agents!),
      expanded: false, done: false, error: "",
      runStatus: "queued" as CallRunStatus,
    })));

    const runSingle = async (cid: string, ci: number) => {
      setFlowCallIdx(ci); // auto-advance flow view to the currently running call
      setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, runStatus: "running", expanded: true } : cr));
      let hadLLM = false;
      try {
        const res = await fetch(`/api/pipelines/${activePipelineId}/run`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sales_agent: salesAgent, customer, call_id: cid, force }),
        });
        if (!res.body) throw new Error("No response body");
        await readPipelineSSE(res, (type, evt, s) => {
          if (type === "step_start")  setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, status: "loading", agentName: evt.agent_name, model: evt.model, stepStartTs: Date.now() } : st) } : cr));
          if (type === "step_cached") setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, status: "cached", content: evt.content, model: evt.model } : st) } : cr));
          if (type === "stream")      setCallResults(p => { const n = p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, stream: st.stream + (evt.text ?? "") } : st) } : cr); setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 0); return n; });
          if (type === "thinking")    setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, thinking: evt.content ?? "" } : st) } : cr));
          if (type === "step_done")   { hadLLM = true; setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, status: "done", content: evt.content, stream: "", model: evt.model, execTimeS: evt.execution_time_s, inputTokenEst: evt.input_token_est, outputTokenEst: evt.output_token_est } : st) } : cr)); }
          if (type === "error" && evt.step != null) setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === evt.step ? { ...st, status: "error", errorMsg: evt.msg ?? "" } : st) } : cr));
          if (type === "pipeline_done") setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, done: true, runStatus: hadLLM ? "done" : "cached", expanded: hadLLM } : cr));
        });
      } catch (e: any) {
        setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, error: e.message ?? "Error", runStatus: "error" } : cr));
      }
    };

    for (let ci = 0; ci < sorted.length; ci++) {
      await runSingle(sorted[ci][0], ci);
    }
    setCallsRunning(false);
  }

  // ── SSE reader ────────────────────────────────────────────────────────────────
  async function readPipelineSSE(res: Response, onEvent: (type: string, data: any, step: number) => void) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      for (const line of dec.decode(value).split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          onEvent(evt.type, evt.data ?? {}, evt.data?.step ?? 0);
        } catch { /* skip malformed */ }
      }
    }
  }

  // ── per_call progress stats ───────────────────────────────────────────────────
  const callStats = callResults.length > 0 ? (() => {
    const total    = callResults.length;
    const queued   = callResults.filter(cr => cr.runStatus === "queued").length;
    const running2 = callResults.filter(cr => cr.runStatus === "running").length;
    const done2    = callResults.filter(cr => cr.runStatus === "done").length;
    const cached2  = callResults.filter(cr => cr.runStatus === "cached").length;
    const error2   = callResults.filter(cr => cr.runStatus === "error").length;
    const completed = done2 + cached2 + error2;
    const pct = Math.round((completed / total) * 100);
    return { total, queued, running: running2, done: done2, cached: cached2, error: error2, completed, pct };
  })() : null;

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <Workflow className="w-3.5 h-3.5 text-teal-400 shrink-0" />
        <span className="text-xs font-semibold text-white flex-1 truncate">{activePipelineName}</span>
        {pipeline && (
          <span className="text-[10px] text-gray-600 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 shrink-0">
            {pipeline.steps.length} step{pipeline.steps.length !== 1 ? "s" : ""} · {isPerCall ? "per call" : "per pair"}
          </span>
        )}
        {(hasResults || hasCallResults) && (
          <button onClick={download} className="text-gray-600 hover:text-teal-400 transition-colors shrink-0" title="Download results (.md)">
            <Download className="w-3.5 h-3.5" />
          </button>
        )}
        {onToggleTranscript && (
          <button onClick={onToggleTranscript} className="text-gray-600 hover:text-gray-400 transition-colors shrink-0" title={showTranscript ? "Hide transcript" : "Show transcript"}>
            {showTranscript ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* Tab switcher: Flow / Steps */}
      <div className="px-3 border-b border-gray-800 flex gap-3 shrink-0 bg-gray-900/50">
        {(["flow", "steps"] as const).map(v => (
          <button
            key={v}
            onClick={() => setPanelView(v)}
            className={cn(
              "py-1.5 text-[10px] font-bold uppercase tracking-widest border-b-2 transition-colors",
              panelView === v
                ? "border-teal-500 text-teal-400"
                : "border-transparent text-gray-600 hover:text-gray-400",
            )}
          >
            {v === "flow" ? "Flow" : "Steps"}
          </button>
        ))}
      </div>

      {/* Context warning */}
      {!contextOk && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 flex items-center gap-1.5 text-[11px] text-amber-400/80">
          <AlertCircle className="w-3 h-3 shrink-0" />
          Needs: agent + customer
        </div>
      )}

      {/* per_call progress bar */}
      {isPerCall && callStats && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1.5">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-gray-500 font-mono">{callStats.completed}/{callStats.total} calls</span>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {callStats.queued  > 0 && <span className="text-gray-600">{callStats.queued} queued</span>}
              {callStats.running > 0 && <span className="text-teal-400 flex items-center gap-0.5"><Loader2 className="w-2.5 h-2.5 animate-spin" /> {callStats.running} running</span>}
              {callStats.done    > 0 && <span className="text-green-400">{callStats.done} done</span>}
              {callStats.cached  > 0 && <span className="text-amber-400">{callStats.cached} cached</span>}
              {callStats.error   > 0 && <span className="text-red-400">{callStats.error} failed</span>}
            </div>
          </div>
          <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-500", callStats.error > 0 && callStats.completed === callStats.total ? "bg-red-600" : "bg-teal-600")}
              style={{ width: `${callStats.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Run button */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1.5">
        <div className="flex gap-1.5">
          <button
            onClick={() => isPerCall ? runAllCalls(false) : run(false)}
            disabled={anyRunning || !contextOk}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {anyRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {anyRunning ? "Running…"
              : isPerCall
                ? (hasCallResults
                    ? `Re-run (${callResults.length} call${callResults.length !== 1 ? "s" : ""})`
                    : callResults.length > 0
                      ? `Run ${callResults.length} call${callResults.length !== 1 ? "s" : ""}`
                      : selectedCallIds?.length ? `Run ${selectedCallIds.length} selected` : "Run all calls")
                : (hasResults ? "Re-run" : "Run Pipeline")}
          </button>
          {(hasResults || hasCallResults) && (
            <button
              onClick={() => isPerCall ? runAllCalls(true) : run(true)}
              disabled={anyRunning || !contextOk}
              title="Force re-run — ignore cache, re-run all steps"
              className="flex items-center gap-1.5 px-2.5 py-2 bg-orange-900/60 hover:bg-orange-800/70 border border-orange-700/50 hover:border-orange-600 disabled:opacity-50 text-orange-300 text-[11px] font-medium rounded-lg transition-colors shrink-0"
            >
              <Play className="w-3 h-3" />
              Force
            </button>
          )}
        </div>
        {!running && !callsRunning && latestRun?.status === "running" && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-amber-400 bg-amber-950/20 border border-amber-800/30 rounded-lg">
            <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
            Pipeline running in background…
          </div>
        )}
        {(runError || callsRunError) && (
          <p className="text-[11px] text-red-400 break-words">{runError || callsRunError}</p>
        )}
      </div>

      {/* ── FLOW VIEW ───────────────────────────────────────────────────────────── */}
      {panelView === "flow" && (
        <div className="flex-1 min-h-0 flex flex-col">

          {/* Call navigator (per_call mode) */}
          {isPerCall && callResults.length > 0 && (
            <div className="px-2 py-1.5 border-b border-gray-800 flex items-center gap-1 shrink-0">
              <button onClick={() => setFlowCallIdx(i => Math.max(0, i - 1))} disabled={safeFlowCallIdx === 0}
                className="p-1 text-gray-600 hover:text-gray-300 disabled:opacity-30 transition-colors rounded">
                <ChevronLeft className="w-3 h-3" />
              </button>
              <div className="flex-1 text-center min-w-0">
                <p className="text-[9px] font-mono text-gray-500 truncate">{flowCall?.callId ?? "—"}</p>
                <p className="text-[8px] text-gray-700">{safeFlowCallIdx + 1} / {callResults.length}</p>
              </div>
              <button onClick={() => setFlowCallIdx(i => Math.min(callResults.length - 1, i + 1))} disabled={safeFlowCallIdx >= callResults.length - 1}
                className="p-1 text-gray-600 hover:text-gray-300 disabled:opacity-30 transition-colors rounded">
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {canvasNodes && pipeline?.canvas ? (
            <>
              {/* ── Mini canvas (visual replica of pipeline canvas) ── */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                <MiniCanvas
                  stages={pipeline.canvas.stages ?? []}
                  nodes={canvasNodes}
                  edges={pipeline.canvas.edges}
                  procStepIdx={procStepIdx}
                  outputProcId={outputProcId}
                  inputProcIds={inputProcIds}
                  flowSteps={flowSteps}
                  selectedKey={flowSelectedKey}
                  onNodeClick={key => {
                    const isToggleOff = flowSelectedKey === key;
                    setFlowSelectedKey(isToggleOff ? null : key);
                    if (isToggleOff) {
                      setInputPreview({ loading: false, content: "", error: "" });
                      setNodeFileInfo({ loading: false, files: [] });
                      return;
                    }
                    if (key.startsWith("input:")) {
                      const nodeId = key.slice(6);
                      const node = canvasNodes.find(n => n.id === nodeId);
                      const src = node?.data.inputSource ?? "";
                      if (src) {
                        fetchInputPreview(src);
                        fetchNodeFiles([src]);
                      }
                    } else if (key.startsWith("proc:")) {
                      setInputPreview({ loading: false, content: "", error: "" });
                      const nodeId = key.slice(5);
                      const stepIdx = procStepIdx.get(nodeId) ?? 0;
                      const step = pipeline?.steps[stepIdx];
                      const agentId = step?.agent_id ?? "";
                      const agent = agents?.find(a => a.id === agentId);
                      const inputSources = (agent?.inputs ?? []).map(inp =>
                        step?.input_overrides?.[inp.key] ?? inp.source
                      ).filter(s => ["transcript","merged_transcript","notes","merged_notes"].includes(s));
                      if (inputSources.length) fetchNodeFiles([...new Set(inputSources)]);
                      else setNodeFileInfo({ loading: false, files: [] });
                    } else {
                      setInputPreview({ loading: false, content: "", error: "" });
                      setNodeFileInfo({ loading: false, files: [] });
                    }
                  }}
                />
              </div>

              {/* ── Live log tail ── */}
              {logLines.length > 0 && (
                <div className="shrink-0 border-t border-gray-800 bg-black/60 max-h-28 overflow-y-auto">
                  {logLines.map((l, i) => (
                    <div key={i} className={cn(
                      "px-2 py-px font-mono text-[9px] leading-relaxed whitespace-pre-wrap break-all",
                      l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-amber-400" :
                      l.level === "stage" ? "text-teal-400" : l.level === "llm" ? "text-indigo-300" : "text-gray-500"
                    )}>
                      <span className="text-gray-700 mr-1">{utcHmsToIsrael(l.ts)}</span>{l.text}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              )}

              {/* ── Detail panel (shown when a node is selected) ── */}
              {flowSelectedKey && (() => {
                const colonIdx = flowSelectedKey.indexOf(":");
                const prefix = flowSelectedKey.slice(0, colonIdx);
                const nodeId = flowSelectedKey.slice(colonIdx + 1);
                const node = canvasNodes.find(n => n.id === nodeId);
                if (!node) return null;

                const dismiss = () => {
                  setFlowSelectedKey(null);
                  setInputPreview({ loading: false, content: "", error: "" });
                  setNodeFileInfo({ loading: false, files: [] });
                };

                /* ── Input detail ── */
                if (prefix === "input") {
                  const src = node.data.inputSource ?? "";
                  const m = SOURCE_META[src] ?? GENERIC_SOURCE;
                  const Icon = m.icon;
                  return (
                    <div className="shrink-0 border-t border-gray-800 bg-gray-950/90 flex flex-col" style={{ maxHeight: "55%" }}>
                      <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-800 shrink-0">
                        <Icon className={cn("w-3.5 h-3.5 shrink-0", m.color)} />
                        <span className={cn("text-xs font-semibold flex-1 truncate", m.color)}>{m.label}</span>
                        <span className="text-[9px] text-gray-600 shrink-0">input</span>
                        <button onClick={dismiss} className="text-gray-600 hover:text-gray-400 transition-colors shrink-0 ml-1"><X className="w-3 h-3" /></button>
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto">
                        {/* File IDs */}
                        {nodeFileInfo.files.length > 0 && (
                          <div className="px-3 pt-2 pb-1 space-y-1 border-b border-gray-800/60">
                            {nodeFileInfo.files.map(f => (
                              <div key={f.id} className="flex items-center gap-1.5 text-[10px]">
                                <span className="text-gray-600 shrink-0">{f.provider}</span>
                                <code className="flex-1 text-teal-400 font-mono truncate" title={f.provider_file_id}>{f.provider_file_id}</code>
                                <span className="text-gray-700 shrink-0">{(f.chars / 1000).toFixed(1)}k chars</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Content preview */}
                        {inputPreview.loading && <div className="p-3 flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>}
                        {inputPreview.error && <p className="p-3 text-[11px] text-amber-500/80">{inputPreview.error}</p>}
                        {!inputPreview.loading && !inputPreview.error && inputPreview.content && (
                          <pre className="p-3 text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed">{inputPreview.content}</pre>
                        )}
                        {!inputPreview.loading && !inputPreview.error && !inputPreview.content && (
                          <p className="p-3 text-[11px] text-gray-600 text-center">Select agent + customer to preview</p>
                        )}
                      </div>
                    </div>
                  );
                }

                /* ── Processing detail ── */
                if (prefix === "proc") {
                  const stepIdx = procStepIdx.get(nodeId) ?? 0;
                  const st = flowSteps[stepIdx];
                  const status = st?.status ?? "pending";
                  const hasContent = !!(st?.content);
                  const hasStream = !!(st?.stream);
                  const statusColor = status === "done" ? "text-green-400" : status === "cached" ? "text-amber-400" :
                    status === "loading" ? "text-orange-400" : status === "error" ? "text-red-400" : "text-gray-500";
                  const agentId = node.data.agentId ?? "";
                  const agent = agents?.find(a => a.id === agentId);
                  const model = agent?.model ?? node.data.label ?? "—";
                  const pipelineStep = pipeline?.steps[stepIdx];
                  const resolvedInputs = (agent?.inputs ?? []).map(inp => ({
                    key: inp.key,
                    source: pipelineStep?.input_overrides?.[inp.key] ?? inp.source,
                  }));
                  return (
                    <div className="shrink-0 border-t border-gray-800 bg-gray-950/90 flex flex-col" style={{ maxHeight: "65%" }}>
                      <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-800 shrink-0">
                        {status === "done" || status === "cached" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" /> : <Bot className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                        <span className="text-xs font-semibold text-gray-200 flex-1 truncate">{node.data.agentName || node.data.label}</span>
                        <span className={cn("text-[9px] shrink-0 font-medium", statusColor)}>{status}</span>
                        <button onClick={dismiss} className="text-gray-600 hover:text-gray-400 transition-colors shrink-0 ml-1"><X className="w-3 h-3" /></button>
                      </div>
                      {/* Meta row: model + timing + tokens + inputs */}
                      <div className="px-3 py-2 border-b border-gray-800/60 shrink-0 space-y-1.5">
                        <div className="flex flex-wrap gap-2">
                          {(st?.model || model) && (
                            <div className="flex items-center gap-1 text-[10px]">
                              <Cpu className="w-3 h-3 text-indigo-400 shrink-0" />
                              <code className="text-indigo-300 font-mono">{st?.model || model}</code>
                            </div>
                          )}
                          {st?.execTimeS != null && (
                            <div className="flex items-center gap-1 text-[10px]">
                              <Clock className="w-3 h-3 text-cyan-400 shrink-0" />
                              <span className="text-cyan-300">{st.execTimeS}s</span>
                            </div>
                          )}
                          {(st?.inputTokenEst != null && st.inputTokenEst > 0) && (
                            <div className="flex items-center gap-1 text-[10px] text-gray-500">
                              <Zap className="w-3 h-3 text-amber-500/60 shrink-0" />
                              <span>~{st.inputTokenEst.toLocaleString()} in / ~{st.outputTokenEst?.toLocaleString() ?? "?"} out</span>
                            </div>
                          )}
                        </div>
                        {resolvedInputs.map(inp => (
                          <div key={inp.key} className="flex items-center gap-1.5 text-[10px]">
                            <span className="text-gray-600">{inp.key}</span>
                            <span className="text-cyan-400">{inp.source}</span>
                          </div>
                        ))}
                        {nodeFileInfo.loading && <span className="text-[10px] text-gray-600">Loading file IDs…</span>}
                        {nodeFileInfo.files.map(f => (
                          <div key={f.id} className="flex items-center gap-1.5 text-[10px]">
                            <span className="text-gray-600 shrink-0">{f.provider}/{f.source}</span>
                            <code className="flex-1 text-teal-400 font-mono truncate" title={f.provider_file_id}>{f.provider_file_id}</code>
                            <span className="text-gray-700 shrink-0">{(f.chars / 1000).toFixed(1)}k</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto">
                        {hasStream && (
                          <pre className="p-3 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed">
                            {st!.stream}<div ref={streamEndRef} />
                          </pre>
                        )}
                        {!hasStream && status === "error" && (
                          <div className="p-3 space-y-2">
                            {st?.errorMsg && (
                              <pre className="text-[10px] text-red-400 font-mono whitespace-pre-wrap break-words bg-red-950/20 rounded p-2 border border-red-900/40">{st.errorMsg}</pre>
                            )}
                            <button onClick={() => { if (isPerCall) runAllCalls(true); else run(true); }}
                              disabled={anyRunning || !contextOk}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-900/60 hover:bg-orange-800 border border-orange-700/50 disabled:opacity-50 text-orange-300 text-[11px] font-medium rounded-lg transition-colors">
                              <Play className="w-3 h-3" /> Force Re-run
                            </button>
                          </div>
                        )}
                        {!hasStream && status === "pending" && (
                          <div className="p-3 flex flex-col items-center gap-2">
                            <p className="text-[11px] text-gray-600">Not yet executed</p>
                            <button onClick={() => { if (isPerCall) runAllCalls(); else run(); }}
                              disabled={anyRunning || !contextOk}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-[11px] font-medium rounded-lg transition-colors">
                              <Play className="w-3 h-3" /> {isPerCall ? "Run All Calls" : "Run Pipeline"}
                            </button>
                          </div>
                        )}
                        {!hasStream && st?.thinking && (
                          <details className="mx-3 mt-2 mb-1 border border-purple-900/40 rounded-lg overflow-hidden">
                            <summary className="px-3 py-1.5 text-[10px] text-purple-400 font-semibold bg-purple-950/20 cursor-pointer list-none flex items-center gap-1.5">
                              <span className="text-purple-500">▶</span> Extended thinking
                            </summary>
                            <pre className="p-3 text-[10px] text-purple-300/70 font-mono whitespace-pre-wrap break-words leading-relaxed bg-purple-950/10 max-h-48 overflow-y-auto">{st.thinking}</pre>
                          </details>
                        )}
                        {!hasStream && hasContent && (
                          <details className="mx-3 mt-2 mb-1 border border-gray-800/60 rounded-lg overflow-hidden">
                            <summary className="px-3 py-1.5 text-[10px] text-gray-400 font-semibold bg-gray-900/60 cursor-pointer list-none flex items-center gap-1.5">
                              <span className="text-gray-600">▶</span> Raw response
                            </summary>
                            <pre className="p-3 text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-64 overflow-y-auto">{st!.content}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  );
                }

                /* ── Output detail ── */
                if (prefix === "out") {
                  const procId = outputProcId.get(nodeId);
                  const stepIdx = procId != null ? procStepIdx.get(procId) : undefined;
                  const st = stepIdx != null ? flowSteps[stepIdx] : undefined;
                  const hasContent = !!(st?.content);
                  const subType = node.data.subType ?? "";
                  const art = ARTIFACT_NODE_META[subType] ?? DEFAULT_ARTIFACT_STYLE;
                  return (
                    <div className="shrink-0 border-t border-gray-800 bg-gray-950/90 flex flex-col" style={{ maxHeight: "65%" }}>
                      <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-800 shrink-0">
                        <FileText className={cn("w-3.5 h-3.5 shrink-0", art.color)} />
                        <span className={cn("text-xs font-semibold flex-1", art.color)}>Output</span>
                        {subType && <span className={cn("text-[10px] px-1.5 py-0.5 rounded border shrink-0", art.color, art.bg, art.border)}>{node.data.label}</span>}
                        {!hasContent && <span className="text-[9px] text-gray-600 shrink-0">awaiting</span>}
                        <button onClick={dismiss} className="text-gray-600 hover:text-gray-400 transition-colors shrink-0 ml-1"><X className="w-3 h-3" /></button>
                      </div>
                      {hasContent
                        ? <div className="flex-1 min-h-0 overflow-y-auto p-1"><SectionContent content={st!.content} /></div>
                        : <p className="p-3 text-[11px] text-gray-600 text-center">Run the pipeline to see results</p>
                      }
                    </div>
                  );
                }

                return null;
              })()}
            </>
          ) : (
            /* ── Legacy fallback for pipelines without saved canvas ── */
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
                <Workflow className="w-8 h-8 opacity-20" />
                <p className="text-xs text-center">Open this pipeline in the Pipeline editor and save it to enable the visual flow view</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── STEPS VIEW ──────────────────────────────────────────────────────────── */}

      {/* Steps (per_pair) */}
      {panelView === "steps" && !isPerCall && (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {steps.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
              <Workflow className="w-8 h-8 opacity-20" />
              <p className="text-xs text-center">{contextOk ? "Hit Run to execute the pipeline" : "Select context to load results"}</p>
            </div>
          )}
          {steps.map((st, i) => (
            <StepRow key={i} st={st} index={i} streamEndRef={streamEndRef}
              onToggle={() => setSteps(p => p.map((s, j) => j === i ? { ...s, expanded: !s.expanded } : s))} />
          ))}
        </div>
      )}

      {/* Call results (per_call) */}
      {panelView === "steps" && isPerCall && (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
          {callResults.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
              <Workflow className="w-8 h-8 opacity-20" />
              <p className="text-xs text-center">
                {!hasPair ? "Select agent + customer"
                  : selectedCallIds?.length ? "Loading selected calls…"
                  : !callDates ? "Loading calls…"
                  : Object.keys(callDates).length === 0 ? "No calls found for this pair"
                  : "Check calls on the left or hit Run to process all"}
              </p>
            </div>
          )}
          {callResults.map((cr, ci) => (
            <div key={cr.callId} className={cn(
              "border rounded-xl overflow-hidden transition-colors",
              cr.runStatus === "running" ? "border-teal-700/60" : "border-gray-700/50",
            )}>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900 hover:bg-gray-800 transition-colors text-left"
                onClick={() => setCallResults(p => p.map((r, i) => i === ci ? { ...r, expanded: !r.expanded } : r))}
              >
                {cr.runStatus === "queued"  && <span className="w-2 h-2 rounded-full border border-gray-700 shrink-0" />}
                {cr.runStatus === "running" && <Loader2 className="w-3 h-3 animate-spin text-teal-400 shrink-0" />}
                {cr.runStatus === "done"    && <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />}
                {cr.runStatus === "cached"  && <SkipForward className="w-3 h-3 text-amber-400 shrink-0" />}
                {cr.runStatus === "error"   && <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />}
                <span className="text-[10px] font-mono text-gray-400 truncate flex-1 min-w-0">{cr.callId}</span>
                <span className="text-[9px] text-gray-600 shrink-0 tabular-nums">{cr.date.slice(0, 10)}</span>
                {cr.runStatus === "queued"  && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-800 text-gray-600 border border-gray-700/40 shrink-0">queued</span>}
                {cr.runStatus === "running" && <span className="text-[9px] px-1 py-0.5 rounded bg-teal-900/40 text-teal-400 border border-teal-700/40 shrink-0">running</span>}
                {cr.runStatus === "done"    && <span className="text-[9px] px-1 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-700/40 shrink-0">done</span>}
                {cr.runStatus === "cached"  && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-700/40 shrink-0">cached</span>}
                {cr.runStatus === "error"   && <span className="text-[9px] px-1 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-700/40 shrink-0">error</span>}
                {cr.expanded ? <ChevronUp className="w-3 h-3 text-gray-600 shrink-0" /> : <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />}
              </button>
              {cr.expanded && (
                <div className="p-2 space-y-1 bg-gray-950/40 border-t border-gray-800">
                  {cr.steps.map((st, i) => (
                    <StepRow key={i} st={st} index={i} streamEndRef={streamEndRef}
                      onToggle={() => setCallResults(p => p.map((r, ri) => ri === ci
                        ? { ...r, steps: r.steps.map((s, j) => j === i ? { ...s, expanded: !s.expanded } : s) }
                        : r))} />
                  ))}
                  {cr.error && <p className="text-[11px] text-red-400 px-2 pt-1">{cr.error}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared step row ───────────────────────────────────────────────────────────
function StepRow({ st, index, streamEndRef, onToggle }: {
  st: StepState; index: number;
  streamEndRef: React.RefObject<HTMLDivElement>;
  onToggle: () => void;
}) {
  return (
    <div className={cn("border rounded-xl overflow-hidden", (st.status === "done" || st.status === "cached") ? "border-gray-700/60" : "border-gray-800")}>
      <div
        className={cn("flex items-center gap-2 px-3 py-2", (st.status === "done" || st.status === "cached") && "cursor-pointer hover:bg-gray-800/40")}
        onClick={() => { if (st.status === "done" || st.status === "cached") onToggle(); }}
      >
        {st.status === "loading" && !st.stream && <Loader2 className="w-3 h-3 animate-spin text-teal-400 shrink-0" />}
        {st.status === "loading" && st.stream  && <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse shrink-0" />}
        {st.status === "cached"  && <SkipForward className="w-3 h-3 text-amber-400 shrink-0" />}
        {st.status === "done"    && <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />}
        {st.status === "error"   && <AlertCircle  className="w-3 h-3 text-red-400 shrink-0" />}
        {st.status === "pending" && <span className="w-2 h-2 rounded-full border border-gray-700 shrink-0" />}
        <span className="text-[10px] text-gray-500 font-mono shrink-0">#{index + 1}</span>
        <span className={cn("text-xs flex-1 font-medium truncate", st.status === "loading" ? "text-teal-300" : "text-gray-300")}>{st.agentName}</span>
        {st.status === "cached" && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-700/40">cached</span>}
        {st.status === "done"   && <span className="text-[9px] px-1 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-700/40">done</span>}
        {st.status === "error"  && <span className="text-[9px] px-1 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-700/40">error</span>}
        {(st.status === "done" || st.status === "cached") && (
          st.expanded ? <ChevronUp className="w-3 h-3 text-gray-600 shrink-0" /> : <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
        )}
      </div>
      {st.status === "loading" && st.stream && (
        <div className="px-3 pb-3 bg-gray-950">
          <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto">
            {st.stream}<div ref={streamEndRef} />
          </pre>
        </div>
      )}
      {st.expanded && (st.status === "done" || st.status === "cached") && st.content && (
        <div className="px-3 pb-3 bg-gray-950"><SectionContent content={st.content} /></div>
      )}
    </div>
  );
}
