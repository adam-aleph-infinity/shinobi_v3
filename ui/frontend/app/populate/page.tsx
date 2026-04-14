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

type LogEntry = {
  id: number;
  event: string;
  msg: string;
  ts: string;
  meta?: Record<string, any>;
};

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
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stage, setStage] = useState(0);
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState<{ submitted: number; skipped: number; pairs: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);
  const idRef = useRef(0);

  const { data: status, mutate: refreshStatus } = useSWR(`${API}/populate/status`, fetcher, {
    refreshInterval: running ? 3000 : 0,
  });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function addLog(event: string, msg: string, meta?: Record<string, any>) {
    setLog(prev => [...prev, {
      id: idRef.current++,
      event,
      msg,
      ts: new Date().toLocaleTimeString(),
      meta,
    }]);
  }

  async function startPopulate() {
    setRunning(true);
    setLog([]);
    setStage(1);
    setDone(false);
    setSummary(null);
    abortRef.current = false;

    try {
      const r = await fetch(`${API}/populate/start`, { method: "POST" });
      if (!r.ok || !r.body) throw new Error(await r.text());

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        if (abortRef.current) { reader.cancel(); break; }

        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const evLine   = part.split("\n").find(l => l.startsWith("event:"));
          const dataLine = part.split("\n").find(l => l.startsWith("data:"));
          if (!dataLine) continue;

          const event = evLine?.replace("event:", "").trim() ?? "message";
          try {
            const data = JSON.parse(dataLine.replace("data:", "").trim());
            const msg = data.msg ?? "";
            const meta = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "msg"));

            addLog(event, msg, meta);

            if (event === "stage" && data.stage) setStage(data.stage);
            if (event === "done") {
              setDone(true);
              setStage(4);
              setSummary({ submitted: data.submitted ?? 0, skipped: data.skipped ?? 0, pairs: data.pairs ?? 0 });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (!abortRef.current) addLog("error", e.message ?? "Populate failed");
    } finally {
      setRunning(false);
      refreshStatus();
    }
  }

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
      {(running || done) && <StageBar stage={stage} />}

      {/* Summary cards */}
      {done && summary && (
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
            <p className="text-2xl font-bold text-gray-300">{summary.pairs.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide mt-1">Pairs Processed</p>
          </div>
        </div>
      )}

      {/* Last run info from server */}
      {status?.last_result && !running && !done && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 space-y-1">
          <p className="text-gray-300 font-medium">Last run</p>
          <p>{status.last_result.submitted} jobs submitted · {status.last_result.skipped} already done · {status.last_result.pairs_processed} pairs</p>
          {status.last_result.completed_at && (
            <p className="text-gray-600">{new Date(status.last_result.completed_at).toLocaleString()}</p>
          )}
        </div>
      )}

      {/* Action button */}
      <div className="flex gap-3">
        <button
          onClick={startPopulate}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
        >
          {running
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Running…</>
            : done
              ? <><RefreshCw className="w-4 h-4" /> Run Again</>
              : <><Play className="w-4 h-4" /> Start Populate</>
          }
        </button>
        {running && (
          <button
            onClick={() => { abortRef.current = true; setRunning(false); }}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm rounded-lg transition-colors"
          >
            Stop
          </button>
        )}
      </div>

      {/* Live log */}
      {log.length > 0 && (
        <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-800 text-[10px] text-gray-500 uppercase tracking-wide font-semibold">
            Live Log
          </div>
          <div ref={logRef} className="max-h-[520px] overflow-y-auto p-4 space-y-0.5 font-mono text-[11px]">
            {log.map(entry => (
              <div key={entry.id} className="flex gap-2 items-start">
                <span className="text-gray-700 shrink-0 w-16">{entry.ts}</span>
                {entry.event === "error" && <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />}
                {entry.event === "done"  && <CheckCircle2  className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />}
                <span className={cn("leading-relaxed", EVENT_STYLE[entry.event] ?? "text-gray-400")}>
                  {entry.msg}
                </span>
              </div>
            ))}
            {running && (
              <div className="flex gap-2 items-center pt-1">
                <span className="text-gray-700 w-16" />
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
