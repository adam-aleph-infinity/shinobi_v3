"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import useSWR from "swr";
import {
  Workflow, Play, Loader2, AlertCircle,
  ChevronDown, ChevronUp, CheckCircle2, SkipForward,
  Download, Eye, EyeOff, ChevronLeft, ChevronRight,
  Mic2, FileText, Bot, StickyNote, Layers, BookOpen,
  GitBranch, PenLine,
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
}
interface UniversalAgent {
  id: string; name: string; agent_class?: string;
  inputs?: { key: string; source: string }[];
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

function ArrowDown() {
  return (
    <div className="flex justify-center py-0.5">
      <div className="flex flex-col items-center">
        <div className="w-px h-3 bg-gray-700" />
        <div className="text-gray-700 text-[10px] leading-none">▾</div>
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

  // ── per_pair: fetch cached results ──────────────────────────────────────────
  const cacheUrl = !isPerCall && activePipelineId && hasPair
    ? `/api/pipelines/${activePipelineId}/results?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(callId)}`
    : null;
  const { data: cachedResults, mutate: mutateCache } = useSWR<CachedStepResult[]>(cacheUrl, fetcher);

  useEffect(() => {
    if (isPerCall || loaded || running || !cachedResults || !pipeline || !agents) return;
    setLoaded(true);
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
      setSteps(initialSteps); setDone(true);
    }
  }, [cachedResults, pipeline, agents, running, loaded, isPerCall]);

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

  // Unique data sources shown at the top of the flow diagram
  const flowInputSources = useMemo(() => {
    if (!pipeline || !agents) return [];
    const sources = new Set<string>();
    pipeline.steps.forEach(step => {
      const agent = agents.find(a => a.id === step.agent_id);
      if (agent?.inputs?.length) {
        agent.inputs.forEach(inp => {
          const src = step.input_overrides?.[inp.key] ?? inp.source;
          // Skip "virtual" sources — they are resolved at runtime, not real files
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
        // Endpoint returns plain text (not JSON)
        content = await res.text();
      } else {
        content = `Source type: ${source}\n\n(Data is resolved at pipeline execution time)`;
      }
      setInputPreview({ loading: false, content, error: "" });
    } catch (e: any) {
      setInputPreview({ loading: false, content: "", error: e.message ?? "Failed to load" });
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
  async function run() {
    if (!activePipelineId || !contextOk || running || !pipeline || !agents) return;
    setRunning(true); setRunError(""); setDone(false); setLoaded(true);
    setSteps(initStepsFor(pipeline, agents));
    try {
      const res = await fetch(`/api/pipelines/${activePipelineId}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sales_agent: salesAgent, customer, call_id: callId }),
      });
      if (!res.body) throw new Error("No response body");
      let hadLLM = false;
      await readPipelineSSE(res,
        (type, evt, s) => {
          if (type === "step_start")  setSteps(p => p.map((st, i) => i === s ? { ...st, status: "loading", agentName: evt.agent_name } : st));
          if (type === "step_cached") setSteps(p => p.map((st, i) => i === s ? { ...st, status: "cached",  content: evt.content } : st));
          if (type === "stream")      setSteps(p => { const n = p.map((st, i) => i === s ? { ...st, stream: st.stream + (evt.text ?? "") } : st); setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 0); return n; });
          if (type === "step_done")   { hadLLM = true; setSteps(p => p.map((st, i) => i === s ? { ...st, status: "done", content: evt.content, stream: "" } : st)); }
          if (type === "error" && evt.step != null) setSteps(p => p.map((st, i) => i === evt.step ? { ...st, status: "error" } : st));
          if (type === "pipeline_done") { setDone(true); mutateCache(); }
        },
      );
    } catch (e: any) {
      if (e.name !== "AbortError") setRunError(e.message ?? "Unexpected error");
    } finally { setRunning(false); }
  }

  // ── per_call parallel run ─────────────────────────────────────────────────────
  async function runAllCalls() {
    if (!activePipelineId || !hasPair || callsRunning || !pipeline || !agents) return;
    const hasSelection = selectedCallIds && selectedCallIds.length > 0;
    if (!hasSelection && !callDates) return;
    const sorted: [string, string][] = hasSelection
      ? selectedCallIds!.map(cid => [cid, callDates?.[cid]?.date ?? ""] as [string, string])
      : Object.entries(callDates!).map(([cid, v]) => [cid, v.date] as [string, string]).sort((a, b) => a[1].localeCompare(b[1]));
    if (sorted.length === 0) { setCallsRunError("No calls found for this pair"); return; }

    setCallsRunning(true); setCallsRunError(""); setCallsLoaded(true);
    setCallResults(sorted.map(([cid, date]) => ({
      callId: cid, date,
      steps: initStepsFor(pipeline!, agents!),
      expanded: false, done: false, error: "",
      runStatus: "queued" as CallRunStatus,
    })));

    const runSingle = async (cid: string, ci: number) => {
      setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, runStatus: "running", expanded: true } : cr));
      let hadLLM = false;
      try {
        const res = await fetch(`/api/pipelines/${activePipelineId}/run`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sales_agent: salesAgent, customer, call_id: cid }),
        });
        if (!res.body) throw new Error("No response body");
        await readPipelineSSE(res, (type, evt, s) => {
          if (type === "step_start")  setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, status: "loading", agentName: evt.agent_name } : st) } : cr));
          if (type === "step_cached") setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, status: "cached", content: evt.content } : st) } : cr));
          if (type === "stream")      setCallResults(p => { const n = p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, stream: st.stream + (evt.text ?? "") } : st) } : cr); setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 0); return n; });
          if (type === "step_done")   { hadLLM = true; setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === s ? { ...st, status: "done", content: evt.content, stream: "" } : st) } : cr)); }
          if (type === "error" && evt.step != null) setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, steps: cr.steps.map((st, j) => j === evt.step ? { ...st, status: "error" } : st) } : cr));
          if (type === "pipeline_done") setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, done: true, runStatus: hadLLM ? "done" : "cached", expanded: hadLLM } : cr));
        });
      } catch (e: any) {
        setCallResults(p => p.map((cr, i) => i === ci ? { ...cr, error: e.message ?? "Error", runStatus: "error" } : cr));
      }
    };

    await Promise.allSettled(sorted.map(([cid], ci) => runSingle(cid, ci)));
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

  const anyRunning = running || callsRunning;

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
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={isPerCall ? runAllCalls : run}
          disabled={anyRunning || !contextOk}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
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
        {(runError || callsRunError) && (
          <p className="mt-1.5 text-[11px] text-red-400 break-words">{runError || callsRunError}</p>
        )}
      </div>

      {/* ── FLOW VIEW ───────────────────────────────────────────────────────────── */}
      {panelView === "flow" && (
        <div className="flex-1 min-h-0 flex flex-col">

          {/* Call navigator (per_call mode) */}
          {isPerCall && callResults.length > 0 && (
            <div className="px-2 py-1.5 border-b border-gray-800 flex items-center gap-1 shrink-0">
              <button
                onClick={() => setFlowCallIdx(i => Math.max(0, i - 1))}
                disabled={safeFlowCallIdx === 0}
                className="p-1 text-gray-600 hover:text-gray-300 disabled:opacity-30 transition-colors rounded"
              >
                <ChevronLeft className="w-3 h-3" />
              </button>
              <div className="flex-1 text-center min-w-0">
                <p className="text-[9px] font-mono text-gray-500 truncate">{flowCall?.callId ?? "—"}</p>
                <p className="text-[8px] text-gray-700">{safeFlowCallIdx + 1} / {callResults.length}</p>
              </div>
              <button
                onClick={() => setFlowCallIdx(i => Math.min(callResults.length - 1, i + 1))}
                disabled={safeFlowCallIdx >= callResults.length - 1}
                className="p-1 text-gray-600 hover:text-gray-300 disabled:opacity-30 transition-colors rounded"
              >
                <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Flow diagram */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-0.5">

            {/* ── Input source nodes ── */}
            {flowInputSources.length > 0 && (
              <>
                <p className="text-[9px] text-gray-600 uppercase tracking-widest font-bold px-1 pb-1">Inputs</p>
                <div className="space-y-1">
                  {flowInputSources.map(src => {
                    const m = SOURCE_META[src] ?? GENERIC_SOURCE;
                    const Icon = m.icon;
                    const key = `input:${src}`;
                    const isSelected = flowSelectedKey === key;
                    return (
                      <div key={src}>
                        <button
                          onClick={() => {
                            if (isSelected) {
                              setFlowSelectedKey(null);
                              setInputPreview({ loading: false, content: "", error: "" });
                            } else {
                              setFlowSelectedKey(key);
                              fetchInputPreview(src);
                            }
                          }}
                          className={cn(
                            "w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-all",
                            m.bg, m.border,
                            isSelected ? "opacity-100 ring-1 ring-inset ring-current/30" : "opacity-75 hover:opacity-100",
                          )}
                        >
                          <Icon className={cn("w-3.5 h-3.5 shrink-0", m.color)} />
                          <span className={cn("text-xs font-semibold flex-1 truncate", m.color)}>{m.label}</span>
                          <span className="text-[9px] text-gray-600 shrink-0">input</span>
                          {isSelected
                            ? <ChevronUp className="w-3 h-3 text-gray-600 shrink-0" />
                            : <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />}
                        </button>

                        {/* Input detail pane */}
                        {isSelected && (
                          <div className="mt-1 rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
                            {inputPreview.loading && (
                              <div className="p-3 flex items-center gap-2 text-xs text-gray-500">
                                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                              </div>
                            )}
                            {inputPreview.error && (
                              <p className="p-3 text-[11px] text-red-400">{inputPreview.error}</p>
                            )}
                            {!inputPreview.loading && !inputPreview.error && inputPreview.content && (
                              <pre className="p-3 text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-56 overflow-y-auto">
                                {inputPreview.content}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Arrow from inputs to first step */}
            {flowInputSources.length > 0 && pipeline && pipeline.steps.length > 0 && (
              <ArrowDown />
            )}

            {/* ── Agent step nodes ── */}
            {pipeline && pipeline.steps.length > 0 && (
              <>
                <p className="text-[9px] text-gray-600 uppercase tracking-widest font-bold px-1 pb-1">
                  Pipeline Steps
                </p>
                {pipeline.steps.map((step, i) => {
                  const agent   = agents?.find(a => a.id === step.agent_id);
                  const agentName = agent?.name ?? step.agent_id;
                  const st      = flowSteps[i];
                  const status  = st?.status ?? "pending";
                  const key     = `agent:${i}`;
                  const isSel   = flowSelectedKey === key;
                  const hasContent = !!(st?.content);
                  const hasStream  = !!(st?.stream);

                  const borderClass =
                    status === "loading" ? "border-teal-700/60 bg-teal-950/20" :
                    status === "cached"  ? "border-amber-700/40 bg-amber-950/10" :
                    status === "done"    ? "border-indigo-700/40 bg-indigo-950/20" :
                    status === "error"   ? "border-red-700/40 bg-red-950/20" :
                                          "border-gray-700/50 bg-gray-900/60";

                  return (
                    <div key={i}>
                      <button
                        onClick={() => setFlowSelectedKey(isSel ? null : key)}
                        className={cn(
                          "w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-all",
                          borderClass,
                          isSel ? "opacity-100 ring-1 ring-inset ring-indigo-500/30" : "opacity-80 hover:opacity-100",
                        )}
                      >
                        {status === "loading" && !hasStream && <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-400 shrink-0" />}
                        {status === "loading" && hasStream   && <span className="w-2.5 h-2.5 rounded-full bg-teal-400 animate-pulse shrink-0" />}
                        {status === "cached"  && <SkipForward  className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                        {status === "done"    && <CheckCircle2  className="w-3.5 h-3.5 text-green-400 shrink-0" />}
                        {status === "error"   && <AlertCircle   className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                        {status === "pending" && <Bot            className="w-3.5 h-3.5 text-indigo-500 shrink-0" />}

                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-gray-200 truncate">{agentName}</p>
                          <p className="text-[9px] text-gray-600">Step {i + 1}</p>
                        </div>

                        {status === "cached"  && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-700/40 shrink-0">cached</span>}
                        {status === "done"    && <span className="text-[9px] px-1 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-700/40 shrink-0">done</span>}
                        {status === "error"   && <span className="text-[9px] px-1 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-700/40 shrink-0">error</span>}
                        {status === "pending" && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-800 text-gray-600 border border-gray-700/40 shrink-0">pending</span>}

                        {isSel
                          ? <ChevronUp className="w-3 h-3 text-gray-600 shrink-0" />
                          : <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />}
                      </button>

                      {/* Agent detail pane */}
                      {isSel && (
                        <div className="mt-1 rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
                          {(status === "done" || status === "cached") && hasContent ? (
                            <div className="max-h-56 overflow-y-auto p-1">
                              <SectionContent content={st!.content} />
                            </div>
                          ) : hasStream ? (
                            <pre className="p-3 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-40 overflow-y-auto">
                              {st!.stream}<div ref={streamEndRef} />
                            </pre>
                          ) : (
                            <div className="p-3 flex flex-col items-center gap-2">
                              <p className="text-[11px] text-gray-600 text-center">
                                {status === "error" ? "Step failed" : "Not yet executed"}
                              </p>
                              <button
                                onClick={() => { if (isPerCall) runAllCalls(); else run(); }}
                                disabled={anyRunning || !contextOk}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-[11px] font-medium rounded-lg transition-colors"
                              >
                                <Play className="w-3 h-3" />
                                {isPerCall ? "Run All Calls" : "Run Pipeline"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {i < pipeline.steps.length - 1 && <ArrowDown />}
                    </div>
                  );
                })}
              </>
            )}

            {/* Empty state */}
            {(!pipeline || pipeline.steps.length === 0) && (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
                <Workflow className="w-8 h-8 opacity-20" />
                <p className="text-xs text-center">No steps in this pipeline</p>
              </div>
            )}
          </div>
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
