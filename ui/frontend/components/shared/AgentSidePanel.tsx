"use client";
import { useState, useRef, useEffect } from "react";
import useSWR from "swr";
import {
  Bot, Play, Loader2, AlertCircle, Clock,
  ChevronDown, ChevronUp, RefreshCw, Eye, EyeOff,
  Copy, Check, Brain,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { parseSections, SectionCard, SectionContent } from "./SectionCards";

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) { const e: any = new Error(r.statusText || String(r.status)); e.status = r.status; throw e; }
  return r.json();
});

interface AgentInput { key: string; source: string; agent_id?: string; }
interface AgentDef {
  id: string;
  name: string;
  agent_class: string;
  inputs: AgentInput[];
  output_format: string;
}
interface AgentResult {
  id: string; agent_id: string; agent_name: string;
  sales_agent: string; customer: string; call_id: string;
  content: string; model: string; created_at: string;
}

// ── Source / output metadata ──────────────────────────────────────────────────

const SOURCE_META: Record<string, { label: string; badge: string }> = {
  transcript:         { label: "Transcript",        badge: "bg-blue-900/60 text-blue-300 border-blue-700/50" },
  merged_transcript:  { label: "Merged Transcript",  badge: "bg-cyan-900/60 text-cyan-300 border-cyan-700/50" },
  notes:              { label: "Notes",              badge: "bg-green-900/60 text-green-300 border-green-700/50" },
  merged_notes:       { label: "Merged Notes",       badge: "bg-teal-900/60 text-teal-300 border-teal-700/50" },
  agent_output:       { label: "Agent Output",       badge: "bg-purple-900/60 text-purple-300 border-purple-700/50" },
  chain_previous:     { label: "Prev Step",          badge: "bg-amber-900/60 text-amber-300 border-amber-700/50" },
  manual:             { label: "Manual",             badge: "bg-gray-700/60 text-gray-300 border-gray-600/50" },
};

const FORMAT_META: Record<string, { label: string; badge: string }> = {
  markdown: { label: "Markdown", badge: "bg-indigo-900/60 text-indigo-300 border-indigo-700/50" },
  json:     { label: "JSON",     badge: "bg-orange-900/60 text-orange-300 border-orange-700/50" },
  text:     { label: "Text",     badge: "bg-gray-700/60 text-gray-300 border-gray-600/50" },
};

function sourceMeta(s: string) { return SOURCE_META[s] ?? { label: s, badge: "bg-gray-700/60 text-gray-300 border-gray-600/50" }; }
function formatMeta(f: string) { return FORMAT_META[f] ?? FORMAT_META.text; }

// ── Context helpers ───────────────────────────────────────────────────────────

function sourceRequires(source: string): "call" | "pair" | "none" {
  if (source === "transcript" || source === "notes") return "call";
  if (source === "merged_transcript" || source === "merged_notes" || source === "agent_output") return "pair";
  return "none";
}

function agentRequires(inputs: AgentInput[]): "call" | "pair" | "none" {
  let level: "call" | "pair" | "none" = "none";
  for (const inp of inputs) {
    const r = sourceRequires(inp.source);
    if (r === "call") { level = "call"; break; }
    if (r === "pair" && level === "none") level = "pair";
  }
  return level;
}

function hasMergedInputs(inputs: AgentInput[]) {
  return inputs.some(i => i.source === "merged_transcript" || i.source === "merged_notes");
}

// ── Inline input viewer ───────────────────────────────────────────────────────

function InputViewer({
  inp, salesAgent, customer, callId, scopedCallId,
}: {
  inp: AgentInput;
  salesAgent: string; customer: string; callId: string;
  scopedCallId: string; // non-empty when scope=call override is active
}) {
  const [open, setOpen] = useState(false);

  const effectiveSource = scopedCallId
    ? (inp.source === "merged_transcript" ? "transcript"
      : inp.source === "merged_notes" ? "notes"
      : inp.source)
    : inp.source;

  const params = new URLSearchParams({
    source: effectiveSource,
    sales_agent: salesAgent,
    customer,
    call_id: scopedCallId || callId,
    ...(inp.agent_id ? { agent_id: inp.agent_id } : {}),
  });

  const { data, isLoading, error } = useSWR<{ content: string; chars: number }>(
    open ? `/api/universal-agents/raw-input?${params}` : null,
    fetcher,
  );

  const meta = sourceMeta(inp.source);

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium leading-none",
          meta.badge,
        )}>
          <span className="text-[9px] text-gray-500 font-mono">{"{" + inp.key + "}"}</span>
          {meta.label}
        </span>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-gray-600 hover:text-gray-400 transition-colors"
          title={open ? "Hide content" : "View content"}
        >
          {open ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
        {data && (
          <span className="text-[10px] text-gray-600">
            {(data.chars / 1000).toFixed(1)}k chars
          </span>
        )}
      </div>
      {open && (
        <div className="mt-1.5 rounded-lg border border-gray-700/60 bg-gray-950 overflow-hidden">
          {isLoading && (
            <div className="flex justify-center p-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-600" />
            </div>
          )}
          {error && (
            <p className="px-3 py-2 text-[11px] text-red-400">Failed to load</p>
          )}
          {data && (
            <pre className="px-3 py-2 text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
              {data.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Result card ───────────────────────────────────────────────────────────────

function ResultCard({ result, format }: { result: AgentResult; format: string }) {
  const [expanded, setExpanded] = useState(true);
  const [copiedAll, setCopiedAll] = useState(false);
  const [expandTick, setExpandTick] = useState(0);
  const [collapseTick, setCollapseTick] = useState(0);

  const hasSections = format !== "json" && parseSections(result.content).length > 0;

  function copyAll() {
    navigator.clipboard.writeText(result.content);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  }

  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center px-3 py-2 bg-gray-900">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-2 flex-1 min-w-0 text-xs text-gray-400"
        >
          <Clock className="w-3 h-3 shrink-0 text-gray-600" />
          <span className="truncate">{new Date(result.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          {result.call_id && (
            <span className="text-[10px] text-gray-600 font-mono truncate max-w-[80px]">{result.call_id}</span>
          )}
        </button>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <span className="text-[10px] text-gray-600 mr-1">{result.model}</span>
          {hasSections && expanded && (
            <>
              <button onClick={() => setExpandTick(t => t + 1)} className="text-[9px] text-gray-600 hover:text-gray-300 transition-colors uppercase tracking-wide px-1" title="Expand all">open</button>
              <span className="text-gray-700 text-[10px]">·</span>
              <button onClick={() => setCollapseTick(t => t + 1)} className="text-[9px] text-gray-600 hover:text-gray-300 transition-colors uppercase tracking-wide px-1 mr-0.5" title="Collapse all">fold</button>
            </>
          )}
          <button onClick={copyAll} className={cn("p-1 rounded transition-colors hover:bg-gray-700/40", copiedAll ? "text-teal-400" : "text-gray-600")} title="Copy all">
            {copiedAll ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
          <button onClick={() => setExpanded(e => !e)} className="text-gray-600 hover:text-gray-400 transition-colors">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="p-3 bg-gray-950">
          <SectionContent content={result.content} format={format} expandTick={expandTick} collapseTick={collapseTick} />
        </div>
      )}
    </div>
  );
}

// ── AgentSidePanel ─────────────────────────────────────────────────────────────

export function AgentSidePanel() {
  const { salesAgent, customer, callId, activeAgentId, activeAgentName, setActiveAgent } = useAppCtx();

  const { data: agentDef, error: agentDefError } = useSWR<AgentDef>(
    activeAgentId ? `/api/universal-agents/${activeAgentId}` : null,
    fetcher,
  );

  // Scope toggle — only for agents with merged inputs when a call is selected
  const agentInputs = agentDef?.inputs ?? [];
  const canScopeDown = !!(agentDef && hasMergedInputs(agentInputs) && callId);
  const [scope, setScope] = useState<"call" | "pair">("pair");
  const scopedCallId = canScopeDown && scope === "call" ? callId : "";

  // Context sufficiency
  const requires = agentDef ? agentRequires(agentInputs) : "none";
  const hasPair = !!(salesAgent && customer);
  const hasCall = !!(hasPair && callId);
  const contextOk = requires === "none" ? true : requires === "pair" ? hasPair : hasCall;

  // Results query
  const resultsUrl = activeAgentId && contextOk
    ? `/api/universal-agents/${activeAgentId}/results?${new URLSearchParams({
        sales_agent: salesAgent,
        customer,
        ...(requires === "call" || (canScopeDown && scope === "call") ? { call_id: callId } : {}),
      })}`
    : null;

  const { data: results, mutate: mutateResults } = useSWR<AgentResult[]>(
    resultsUrl, fetcher, { refreshInterval: 15000 },
  );

  // Run
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState("");
  const [runError, setRunError] = useState("");
  const [runThinking, setRunThinking] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [runStream, setRunStream] = useState("");
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function runAgent() {
    if (!activeAgentId || !contextOk) return;
    setRunning(true); setRunError(""); setRunProgress("Starting…"); setRunThinking(""); setShowThinking(false); setRunStream("");
    abortRef.current = new AbortController();

    const sourceOverrides: Record<string, string> = {};
    if (scopedCallId && agentInputs.length > 0) {
      for (const inp of agentInputs) {
        if (inp.source === "merged_transcript") sourceOverrides[inp.key] = "transcript";
        if (inp.source === "merged_notes")      sourceOverrides[inp.key] = "notes";
      }
    }

    try {
      const res = await fetch(`/api/universal-agents/${activeAgentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({ sales_agent: salesAgent, customer, call_id: callId, manual_inputs: {}, source_overrides: sourceOverrides }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === "progress") setRunProgress(evt.data.msg ?? "");
            if (evt.type === "error")    setRunError(evt.data.msg ?? "Error");
            if (evt.type === "stream")   { setRunStream(s => s + (evt.data.text ?? "")); streamEndRef.current?.scrollIntoView({ behavior: "smooth" }); }
            if (evt.type === "thinking") { setRunThinking(evt.data.content ?? ""); setShowThinking(true); }
            if (evt.type === "done")     { setRunProgress(""); mutateResults(); }
          } catch { /* skip */ }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setRunError(e.message ?? "Unexpected error");
    } finally {
      setRunning(false); setRunProgress("");
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

  if (agentDefError?.status === 404) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
        <AlertCircle className="w-8 h-8 text-red-500/40" />
        <p className="text-xs text-red-400">Agent not found — it may have been deleted.</p>
        <button
          onClick={() => setActiveAgent("", "", "")}
          className="text-[10px] text-gray-500 hover:text-white underline transition-colors"
        >
          Clear active agent
        </button>
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

  const outMeta = formatMeta(agentDef?.output_format ?? "markdown");

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
        <button onClick={() => mutateResults()} className="text-gray-600 hover:text-gray-400 transition-colors shrink-0" title="Refresh results">
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {/* Input + output badges */}
      {agentDef && agentDef.inputs.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1.5">
          {agentDef.inputs.map((inp, i) => (
            <InputViewer
              key={i}
              inp={inp}
              salesAgent={salesAgent}
              customer={customer}
              callId={callId}
              scopedCallId={scopedCallId}
            />
          ))}
          <div className="flex items-center gap-1 pt-0.5">
            <span className="text-[9px] text-gray-600 uppercase tracking-wide mr-0.5">out</span>
            <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium leading-none", outMeta.badge)}>
              {outMeta.label}
            </span>
          </div>
        </div>
      )}

      {/* Scope toggle */}
      {canScopeDown && (
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 flex items-center gap-2">
          <span className="text-[10px] text-gray-500 shrink-0">Scope</span>
          <div className="flex rounded-lg overflow-hidden border border-gray-700 text-[11px] flex-1">
            <button
              onClick={() => setScope("call")}
              className={cn(
                "flex-1 px-2 py-1 transition-colors",
                scope === "call" ? "bg-violet-800 text-violet-100" : "bg-gray-800 text-gray-400 hover:text-white"
              )}
            >
              This call
            </button>
            <button
              onClick={() => setScope("pair")}
              className={cn(
                "flex-1 px-2 py-1 transition-colors border-l border-gray-700",
                scope === "pair" ? "bg-violet-800 text-violet-100" : "bg-gray-800 text-gray-400 hover:text-white"
              )}
            >
              All calls
            </button>
          </div>
        </div>
      )}

      {/* Run button */}
      <div className="px-3 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={runAgent}
          disabled={running}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-violet-700 hover:bg-violet-600 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors"
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          {running ? (runProgress || "Running…") : "Run Agent"}
        </button>
        {runError && <p className="mt-1.5 text-[11px] text-red-400 text-center break-words">{runError}</p>}
      </div>

      {/* Live stream panel */}
      {(running || runStream) && (
        <div className="border-b border-gray-800 shrink-0 max-h-72 overflow-y-auto">
          <div className="px-3 pt-2 pb-1 flex items-center gap-2 sticky top-0 bg-gray-900/90 backdrop-blur-sm">
            {running && !runStream && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse shrink-0" />
            )}
            <span className="text-[10px] text-gray-600 uppercase tracking-wide">
              {running && !runStream ? (runProgress || "Waiting…") : "Live output"}
            </span>
            {running && runStream && (
              <span className="inline-block w-1 h-3 bg-violet-400 animate-pulse ml-auto shrink-0" />
            )}
          </div>
          {runStream && (
            <pre className="px-3 pb-3 text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed">
              {runStream}
              <div ref={streamEndRef} />
            </pre>
          )}
        </div>
      )}

      {/* Thinking panel */}
      {(running || runThinking) && (
        <div className="border-b border-gray-800 shrink-0">
          <button
            onClick={() => setShowThinking(o => !o)}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-800/40 transition-colors text-left"
          >
            <Brain className="w-3 h-3 text-violet-400 shrink-0" />
            <span className="text-[11px] text-violet-300/70 flex-1">
              {running && !runThinking ? "Thinking…" : "Thinking"}
            </span>
            {running && !runThinking && <Loader2 className="w-3 h-3 animate-spin text-violet-400/60 shrink-0" />}
            {runThinking && (
              showThinking
                ? <ChevronUp className="w-3 h-3 text-gray-500 shrink-0" />
                : <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
            )}
          </button>
          {showThinking && runThinking && (
            <div className="px-3 pb-3">
              <div className="rounded-lg border border-violet-700/30 bg-violet-950/20 p-3 max-h-64 overflow-y-auto">
                <pre className="text-[10px] text-violet-300/70 font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {runThinking}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!results ? (
          <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-gray-600">
            <Bot className="w-8 h-8 opacity-20" />
            <p className="text-xs">No results yet. Hit Run to generate one.</p>
          </div>
        ) : (
          results.map(r => (
            <ResultCard key={r.id} result={r} format={agentDef?.output_format ?? "markdown"} />
          ))
        )}
      </div>
    </div>
  );
}
