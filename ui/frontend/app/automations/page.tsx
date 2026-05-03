"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  Clock3,
  Loader2,
  Play,
  RefreshCw,
  Save,
  CheckCircle2,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface AutomationRow {
  id: string;
  name: string;
  description?: string;
  action?: string;
  enabled: boolean;
  schedule: string;
  running?: boolean;
  last_status?: string;
  last_message?: string;
  last_run_at?: string | null;
  next_run_at?: string | null;
  params?: Record<string, unknown>;
}

interface AutomationSnapshot {
  scheduler?: { running?: boolean; tick_interval_s?: number };
  automations: AutomationRow[];
  runs?: Array<{
    run_id: string;
    automation_id: string;
    automation_name?: string;
    trigger?: string;
    status?: string;
    message?: string;
    started_at?: string;
    finished_at?: string;
  }>;
}

function StatusBadge({ status, running }: { status?: string; running?: boolean }) {
  if (running) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/50 bg-amber-900/35 px-2 py-0.5 text-[10px] font-medium text-amber-200">
        <Loader2 className="h-3 w-3 animate-spin" /> running
      </span>
    );
  }

  const norm = String(status || "idle").toLowerCase();
  if (norm === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700/50 bg-emerald-900/35 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
        <CheckCircle2 className="h-3 w-3" /> success
      </span>
    );
  }
  if (norm === "error" || norm === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-700/50 bg-red-900/35 px-2 py-0.5 text-[10px] font-medium text-red-200">
        <AlertTriangle className="h-3 w-3" /> failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-gray-700/60 bg-gray-900/60 px-2 py-0.5 text-[10px] font-medium text-gray-300">
      idle
    </span>
  );
}

export default function AutomationsPage() {
  const { data, mutate, isLoading } = useSWR<AutomationSnapshot>("/api/automations/config", fetcher, {
    refreshInterval: 8000,
  });

  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [runningId, setRunningId] = useState("");

  useEffect(() => {
    if (!data?.automations) return;
    setRows(data.automations.map((a) => ({ ...a })));
  }, [data?.automations]);

  const dirty = useMemo(() => {
    const a = rows || [];
    const b = data?.automations || [];
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id) return true;
      if (Boolean(a[i].enabled) !== Boolean(b[i].enabled)) return true;
      if (String(a[i].schedule || "").trim() !== String(b[i].schedule || "").trim()) return true;
    }
    return false;
  }, [rows, data?.automations]);

  async function saveAll() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const res = await fetch("/api/automations/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          automations: rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            action: r.action,
            enabled: !!r.enabled,
            schedule: String(r.schedule || "").trim(),
            params: r.params || {},
          })),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(payload?.detail || payload?.error || `HTTP ${res.status}`));
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      await mutate();
    } catch (e: any) {
      setError(String(e?.message || "Failed to save automations."));
    } finally {
      setSaving(false);
    }
  }

  async function runNow(id: string) {
    setRunningId(id);
    setError("");
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(payload?.detail || payload?.error || `HTTP ${res.status}`));
      await mutate();
    } catch (e: any) {
      setError(String(e?.message || "Failed to trigger automation."));
    } finally {
      setRunningId("");
    }
  }

  function setEnabled(id: string, enabled: boolean) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }

  function setSchedule(id: string, schedule: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, schedule } : r)));
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-white">Automations</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Configure production automations and their cron timing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => mutate()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={saveAll}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              !dirty || saving
                ? "cursor-not-allowed border-gray-800 bg-gray-900 text-gray-500"
                : "border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-500",
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </div>

      {saved && (
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/25 px-3 py-2 text-xs text-emerald-200">
          Automation settings saved.
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-700/40 bg-red-900/25 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/70">
        <div className="grid grid-cols-[1.2fr_0.8fr_0.85fr_0.9fr_0.9fr] gap-3 border-b border-gray-800 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          <div>Automation</div>
          <div>Enabled</div>
          <div>Cron</div>
          <div>Status</div>
          <div className="text-right">Action</div>
        </div>

        {isLoading && (
          <div className="px-4 py-5 text-xs text-gray-400 inline-flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading automations…
          </div>
        )}

        {!isLoading && rows.map((row) => (
          <div
            key={row.id}
            className="grid grid-cols-[1.2fr_0.8fr_0.85fr_0.9fr_0.9fr] gap-3 border-b border-gray-800/60 px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-white truncate">{row.name}</div>
              {row.description && (
                <div className="mt-0.5 text-[11px] text-gray-500 leading-snug">{row.description}</div>
              )}
              <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-600">
                <Clock3 className="h-3 w-3" />
                <span>Next run: {row.next_run_at ? new Date(row.next_run_at).toLocaleString() : "-"}</span>
              </div>
              {row.last_run_at && (
                <div className="mt-0.5 text-[10px] text-gray-600">
                  Last run: {new Date(row.last_run_at).toLocaleString()}
                </div>
              )}
              {row.last_message && (
                <div className="mt-1 text-[10px] text-gray-500 line-clamp-2">{row.last_message}</div>
              )}
            </div>

            <div className="flex items-start">
              <button
                type="button"
                onClick={() => setEnabled(row.id, !row.enabled)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                  row.enabled
                    ? "border-emerald-700/50 bg-emerald-900/30 text-emerald-200"
                    : "border-gray-700 bg-gray-900 text-gray-400",
                )}
              >
                {row.enabled ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                {row.enabled ? "On" : "Off"}
              </button>
            </div>

            <div className="flex items-start">
              <input
                value={row.schedule || ""}
                onChange={(e) => setSchedule(row.id, e.target.value)}
                className="h-8 w-full min-w-0 rounded-md border border-gray-700 bg-gray-950 px-2 text-xs text-gray-100 outline-none focus:border-indigo-500"
                placeholder="0 */2 * * *"
                spellCheck={false}
              />
            </div>

            <div className="flex items-start">
              <StatusBadge status={row.last_status} running={row.running} />
            </div>

            <div className="flex items-start justify-end">
              <button
                type="button"
                disabled={runningId === row.id || row.running}
                onClick={() => runNow(row.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs",
                  runningId === row.id || row.running
                    ? "cursor-not-allowed border-gray-800 bg-gray-900 text-gray-500"
                    : "border-indigo-700/60 bg-indigo-900/35 text-indigo-200 hover:bg-indigo-900/55",
                )}
              >
                {runningId === row.id || row.running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Run now
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900/40">
        <div className="border-b border-gray-800 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Recent Automation Runs
        </div>
        <div className="max-h-[320px] overflow-y-auto px-4 py-2">
          {(data?.runs || []).length === 0 ? (
            <p className="py-2 text-xs text-gray-500">No automation runs yet.</p>
          ) : (
            (data?.runs || []).slice(0, 40).map((r) => (
              <div
                key={r.run_id}
                className="grid grid-cols-[1.2fr_0.7fr_1fr_1fr] gap-3 border-b border-gray-800/50 py-2 text-xs last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-gray-200">{r.automation_name || r.automation_id}</div>
                  <div className="truncate text-[10px] text-gray-600">run {r.run_id.slice(0, 8)}</div>
                </div>
                <div className="text-gray-400">{r.trigger || "-"}</div>
                <div className="text-gray-500">{r.started_at ? new Date(r.started_at).toLocaleString() : "-"}</div>
                <div className={cn(
                  "truncate",
                  (r.status || "").toLowerCase() === "success" && "text-emerald-300",
                  ((r.status || "").toLowerCase() === "error" || (r.status || "").toLowerCase() === "failed") && "text-red-300",
                  (r.status || "").toLowerCase() === "running" && "text-amber-300",
                )}>
                  {r.status || "-"}
                  {r.message ? ` · ${r.message}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="text-[10px] text-gray-600">
        Cron format: <code>minute hour day-of-month month day-of-week</code> (UTC), examples: <code>0 */2 * * *</code>, <code>30 3 * * *</code>
      </div>
    </div>
  );
}
