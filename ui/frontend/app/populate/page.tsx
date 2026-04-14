"use client";
import { useState, useRef, useEffect } from "react";
import useSWR from "swr";
import {
  Play, Loader2, CheckCircle2, AlertTriangle,
  Database, ArrowDownUp, Mic2, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

const EVENT_STYLE: Record<string, string> = {
  stage:      "text-indigo-300 font-semibold",
  sync:       "text-gray-300",
  plan:       "text-teal-300",
  progress:   "text-gray-400",
  batch_done: "text-emerald-400",
  done:       "text-emerald-300 font-semibold",
  error:      "text-red-400",
};

const STAGE_ICONS = [
  <Database  key="db"  className="w-4 h-4" />,
  <ArrowDownUp key="sort" className="w-4 h-4" />,
  <Mic2      key="mic" className="w-4 h-4" />,
];

function StageBar({ stage }: { stage: number }) {
  const stages = ["CRM Sync", "Sort by Deposits", "Submit Jobs"];
  return (
    <div className="flex gap-1">
      {stages.map((label, i) => (
        <div key={i} className={cn(
          "flex-1 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors",
          stage > i + 1  ? "bg-emerald-900/30 text-emerald-400 border border-emerald-800/40" :
          stage === i + 1 ? "bg-indigo-900/40 text-indigo-300 border border-indigo-700/40 animate-pulse" :
                            "bg-gray-900 text-gray-600 border border-gray-800"
        )}>
          {stage > i + 1 ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : STAGE_ICONS[i]}
          {label}
        </div>
      ))}
    </div>
  );
}

export default function PopulatePage() {
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [resetting, setResetting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Poll status every 2s whenever a run is active (started by us OR detected as running)
  const { data: status, mutate: refreshStatus } = useSWR(
    `${API}/populate/status`,
    fetcher,
    { refreshInterval: 2000 },   // always poll — cheap GET, stops when done
  );

  const running = status?.running ?? false;
  const log: any[] = status?.log ?? [];
  const stage: number = status?.stage ?? 0;
  const staleRun = !started && running; // server thinks it's running but we didn't start it

  // Stop polling when the job finishes
  useEffect(() => {
    if (started && !running && log.length > 0) {
      setDone(true);
      setStarted(false);
    }
  }, [started, running, log.length]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.length]);

  async function startPopulate() {
    setDone(false);
    const r = await fetch(`${API}/populate/start`, { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      setStarted(true);
      refreshStatus();
    }
  }

  async function resetStaleRun() {
    setResetting(true);
    await fetch(`${API}/populate/reset`, { method: "POST" });
    await refreshStatus();
    setResetting(false);
  }

  const summary = status?.last_result;
  const showSummary = done && summary;
  const showLastRun = summary && !started && !done;

  return (
    <div className="max-w-3xl mx-auto space-y-5 py-2">
      {/* Header */}
      <div>
        <h1 className="text-base font-bold text-white">Populate</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          Sync CRM data then transcribe all agent-customer pairs, highest net deposits first.
        </p>
      </div>

      {/* Stage bar */}
      {(started || running || done) && stage > 0 && <StageBar stage={stage} />}

      {/* Progress note during stale run */}
      {staleRun && log.length > 0 && (
        <p className="text-xs text-gray-500">Showing progress from active run — reset above to start fresh.</p>
      )}

      {/* Summary cards */}
      {showSummary && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-emerald-900/20 border border-emerald-800/40 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-emerald-400">{summary.submitted.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mt-1">Jobs Submitted</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-gray-300">{summary.skipped.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mt-1">Already Done</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <p className="text-2xl font-bold text-gray-300">{summary.pairs_processed?.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mt-1">Pairs Processed</p>
          </div>
        </div>
      )}

      {/* Last run info from server */}
      {showLastRun && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 space-y-1">
          <p className="text-gray-300 font-medium">Last run</p>
          <p>{summary.submitted} jobs submitted · {summary.skipped} already done · {summary.pairs_processed} pairs</p>
          {summary.completed_at && (
            <p className="text-gray-600">{new Date(summary.completed_at).toLocaleString()}</p>
          )}
        </div>
      )}

      {/* Stale-run banner */}
      {staleRun && (
        <div className="flex items-center gap-3 bg-yellow-900/20 border border-yellow-700/40 rounded-xl px-4 py-3 text-sm text-yellow-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="flex-1">A previous run is still marked as active (connection was likely dropped).</span>
          <button
            onClick={resetStaleRun}
            disabled={resetting}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {resetting ? <><Loader2 className="w-3 h-3 animate-spin" /> Resetting…</> : "Reset & Start Fresh"}
          </button>
        </div>
      )}

      {/* Action button */}
      <div className="flex gap-3">
        <button
          onClick={startPopulate}
          disabled={started || running || !!staleRun}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
        >
          {(started || running)
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Running…</>
            : done
              ? <><RefreshCw className="w-4 h-4" /> Run Again</>
              : <><Play className="w-4 h-4" /> Start Populate</>
          }
        </button>
      </div>

      {/* Live log */}
      {log.length > 0 && (
        <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 text-[10px] text-gray-500 uppercase tracking-wide font-semibold">
            Log
          </div>
          <div ref={logRef} className="max-h-[520px] overflow-y-auto p-4 space-y-0.5 font-mono text-[11px]">
            {log.map((entry, i) => (
              <div key={i} className="flex gap-2 items-start">
                {entry.event === "error" && <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />}
                {entry.event === "done"  && <CheckCircle2  className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />}
                <span className={cn("leading-relaxed", EVENT_STYLE[entry.event] ?? "text-gray-400")}>
                  {entry.msg}
                </span>
              </div>
            ))}
            {(started || running) && (
              <div className="flex gap-2 items-center pt-1">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-400 shrink-0" />
                <span className="text-gray-600">Running…</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
