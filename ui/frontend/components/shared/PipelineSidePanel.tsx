"use client";
import { useState, useRef } from "react";
import useSWR from "swr";
import {
  Workflow, Play, Loader2, AlertCircle,
  ChevronDown, ChevronUp, CheckCircle2, SkipForward,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { SectionContent } from "./SectionCards";

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface PipelineStep { agent_id: string; input_overrides: Record<string, string>; }
interface Pipeline {
  id: string; name: string; scope: string;
  steps: PipelineStep[]; created_at: string;
}
interface UniversalAgent { id: string; name: string; }

type StepStatus = "pending" | "loading" | "cached" | "done" | "error";
interface StepState {
  agentName: string; status: StepStatus;
  content: string; stream: string; expanded: boolean;
}

export function PipelineSidePanel() {
  const { salesAgent, customer, callId, activePipelineId, activePipelineName } = useAppCtx();

  const { data: pipeline } = useSWR<Pipeline>(
    activePipelineId ? `/api/pipelines/${activePipelineId}` : null,
    fetcher,
  );
  const { data: agents } = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [runError, setRunError] = useState("");
  const [done, setDone] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  if (!activePipelineId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 p-4 text-center">
        <Workflow className="w-8 h-8 opacity-20" />
        <p className="text-xs">Select a pipeline in the context bar</p>
      </div>
    );
  }

  const needsCall = pipeline?.scope === "per_call";
  const hasPair = !!(salesAgent && customer);
  const hasCall = !!(hasPair && callId);
  const contextOk = needsCall ? hasCall : hasPair;

  function initSteps() {
    return (pipeline?.steps ?? []).map(s => {
      const a = (agents ?? []).find(x => x.id === s.agent_id);
      return { agentName: a?.name ?? s.agent_id, status: "pending" as StepStatus, content: "", stream: "", expanded: false };
    });
  }

  async function run() {
    if (!activePipelineId || !contextOk || running) return;
    setRunning(true); setRunError(""); setDone(false);
    setSteps(initSteps());
    abortRef.current = new AbortController();

    try {
      const res = await fetch(`/api/pipelines/${activePipelineId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({ sales_agent: salesAgent, customer, call_id: callId }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();

      while (true) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        for (const line of dec.decode(value).split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            const s: number = evt.data.step ?? 0;

            if (evt.type === "step_start") {
              setSteps(prev => prev.map((st, i) => i === s ? { ...st, status: "loading", agentName: evt.data.agent_name } : st));
            }
            if (evt.type === "step_cached") {
              setSteps(prev => prev.map((st, i) => i === s ? { ...st, status: "cached", content: evt.data.content } : st));
            }
            if (evt.type === "stream") {
              setSteps(prev => prev.map((st, i) => {
                if (i !== s) return st;
                setTimeout(() => streamEndRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
                return { ...st, stream: st.stream + (evt.data.text ?? "") };
              }));
            }
            if (evt.type === "step_done") {
              setSteps(prev => prev.map((st, i) => i === s ? { ...st, status: "done", content: evt.data.content, stream: "" } : st));
            }
            if (evt.type === "error") {
              if (evt.data.step != null) {
                setSteps(prev => prev.map((st, i) => i === evt.data.step ? { ...st, status: "error" } : st));
              }
              setRunError(evt.data.msg ?? "Error");
            }
            if (evt.type === "pipeline_done") setDone(true);
          } catch { /* skip */ }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setRunError(e.message ?? "Unexpected error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <Workflow className="w-3.5 h-3.5 text-teal-400 shrink-0" />
        <span className="text-xs font-semibold text-white flex-1 truncate">{activePipelineName}</span>
        {pipeline && (
          <span className="text-[10px] text-gray-600 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 shrink-0">
            {pipeline.steps.length}s · {pipeline.scope}
          </span>
        )}
      </div>

      {/* Context check */}
      {!contextOk && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 flex items-center gap-1.5 text-[11px] text-amber-400/80">
          <AlertCircle className="w-3 h-3 shrink-0" />
          Needs: {needsCall ? "agent + customer + call" : "agent + customer"}
        </div>
      )}

      {/* Run button */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={run}
          disabled={running || !contextOk}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? "Running…" : done ? "Run again" : "Run Pipeline"}
        </button>
        {runError && <p className="mt-1.5 text-[11px] text-red-400 break-words">{runError}</p>}
      </div>

      {/* Steps */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
        {steps.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
            <Workflow className="w-8 h-8 opacity-20" />
            <p className="text-xs">Hit Run to execute the pipeline</p>
          </div>
        )}

        {steps.map((st, i) => (
          <div key={i} className={cn(
            "border rounded-xl overflow-hidden",
            st.status === "done" || st.status === "cached" ? "border-gray-700/60" : "border-gray-800",
          )}>
            {/* Step header */}
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-2",
                (st.status === "done" || st.status === "cached") && "cursor-pointer hover:bg-gray-800/40",
              )}
              onClick={() => {
                if (st.status === "done" || st.status === "cached") {
                  setSteps(prev => prev.map((s, j) => j === i ? { ...s, expanded: !s.expanded } : s));
                }
              }}
            >
              {/* Status icon */}
              {st.status === "loading" && !st.stream && <Loader2 className="w-3 h-3 animate-spin text-teal-400 shrink-0" />}
              {st.status === "loading" && st.stream && <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse shrink-0" />}
              {st.status === "cached"  && <SkipForward className="w-3 h-3 text-amber-400 shrink-0" />}
              {st.status === "done"    && <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />}
              {st.status === "error"   && <AlertCircle  className="w-3 h-3 text-red-400 shrink-0" />}
              {st.status === "pending" && <span className="w-2 h-2 rounded-full border border-gray-700 shrink-0" />}

              <span className="text-[10px] text-gray-500 font-mono shrink-0">#{i + 1}</span>
              <span className={cn("text-xs flex-1 font-medium truncate", st.status === "loading" ? "text-teal-300" : "text-gray-300")}>
                {st.agentName}
              </span>

              {st.status === "cached" && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-700/40">cached</span>}
              {st.status === "done"   && <span className="text-[9px] px-1 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-700/40">done</span>}
              {st.status === "error"  && <span className="text-[9px] px-1 py-0.5 rounded bg-red-900/40 text-red-400 border border-red-700/40">error</span>}

              {(st.status === "done" || st.status === "cached") && (
                st.expanded ? <ChevronUp className="w-3 h-3 text-gray-600 shrink-0" /> : <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />
              )}
            </div>

            {/* Live stream */}
            {st.status === "loading" && st.stream && (
              <div className="px-3 pb-3 bg-gray-950">
                <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto">
                  {st.stream}
                  <div ref={streamEndRef} />
                </pre>
              </div>
            )}

            {/* Completed content */}
            {st.expanded && (st.status === "done" || st.status === "cached") && st.content && (
              <div className="px-3 pb-3 bg-gray-950">
                <SectionContent content={st.content} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
