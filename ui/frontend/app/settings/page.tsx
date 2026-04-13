"use client";
import { useState } from "react";
import useSWR from "swr";
import {
  Cpu, RefreshCw, Trash2, Loader2, CheckCircle2,
  Settings, RotateCcw, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-gray-800/60 last:border-b-0">
      <div>
        <p className="text-sm text-white">{label}</p>
        {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { data: config, mutate: mutateConfig } = useSWR<{ max_workers: number }>(
    `${API}/jobs/config`, fetcher, { refreshInterval: 0 }
  );
  const { data: sysStats } = useSWR<{ cpu_pct: number | null; mem_pct: number | null; active_workers: number | null }>(
    `${API}/jobs/stats`, fetcher, { refreshInterval: 3000 }
  );

  const [workerInput, setWorkerInput] = useState("");
  const [workerSaving, setWorkerSaving] = useState(false);
  const [workerSaved, setWorkerSaved] = useState(false);

  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearResult, setClearResult] = useState<number | null>(null);

  const [clearingBuffer, setClearingBuffer] = useState(false);
  const [bufferCleared, setBufferCleared] = useState(false);

  const maxWorkers = config?.max_workers ?? 10;
  const displayWorkers = workerInput !== "" ? parseInt(workerInput) || maxWorkers : maxWorkers;

  async function saveWorkers() {
    const n = parseInt(workerInput);
    if (!n || n < 1 || n > 64) return;
    setWorkerSaving(true);
    try {
      await fetch(`${API}/jobs/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_workers: n }),
      });
      await mutateConfig();
      setWorkerInput("");
      setWorkerSaved(true);
      setTimeout(() => setWorkerSaved(false), 2000);
    } finally {
      setWorkerSaving(false);
    }
  }

  async function clearHistory() {
    setClearingHistory(true);
    setClearResult(null);
    try {
      const res = await fetch(`${API}/jobs/history`, { method: "DELETE" });
      const data = await res.json();
      setClearResult(data.deleted ?? 0);
    } finally {
      setClearingHistory(false);
    }
  }

  async function clearLogBuffer() {
    setClearingBuffer(true);
    try {
      await fetch(`${API}/logs/buffer`, { method: "DELETE" });
      setBufferCleared(true);
      setTimeout(() => setBufferCleared(false), 2000);
    } finally {
      setClearingBuffer(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="w-5 h-5 text-indigo-400" />
        <h1 className="text-lg font-semibold text-white">Settings</h1>
      </div>

      {/* Workers */}
      <Section title="Transcription Workers">
        <Row
          label="Parallel workers"
          sub="Max simultaneous transcription jobs running at once. Increase for faster batch processing (uses more CPU/memory)."
        >
          <div className="flex items-center gap-2">
            {sysStats?.active_workers != null && (
              <span className="text-xs text-gray-600">
                <Activity className="w-3 h-3 inline mr-0.5" />
                {sysStats.active_workers} active
              </span>
            )}
            <button
              onClick={() => {
                const n = maxWorkers - 1;
                if (n >= 1) {
                  setWorkerInput(String(n));
                  fetch(`${API}/jobs/config`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ max_workers: n }),
                  }).then(() => mutateConfig());
                }
              }}
              className="w-7 h-7 flex items-center justify-center bg-gray-800 hover:bg-gray-700 rounded text-gray-300 text-sm font-mono transition-colors"
            >−</button>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={64}
                value={workerInput !== "" ? workerInput : maxWorkers}
                onChange={e => setWorkerInput(e.target.value)}
                onBlur={() => { if (workerInput) saveWorkers(); }}
                onKeyDown={e => { if (e.key === "Enter" && workerInput) saveWorkers(); }}
                className="w-12 text-center bg-gray-800 border border-gray-700 rounded px-1 py-1 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              {workerSaving && <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />}
              {workerSaved && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
            </div>
            <button
              onClick={() => {
                const n = maxWorkers + 1;
                if (n <= 64) {
                  setWorkerInput(String(n));
                  fetch(`${API}/jobs/config`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ max_workers: n }),
                  }).then(() => mutateConfig());
                }
              }}
              className="w-7 h-7 flex items-center justify-center bg-gray-800 hover:bg-gray-700 rounded text-gray-300 text-sm font-mono transition-colors"
            >+</button>
          </div>
        </Row>

        {sysStats && (sysStats.cpu_pct != null || sysStats.mem_pct != null) && (
          <div className="flex gap-4 mt-3 pt-3 border-t border-gray-800/60">
            {sysStats.cpu_pct != null && (
              <div className="flex-1">
                <div className="flex justify-between text-[10px] text-gray-600 mb-1">
                  <span>CPU</span>
                  <span className={sysStats.cpu_pct > 80 ? "text-red-400" : sysStats.cpu_pct > 50 ? "text-yellow-400" : "text-gray-500"}>
                    {sysStats.cpu_pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${sysStats.cpu_pct > 80 ? "bg-red-500" : sysStats.cpu_pct > 50 ? "bg-yellow-500" : "bg-indigo-600"}`}
                    style={{ width: `${sysStats.cpu_pct}%` }}
                  />
                </div>
              </div>
            )}
            {sysStats.mem_pct != null && (
              <div className="flex-1">
                <div className="flex justify-between text-[10px] text-gray-600 mb-1">
                  <span>Memory</span>
                  <span className={sysStats.mem_pct > 85 ? "text-red-400" : "text-gray-500"}>
                    {sysStats.mem_pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${sysStats.mem_pct > 85 ? "bg-red-500" : "bg-teal-700"}`}
                    style={{ width: `${sysStats.mem_pct}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Logs */}
      <Section title="Logs">
        <Row
          label="Clear log buffer"
          sub="Empties the in-memory log buffer. Active SSE subscribers continue receiving new logs."
        >
          <button
            onClick={clearLogBuffer}
            disabled={clearingBuffer}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-xs rounded-lg transition-colors"
          >
            {clearingBuffer
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : bufferCleared
              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              : <RotateCcw className="w-3.5 h-3.5" />}
            {bufferCleared ? "Cleared" : "Clear buffer"}
          </button>
        </Row>
      </Section>

      {/* Job history */}
      <Section title="Job History">
        <Row
          label="Clear completed & failed jobs"
          sub="Permanently removes all completed and failed jobs from the database. Running and queued jobs are not affected."
        >
          <div className="flex items-center gap-2">
            {clearResult != null && (
              <span className="text-xs text-emerald-400">{clearResult} removed</span>
            )}
            <button
              onClick={clearHistory}
              disabled={clearingHistory}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/40 hover:bg-red-900/60 disabled:opacity-50 text-red-300 text-xs rounded-lg transition-colors border border-red-800/50"
            >
              {clearingHistory
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Trash2 className="w-3.5 h-3.5" />}
              Clear history
            </button>
          </div>
        </Row>
      </Section>
    </div>
  );
}
