"use client";
import { useState, useRef, useCallback } from "react";
import { RefreshCw, X, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { mutate } from "swr";

interface SyncEvent {
  stage: number;
  msg: string;
  done?: boolean;
  error?: boolean;
  warning?: boolean;
  complete?: boolean;
  elapsed?: number;
}

const STAGE_LABELS: Record<number, string> = {
  1: "CRM Pairs",
  2: "Deposits",
  3: "Index",
  4: "DB Sync",
};

export function SyncButton() {
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [complete, setComplete] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startSync = useCallback(async () => {
    if (running) { setOpen(true); return; }

    // Clear any pending auto-dismiss
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);

    setRunning(true);
    setOpen(true);
    setEvents([]);
    setComplete(false);
    setHasError(false);
    setElapsed(null);
    setShowLog(false);

    try {
      const res = await fetch("/api/sync/full", { method: "POST" });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.split("\n").find(l => l.startsWith("data:"));
          if (!line) continue;
          try {
            const ev: SyncEvent = JSON.parse(line.replace("data:", "").trim());
            setEvents(prev => [...prev, ev]);
            if (ev.error) setHasError(true);
            if (ev.complete) {
              setComplete(true);
              setElapsed(ev.elapsed ?? null);
              mutate(() => true, undefined, { revalidate: true });
            }
            requestAnimationFrame(() => {
              if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
            });
          } catch {}
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setEvents(prev => [...prev, { stage: 0, msg: `Connection error: ${e.message}`, error: true }]);
        setHasError(true);
      }
    } finally {
      setRunning(false);
      // Auto-dismiss after 8s if no errors
      autoDismissRef.current = setTimeout(() => {
        setHasError(prev => {
          if (!prev) setOpen(false);
          return prev;
        });
      }, 8000);
    }
  }, [running]);

  const dismiss = () => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    setOpen(false);
  };

  const stagesDone = new Set(events.filter(e => e.done && e.stage > 0).map(e => e.stage));
  const stageErrors = new Set(events.filter(e => e.error && e.stage > 0).map(e => e.stage));
  const currentStage = events.length > 0 ? events[events.length - 1].stage : 0;

  // Status for the trigger button
  const btnStatus = running ? "running" : complete ? (hasError ? "warn" : "ok") : "idle";

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        onClick={startSync}
        title={running ? "Sync in progress…" : "Sync all data from CRM"}
        className={cn(
          "flex items-center gap-1.5 text-xs transition-colors",
          btnStatus === "running" && "text-indigo-400 cursor-default",
          btnStatus === "ok"      && "text-emerald-500 hover:text-emerald-400",
          btnStatus === "warn"    && "text-amber-400 hover:text-amber-300",
          btnStatus === "idle"    && "text-gray-500 hover:text-gray-300",
        )}
      >
        <RefreshCw className={cn("w-3 h-3 flex-shrink-0", running && "animate-spin")} />
        <span>
          {btnStatus === "running" ? "Syncing…"
           : btnStatus === "ok"   ? `Synced ✓`
           : btnStatus === "warn" ? "Synced (warnings)"
           : "Sync"}
        </span>
      </button>

      {/* Progress overlay */}
      {open && (
        <div className="absolute bottom-7 left-0 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800">
            <RefreshCw className={cn(
              "w-3.5 h-3.5 flex-shrink-0",
              running          ? "text-indigo-400 animate-spin"
              : hasError       ? "text-amber-400"
              : complete       ? "text-emerald-400"
              :                  "text-gray-500"
            )} />
            <span className="text-xs font-semibold text-white flex-1">
              {running   ? "Syncing data…"
               : complete && !hasError ? `Done in ${elapsed}s — all up to date`
               : complete ? `Done in ${elapsed}s — some warnings`
               : "Sync"}
            </span>
            <button onClick={dismiss} className="text-gray-600 hover:text-gray-300 transition-colors" title="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Stage progress */}
          <div className="px-3 py-2.5 space-y-1.5 border-b border-gray-800">
            {[1, 2, 3, 4].map(s => {
              const isDone   = stagesDone.has(s);
              const isErr    = stageErrors.has(s);
              const isActive = !isDone && !isErr && currentStage === s && running;
              const lastMsg  = events.filter(e => e.stage === s).at(-1)?.msg ?? "";
              return (
                <div key={s} className="flex items-center gap-2">
                  <span className={cn(
                    "w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-[9px] font-bold",
                    isDone && !isErr ? "bg-emerald-600 text-white"
                    : isErr          ? "bg-amber-600 text-white"
                    : isActive       ? "bg-indigo-600 text-white animate-pulse"
                    :                  "bg-gray-800 text-gray-600"
                  )}>
                    {isDone && !isErr ? "✓" : isErr ? "!" : s}
                  </span>
                  <span className={cn(
                    "text-xs",
                    isDone && !isErr ? "text-emerald-400"
                    : isErr          ? "text-amber-400"
                    : isActive       ? "text-white"
                    :                  "text-gray-600"
                  )}>
                    {STAGE_LABELS[s]}
                  </span>
                  {(isDone || isErr) && (
                    <span className="ml-auto text-[10px] text-gray-600 truncate max-w-[110px]" title={lastMsg}>
                      {lastMsg.replace(/^.*— /, "")}
                    </span>
                  )}
                  {isActive && (
                    <span className="ml-auto text-[10px] text-indigo-400 truncate max-w-[110px]">
                      …
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Log toggle */}
          <button
            onClick={() => setShowLog(v => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
          >
            {showLog ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showLog ? "Hide log" : "Show log"}
          </button>
          {showLog && (
            <div ref={logRef} className="px-3 pb-3 max-h-36 overflow-y-auto space-y-0.5 font-mono border-t border-gray-800 pt-2">
              {events.map((e, i) => (
                <p key={i} className={cn(
                  "text-[10px] leading-relaxed",
                  e.error   ? "text-amber-400"
                  : e.warning ? "text-yellow-500"
                  : e.complete ? "text-emerald-400 font-semibold"
                  : e.done    ? "text-emerald-500"
                  :             "text-gray-500"
                )}>
                  {e.stage > 0 && (
                    <span className="text-gray-700 mr-1">[{STAGE_LABELS[e.stage] ?? `S${e.stage}`}]</span>
                  )}
                  {e.msg}
                </p>
              ))}
              {running && <p className="text-[10px] text-indigo-400 animate-pulse">…</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
