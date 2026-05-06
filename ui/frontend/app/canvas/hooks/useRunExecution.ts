"use client";

import { useCallback, useRef, useState } from "react";
import type { CanvasNode } from "./useCanvasState";
import type { CanvasLogLine, RunLaunchOptions, RuntimeStatus } from "../types";

async function readSSE(
  res: Response,
  onEvent: (type: string, data: Record<string, unknown>, stepIdx: number) => void,
) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    while (true) {
      const sep = buffer.indexOf("\n\n");
      if (sep < 0) break;
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLines = block.replace(/\r/g, "").split("\n")
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart());
      if (!dataLines.length) continue;
      try {
        const evt = JSON.parse(dataLines.join("\n"));
        const type = String(evt.type || "");
        const data = (evt.data ?? {}) as Record<string, unknown>;
        const step = typeof data.step === "number" ? data.step : -1;
        onEvent(type, data, step);
      } catch { /* ignore malformed */ }
    }
  }
  if (buffer.trim()) {
    const dataLines = buffer.replace(/\r/g, "").split("\n")
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(5).trimStart());
    if (dataLines.length) {
      try {
        const evt = JSON.parse(dataLines.join("\n"));
        const type = String(evt.type || "");
        const data = (evt.data ?? {}) as Record<string, unknown>;
        const step = typeof data.step === "number" ? data.step : -1;
        onEvent(type, data, step);
      } catch { /* ignore */ }
    }
  }
}

export function useRunExecution(
  onNodeStatusChange: (nodeId: string, status: RuntimeStatus, durationS?: number, preview?: string, noteId?: string) => void,
) {
  const [running, setRunning]       = useState(false);
  const [runError, setRunError]     = useState("");
  const [currentRunId, setCurrentRunId] = useState("");
  const [logLines, setLogLines]     = useState<CanvasLogLine[]>([]);
  const abortRef                    = useRef<AbortController | null>(null);

  const appendLog = useCallback((text: string, level?: CanvasLogLine["level"]) => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    const resolved: CanvasLogLine["level"] = level ?? (
      text.toLowerCase().includes("error") || text.toLowerCase().includes("fail") ? "error"
      : text.toLowerCase().includes("llm") || text.toLowerCase().includes("token") ? "llm"
      : "pipeline"
    );
    setLogLines(prev => {
      const next = [...prev, { ts, text, level: resolved }];
      return next.length > 800 ? next.slice(-800) : next;
    });
  }, []);

  const clearLogs = useCallback(() => setLogLines([]), []);

  // Maps step index → agent node id (built from sorted agent nodes before run)
  const stepToNodeRef = useRef<string[]>([]);

  const onStatusChangeRef = useRef(onNodeStatusChange);
  onStatusChangeRef.current = onNodeStatusChange;

  const launch = useCallback(async (
    pipelineId: string,
    salesAgent: string,
    customer: string,
    callId: string,
    agentNodesSortedByX: CanvasNode[],
    opts: RunLaunchOptions,
  ) => {
    if (!pipelineId || !salesAgent || !customer) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Build step → nodeId map
    stepToNodeRef.current = agentNodesSortedByX.map(n => n.id);

    setRunning(true);
    setRunError("");
    clearLogs();
    appendLog(`Starting pipeline run for ${salesAgent} · ${customer}`, "pipeline");

    // Reset all agent nodes to pending
    agentNodesSortedByX.forEach(n => onStatusChangeRef.current(n.id, "pending"));

    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          sales_agent:   salesAgent,
          customer,
          call_id:       callId || "",
          context_call_id: callId || "",
          run_id:        opts.resumeRunId || "",
          force:         opts.force && !opts.failedOnly,
          resume_partial: !!opts.resumeRunId,
          force_step_indices: [],
          execute_step_indices: [],
          prepare_input_only: false,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Run failed (${res.status})${txt ? `: ${txt.slice(0, 120)}` : ""}`);
      }
      if (!res.body) throw new Error("No response body");

      await readSSE(res, (type, data, stepIdx) => {
        if (type === "pipeline_start") {
          appendLog("Pipeline started", "pipeline");
          const rid = String(data.run_id || "").trim();
          if (rid) setCurrentRunId(rid);
        }
        if (type === "pipeline_done") appendLog("Pipeline finished", "pipeline");
        if (type === "error") {
          appendLog(String(data.msg || data.message || "Pipeline error"), "error");
          setRunError(String(data.msg || data.message || "Pipeline error"));
        }
        if (type === "progress" && data.msg) appendLog(String(data.msg), "pipeline");
        if (type === "stream"   && data.text) appendLog(String(data.text), "llm");

        if (stepIdx < 0 || stepIdx >= stepToNodeRef.current.length) return;
        const nodeId = stepToNodeRef.current[stepIdx];
        if (!nodeId) return;

        const agentName = String(data.agent_name || `Step ${stepIdx + 1}`);
        if (type === "step_start")  {
          onStatusChangeRef.current(nodeId, "loading");
          appendLog(`${agentName}: started`, "pipeline");
        }
        if (type === "step_cached") {
          onStatusChangeRef.current(nodeId, "cached");
          appendLog(`${agentName}: cache hit`, "pipeline");
        }
        if (type === "step_done") {
          const dur = typeof data.execution_time_s === "number" ? data.execution_time_s : undefined;
          const preview = String(data.content || "").slice(0, 120) || undefined;
          const noteId  = String(data.note_id || "").trim() || undefined;
          onStatusChangeRef.current(nodeId, "done", dur, preview, noteId);
          appendLog(`${agentName}: done${dur != null ? ` (${dur.toFixed(1)}s)` : ""}`, "pipeline");
        }
        if (type === "step_error") {
          onStatusChangeRef.current(nodeId, "error");
          appendLog(`${agentName}: error — ${String(data.msg || "")}`, "error");
        }
      });

    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        appendLog("Run cancelled", "pipeline");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setRunError(msg);
        appendLog(`Error: ${msg}`, "error");
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, clearLogs]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, runError, currentRunId, logLines, launch, cancel, clearLogs, appendLog };
}
