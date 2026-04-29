"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { Activity, CheckCircle2, Clock3, Loader2, RefreshCcw, Search, Workflow } from "lucide-react";
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
}

interface LiveWebhookConfig {
  enabled: boolean;
  ingest_only: boolean;
  trigger_pipeline: boolean;
  default_pipeline_id: string;
  pipeline_by_agent: Record<string, string>;
  run_payload: Record<string, unknown>;
  transcription_model: string;
  transcription_timeout_s: number;
  transcription_poll_interval_s: number;
}

type SortKey = "started_at" | "finished_at" | "pipeline_name" | "sales_agent" | "customer" | "status" | "call_id";
type SortDir = "asc" | "desc";

function statusTone(status: string): string {
  const s = String(status || "").toLowerCase();
  if (s === "done" || s === "completed") return "text-emerald-300 border-emerald-700/50 bg-emerald-950/40";
  if (s === "error" || s === "failed") return "text-red-300 border-red-700/50 bg-red-950/40";
  return "text-amber-300 border-amber-700/50 bg-amber-950/40";
}

function isCompletedRun(status: string): boolean {
  const s = String(status || "").toLowerCase();
  return s === "done" || s === "completed" || s === "error" || s === "failed" || s === "stopped" || s === "cancelled";
}

function relativeTime(isoStr: string | null | undefined): string {
  const dt = parseServerDate(isoStr);
  if (!dt) return "—";
  const d = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function durationStr(startedAt: string | null | undefined, finishedAt: string | null | undefined): string {
  const s = parseServerDate(startedAt);
  if (!s) return "—";
  const e = parseServerDate(finishedAt) ?? new Date();
  const ms = Math.max(0, e.getTime() - s.getTime());
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export default function LivePage() {
  const router = useRouter();
  const { setCustomer, setCallId, setActivePipeline } = useAppCtx();

  const [pipelineId, setPipelineId] = useState("");
  const [salesAgent, setSalesAgent] = useState("");
  const [customer, setCustomerFilter] = useState("");
  const [crmUrl, setCrmUrl] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("started_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [livePipelineId, setLivePipelineId] = useState("");
  const [liveSaving, setLiveSaving] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [liveMessageError, setLiveMessageError] = useState(false);

  const { data: pipelines } = useSWR<PipelineLite[]>("/api/pipelines", fetcher, { refreshInterval: 60000 });
  const { data: liveCfg, mutate: mutateLiveCfg } = useSWR<LiveWebhookConfig>(
    "/api/pipelines/live-webhook/config",
    fetcher,
    { refreshInterval: 7000 },
  );

  const runsUrl = useMemo(() => {
    const qp = new URLSearchParams();
    if (pipelineId) qp.set("pipeline_id", pipelineId);
    if (salesAgent.trim()) qp.set("sales_agent", salesAgent.trim());
    if (customer.trim()) qp.set("customer", customer.trim());
    if (crmUrl.trim()) qp.set("crm_url", crmUrl.trim());
    if (dateFrom) qp.set("date_from", `${dateFrom}T00:00:00Z`);
    if (dateTo) qp.set("date_to", `${dateTo}T23:59:59Z`);
    qp.set("sort_by", sortBy);
    qp.set("sort_dir", sortDir);
    qp.set("limit", "600");
    return `/api/history/runs?${qp.toString()}`;
  }, [pipelineId, salesAgent, customer, crmUrl, dateFrom, dateTo, sortBy, sortDir]);

  const { data: runsData, isLoading, mutate } = useSWR<PipelineRunRecord[]>(runsUrl, fetcher, {
    refreshInterval: 5000,
  });

  const runs = runsData ?? [];
  const crmOptions = useMemo(() => {
    const uniq = new Set<string>();
    for (const r of runs) {
      const u = String(r.crm_url || "").trim();
      if (u) uniq.add(u);
    }
    return Array.from(uniq).sort((a, b) => a.localeCompare(b));
  }, [runs]);

  const pipelineNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of pipelines ?? []) {
      map[String(p.id || "")] = String(p.name || p.id || "");
    }
    return map;
  }, [pipelines]);

  const liveIsActive = Boolean(liveCfg?.enabled) && !Boolean(liveCfg?.ingest_only) && Boolean(liveCfg?.default_pipeline_id);
  const activeLivePipelineName = pipelineNameById[String(liveCfg?.default_pipeline_id || "")] || String(liveCfg?.default_pipeline_id || "");

  useEffect(() => {
    if (!liveCfg) return;
    setLivePipelineId(String(liveCfg.default_pipeline_id || ""));
  }, [liveCfg?.default_pipeline_id]);

  const enableLiveForAllWebhooks = async () => {
    const pid = String(livePipelineId || "").trim();
    if (!pid) {
      setLiveMessageError(true);
      setLiveMessage("Select a pipeline first.");
      return;
    }
    setLiveSaving(true);
    setLiveMessage("");
    try {
      const res = await fetch("/api/pipelines/live-webhook/quick-set", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pipeline_id: pid,
          enabled: true,
          listen_all_webhooks: true,
          clear_agent_mappings: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      }
      setLiveMessageError(false);
      setLiveMessage(`Live enabled. All incoming webhooks now trigger: ${pipelineNameById[pid] || pid}`);
      await mutateLiveCfg();
    } catch (e: any) {
      setLiveMessageError(true);
      setLiveMessage(String(e?.message || "Failed to enable live webhook pipeline."));
    } finally {
      setLiveSaving(false);
    }
  };

  const disableLiveExecution = async () => {
    setLiveSaving(true);
    setLiveMessage("");
    try {
      const res = await fetch("/api/pipelines/live-webhook/quick-set", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pipeline_id: "",
          enabled: false,
          listen_all_webhooks: true,
          clear_agent_mappings: false,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      }
      setLiveMessageError(false);
      setLiveMessage("Live execution disabled (webhooks still ingested and saved).");
      await mutateLiveCfg();
    } catch (e: any) {
      setLiveMessageError(true);
      setLiveMessage(String(e?.message || "Failed to disable live execution."));
    } finally {
      setLiveSaving(false);
    }
  };

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => (
      String(r.id || "").toLowerCase().includes(q)
      || String(r.pipeline_name || "").toLowerCase().includes(q)
      || String(r.sales_agent || "").toLowerCase().includes(q)
      || String(r.customer || "").toLowerCase().includes(q)
      || String(r.call_id || "").toLowerCase().includes(q)
      || String(r.crm_url || "").toLowerCase().includes(q)
    ));
  }, [runs, search]);

  const runningRuns = useMemo(() => filteredRuns.filter((r) => !isCompletedRun(r.status)), [filteredRuns]);
  const completedRuns = useMemo(() => filteredRuns.filter((r) => isCompletedRun(r.status)), [filteredRuns]);

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

  const renderRunCard = (run: PipelineRunRecord) => (
    <button
      key={run.id}
      onClick={() => openRunInCanvas(run)}
      className="w-full text-left rounded-xl border border-gray-700/70 bg-gray-900 hover:bg-gray-800 hover:border-indigo-600/60 transition-colors px-3 py-2.5"
      title="Open this run in Pipeline canvas"
    >
      <div className="flex items-center gap-2 flex-wrap">
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
        <span>{relativeTime(run.started_at)}</span>
        <span>{durationStr(run.started_at, run.finished_at)}</span>
      </div>
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
          <span className="text-xs text-gray-500">Running + completed pipeline runs</span>
        </div>
      </div>

      <div className="px-5 py-3 border-b border-gray-800 bg-gray-950/80 shrink-0 space-y-2">
        <div className="rounded-xl border border-gray-700/70 bg-gray-900/70 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "text-[10px] px-2 py-0.5 rounded border font-semibold",
                liveIsActive
                  ? "text-emerald-300 border-emerald-700/50 bg-emerald-950/50"
                  : "text-amber-300 border-amber-700/50 bg-amber-950/40",
              )}
            >
              {liveIsActive ? "LIVE ACTIVE" : "INGEST ONLY"}
            </span>
            <span className="text-xs text-gray-300">
              {liveIsActive
                ? `Listening to all CRM webhooks and executing pipeline: ${activeLivePipelineName || "unknown"}`
                : "Webhooks are currently saved only (no pipeline execution)."}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-center">
            <select
              value={livePipelineId}
              onChange={(e) => setLivePipelineId(e.target.value)}
              className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
              disabled={liveSaving}
            >
              <option value="">Select pipeline for LIVE webhook execution…</option>
              {(pipelines ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              onClick={enableLiveForAllWebhooks}
              disabled={liveSaving}
              className={cn(
                "px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors",
                liveSaving
                  ? "opacity-60 cursor-wait border-gray-700 text-gray-400"
                  : "border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/40",
              )}
            >
              {liveSaving ? "Saving…" : "Enable Live"}
            </button>
            <button
              onClick={disableLiveExecution}
              disabled={liveSaving}
              className={cn(
                "px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors",
                liveSaving
                  ? "opacity-60 cursor-wait border-gray-700 text-gray-400"
                  : "border-amber-700/60 text-amber-300 hover:bg-amber-950/40",
              )}
            >
              Disable Live
            </button>
          </div>
          {liveMessage ? (
            <p className={cn("mt-1 text-[11px]", liveMessageError ? "text-red-300" : "text-emerald-300")}>
              {liveMessage}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
          <select
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
          >
            <option value="">All pipelines</option>
            {(pipelines ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input
            value={salesAgent}
            onChange={(e) => setSalesAgent(e.target.value)}
            placeholder="Filter: sales agent"
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100 placeholder-gray-500"
          />
          <input
            value={customer}
            onChange={(e) => setCustomerFilter(e.target.value)}
            placeholder="Filter: customer"
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100 placeholder-gray-500"
          />
          <select
            value={crmUrl}
            onChange={(e) => setCrmUrl(e.target.value)}
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
          >
            <option value="">All CRM</option>
            {crmOptions.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
          />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
          >
            <option value="started_at">Sort: started_at</option>
            <option value="finished_at">Sort: finished_at</option>
            <option value="pipeline_name">Sort: pipeline</option>
            <option value="sales_agent">Sort: agent</option>
            <option value="customer">Sort: customer</option>
            <option value="status">Sort: status</option>
            <option value="call_id">Sort: call id</option>
          </select>
          <select
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value as SortDir)}
            className="px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-100"
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-[240px] flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700">
            <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search runs by run id, pipeline, agent, customer, call id, crm…"
              className="w-full bg-transparent text-xs text-gray-100 placeholder-gray-500 focus:outline-none"
            />
          </div>
          <button
            onClick={() => void mutate()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-xs text-gray-300 hover:bg-gray-800"
            title="Refresh now"
          >
            <RefreshCcw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <span className="text-[11px] text-gray-500">
            {filteredRuns.length} runs
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center gap-2 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            Loading live runs…
          </div>
        ) : (
          <div className="h-full grid grid-cols-1 xl:grid-cols-2 gap-0">
            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <Clock3 className="w-4 h-4 text-amber-400" />
                <p className="text-sm font-semibold text-gray-100">Running</p>
                <span className="text-xs text-gray-500">{runningRuns.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {runningRuns.length === 0
                  ? <p className="text-xs text-gray-600 italic">No running runs.</p>
                  : runningRuns.map(renderRunCard)}
              </div>
            </section>

            <section className="min-h-0 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-semibold text-gray-100">Completed</p>
                <span className="text-xs text-gray-500">{completedRuns.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {completedRuns.length === 0
                  ? <p className="text-xs text-gray-600 italic">No completed runs.</p>
                  : completedRuns.map(renderRunCard)}
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
