"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { getJobs } from "@/lib/api";
import { Job } from "@/lib/types";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Circle, Cpu, List, Loader2, Radio, RotateCcw, Sparkles, Terminal,
  Trash2, XCircle,
} from "lucide-react";
import { cn, formatDuration, formatDate } from "@/lib/utils";

// Use backend URL directly for EventSource — Next.js dev-server proxy buffers
// SSE streams and events never arrive. Regular SWR fetches go through /api rewrite.
const API = "/api";
const MAX_WORKERS = 4; // fallback default only — real value comes from /api/jobs/config

type LogLine = { ts: string; text: string; level: string; job_id?: string | null };

const LEVEL_COLOR: Record<string, string> = {
  error: "text-red-400",
  warn:  "text-yellow-400",
  stage: "text-indigo-300 font-semibold",
  llm:   "text-teal-300 font-medium",
  info:  "text-gray-400",
};

// Stable color rotation for job IDs in global log view
const JOB_BADGE_COLORS = [
  "bg-cyan-900/50 text-cyan-300",
  "bg-emerald-900/50 text-emerald-300",
  "bg-violet-900/50 text-violet-300",
  "bg-orange-900/50 text-orange-300",
  "bg-pink-900/50 text-pink-300",
  "bg-teal-900/50 text-teal-300",
  "bg-yellow-900/50 text-yellow-300",
  "bg-blue-900/50 text-blue-300",
];

function classifyLine(text: string): string {
  const t = text.toUpperCase();
  if (t.includes("ERROR") || t.includes("EXCEPTION") || t.includes("TRACEBACK") || t.includes("FAILED")) return "error";
  if (t.includes("WARN")) return "warn";
  if (t.includes("STAGE") || t.includes("PIPELINE") || ["✅","🚀","📡","🎵","📝","📊","🔤","🗳"].some(e => text.includes(e))) return "stage";
  if (["[VOTE]","[SMOOTH]","[LLM]","[PERSONA]","[SESSION","[VOTE-BATCH]","[SMOOTH-BATCH]","[MERGE]"].some(p => t.startsWith(p))) return "llm";
  return "info";
}

type FilterMode = "all" | "llm" | "pipeline" | "errors";

// ── sessionStorage helpers ─────────────────────────────────────────────────────

function ssGet(key: string): string | null {
  try { return sessionStorage.getItem(`logs_${key}`); } catch { return null; }
}
function ssSet(key: string, value: string): void {
  try { sessionStorage.setItem(`logs_${key}`, value); } catch { /* SSR/private */ }
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: string | number; icon: React.ElementType; color: string;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 mb-0.5">
        <Icon className={cn("w-3 h-3", color)} />
        <span className="text-[10px] text-gray-500">{label}</span>
      </div>
      <p className={cn("text-xl font-bold font-mono leading-tight", color)}>{value}</p>
    </div>
  );
}

// ── Worker Lane ───────────────────────────────────────────────────────────────

function WorkerLane({ slot, job, active, onClick }: {
  slot: number; job: Job | null; active: boolean; onClick: () => void;
}) {
  return (
    <div
      onClick={job ? onClick : undefined}
      className={cn(
        "rounded-lg border px-2.5 py-2 transition-colors",
        job ? "border-indigo-700/50 bg-indigo-900/10 cursor-pointer hover:bg-indigo-900/20" : "border-gray-800",
        active && "ring-1 ring-indigo-500/60"
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <Cpu className={cn("w-3 h-3 shrink-0", job ? "text-indigo-400" : "text-gray-700")} />
        <span className="text-[10px] font-semibold text-gray-600">W{slot}</span>
        {job ? (
          <span className="ml-auto text-[10px] font-mono text-indigo-300 truncate max-w-[90px]">
            {job.call_id}
          </span>
        ) : (
          <span className="ml-auto text-[10px] text-gray-700 italic">idle</span>
        )}
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mb-1">
        {job ? (
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-700"
            style={{ width: `${job.pct}%` }}
          />
        ) : null}
      </div>
      {job ? (
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-gray-600 truncate max-w-[110px]">
            {job.duration_s ? formatDuration(job.duration_s) + (job.started_at ? ` · ${formatDate(job.started_at)}` : "") : (job.message?.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 22) || job.status)}
          </span>
          <span className="text-[9px] text-indigo-400/80 shrink-0 ml-1">{job.pct}%</span>
        </div>
      ) : (
        <div className="h-3" />
      )}
    </div>
  );
}

// ── Batch Group ───────────────────────────────────────────────────────────────

function BatchGroup({ batchId, jobs, total, onSelect, focusId, defaultOpen = false }: {
  batchId: string;
  jobs: Job[];
  total: number;
  onSelect: (j: Job) => void;
  focusId?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const done = jobs.filter(j => j.status === "complete" || j.status === "failed").length;
  const running = jobs.filter(j => j.status === "running").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-gray-800/40 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3 text-gray-600" /> : <ChevronRight className="w-3 h-3 text-gray-600" />}
        <span className="text-[10px] font-mono text-gray-500 truncate flex-1 text-left">
          batch·{batchId.slice(0, 8)} — {total} job{total !== 1 ? "s" : ""}
        </span>
        {running > 0 && <Loader2 className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />}
        <span className="text-[10px] text-gray-500 shrink-0">{done}/{total}</span>
      </button>
      <div className="h-1 bg-gray-800">
        <div className="h-full bg-indigo-600/60 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <div className="divide-y divide-gray-800/50">
          {jobs.map(j => {
            const agent = j.pair_slug ? j.pair_slug.split("/")[0] : "";
            return (
              <button key={j.id} onClick={() => onSelect(j)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-800/50 transition-colors",
                  focusId === j.id && "bg-gray-800"
                )}>
                {j.status === "running"  && <Loader2 className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />}
                {j.status === "pending"  && <Circle className="w-3 h-3 text-gray-700 shrink-0" />}
                {j.status === "complete" && <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />}
                {j.status === "failed"   && <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] font-mono text-gray-300 truncate block">{agent || j.call_id}</span>
                  <span className="text-[9px] font-mono text-gray-600 truncate block">{j.call_id}</span>
                  {(j.duration_s || j.started_at) && (
                    <span className="text-[9px] text-gray-600">
                      {j.duration_s ? formatDuration(j.duration_s) : ""}{j.duration_s && j.started_at ? " · " : ""}{j.started_at ? formatDate(j.started_at) : ""}
                    </span>
                  )}
                </div>
                {(j.status === "running" || j.status === "complete") && (
                  <span className="text-[9px] text-gray-600 ml-auto shrink-0">{j.pct}%</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── History Batch Group ────────────────────────────────────────────────────────

function HistoryBatchGroup({ batchId, jobs, onSelect, focusId }: {
  batchId: string;
  jobs: Job[];
  onSelect: (j: Job) => void;
  focusId?: string;
}) {
  const [open, setOpen] = useState(false);
  const failed = jobs.filter(j => j.status === "failed").length;

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-gray-800/40 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3 text-gray-600" /> : <ChevronRight className="w-3 h-3 text-gray-600" />}
        <span className="text-[10px] font-mono text-gray-500 truncate flex-1 text-left">
          batch · {batchId.slice(0, 8)} — {jobs.length} job{jobs.length !== 1 ? "s" : ""}
        </span>
        {failed > 0 && <span className="text-[9px] text-red-400 shrink-0">{failed} err</span>}
      </button>
      {open && (
        <div className="divide-y divide-gray-800/50">
          {jobs.map(j => (
            <button key={j.id} onClick={() => onSelect(j)}
              className={cn(
                "w-full text-left flex items-start gap-2 py-1.5 px-3 transition-colors",
                focusId === j.id ? "bg-gray-700/60 border-l-2 border-l-indigo-500" : "hover:bg-gray-800"
              )}>
              {j.status === "complete"
                ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                : <XCircle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-white font-mono truncate">{j.call_id}</p>
                <p className="text-[9px] text-gray-500 truncate">
                  {j.duration_s ? formatDuration(j.duration_s) + " · " : ""}{j.started_at ? formatDate(j.started_at) : j.pair_slug}
                </p>
                {j.error && <p className="text-[9px] text-red-400 truncate">{j.error}</p>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── LLM Op tracker (parsed from log lines) ────────────────────────────────────

interface LlmOp {
  id: string;          // call_id or unique key
  type: string;        // "vote" | "smooth" | "persona" | "LLM" | etc.
  label: string;       // display text
  status: "running" | "done" | "error";
  ts: string;
}

function useLlmOps(lines: LogLine[]): LlmOp[] {
  return useMemo(() => {
    const ops: LlmOp[] = [];
    const seen = new Map<string, LlmOp>();
    for (const l of lines) {
      const t = l.text;
      // [vote] call_id — ...
      const voteStart = t.match(/^\[vote(?:-batch)?\]\s+(\S+)\s+—\s+start/i);
      const voteDone  = t.match(/^\[vote(?:-batch)?\]\s+(\S+)\s+—\s+(✅|saving|done|finish)/i);
      const voteErr   = t.match(/^\[vote(?:-batch)?\]\s+(\S+)\s+—\s+ERROR/i);
      const smoothStart = t.match(/^\[smooth(?:-batch)?\]\s+(\S+)\s+—\s+start/i);
      const smoothDone  = t.match(/^\[smooth(?:-batch)?\]\s+(\S+)\s+—\s+(✅|saving|done|finish)/i);
      const smoothErr   = t.match(/^\[smooth(?:-batch)?\]\s+(\S+)\s+—\s+ERROR/i);
      const llmCall  = t.match(/^\[LLM\]\s+(\S+)\s+—\s+[\d,]+\s+chars\s+input/i);
      const llmDone  = t.match(/^\[LLM\]\s+(\S+)\s+—\s+done/i);

      if (voteStart) {
        const key = `vote:${voteStart[1]}:${l.ts}`;
        const op: LlmOp = { id: key, type: "vote", label: `Vote · ${voteStart[1]}`, status: "running", ts: l.ts };
        seen.set(key, op); ops.push(op);
      } else if (voteDone) {
        const key = [...seen.keys()].reverse().find(k => k.startsWith(`vote:${voteDone[1]}`));
        if (key) seen.get(key)!.status = "done";
      } else if (voteErr) {
        const key = [...seen.keys()].reverse().find(k => k.startsWith(`vote:${voteErr[1]}`));
        if (key) seen.get(key)!.status = "error";
      } else if (smoothStart) {
        const key = `smooth:${smoothStart[1]}:${l.ts}`;
        const op: LlmOp = { id: key, type: "smooth", label: `Smooth · ${smoothStart[1]}`, status: "running", ts: l.ts };
        seen.set(key, op); ops.push(op);
      } else if (smoothDone) {
        const key = [...seen.keys()].reverse().find(k => k.startsWith(`smooth:${smoothDone[1]}`));
        if (key) seen.get(key)!.status = "done";
      } else if (smoothErr) {
        const key = [...seen.keys()].reverse().find(k => k.startsWith(`smooth:${smoothErr[1]}`));
        if (key) seen.get(key)!.status = "error";
      } else if (llmCall) {
        const key = `llm:${llmCall[1]}:${l.ts}`;
        const op: LlmOp = { id: key, type: "llm", label: `LLM · ${llmCall[1]}`, status: "running", ts: l.ts };
        seen.set(key, op); ops.push(op);
      } else if (llmDone) {
        const key = [...seen.keys()].reverse().find(k => k.startsWith(`llm:${llmDone[1]}`));
        if (key) seen.get(key)!.status = "done";
      }
    }
    return [...seen.values()].reverse().slice(0, 30);
  }, [lines]); // eslint-disable-line
}

// ── Terminal ──────────────────────────────────────────────────────────────────

function TerminalPane({ focusJob, jobBadgeMap, onLinesChange, initialGrouped, onGroupedChange, initialFilterMode, onFilterModeChange }: {
  focusJob: Job | null;
  jobBadgeMap: Map<string, string>;
  onLinesChange?: (lines: LogLine[]) => void;
  initialGrouped?: boolean;
  onGroupedChange?: (v: boolean) => void;
  initialFilterMode?: FilterMode;
  onFilterModeChange?: (v: FilterMode) => void;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>(initialFilterMode ?? "all");
  const [paused, setPaused] = useState(false);
  const [grouped, setGrouped] = useState(initialGrouped ?? false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [connErr, setConnErr] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  // Ref to track whether we've received any data — avoids stale closure in onerror
  const hasReceivedRef = useRef(false);

  const handleSetFilterMode = (mode: FilterMode) => {
    setFilterMode(mode);
    onFilterModeChange?.(mode);
  };

  const handleSetGrouped = (v: boolean) => {
    setGrouped(v);
    onGroupedChange?.(v);
  };

  const maybeScrollToBottom = () => {
    const el = scrollRef.current;
    if (!el || pausedRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  const appendMany = (incoming: LogLine[]) => {
    if (!incoming.length) return;
    hasReceivedRef.current = true;
    setLines(prev => {
      const next = [...prev, ...incoming];
      const trimmed = next.length > 2000 ? next.slice(-2000) : next;
      onLinesChange?.(trimmed);
      return trimmed;
    });
    setTimeout(maybeScrollToBottom, 50);
  };

  useEffect(() => {
    setLines([]);
    setConnErr(null);
    setConnected(false);
    hasReceivedRef.current = false;
    const url = focusJob ? `${API}/jobs/${focusJob.id}/stream` : `${API}/logs/stream`;
    const es = new EventSource(url);
    const batch: LogLine[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (batch.length) appendMany([...batch]);
      batch.length = 0;
      timer = null;
    };

    es.onopen = () => {
      setConnErr(null);
      setConnected(true);
    };

    es.onerror = () => {
      setConnected(false);
      // For a finished/failed job the stream closes after "done" — don't show an error.
      // Only show the error banner if we never received any data.
      if (!hasReceivedRef.current) {
        setConnErr(`Cannot connect to ${url} — is the backend running?`);
      }
    };

    es.onmessage = (e) => {
      if (!e.data || e.data === "{}") return;
      setConnErr(null);
      try {
        const data = JSON.parse(e.data);
        if (data.heartbeat) return;
        let line: LogLine;
        if (focusJob) {
          const text = (data.message as string || "").trim();
          if (!text) return;
          line = { ts: new Date().toISOString().slice(11, 19), text, level: classifyLine(text) };
          batch.push(line);
          if (!timer) timer = setTimeout(flush, 80);
          // Close once the job signals done — prevents EventSource auto-reconnect loop
          if (data.done) {
            flush();
            es.close();
          }
        } else {
          line = { ts: data.ts || "", text: data.text || "", level: data.level || "info", job_id: data.job_id };
          batch.push(line);
          if (!timer) timer = setTimeout(flush, 80);
        }
      } catch { /* ignore */ }
    };

    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior }), 300);
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [focusJob?.id, reconnectKey]); // eslint-disable-line

  const modeFiltered = filterMode === "all" ? lines
    : filterMode === "llm"      ? lines.filter(l => l.level === "llm")
    : filterMode === "pipeline" ? lines.filter(l => l.level === "stage")
    : filterMode === "errors"   ? lines.filter(l => l.level === "error" || l.level === "warn")
    : lines;
  const filtered = filter
    ? modeFiltered.filter(l => l.text.toLowerCase().includes(filter.toLowerCase()))
    : modeFiltered;

  // Grouped view: cluster lines by job_id
  const groupedData = useMemo(() => {
    if (!grouped) return null;
    const order: string[] = [];
    const map = new Map<string, LogLine[]>();
    for (const line of filtered) {
      const key = line.job_id ?? "__system__";
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key)!.push(line);
    }
    return { order, map };
  }, [filtered, grouped]); // eslint-disable-line

  const toggleGroup = (key: string) =>
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="flex-1 bg-gray-950 border border-gray-800 rounded-xl overflow-hidden flex flex-col min-h-0">
      {/* Chrome bar */}
      <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500/60" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/60" />
          <span className="w-3 h-3 rounded-full bg-green-500/60" />
        </div>
        {/* Dynamic connection status */}
        <span className="text-xs text-gray-500 ml-1 flex items-center gap-1.5">
          {focusJob ? (
            <>
              <Radio className="w-3 h-3 text-indigo-400 animate-pulse" />
              {`job · ${focusJob.call_id}`}
            </>
          ) : connected ? (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-emerald-400">live</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-yellow-500 shrink-0 animate-pulse" />
              <span className="text-yellow-400">reconnecting…</span>
            </>
          )}
        </span>
        {/* Reconnect button */}
        <button
          onClick={() => setReconnectKey(k => k + 1)}
          title="Reconnect"
          className="p-1 rounded text-gray-600 hover:text-gray-400 hover:bg-gray-800 transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        <div className="ml-auto flex items-center gap-2">
          <input
            className="px-2.5 py-1 bg-gray-800 border border-gray-700 rounded-md text-xs text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 w-40"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
          <button
            onClick={() => setPaused(p => !p)}
            className={cn("px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
              paused ? "bg-indigo-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700")}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          {!focusJob && (
            <button
              onClick={() => { handleSetGrouped(!grouped); setCollapsedGroups(new Set()); }}
              className={cn("px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                grouped ? "bg-violet-700 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700")}
            >
              Group
            </button>
          )}
          <button
            onClick={async () => {
              if (!focusJob) {
                await fetch(`${API}/logs/buffer`, { method: "DELETE" }).catch(() => {});
              }
              setLines([]);
              onLinesChange?.([]);
            }}
            className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-500 rounded-md text-xs transition-colors"
          >
            Clear
          </button>
          <span className="text-xs text-gray-700">{filtered.length}</span>
        </div>
      </div>
      {/* Filter mode tabs */}
      {!focusJob && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 shrink-0 bg-gray-950">
          {(["all", "llm", "pipeline", "errors"] as FilterMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => handleSetFilterMode(mode)}
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                filterMode === mode
                  ? mode === "llm"      ? "bg-teal-800/60 text-teal-300"
                  : mode === "pipeline" ? "bg-indigo-800/60 text-indigo-300"
                  : mode === "errors"   ? "bg-red-800/60 text-red-300"
                  : "bg-gray-700 text-white"
                  : "text-gray-600 hover:text-gray-400"
              )}
            >
              {mode === "all" ? "All" : mode === "llm" ? "LLM Ops" : mode === "pipeline" ? "Pipeline" : "Errors"}
            </button>
          ))}
        </div>
      )}

      {/* Log output */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-xs p-3">
        {connErr && (
          <p className="text-red-500 text-center pt-8 text-xs">{connErr}</p>
        )}
        {!connErr && filtered.length === 0 && (
          <p className="text-gray-600 text-center pt-8">
            {focusJob ? "Waiting for job output…" : "No log output yet — run a transcription job to see activity"}
          </p>
        )}

        {/* ── Grouped view ── */}
        {groupedData && groupedData.order.map(key => {
          const groupLines = groupedData.map.get(key)!;
          const isCollapsed = collapsedGroups.has(key);
          const isSystem = key === "__system__";
          const badge = !isSystem ? (jobBadgeMap.get(key) ?? JOB_BADGE_COLORS[0]) : null;
          const errCount = groupLines.filter(l => l.level === "error").length;
          const warnCount = groupLines.filter(l => l.level === "warn").length;
          return (
            <div key={key} className="mb-1.5">
              <button
                onClick={() => toggleGroup(key)}
                className="flex items-center gap-1.5 w-full py-0.5 px-1 rounded hover:bg-gray-900/60 text-left select-none"
              >
                {isCollapsed
                  ? <ChevronRight className="w-3 h-3 text-gray-600 shrink-0" />
                  : <ChevronDown className="w-3 h-3 text-gray-600 shrink-0" />}
                {badge
                  ? <span className={cn("shrink-0 text-[9px] font-mono px-1 py-0.5 rounded leading-none", badge)}>{key.slice(0, 6)}</span>
                  : <span className="text-[10px] text-gray-600 font-mono">system</span>}
                <span className="text-[10px] text-gray-700">{groupLines.length} line{groupLines.length !== 1 ? "s" : ""}</span>
                {errCount > 0 && <span className="text-[10px] text-red-500 ml-0.5">{errCount} err</span>}
                {warnCount > 0 && <span className="text-[10px] text-yellow-500 ml-0.5">{warnCount} warn</span>}
              </button>
              {!isCollapsed && (
                <div className="pl-3 border-l border-gray-800/60 ml-1.5 space-y-0.5 mt-0.5">
                  {groupLines.map((l, i) => (
                    <div key={i} className="flex gap-2 leading-5 items-start">
                      <span className="text-gray-700 shrink-0 select-none w-16">{l.ts}</span>
                      <span className={cn("min-w-0 whitespace-pre-wrap break-words", LEVEL_COLOR[l.level] || "text-gray-300")}>{l.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* ── Flat view ── */}
        {!groupedData && (
          <div className="space-y-0.5">
            {filtered.map((l, i) => {
              const badge = (!focusJob && l.job_id) ? (jobBadgeMap.get(l.job_id) ?? JOB_BADGE_COLORS[0]) : null;
              return (
                <div key={i} className="flex gap-2 leading-5 items-start">
                  <span className="text-gray-700 shrink-0 select-none w-16">{l.ts}</span>
                  {badge && (
                    <span className={cn("shrink-0 text-[9px] font-mono px-1 py-0.5 rounded leading-none mt-0.5", badge)}>
                      {l.job_id!.slice(0, 6)}
                    </span>
                  )}
                  <span className={cn("min-w-0 whitespace-pre-wrap break-words", LEVEL_COLOR[l.level] || "text-gray-300")}>{l.text}</span>
                </div>
              );
            })}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LogsPage() {
  // Restore persisted state from sessionStorage
  const [focusJob, setFocusJob] = useState<Job | null>(null);
  const [recentTab, setRecentTab] = useState<"all" | "failed">(() => {
    const v = ssGet("recentTab");
    return (v === "all" || v === "failed") ? v : "all";
  });
  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    const v = ssGet("filterMode");
    return (v === "all" || v === "llm" || v === "pipeline" || v === "errors") ? v as FilterMode : "all";
  });
  const [initialGrouped] = useState<boolean>(() => {
    const v = ssGet("grouped");
    return v === "true";
  });

  const [clearMsg, setClearMsg] = useState<string | null>(null);
  const [llmOpsLines, setLlmOpsLines] = useState<LogLine[]>([]);
  const llmOps = useLlmOps(llmOpsLines);

  const { data: jobs, mutate: mutateJobs } = useSWR<Job[]>("/jobs", () => getJobs() as Promise<Job[]>, {
    refreshInterval: 800,
    revalidateOnFocus: true,
  });

  const { data: sysStats } = useSWR<{ cpu_pct: number | null; mem_pct: number | null }>(
    "/api/jobs/stats",
    (url: string) => fetch(url).then(r => r.json()),
    { refreshInterval: 2000 }
  );

  const { data: jobsConfig, mutate: mutateConfig } = useSWR<{ max_workers: number }>(
    "/api/jobs/config",
    (url: string) => fetch(url).then(r => r.json()),
    { refreshInterval: 10000 }
  );

  const maxWorkers = jobsConfig?.max_workers ?? MAX_WORKERS;

  const running   = jobs?.filter(j => j.status === "running")  ?? [];
  const pending   = jobs?.filter(j => j.status === "pending")  ?? [];
  const completed = jobs?.filter(j => j.status === "complete") ?? [];
  const failed    = jobs?.filter(j => j.status === "failed")   ?? [];
  const activeLlmOps = llmOps.filter(o => o.status === "running").length;
  // Preserve API sort order (created_at desc), mix complete+failed by time
  const recent = jobs?.filter(j => j.status === "complete" || j.status === "failed").slice(0, 100) ?? [];
  const recentShown = recentTab === "failed" ? recent.filter(j => j.status === "failed") : recent;

  // Stable badge color assignment by job ID
  const jobBadgeMap = useMemo(() => {
    const map = new Map<string, string>();
    let idx = 0;
    for (const j of jobs ?? []) {
      if (!map.has(j.id)) map.set(j.id, JOB_BADGE_COLORS[idx++ % JOB_BADGE_COLORS.length]);
    }
    return map;
  }, [jobs]);

  // Group pending + running jobs by batch_id
  const allActive = [...running, ...pending];
  const batchGroups = useMemo(() => {
    const groups: Record<string, { jobs: Job[]; total: number }> = {};
    for (const j of allActive) {
      const key = j.batch_id || "__solo__";
      if (!groups[key]) groups[key] = { jobs: [], total: 0 };
      groups[key].jobs.push(j);
      groups[key].total++;
    }
    return groups;
  }, [allActive]); // eslint-disable-line

  const batchIds = Object.keys(batchGroups).filter(k => k !== "__solo__");
  const soloJobs = batchGroups["__solo__"]?.jobs ?? [];

  // Group history by batch_id
  const historyBatchGroups = useMemo(() => {
    const groups: Record<string, Job[]> = {};
    for (const j of recentShown) {
      const key = j.batch_id || "__solo__";
      if (!groups[key]) groups[key] = [];
      groups[key].push(j);
    }
    return groups;
  }, [recentShown]); // eslint-disable-line

  const historyBatchIds = Object.keys(historyBatchGroups).filter(k => k !== "__solo__");
  const historySoloJobs = historyBatchGroups["__solo__"] ?? [];

  const selectJob = (j: Job) => {
    setFocusJob(f => {
      const next = f?.id === j.id ? null : j;
      ssSet("focusJobId", next ? next.id : "");
      return next;
    });
  };

  // Restore focusJob from sessionStorage when jobs load
  useEffect(() => {
    if (!jobs || jobs.length === 0) return;
    const storedId = ssGet("focusJobId");
    if (!storedId) return;
    // Only restore if focusJob not already set
    setFocusJob(current => {
      if (current) return current;
      const match = jobs.find(j => j.id === storedId);
      return match ?? null;
    });
  }, [jobs]);

  // Persist recentTab
  const handleSetRecentTab = (v: "all" | "failed") => {
    setRecentTab(v);
    ssSet("recentTab", v);
  };

  // Persist filterMode (passed down to TerminalPane)
  const handleFilterModeChange = (v: FilterMode) => {
    setFilterMode(v);
    ssSet("filterMode", v);
  };

  // Persist grouped (callback from TerminalPane)
  const handleGroupedChange = (v: boolean) => {
    ssSet("grouped", String(v));
  };

  // Clear history handler
  const handleClearHistory = async () => {
    try {
      const res = await fetch(`${API}/jobs/history`, { method: "DELETE" });
      const data = await res.json();
      await mutateJobs();
      const n = data?.deleted ?? 0;
      setClearMsg(`Cleared ${n}`);
      setTimeout(() => setClearMsg(null), 2500);
    } catch {
      setClearMsg("Error clearing");
      setTimeout(() => setClearMsg(null), 2500);
    }
  };

  // Worker count controls
  const changeWorkers = async (delta: number) => {
    const next = Math.max(1, maxWorkers + delta);
    try {
      await fetch(`${API}/jobs/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_workers: next }),
      });
      await mutateConfig();
    } catch { /* ignore */ }
  };

  return (
    <div className="h-[calc(100vh-3rem)] flex gap-3">

      {/* ── Left: Orchestration panel ── */}
      <div className="w-72 flex-shrink-0 flex flex-col gap-2 min-h-0 overflow-y-auto">

        {/* Stats */}
        <div className="grid grid-cols-4 gap-1 shrink-0">
          <StatCard label="Active"  value={running.length + activeLlmOps} icon={Activity}     color={(running.length + activeLlmOps) > 0 ? "text-indigo-400" : "text-gray-600"} />
          <StatCard label="Queued"  value={pending.length} icon={List}          color={pending.length > 0 ? "text-yellow-400" : "text-gray-600"} />
          <StatCard label="Done"    value={completed.length} icon={CheckCircle2} color="text-emerald-500" />
          <StatCard label="Failed"  value={failed.length}  icon={AlertTriangle} color={failed.length > 0 ? "text-red-400" : "text-gray-600"} />
        </div>

        {/* Clear stats button */}
        {(completed.length + failed.length > 0) && (
          <div className="flex items-center justify-between shrink-0 px-0.5">
            <button
              onClick={handleClearHistory}
              className="flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-gray-900"
            >
              <Trash2 className="w-3 h-3" />
              Clear completed &amp; failed
            </button>
            {clearMsg && (
              <span className="text-[10px] text-emerald-400 font-mono">{clearMsg}</span>
            )}
          </div>
        )}

        {/* Workers — running jobs as live lanes */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 shrink-0">
          <div className="flex items-center gap-1.5 mb-1">
            <Cpu className="w-3 h-3 text-gray-500" />
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Workers</h3>
            <span className="ml-auto text-[10px] text-gray-700">
              {running.length}/{maxWorkers} active{activeLlmOps > 0 && running.length === 0 ? ` · ${activeLlmOps} LLM` : ""}
            </span>
            {/* Worker count controls */}
            <button
              onClick={() => changeWorkers(-1)}
              disabled={maxWorkers <= 1}
              className="ml-1 w-5 h-5 flex items-center justify-center rounded bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-xs leading-none"
              title="Decrease max workers"
            >−</button>
            <button
              onClick={() => changeWorkers(1)}
              className="w-5 h-5 flex items-center justify-center rounded bg-gray-800 text-gray-400 hover:bg-gray-700 text-xs leading-none"
              title="Increase max workers"
            >+</button>
          </div>
          {sysStats && (sysStats.cpu_pct != null || sysStats.mem_pct != null) && (
            <div className="flex items-center gap-2 mb-2">
              {sysStats.cpu_pct != null && (
                <div className="flex-1">
                  <div className="flex justify-between text-[9px] text-gray-600 mb-0.5">
                    <span>CPU</span>
                    <span className={sysStats.cpu_pct > 80 ? "text-red-400" : sysStats.cpu_pct > 50 ? "text-yellow-400" : "text-gray-500"}>
                      {sysStats.cpu_pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${sysStats.cpu_pct > 80 ? "bg-red-500" : sysStats.cpu_pct > 50 ? "bg-yellow-500" : "bg-indigo-600"}`}
                      style={{ width: `${sysStats.cpu_pct}%` }}
                    />
                  </div>
                </div>
              )}
              {sysStats.mem_pct != null && (
                <div className="flex-1">
                  <div className="flex justify-between text-[9px] text-gray-600 mb-0.5">
                    <span>MEM</span>
                    <span className={sysStats.mem_pct > 85 ? "text-red-400" : "text-gray-500"}>
                      {sysStats.mem_pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-700 ${sysStats.mem_pct > 85 ? "bg-red-500" : "bg-teal-700"}`}
                      style={{ width: `${sysStats.mem_pct}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          {running.length === 0 ? (
            <p className="text-[11px] text-gray-700 text-center py-2">
              {activeLlmOps > 0 ? `Idle · ${activeLlmOps} LLM op${activeLlmOps !== 1 ? "s" : ""} running` : "All workers idle"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {running.map((job, i) => (
                <WorkerLane
                  key={job.id}
                  slot={i + 1}
                  job={job}
                  active={focusJob?.id === job.id}
                  onClick={() => selectJob(job)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Queue — always visible */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 shrink-0">
          <div className="flex items-center gap-1.5 mb-2">
            <List className="w-3 h-3 text-gray-500" />
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Queue</h3>
            <span className="ml-auto text-[10px] text-gray-700">{allActive.length} active</span>
          </div>
          {allActive.length === 0 ? (
            <p className="text-[11px] text-gray-700 text-center py-2">Queue empty</p>
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {batchIds.map(bid => (
                <BatchGroup
                  key={bid}
                  batchId={bid}
                  jobs={batchGroups[bid].jobs}
                  total={batchGroups[bid].total}
                  onSelect={selectJob}
                  focusId={focusJob?.id}
                  defaultOpen
                />
              ))}
              {soloJobs.map((j, i) => {
                const agent    = j.pair_slug ? j.pair_slug.split("/")[0] : "";
                const customer = j.pair_slug ? j.pair_slug.split("/").slice(1).join("/") : "";
                return (
                  <button key={j.id} onClick={() => selectJob(j)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors",
                      focusJob?.id === j.id ? "bg-indigo-900/20 border border-indigo-700/40" : "hover:bg-gray-800"
                    )}>
                    <span className="text-[10px] font-mono text-gray-600 w-4 shrink-0">{i + 1}</span>
                    {j.status === "running"
                      ? <Loader2 className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />
                      : <Circle className="w-3 h-3 text-gray-700 shrink-0" />}
                    <div className="min-w-0 flex-1 text-left">
                      <p className="text-[11px] font-mono text-gray-300 truncate">{agent || j.call_id}</p>
                      {customer && (
                        <p className="text-[10px] text-gray-500 truncate">{customer}</p>
                      )}
                      <p className="text-[9px] font-mono text-gray-700 truncate">{j.call_id}</p>
                    </div>
                    {j.status === "running" && (
                      <span className="text-[9px] text-indigo-400/70 shrink-0">{j.pct}%</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* LLM Operations */}
        {llmOps.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <Sparkles className="w-3 h-3 text-teal-500" />
              <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">LLM Ops</h3>
              <span className="ml-auto text-[10px] text-gray-700">{llmOps.filter(o => o.status === "running").length} active</span>
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {llmOps.map(op => (
                <div key={op.id} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-gray-800/50">
                  {op.status === "running" && <Loader2 className="w-3 h-3 text-teal-400 animate-spin shrink-0" />}
                  {op.status === "done"    && <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />}
                  {op.status === "error"   && <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
                  <span className={cn(
                    "text-[10px] font-mono truncate flex-1",
                    op.status === "running" ? "text-teal-300" : op.status === "error" ? "text-red-400" : "text-gray-400"
                  )}>{op.label}</span>
                  <span className="text-[9px] text-gray-700 shrink-0">{op.ts}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent completed/failed */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 mb-2 shrink-0">
            <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex-1">History</h3>
            {(completed.length + failed.length > 0) && (
              <button
                onClick={handleClearHistory}
                title="Clear history"
                className="p-1 rounded text-gray-700 hover:text-red-400 hover:bg-gray-800 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={() => handleSetRecentTab("all")}
              className={cn("text-[10px] px-1.5 py-0.5 rounded transition-colors",
                recentTab === "all" ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-400")}
            >All</button>
            <button
              onClick={() => handleSetRecentTab("failed")}
              className={cn("text-[10px] px-1.5 py-0.5 rounded transition-colors",
                recentTab === "failed"
                  ? "bg-red-900/60 text-red-300"
                  : failed.length > 0 ? "text-red-500 hover:text-red-400" : "text-gray-600")}
            >
              Failed {failed.length > 0 ? `(${failed.length})` : ""}
            </button>
          </div>
          <div className="space-y-0.5 overflow-y-auto flex-1">
            {/* Batch history groups */}
            {historyBatchIds.map(bid => (
              <HistoryBatchGroup
                key={bid}
                batchId={bid}
                jobs={historyBatchGroups[bid]}
                onSelect={selectJob}
                focusId={focusJob?.id}
              />
            ))}
            {/* Solo history items */}
            {historySoloJobs.map(j => (
              <button key={j.id} onClick={() => selectJob(j)}
                className={cn(
                  "w-full text-left flex items-start gap-2 py-1.5 px-1.5 rounded-lg transition-colors",
                  focusJob?.id === j.id ? "bg-gray-700/60 border border-gray-600/40" : "hover:bg-gray-800"
                )}>
                {j.status === "complete"
                  ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                  : <XCircle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-white font-mono truncate">{j.call_id}</p>
                  <p className="text-[9px] text-gray-500 truncate">
                    {j.duration_s ? formatDuration(j.duration_s) + " · " : ""}{j.started_at ? formatDate(j.started_at) : j.pair_slug}
                  </p>
                  {j.error && <p className="text-[9px] text-red-400 truncate">{j.error}</p>}
                </div>
              </button>
            ))}
            {recentShown.length === 0 && (
              <p className="text-xs text-gray-600 text-center py-4">
                {recentTab === "failed" ? "No failed jobs" : "No history yet"}
              </p>
            )}
          </div>
        </div>

      </div>

      {/* ── Right: Terminal ── */}
      <div className="flex-1 flex flex-col min-h-0 gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <Terminal className="w-4 h-4 text-indigo-400" />
          <h1 className="text-sm font-semibold text-white">
            {focusJob ? `Logs · ${focusJob.call_id}` : "System Logs"}
          </h1>
          {focusJob && (
            <button
              onClick={() => { setFocusJob(null); ssSet("focusJobId", ""); }}
              className="ml-auto text-xs text-gray-500 hover:text-gray-300 px-2 py-1 bg-gray-800 rounded-md transition-colors"
            >
              ← All jobs
            </button>
          )}
        </div>
        <TerminalPane
          focusJob={focusJob}
          jobBadgeMap={jobBadgeMap}
          onLinesChange={setLlmOpsLines}
          initialGrouped={initialGrouped}
          onGroupedChange={handleGroupedChange}
          initialFilterMode={filterMode}
          onFilterModeChange={handleFilterModeChange}
        />
      </div>
    </div>
  );
}
