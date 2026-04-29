"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { Activity, CheckCircle2, ChevronRight, Clock3, Loader2, Workflow } from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { parseServerDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const PIPELINE_OPEN_RUN_STORAGE_KEY = "shinobi.pipeline.open_run";

interface PipelineLite {
  id: string;
  name: string;
}

interface PipelineRunRecord {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  sales_agent: string;
  customer: string;
  call_id: string;
  crm_url?: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  canvas_json?: string;
  steps_json: string;
  log_json?: string;
  run_origin?: string;
}

interface PhaseBadge {
  label: string;
  tone: string;
}

interface LiveWebhookConfig {
  enabled: boolean;
  ingest_only: boolean;
  trigger_pipeline: boolean;
  live_pipeline_ids: string[];
  default_pipeline_id: string;
  pipeline_by_agent: Record<string, string>;
  run_payload: Record<string, unknown>;
  transcription_model: string;
  transcription_timeout_s: number;
  transcription_poll_interval_s: number;
  backfill_historical_transcripts: boolean;
  backfill_timeout_s: number;
  max_live_running: number;
  auto_retry_enabled: boolean;
  retry_max_attempts: number;
  retry_delay_s: number;
  retry_on_server_error: boolean;
  retry_on_rate_limit: boolean;
  retry_on_timeout: boolean;
  read_only?: boolean;
  mirror_source?: string;
}

function statusTone(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "queued") return "text-sky-200 border-sky-700/50 bg-sky-950/40";
  if (s === "preparing") return "text-cyan-200 border-cyan-700/50 bg-cyan-950/40";
  if (s === "retrying") return "text-violet-200 border-violet-700/50 bg-violet-950/40";
  if (s === "done" || s === "completed") return "text-emerald-300 border-emerald-700/50 bg-emerald-950/40";
  if (s === "error" || s === "failed") return "text-red-300 border-red-700/50 bg-red-950/40";
  return "text-amber-300 border-amber-700/50 bg-amber-950/40";
}

function isCompletedRun(status: string): boolean {
  const s = String(status || "").toLowerCase();
  return s === "done" || s === "completed" || s === "error" || s === "failed" || s === "stopped" || s === "cancelled";
}

function isQueuedRun(status: string): boolean {
  const s = String(status || "").toLowerCase();
  return s === "queued";
}

function normalizeRunOrigin(origin: string | null | undefined): "webhook" | "local" {
  const v = String(origin || "").trim().toLowerCase();
  if (v === "webhook" || v === "production") return "webhook";
  return "local";
}

function relativeTime(isoStr: string | null | undefined, nowMs?: number): string {
  const dt = parseServerDate(isoStr);
  if (!dt) return "—";
  const nowTs = typeof nowMs === "number" ? nowMs : Date.now();
  const d = Math.floor((nowTs - dt.getTime()) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function durationStr(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  nowMs?: number,
): string {
  const s = parseServerDate(startedAt);
  if (!s) return "—";
  const e = parseServerDate(finishedAt) ?? new Date(typeof nowMs === "number" ? nowMs : Date.now());
  const ms = Math.max(0, e.getTime() - s.getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function _safeJsonArray(raw: unknown): any[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _phaseTone(label: string): string {
  const k = String(label || "").toLowerCase();
  if (k === "transcript") return "text-cyan-200 border-cyan-700/50 bg-cyan-950/40";
  if (k === "merge") return "text-indigo-200 border-indigo-700/50 bg-indigo-950/40";
  if (k === "input") return "text-blue-200 border-blue-700/50 bg-blue-950/40";
  if (k === "output") return "text-emerald-200 border-emerald-700/50 bg-emerald-950/40";
  if (k === "processing") return "text-amber-200 border-amber-700/50 bg-amber-950/40";
  if (k === "retrying") return "text-violet-200 border-violet-700/50 bg-violet-950/40";
  if (k === "queued") return "text-sky-200 border-sky-700/50 bg-sky-950/40";
  return "text-gray-200 border-gray-700/50 bg-gray-900/50";
}

function _phaseFromName(stepName: string, state: string): string {
  const name = String(stepName || "").toLowerCase();
  const st = String(state || "").toLowerCase();
  if (name.includes("transcript") || name.includes("audio")) return "transcript";
  if (name.includes("merge")) return "merge";
  if (name.includes("input")) return "input";
  if (name.includes("artifact") || name.includes("output")) return "output";
  if (st.includes("input_prepared")) return "merge";
  return "processing";
}

function inferPhaseBadges(run: PipelineRunRecord): PhaseBadge[] {
  const status = String(run.status || "").toLowerCase();
  if (status === "queued") return [{ label: "queued", tone: _phaseTone("queued") }];
  if (status === "retrying") return [{ label: "retrying", tone: _phaseTone("retrying") }];

  const logs = _safeJsonArray(run.log_json);
  const steps = _safeJsonArray(run.steps_json);
  const lastText = String((logs.length ? logs[logs.length - 1]?.text : "") || "").toLowerCase();

  if (status === "preparing") {
    if (lastText.includes("transcript") || lastText.includes("backfill") || lastText.includes("audio")) {
      return [{ label: "transcript", tone: _phaseTone("transcript") }];
    }
    if (lastText.includes("merge")) {
      return [{ label: "merge", tone: _phaseTone("merge") }];
    }
    if (lastText.includes("input")) {
      return [{ label: "input", tone: _phaseTone("input") }];
    }
    return [{ label: "processing", tone: _phaseTone("processing") }];
  }

  if (!isCompletedRun(status)) {
    const phases: string[] = [];
    const seen = new Set<string>();
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const st = String((step as any).state || (step as any).status || "").toLowerCase();
      if (!st || st === "waiting" || st === "pending" || st === "done" || st === "completed" || st === "success") {
        continue;
      }
      const phase = _phaseFromName(String((step as any).agent_name || ""), st);
      if (!seen.has(phase)) {
        seen.add(phase);
        phases.push(phase);
      }
    }
    if (phases.length === 0) {
      if (lastText.includes("merge")) phases.push("merge");
      else if (lastText.includes("input")) phases.push("input");
      else if (lastText.includes("artifact") || lastText.includes("output")) phases.push("output");
      else phases.push("processing");
    }
    return phases.map((label) => ({ label, tone: _phaseTone(label) }));
  }
  return [];
}

export default function LivePage() {
  const router = useRouter();
  const { setCustomer, setCallId, setActivePipeline } = useAppCtx();

  const [liveSelectedPipelineIds, setLiveSelectedPipelineIds] = useState<string[]>([]);
  const [liveSaving, setLiveSaving] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [liveMessageError, setLiveMessageError] = useState(false);
  const [collapsedCompletedDayIds, setCollapsedCompletedDayIds] = useState<Record<string, boolean>>({});
  const [filterRunType, setFilterRunType] = useState<"all" | "webhook" | "local">("all");
  const [filterPipelineId, setFilterPipelineId] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const ticker = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  const { data: pipelines } = useSWR<PipelineLite[]>("/api/pipelines", fetcher, { refreshInterval: 60000 });
  const { data: liveCfg, mutate: mutateLiveCfg } = useSWR<LiveWebhookConfig>(
    "/api/pipelines/live-webhook/config",
    fetcher,
    { refreshInterval: 7000 },
  );
  const liveReadOnly = !!liveCfg?.read_only;

  const runsUrl = "/api/history/runs?sort_by=started_at&sort_dir=desc&limit=600&mirror=1";

  const { data: runsData, isLoading } = useSWR<PipelineRunRecord[]>(runsUrl, fetcher, {
    refreshInterval: 1500,
  });

  const runs = runsData ?? [];

  const pipelineNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of pipelines ?? []) {
      map[String(p.id || "")] = String(p.name || p.id || "");
    }
    return map;
  }, [pipelines]);

  const pipelineFilterOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs) {
      const pid = String(run.pipeline_id || "").trim();
      if (!pid) continue;
      const nm = String(run.pipeline_name || pipelineNameById[pid] || pid).trim();
      map.set(pid, nm || pid);
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [runs, pipelineNameById]);

  const salesAgentFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const run of runs) {
      const name = String(run.sales_agent || "").trim();
      if (name) set.add(name);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  }, [runs]);

  const customerFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const run of runs) {
      const name = String(run.customer || "").trim();
      if (name) set.add(name);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  }, [runs]);

  useEffect(() => {
    if (!liveCfg) return;
    const ids = Array.isArray(liveCfg.live_pipeline_ids)
      ? liveCfg.live_pipeline_ids.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    const fallback = String(liveCfg.default_pipeline_id || "").trim();
    const next = ids.length ? ids : (fallback ? [fallback] : []);
    setLiveSelectedPipelineIds(next);
  }, [liveCfg?.live_pipeline_ids, liveCfg?.default_pipeline_id]);

  const applyLivePipelineSelection = async (pipelineIds: string[]) => {
    if (liveReadOnly) {
      setLiveMessageError(true);
      setLiveMessage("Live mirror mode is read-only in this environment.");
      return;
    }
    const cleaned = Array.from(new Set((pipelineIds || []).map((v) => String(v || "").trim()).filter(Boolean)));
    setLiveSaving(true);
    setLiveMessage("");
    try {
      const currentRunPayload = (liveCfg && typeof liveCfg.run_payload === "object" && liveCfg.run_payload)
        ? liveCfg.run_payload
        : { resume_partial: true };
      const res = await fetch("/api/pipelines/live-webhook/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          ingest_only: cleaned.length === 0,
          trigger_pipeline: true,
          live_pipeline_ids: cleaned,
          default_pipeline_id: cleaned[0] || "",
          pipeline_by_agent: (liveCfg?.pipeline_by_agent && typeof liveCfg.pipeline_by_agent === "object")
            ? liveCfg.pipeline_by_agent
            : {},
          run_payload: currentRunPayload,
          transcription_model: String(liveCfg?.transcription_model || "gpt-5.4"),
          transcription_timeout_s: Number(liveCfg?.transcription_timeout_s || 900),
          transcription_poll_interval_s: Number(liveCfg?.transcription_poll_interval_s || 2),
          max_live_running: Number(liveCfg?.max_live_running || 5),
          auto_retry_enabled: !!(liveCfg?.auto_retry_enabled ?? true),
          retry_max_attempts: Number(liveCfg?.retry_max_attempts || 2),
          retry_delay_s: Number(liveCfg?.retry_delay_s || 45),
          backfill_historical_transcripts: !!(liveCfg?.backfill_historical_transcripts ?? true),
          backfill_timeout_s: Number(liveCfg?.backfill_timeout_s || 5400),
          retry_on_server_error: !!(liveCfg?.retry_on_server_error ?? true),
          retry_on_rate_limit: !!(liveCfg?.retry_on_rate_limit ?? true),
          retry_on_timeout: !!(liveCfg?.retry_on_timeout ?? true),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      }
      setLiveMessageError(false);
      setLiveMessage(
        cleaned.length
          ? `Live enabled for ${cleaned.length} pipeline(s).`
          : "Live disabled (ingest-only mode).",
      );
      await mutateLiveCfg();
    } catch (e: any) {
      setLiveMessageError(true);
      setLiveMessage(String(e?.message || "Failed to update live pipeline selection."));
    } finally {
      setLiveSaving(false);
    }
  };

  const toggleLivePipelineChecked = async (pipelineIdToToggle: string) => {
    const pid = String(pipelineIdToToggle || "").trim();
    if (!pid) return;
    const currentlyOn = liveSelectedPipelineIds.includes(pid);
    const action = currentlyOn ? "disable" : "enable";
    const name = pipelineNameById[pid] || pid;
    const ok = window.confirm(`Are you sure you want to ${action} LIVE webhook execution for "${name}"?`);
    if (!ok) return;
    const next = currentlyOn
      ? liveSelectedPipelineIds.filter((v) => v !== pid)
      : [...liveSelectedPipelineIds, pid];
    setLiveSelectedPipelineIds(next);
    await applyLivePipelineSelection(next);
  };

  const filteredRuns = useMemo(() => {
    const fromTs = filterDateFrom ? new Date(`${filterDateFrom}T00:00:00`).getTime() : null;
    const toTs = filterDateTo ? new Date(`${filterDateTo}T23:59:59`).getTime() : null;
    return runs.filter((run) => {
      if (filterStatus) {
        const rs = String(run.status || "").toLowerCase();
        const fs = filterStatus.toLowerCase();
        if (fs === "success" && !["done", "completed"].includes(rs)) return false;
        else if (fs === "failed" && !["failed", "error"].includes(rs)) return false;
        else if (!["success", "failed"].includes(fs) && rs !== fs) return false;
      }
      if (filterRunType !== "all" && normalizeRunOrigin(run.run_origin) !== filterRunType) return false;
      if (filterPipelineId && String(run.pipeline_id || "").trim() !== filterPipelineId) return false;
      if (filterAgent && String(run.sales_agent || "").trim() !== filterAgent) return false;
      if (filterCustomer && String(run.customer || "").trim() !== filterCustomer) return false;
      if (fromTs !== null || toTs !== null) {
        const ts = parseServerDate(run.finished_at || run.started_at)?.getTime();
        if (!ts) return false;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      return true;
    });
  }, [runs, filterStatus, filterRunType, filterPipelineId, filterAgent, filterCustomer, filterDateFrom, filterDateTo]);

  const queuedRuns = useMemo(() => filteredRuns.filter((r) => isQueuedRun(r.status)), [filteredRuns]);
  const runningRuns = useMemo(
    () => filteredRuns.filter((r) => !isCompletedRun(r.status) && !isQueuedRun(r.status)),
    [filteredRuns],
  );
  const completedRuns = useMemo(() => filteredRuns.filter((r) => isCompletedRun(r.status)), [filteredRuns]);
  const queuedProductionRuns = useMemo(
    () => queuedRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "webhook"),
    [queuedRuns],
  );
  const queuedTestRuns = useMemo(
    () => queuedRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "local"),
    [queuedRuns],
  );
  const runningProductionRuns = useMemo(
    () => runningRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "webhook"),
    [runningRuns],
  );
  const runningTestRuns = useMemo(
    () => runningRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "local"),
    [runningRuns],
  );
  const completedRunsByDay = useMemo(() => {
    const byDay = new Map<string, PipelineRunRecord[]>();
    for (const run of completedRuns) {
      const d = parseServerDate(run.finished_at || run.started_at);
      const dayId = d
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        : "unknown";
      const arr = byDay.get(dayId) || [];
      arr.push(run);
      byDay.set(dayId, arr);
    }
    const groups = Array.from(byDay.entries()).map(([dayId, dayRuns]) => {
      const sorted = [...dayRuns].sort((a, b) => {
        const ta = parseServerDate(a.finished_at || a.started_at)?.getTime() ?? 0;
        const tb = parseServerDate(b.finished_at || b.started_at)?.getTime() ?? 0;
        return tb - ta;
      });
      const productionRuns = sorted.filter((r) => normalizeRunOrigin(r.run_origin) === "webhook");
      const testRuns = sorted.filter((r) => normalizeRunOrigin(r.run_origin) === "local");
      return {
        dayId,
        label: dayId === "unknown" ? "Unknown date" : new Date(`${dayId}T00:00:00`).toLocaleDateString(),
        runs: sorted,
        productionRuns,
        testRuns,
      };
    });
    groups.sort((a, b) => (a.dayId < b.dayId ? 1 : a.dayId > b.dayId ? -1 : 0));
    return groups;
  }, [completedRuns]);

  const openRunInCanvas = (run: PipelineRunRecord) => {
    setCustomer(run.customer || "", run.sales_agent || "");
    setCallId(String(run.call_id || "").trim());
    setActivePipeline(run.pipeline_id || "", run.pipeline_name || "");
    const payload = {
      source: "live_page",
      run_id: run.id,
      pipeline_id: run.pipeline_id,
      pipeline_name: run.pipeline_name,
      sales_agent: run.sales_agent,
      customer: run.customer,
      call_id: run.call_id,
      requested_at: new Date().toISOString(),
    };
    try {
      window.localStorage.setItem(PIPELINE_OPEN_RUN_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // no-op
    }
    router.push("/pipeline");
  };

  const clearRunFilters = () => {
    setFilterRunType("all");
    setFilterPipelineId("");
    setFilterAgent("");
    setFilterCustomer("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setFilterStatus("");
  };

  const renderRunCard = (run: PipelineRunRecord) => (
    <button
      key={run.id}
      onClick={() => openRunInCanvas(run)}
      className="w-full text-left rounded-xl border border-gray-700/70 bg-gray-900 hover:bg-gray-800 hover:border-indigo-600/60 transition-colors px-3 py-2.5"
      title="Open this run in Pipeline canvas"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {normalizeRunOrigin(run.run_origin) === "webhook" ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded border font-semibold text-blue-200 border-blue-700/60 bg-blue-950/50">
            PRODUCTION
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded border font-semibold text-fuchsia-200 border-fuchsia-700/60 bg-fuchsia-950/40">
            TEST
          </span>
        )}
        <span className="text-[10px] font-mono text-indigo-300 bg-indigo-950/40 border border-indigo-800/40 px-1.5 py-0.5 rounded">
          {run.id.slice(0, 8)}
        </span>
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-semibold", statusTone(run.status))}>
          {run.status}
        </span>
        <span className="text-xs text-gray-100 font-semibold truncate">{run.pipeline_name}</span>
      </div>
      <div className="mt-1.5 text-[11px] text-gray-400 flex flex-wrap gap-x-3 gap-y-1">
        <span>{run.sales_agent || "—"} · {run.customer || "—"}</span>
        <span>call {run.call_id || "—"}</span>
        <span>{relativeTime(run.started_at, nowMs)}</span>
        <span>{durationStr(run.started_at, run.finished_at, nowMs)}</span>
      </div>
      {(() => {
        const phases = inferPhaseBadges(run);
        if (!phases.length) return null;
        return (
          <div className="mt-1.5 flex flex-col gap-1">
            {phases.map((p, idx) => (
              <span
                key={`${run.id}-phase-${idx}-${p.label}`}
                className={cn("inline-flex w-fit text-[10px] px-1.5 py-0.5 rounded border font-semibold", p.tone)}
              >
                {p.label}
              </span>
            ))}
          </div>
        );
      })()}
      <div className="mt-1 text-[10px] text-gray-500 truncate">
        CRM: {run.crm_url || "unknown"}
      </div>
    </button>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 bg-gray-900 shrink-0">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-400" />
          <h1 className="text-lg font-semibold text-white">Live</h1>
          <span className="text-xs text-gray-500">Queued, running + completed pipeline runs</span>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-8 gap-2">
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            Run Type
            <select
              value={filterRunType}
              onChange={(e) => setFilterRunType(e.target.value as "all" | "webhook" | "local")}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            >
              <option value="all">All</option>
              <option value="webhook">Production (webhook)</option>
              <option value="local">Test (local)</option>
            </select>
          </label>
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            Pipeline
            <select
              value={filterPipelineId}
              onChange={(e) => setFilterPipelineId(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            >
              <option value="">All pipelines</option>
              {pipelineFilterOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            State
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            >
              <option value="">All states</option>
              <option value="queued">queued</option>
              <option value="preparing">preparing</option>
              <option value="running">running</option>
              <option value="retrying">retrying</option>
              <option value="success">success</option>
              <option value="done">done</option>
              <option value="completed">completed</option>
              <option value="error">error</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
              <option value="stopped">stopped</option>
            </select>
          </label>
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            Agent
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            >
              <option value="">All agents</option>
              {salesAgentFilterOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            Customer
            <select
              value={filterCustomer}
              onChange={(e) => setFilterCustomer(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            >
              <option value="">All customers</option>
              {customerFilterOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            Date From
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            />
          </label>
          <label className="text-[11px] text-gray-400 flex flex-col gap-1">
            Date To
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-400">Actions</span>
            <button
              onClick={clearRunFilters}
              className="h-8 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-xs text-gray-200 transition-colors"
            >
              Clear filters
            </button>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-gray-500">
          Showing {filteredRuns.length} of {runs.length} runs
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center gap-2 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            Loading live runs…
          </div>
        ) : (
          <div className="h-full grid grid-cols-1 2xl:grid-cols-[300px_1fr_1fr_1fr] gap-0">
            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <Workflow className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-semibold text-gray-100">Live Pipelines</p>
                <span className="text-xs text-gray-500">{(pipelines ?? []).length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
                {(pipelines ?? []).map((p) => {
                  const checked = liveSelectedPipelineIds.includes(String(p.id || ""));
                  return (
                    <label
                      key={p.id}
                      className={cn(
                        "w-full flex items-center gap-2 text-xs rounded-lg border px-2 py-2 cursor-pointer transition-colors",
                        checked
                          ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-200"
                          : "border-gray-800 bg-gray-900 text-gray-300 hover:bg-gray-800",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={liveSaving || liveReadOnly}
                        onChange={() => { void toggleLivePipelineChecked(String(p.id || "")); }}
                        className="accent-emerald-500"
                      />
                      <span className="truncate">{p.name}</span>
                    </label>
                  );
                })}
                {(pipelines ?? []).length === 0 && (
                  <p className="text-[11px] text-gray-500 italic">No pipelines found.</p>
                )}
                {liveMessage ? (
                  <p className={cn("pt-2 text-[11px]", liveMessageError ? "text-red-300" : "text-emerald-300")}>
                    {liveMessage}
                  </p>
                ) : null}
                {liveReadOnly ? (
                  <p className="pt-1 text-[11px] text-amber-300">
                    Read-only mirror from {String(liveCfg?.mirror_source || "production")}.
                  </p>
                ) : null}
              </div>
            </section>

            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <Clock3 className="w-4 h-4 text-sky-400" />
                <p className="text-sm font-semibold text-gray-100">Queued</p>
                <span className="text-xs text-gray-500">{queuedRuns.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {queuedRuns.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">No queued runs.</p>
                ) : (
                  <>
                    <div className="text-[10px] font-semibold text-blue-200 border border-blue-800/50 bg-blue-950/30 rounded px-2 py-1">
                      PRODUCTION · webhook ({queuedProductionRuns.length})
                    </div>
                    {queuedProductionRuns.length === 0 ? (
                      <p className="text-[11px] text-gray-500 italic px-1">No production runs.</p>
                    ) : (
                      queuedProductionRuns.map(renderRunCard)
                    )}
                    <div className="pt-2 text-[10px] font-semibold text-fuchsia-200 border border-fuchsia-800/50 bg-fuchsia-950/20 rounded px-2 py-1">
                      TEST · local ({queuedTestRuns.length})
                    </div>
                    {queuedTestRuns.length === 0 ? (
                      <p className="text-[11px] text-gray-500 italic px-1">No test runs.</p>
                    ) : (
                      queuedTestRuns.map(renderRunCard)
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <Clock3 className="w-4 h-4 text-amber-400" />
                <p className="text-sm font-semibold text-gray-100">Running</p>
                <span className="text-xs text-gray-500">{runningRuns.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {runningRuns.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">No running runs.</p>
                ) : (
                  <>
                    <div className="text-[10px] font-semibold text-blue-200 border border-blue-800/50 bg-blue-950/30 rounded px-2 py-1">
                      PRODUCTION · webhook ({runningProductionRuns.length})
                    </div>
                    {runningProductionRuns.length === 0 ? (
                      <p className="text-[11px] text-gray-500 italic px-1">No production runs.</p>
                    ) : (
                      runningProductionRuns.map(renderRunCard)
                    )}
                    <div className="pt-2 text-[10px] font-semibold text-fuchsia-200 border border-fuchsia-800/50 bg-fuchsia-950/20 rounded px-2 py-1">
                      TEST · local ({runningTestRuns.length})
                    </div>
                    {runningTestRuns.length === 0 ? (
                      <p className="text-[11px] text-gray-500 italic px-1">No test runs.</p>
                    ) : (
                      runningTestRuns.map(renderRunCard)
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="min-h-0 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-semibold text-gray-100">Completed</p>
                <span className="text-xs text-gray-500">{completedRuns.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {completedRuns.length === 0 && (
                  <p className="text-xs text-gray-600 italic">No completed runs.</p>
                )}
                {completedRunsByDay.map((group) => {
                  const collapsed = !!collapsedCompletedDayIds[group.dayId];
                  return (
                    <div key={group.dayId} className="space-y-1.5">
                      <button
                        onClick={() => setCollapsedCompletedDayIds((prev) => ({ ...prev, [group.dayId]: !prev[group.dayId] }))}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded border border-gray-800 bg-gray-900/70 hover:bg-gray-800 text-left"
                        title={collapsed ? "Expand date folder" : "Collapse date folder"}
                      >
                        <ChevronRight className={cn("w-3.5 h-3.5 text-gray-500 transition-transform", !collapsed && "rotate-90")} />
                        <span className="text-[11px] text-gray-300 font-semibold">{group.label}</span>
                        <span className="ml-auto text-[10px] text-gray-500">{group.runs.length}</span>
                      </button>
                      {!collapsed && (
                        <div className="space-y-2 pl-2">
                          <div className="text-[10px] font-semibold text-blue-200 border border-blue-800/50 bg-blue-950/30 rounded px-2 py-1">
                            PRODUCTION · webhook ({group.productionRuns.length})
                          </div>
                          {group.productionRuns.length === 0 ? (
                            <p className="text-[11px] text-gray-500 italic px-1">No production runs on this day.</p>
                          ) : (
                            group.productionRuns.map(renderRunCard)
                          )}

                          <div className="pt-1 text-[10px] font-semibold text-fuchsia-200 border border-fuchsia-800/50 bg-fuchsia-950/20 rounded px-2 py-1">
                            TEST · local ({group.testRuns.length})
                          </div>
                          {group.testRuns.length === 0 ? (
                            <p className="text-[11px] text-gray-500 italic px-1">No test runs on this day.</p>
                          ) : (
                            group.testRuns.map(renderRunCard)
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-gray-800 bg-gray-900/80 text-[11px] text-gray-500 shrink-0 flex items-center gap-2">
        <Workflow className="w-3.5 h-3.5 text-indigo-400" />
        Click any run to open Pipeline canvas with that historical run context and real-time node states.
      </div>
    </div>
  );
}
