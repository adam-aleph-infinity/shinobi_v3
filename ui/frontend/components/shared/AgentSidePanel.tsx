"use client";
import { useState, useRef, useEffect } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Play, Loader2, AlertCircle, Clock, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface AgentDef {
  id: string;
  name: string;
  agent_class: string;
  inputs: { key: string; source: string; agent_id?: string }[];
  output_format: string;
}

interface AgentResult {
  id: string;
  agent_id: string;
  agent_name: string;
  sales_agent: string;
  customer: string;
  call_id: string;
  content: string;
  model: string;
  created_at: string;
}

// Determine what context a given input source requires
function sourceRequires(source: string): "call" | "pair" | "none" {
  if (source === "transcript" || source === "notes") return "call";
  if (source === "merged_transcript" || source === "merged_notes" || source === "agent_output") return "pair";
  return "none";
}

// Highest context requirement across all inputs
function agentRequires(inputs: AgentDef["inputs"]): "call" | "pair" | "none" {
  let level: "call" | "pair" | "none" = "none";
  for (const inp of inputs) {
    const r = sourceRequires(inp.source);
    if (r === "call") { level = "call"; break; }
    if (r === "pair" && level === "none") level = "pair";
  }
  return level;
}

function formatTs(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// ── Result card ───────────────────────────────────────────────────────────────

function ResultCard({ result, format }: { result: AgentResult; format: string }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-900 hover:bg-gray-800 transition-colors text-xs"
      >
        <div className="flex items-center gap-2 text-gray-400 min-w-0">
          <Clock className="w-3 h-3 shrink-0 text-gray-600" />
          <span className="truncate">{formatTs(result.created_at)}</span>
          {result.call_id && (
            <span className="text-[10px] text-gray-600 font-mono truncate max-w-[80px]">{result.call_id}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <span className="text-[10px] text-gray-600">{result.model}</span>
          {expanded ? <ChevronUp className="w-3 h-3 text-gray-600" /> : <ChevronDown className="w-3 h-3 text-gray-600" />}
        </div>
      </button>
      {expanded && (
        <div className="p-3 bg-gray-950 text-xs text-gray-300">
          {format === "json" ? (
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-green-300 overflow-x-auto">
              {result.content}
            </pre>
          ) : (
            <div className="prose prose-invert prose-xs max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── AgentSidePanel ─────────────────────────────────────────────────────────────

export function AgentSidePanel() {
  const { salesAgent, customer, callId, activeAgentId, activeAgentName } = useAppCtx();

  // Fetch agent definition
  const { data: agentDef } = useSWR<AgentDef>(
    activeAgentId ? `/api/universal-agents/${activeAgentId}` : null,
    fetcher,
  );

  // Context sufficiency check
  const requires = agentDef ? agentRequires(agentDef.inputs) : "none";
  const hasPair = !!(salesAgent && customer);
  const hasCall = !!(hasPair && callId);

  const contextOk =
    requires === "none" ? true :
    requires === "pair" ? hasPair :
    hasCall; // "call"

  // Build results query URL
  const resultsUrl = activeAgentId && contextOk
    ? `/api/universal-agents/${activeAgentId}/results?${new URLSearchParams({
        sales_agent: salesAgent,
        customer,
        ...(requires === "call" ? { call_id: callId } : {}),
      }).toString()}`
    : null;

  const { data: results, mutate: mutateResults } = useSWR<AgentResult[]>(
    resultsUrl,
    fetcher,
    { refreshInterval: 15000 },
  );

  // Run state
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState("");
  const [runError, setRunError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function runAgent() {
    if (!activeAgentId || !contextOk) return;
    setRunning(true);
    setRunError("");
    setRunProgress("Starting…");
    abortRef.current = new AbortController();
    try {
      const res = await fetch(`/api/universal-agents/${activeAgentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          sales_agent: salesAgent,
          customer,
          call_id: callId,
          manual_inputs: {},
        }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === "progress") setRunProgress(evt.data.msg ?? "");
            if (evt.type === "error")    { setRunError(evt.data.msg ?? "Error"); break; }
            if (evt.type === "done")     { setRunProgress(""); mutateResults(); }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setRunError(e.message ?? "Unexpected error");
    } finally {
      setRunning(false);
      setRunProgress("");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!activeAgentId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 p-4 text-center">
        <Bot className="w-8 h-8 opacity-20" />
        <p className="text-xs">Select an agent in the context bar</p>
      </div>
    );
  }

  if (!contextOk) {
    const needed = requires === "call" ? "a call selected" : "a sales agent + customer selected";
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 p-4 text-center">
        <AlertCircle className="w-7 h-7 opacity-30" />
        <p className="text-xs font-medium text-gray-500">{activeAgentName}</p>
        <p className="text-xs">Needs: {needed}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <Bot className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="text-xs font-semibold text-white flex-1 truncate">{activeAgentName}</span>
        {agentDef?.agent_class && (
          <span className="text-[10px] text-gray-600 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 shrink-0">
            {agentDef.agent_class}
          </span>
        )}
        <button
          onClick={mutateResults}
          className="text-gray-600 hover:text-gray-400 transition-colors shrink-0"
          title="Refresh results"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {/* Run button + progress */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={runAgent}
          disabled={running}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-violet-700 hover:bg-violet-600 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors"
        >
          {running
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Play className="w-3.5 h-3.5" />}
          {running ? (runProgress || "Running…") : "Run Agent"}
        </button>
        {runError && (
          <p className="mt-1.5 text-[11px] text-red-400 text-center">{runError}</p>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!results ? (
          <div className="flex justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-gray-600" />
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
            <Bot className="w-8 h-8 opacity-20" />
            <p className="text-xs">No results yet. Hit Run to generate one.</p>
          </div>
        ) : (
          results.map(r => (
            <ResultCard
              key={r.id}
              result={r}
              format={agentDef?.output_format ?? "markdown"}
            />
          ))
        )}
      </div>
    </div>
  );
}
