"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { Activity, CheckCircle2, ChevronRight, Clock3, Loader2, Workflow, XCircle } from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { useUserProfile } from "@/lib/user-profile";
import { parseServerDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error("Invalid JSON response");
  }
  if (!res.ok) {
    const msg = String(data?.detail || data?.error || data?.message || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return data;
};
const PIPELINE_OPEN_RUN_STORAGE_KEY = "shinobi.pipeline.open_run";
const LIVE_RUNS_CACHE_KEY = "shinobi.live.runs_cache.v1";
const LIVE_RUNS_CACHE_MAX = 300;

function loadRunsCache(): PipelineRunRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LIVE_RUNS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRunsCache(runs: PipelineRunRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    // Only cache completed/terminal runs — active runs will refresh quickly anyway.
    const toCache = runs.slice(0, LIVE_RUNS_CACHE_MAX);
    window.localStorage.setItem(LIVE_RUNS_CACHE_KEY, JSON.stringify(toCache));
  } catch {
    // localStorage full or unavailable — silently skip
  }
}

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
  note_sent?: boolean;
  note_sent_at?: string | null;
}

interface PhaseBadge {
  label: string;
  tone: string;
}

interface LiveWebhookConfig {
  enabled: boolean;
  ingest_only: boolean;
  trigger_pipeline: boolean;
  agent_continuity_filter_enabled: boolean;
  agent_continuity_pair_tag_fallback_enabled: boolean;
  agent_continuity_reject_multi_agent_pair_tags: boolean;
  live_pipeline_ids: string[];
  send_note_pipeline_ids: string[];
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
  rejected_webhooks_total?: number;
  rejected_by_reason?: Record<string, number>;
  read_only?: boolean;
  mirror_source?: string;
}

interface RejectedWebhookItem {
  id: string;
  status?: string;
  source?: string;
  reason?: string;
  message?: string;
  webhook_type?: string;
  event_id?: string;
  event_file?: string;
  account_id?: string;
  crm_url?: string;
  sales_agent?: string;
  customer?: string;
  call_id?: string;
  pipeline_ids?: string[];
  moved_pipeline_ids?: string[];
  moved_run_ids?: string[];
  created_at?: string;
  updated_at?: string;
  payload?: Record<string, any>;
}

function rejectedItemTs(item: RejectedWebhookItem): number {
  const primary = parseServerDate(item.created_at || item.updated_at);
  if (primary) return primary.getTime();
  const secondary = parseServerDate(item.updated_at || item.created_at);
  if (secondary) return secondary.getTime();
  return 0;
}

function rejectedDayId(item: RejectedWebhookItem): string {
  const d = parseServerDate(item.created_at || item.updated_at) || parseServerDate(item.updated_at || item.created_at);
  if (!d) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rejectedDayLabel(dayId: string): string {
  if (dayId === "unknown") return "Unknown date";
  return new Date(`${dayId}T00:00:00`).toLocaleDateString();
}

function statusTone(status: string): string {
  const s = String(status || "").trim().toLowerCase();
  if (s === "queued") return "text-sky-200 border-sky-700/50 bg-sky-950/40";
  if (s === "preparing") return "text-cyan-200 border-cyan-700/50 bg-cyan-950/40";
  if (s === "retrying") return "text-violet-200 border-violet-700/50 bg-violet-950/40";
  if (s === "done" || s === "completed" || s === "success" || s === "ok" || s === "finished" || s === "cached") {
    return "text-emerald-300 border-emerald-700/50 bg-emerald-950/40";
  }
  if (s === "error" || s === "failed" || s.includes("exception")) return "text-red-300 border-red-700/50 bg-red-950/40";
  if (s.includes("cancel") || s.includes("abort") || s.includes("stop")) return "text-slate-200 border-slate-700/50 bg-slate-900/50";
  return "text-amber-300 border-amber-700/50 bg-amber-950/40";
}

function isCompletedRun(status: string): boolean {
  const s = String(status || "").trim().toLowerCase();
  return (
    s === "done"
    || s === "completed"
    || s === "success"
    || s === "ok"
    || s === "finished"
    || s === "cached"
    || s === "error"
    || s === "failed"
    || s.includes("cancel")
    || s.includes("abort")
    || s.includes("stop")
    || s.includes("exception")
  );
}

function isSuccessCompletedRun(status: string): boolean {
  const s = String(status || "").trim().toLowerCase();
  return s === "done" || s === "completed" || s === "success" || s === "ok" || s === "finished" || s === "cached";
}

function isFailedCompletedRun(status: string): boolean {
  const s = String(status || "").trim().toLowerCase();
  return isCompletedRun(s) && !isSuccessCompletedRun(s);
}

function isQueuedRun(status: string): boolean {
  const s = String(status || "").toLowerCase();
  return s === "queued";
}

function statusLabel(status: string): string {
  const s = String(status || "").trim().toLowerCase();
  if (s === "retrying") return "retry";
  return status;
}

function normalizeStateToken(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

function isFailedLike(status: string): boolean {
  const s = normalizeStateToken(status);
  return s === "failed" || s === "error" || s === "fail" || s.includes("exception");
}

function isCancelledLike(status: string): boolean {
  const s = normalizeStateToken(status);
  return s.includes("cancel") || s.includes("abort") || s.includes("stop");
}

function isActiveLike(status: string): boolean {
  const s = normalizeStateToken(status);
  return (
    s === "running"
    || s === "loading"
    || s === "started"
    || s === "queued"
    || s === "preparing"
    || s === "retrying"
    || s.includes("in_progress")
  );
}

function deriveEffectiveRunStatus(run: PipelineRunRecord): string {
  const base = normalizeStateToken(run.status);
  const finished = parseServerDate(run.finished_at);
  const steps = _safeJsonArray(run.steps_json);
  const stepStates = steps
    .map((step) => {
      if (!step || typeof step !== "object") return "";
      const obj = step as Record<string, any>;
      return normalizeStateToken(obj.state || obj.status || "");
    })
    .filter(Boolean);

  const hasFailedStep = stepStates.some((s) => isFailedLike(s));
  const hasCancelledStep = stepStates.some((s) => isCancelledLike(s));
  const hasActiveStep = stepStates.some((s) => isActiveLike(s));
  const runIsActive = isActiveLike(base) && !finished;
  const baseIsRetry = base === "retrying";
  const baseIsLive = base === "running" || base === "preparing" || base === "queued" || baseIsRetry;

  // Manual retry/requeue should be reflected immediately in Jobs, even if
  // stale failed step states still exist on the same run row.
  if (baseIsRetry) return "retrying";
  // Real-status override: if no step is actively progressing and one step is
  // already terminal failed/cancelled, prefer that over a stale live row status.
  if (!hasActiveStep && hasFailedStep) return "failed";
  if (!hasActiveStep && hasCancelledStep) return "cancelled";
  if (baseIsLive && !finished) return base;

  if (hasCancelledStep) return "cancelled";
  if (hasFailedStep) return "failed";
  if (hasActiveStep && !runIsActive) return "cancelled";
  return base || String(run.status || "").trim().toLowerCase();
}

function normalizeRunOrigin(origin: string | null | undefined): "webhook" | "local" {
  const v = String(origin || "").trim().toLowerCase();
  if (v === "webhook" || v === "production") return "webhook";
  return "local";
}

function mergeRunsById(prev: PipelineRunRecord[], incoming: PipelineRunRecord[]): PipelineRunRecord[] {
  const byId = new Map(prev.map((r) => [String(r.id || ""), r]));
  for (const row of incoming) {
    const rid = String(row?.id || "").trim();
    if (!rid) continue;
    byId.set(rid, row);
  }
  return [...byId.values()].sort((a, b) => ((b.started_at || "") > (a.started_at || "") ? 1 : -1));
}

function relativeTime(isoStr: string | null | undefined, nowMs?: number | null): string {
  const dt = parseServerDate(isoStr);
  if (!dt) return "—";
  if (typeof nowMs !== "number") return "—";
  const nowTs = nowMs;
  const d = Math.floor((nowTs - dt.getTime()) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function durationStr(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  nowMs?: number | null,
): string {
  const s = parseServerDate(startedAt);
  if (!s) return "—";
  const finished = parseServerDate(finishedAt);
  if (!finished && typeof nowMs !== "number") return "—";
  const e = finished ?? new Date(nowMs as number);
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

function inferNotePushState(run: PipelineRunRecord): { sent: boolean; sentAt: string } {
  const directSent = !!(run.note_sent === true);
  const directSentAt = String(run.note_sent_at || "").trim();
  if (directSent) {
    return { sent: true, sentAt: directSentAt };
  }

  const logs = _safeJsonArray(run.log_json);
  let sent = false;
  let sentAt = "";
  for (const line of logs) {
    const text = typeof line === "string"
      ? line
      : String((line && (line.text || line.message || line.msg)) || "");
    if (!text.includes("[CRM-PUSH] ✓ Sent note ")) continue;
    sent = true;
    const ts = typeof line === "object" && line
      ? String((line.ts || line.timestamp || line.time || "") || "").trim()
      : "";
    if (ts) sentAt = ts;
  }
  return { sent, sentAt };
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

function inferPhaseBadges(run: PipelineRunRecord, statusOverride?: string): PhaseBadge[] {
  const status = String(statusOverride || run.status || "").toLowerCase();
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

function inferRunCallId(run: PipelineRunRecord): string {
  const direct = String(run.call_id || "").trim();
  if (direct) return direct;
  try {
    const parsedSteps = JSON.parse(String(run.steps_json || "[]"));
    if (Array.isArray(parsedSteps)) {
      for (const step of parsedSteps) {
        if (!step || typeof step !== "object") continue;
        const obj = step as Record<string, any>;
        const candidates = [
          obj.call_id,
          obj.context_call_id,
          obj.input_scope_call_id,
          obj.merged_until_call_id,
        ];
        for (const candidate of candidates) {
          const value = String(candidate || "").trim();
          if (value) return value;
        }
      }
    }
  } catch {
    // ignore
  }
  const raw = String(run.log_json || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const lines = Array.isArray(parsed) ? parsed : [];
    for (const item of lines) {
      const txt = typeof item === "string"
        ? item
        : String((item && (item.text || item.msg || item.message)) || "");
      const m1 = txt.match(/input\s+scope\s+call\s+context\s*:\s*([A-Za-z0-9_-]{3,})/i);
      if (m1 && m1[1]) return String(m1[1]).trim();
      const m2 = txt.match(/\bcall[_\s-]?id\s*[:=]\s*([A-Za-z0-9_-]{3,})\b/i);
      if (m2 && m2[1]) return String(m2[1]).trim();
      const m3 = txt.match(/\bcall\s+([A-Za-z0-9_-]{3,})\b/i);
      if (m3 && m3[1]) return String(m3[1]).trim();
    }
  } catch {
    const m1 = raw.match(/input\s+scope\s+call\s+context\s*:\s*([A-Za-z0-9_-]{3,})/i);
    if (m1 && m1[1]) return String(m1[1]).trim();
    const m2 = raw.match(/\bcall[_\s-]?id\s*[:=]\s*([A-Za-z0-9_-]{3,})\b/i);
    if (m2 && m2[1]) return String(m2[1]).trim();
    const m3 = raw.match(/\bcall\s+([A-Za-z0-9_-]{3,})\b/i);
    if (m3 && m3[1]) return String(m3[1]).trim();
  }
  return "";
}

export default function LivePage() {
  const { permissions } = useUserProfile();
  const router = useRouter();
  const { setCustomer, setCallId, setActivePipeline } = useAppCtx();

  const [liveSelectedPipelineIds, setLiveSelectedPipelineIds] = useState<string[]>([]);
  const [sendNotePipelineIds, setSendNotePipelineIds] = useState<string[]>([]);
  const [liveSaving, setLiveSaving] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [liveMessageError, setLiveMessageError] = useState(false);
  const [collapsedCompletedFailedDayIds, setCollapsedCompletedFailedDayIds] = useState<Record<string, boolean>>({});
  const [collapsedCompletedSuccessDayIds, setCollapsedCompletedSuccessDayIds] = useState<Record<string, boolean>>({});
  const [filterRunType, setFilterRunType] = useState<"all" | "webhook" | "local">("all");
  const [filterPipelineId, setFilterPipelineId] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [expandedRejectedId, setExpandedRejectedId] = useState("");
  const [loadingRejectedDetailId, setLoadingRejectedDetailId] = useState("");
  const [rejectedDetailsById, setRejectedDetailsById] = useState<Record<string, RejectedWebhookItem>>({});
  const [requeueingRejectedId, setRequeueingRejectedId] = useState("");
  const [rejectionActionMsg, setRejectionActionMsg] = useState("");
  const [rejectionActionErr, setRejectionActionErr] = useState(false);
  const [retryingFailedRunId, setRetryingFailedRunId] = useState("");
  const [cancellingRunId, setCancellingRunId] = useState("");
  const [failedRunActionMsg, setFailedRunActionMsg] = useState("");
  const [failedRunActionErr, setFailedRunActionErr] = useState(false);
  const [runControlActionMsg, setRunControlActionMsg] = useState("");
  const [runControlActionErr, setRunControlActionErr] = useState(false);
  const [collapsedRejectedFilters, setCollapsedRejectedFilters] = useState(true);
  const [collapsedRejectedDayIds, setCollapsedRejectedDayIds] = useState<Record<string, boolean>>({});
  const [dismissedRejectedIds, setDismissedRejectedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setNowMs(Date.now());
    const ticker = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  const { data: pipelines } = useSWR<PipelineLite[]>("/api/pipelines", fetcher, { refreshInterval: 60000 });
  const { data: liveCfg, mutate: mutateLiveCfg } = useSWR<LiveWebhookConfig>(
    "/api/pipelines/live-webhook/config",
    fetcher,
    { refreshInterval: 7000 },
  );
  const {
    data: rejectedData,
    mutate: mutateRejected,
  } = useSWR<{ ok?: boolean; count?: number; total_count?: number; returned_count?: number; items?: RejectedWebhookItem[] }>(
    "/api/pipelines/live-webhook/rejections?limit=500&status=rejected&include_payload=0",
    fetcher,
    {
      refreshInterval: 10000,
      keepPreviousData: true,
      revalidateOnFocus: true,
    },
  );
  const liveReadOnly = !!liveCfg?.read_only || !permissions.can_manage_live_jobs;

  // Incremental load: full baseline every 30s, delta every 4s (only new/changed rows since last seen).
  const [sinceTs, setSinceTs] = useState("");
  const sinceTsRef = useRef("");
  // Seed from localStorage so the view is instant on load (stale-while-revalidate).
  const [runsState, setRunsState] = useState<PipelineRunRecord[]>(() => loadRunsCache());
  const [runsInitialLoading, setRunsInitialLoading] = useState(() => loadRunsCache().length === 0);
  const [runsError, setRunsError] = useState<Error | null>(null);

  const { mutate: mutateRunsBase } = useSWR<PipelineRunRecord[]>(
    "/api/history/runs?sort_by=started_at&sort_dir=desc&limit=500&compact=1&mirror=1&run_origin=webhook",
    fetcher,
    {
      refreshInterval: 30000,
      keepPreviousData: true,
      revalidateOnFocus: true,
      onSuccess: (data) => {
        setRunsInitialLoading(false);
        setRunsError(null);
        if (!Array.isArray(data)) return;
        const max = data.reduce((m, r) => ((r.started_at || "") > m ? (r.started_at || "") : m), "");
        if (max && max > sinceTsRef.current) {
          sinceTsRef.current = max;
          setSinceTs(max);
        }
        setRunsState((prev) => {
          const next = mergeRunsById(prev, data);
          saveRunsCache(next);
          return next;
        });
      },
      onError: (err: Error) => {
        setRunsInitialLoading(false);
        setRunsError(err);
      },
    },
  );

  // Separate fetch for local/test runs — always fetched independently so they
  // never get crowded out by the high volume of production webhook runs.
  useSWR<PipelineRunRecord[]>(
    "/api/history/runs?sort_by=started_at&sort_dir=desc&limit=100&compact=1&run_origin=local",
    fetcher,
    {
      refreshInterval: 60000,
      keepPreviousData: true,
      onSuccess: (data) => {
        if (!Array.isArray(data)) return;
        setRunsState((prev) => {
          const next = mergeRunsById(prev, data);
          saveRunsCache(next);
          return next;
        });
      },
    },
  );

  const deltaUrl = sinceTs
    ? `/api/history/runs?sort_by=started_at&sort_dir=desc&limit=100&compact=1&mirror=1&run_origin=webhook&date_from=${encodeURIComponent(sinceTs)}`
    : null;
  useSWR<PipelineRunRecord[]>(deltaUrl, fetcher, {
    refreshInterval: 4000,
    onSuccess: (delta) => {
      if (!Array.isArray(delta) || !delta.length) return;
      const max = delta.reduce((m, r) => ((r.started_at || "") > m ? (r.started_at || "") : m), sinceTsRef.current);
      if (max > sinceTsRef.current) {
        sinceTsRef.current = max;
        setSinceTs(max);
      }
      setRunsState((prev) => {
        const next = mergeRunsById(prev, delta);
        saveRunsCache(next);
        return next;
      });
    },
  });

  // Keep "active" cards truthful by polling those run ids directly.
  // This catches status flips that don't change started_at and can otherwise
  // be missed by started_at-based delta loading.
  const activeRunIds = useMemo(() => {
    const out: string[] = [];
    for (const run of runsState) {
      const rid = String(run?.id || "").trim();
      if (!rid) continue;
      const st = deriveEffectiveRunStatus(run);
      if (!["queued", "preparing", "running", "retrying"].includes(st)) continue;
      out.push(rid);
      if (out.length >= 80) break;
    }
    return out;
  }, [runsState]);
  const activeRunIdsKey = useMemo(() => activeRunIds.join(","), [activeRunIds]);

  useEffect(() => {
    if (!activeRunIds.length) return;
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const rows = await Promise.all(
          activeRunIds.map(async (rid) => {
            const res = await fetch(`/api/history/runs/${encodeURIComponent(rid)}?compact=1&mirror=1`, {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!res.ok) return null;
            const data = await res.json().catch(() => null);
            if (!data || typeof data !== "object") return null;
            return data as PipelineRunRecord;
          }),
        );
        if (cancelled) return;
        const fresh = rows.filter((r): r is PipelineRunRecord => !!r && !!String(r.id || "").trim());
        if (!fresh.length) return;
        setRunsState((prev) => mergeRunsById(prev, fresh));
      } catch (err: any) {
        if (err?.name === "AbortError") return;
      }
    };

    void poll();
    const t = window.setInterval(() => {
      void poll();
    }, 5000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(t);
    };
  }, [activeRunIdsKey]);

  const isLoading = runsInitialLoading;
  const mutateRuns = useCallback(
    async (updater?: any, opts?: any) => {
      if (typeof updater === "function") {
        setRunsState(updater);
        if (opts?.revalidate !== false) void mutateRunsBase();
      } else if (Array.isArray(updater)) {
        setRunsState(updater);
      } else {
        await mutateRunsBase();
      }
    },
    [mutateRunsBase],
  );

  const pipelineList: PipelineLite[] = Array.isArray(pipelines) ? pipelines : [];
  const runs: PipelineRunRecord[] = runsState;
  const rejectedItems: RejectedWebhookItem[] = Array.isArray(rejectedData?.items) ? rejectedData.items : [];
  const activeRejectedItems = useMemo(
    () =>
      rejectedItems
        .filter((item) => !dismissedRejectedIds[String(item?.id || "").trim()])
        .sort((a, b) => rejectedItemTs(b) - rejectedItemTs(a)),
    [rejectedItems, dismissedRejectedIds],
  );
  const rejectedTotalCount = Number(
    rejectedData?.total_count ?? rejectedData?.count ?? activeRejectedItems.length ?? 0,
  ) || 0;
  const rejectedStatsTotal = Number((liveCfg?.rejected_webhooks_total as number) || 0) || 0;
  const rejectedDisplayCount = activeRejectedItems.length;
  const rejectedByReason = (liveCfg?.rejected_by_reason && typeof liveCfg.rejected_by_reason === "object")
    ? liveCfg.rejected_by_reason
    : {};
  const continuityRejectedCount = useMemo(
    () =>
      activeRejectedItems.filter((r) => {
        const reason = String(r?.reason || "").toLowerCase();
        return (
          reason === "multi_agent_pair"
          || reason === "payload_agent_mismatch"
          || reason === "resolved_agent_mismatch"
          || reason === "no_agent_history"
        );
      }).length,
    [activeRejectedItems],
  );
  const rejectedByDay = useMemo(() => {
    const byDay = new Map<string, RejectedWebhookItem[]>();
    for (const item of activeRejectedItems) {
      const dayId = rejectedDayId(item);
      const arr = byDay.get(dayId) || [];
      arr.push(item);
      byDay.set(dayId, arr);
    }
    const groups = Array.from(byDay.entries()).map(([dayId, rows]) => ({
      dayId,
      label: rejectedDayLabel(dayId),
      items: [...rows].sort((a, b) => rejectedItemTs(b) - rejectedItemTs(a)),
    }));
    groups.sort((a, b) => (a.dayId < b.dayId ? 1 : a.dayId > b.dayId ? -1 : 0));
    return groups;
  }, [activeRejectedItems]);

  useEffect(() => {
    setCollapsedRejectedDayIds((prev) => {
      const next: Record<string, boolean> = { ...prev };
      let changed = false;
      const newestDayId = rejectedByDay[0]?.dayId || "";
      for (const group of rejectedByDay) {
        if (next[group.dayId] == null) {
          next[group.dayId] = group.dayId !== newestDayId;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rejectedByDay]);

  const pipelineNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of pipelineList) {
      map[String(p.id || "")] = String(p.name || p.id || "");
    }
    return map;
  }, [pipelineList]);

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

  const effectiveStatusByRunId = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs) {
      const rid = String(run.id || "").trim();
      if (!rid) continue;
      map.set(rid, deriveEffectiveRunStatus(run));
    }
    return map;
  }, [runs]);

  const getRunStatus = useCallback((run: PipelineRunRecord): string => {
    const rid = String(run.id || "").trim();
    if (rid && effectiveStatusByRunId.has(rid)) return String(effectiveStatusByRunId.get(rid) || "");
    return deriveEffectiveRunStatus(run);
  }, [effectiveStatusByRunId]);

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
    const sendIds = Array.isArray(liveCfg.send_note_pipeline_ids)
      ? liveCfg.send_note_pipeline_ids.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    const fallback = String(liveCfg.default_pipeline_id || "").trim();
    const next = ids.length ? ids : (fallback ? [fallback] : []);
    setLiveSelectedPipelineIds(next);
    setSendNotePipelineIds(sendIds);
  }, [liveCfg?.live_pipeline_ids, liveCfg?.send_note_pipeline_ids, liveCfg?.default_pipeline_id]);

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
      const currentSendNoteIds = Array.from(
        new Set((sendNotePipelineIds || []).map((v) => String(v || "").trim()).filter(Boolean)),
      );
      const res = await fetch("/api/pipelines/live-webhook/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          ingest_only: cleaned.length === 0,
          trigger_pipeline: true,
          agent_continuity_filter_enabled: !!(liveCfg?.agent_continuity_filter_enabled ?? true),
          agent_continuity_pair_tag_fallback_enabled: !!(
            liveCfg?.agent_continuity_pair_tag_fallback_enabled ?? true
          ),
          agent_continuity_reject_multi_agent_pair_tags: !!(
            liveCfg?.agent_continuity_reject_multi_agent_pair_tags ?? true
          ),
          live_pipeline_ids: cleaned,
          send_note_pipeline_ids: currentSendNoteIds,
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

  const toggleContinuityFilter = async () => {
    if (liveReadOnly) {
      setLiveMessageError(true);
      setLiveMessage("Live mirror mode is read-only in this environment.");
      return;
    }
    const currentEnabled = !!(liveCfg?.agent_continuity_filter_enabled ?? true);
    const nextEnabled = !currentEnabled;
    const ok = window.confirm(
      nextEnabled
        ? "Enable unique-pair filter? Only webhooks with a unique customer-agent history will auto-run."
        : "Disable unique-pair filter? Webhooks will run regardless of pair uniqueness.",
    );
    if (!ok) return;

    setLiveSaving(true);
    setLiveMessage("");
    try {
      const currentRunPayload = (liveCfg && typeof liveCfg.run_payload === "object" && liveCfg.run_payload)
        ? liveCfg.run_payload
        : { resume_partial: true };
      const selected = Array.from(new Set((liveSelectedPipelineIds || []).map((v) => String(v || "").trim()).filter(Boolean)));
      const currentSendNoteIds = Array.from(
        new Set((sendNotePipelineIds || []).map((v) => String(v || "").trim()).filter(Boolean)),
      );
      const res = await fetch("/api/pipelines/live-webhook/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          ingest_only: selected.length === 0,
          trigger_pipeline: true,
          agent_continuity_filter_enabled: nextEnabled,
          agent_continuity_pair_tag_fallback_enabled: !!(
            liveCfg?.agent_continuity_pair_tag_fallback_enabled ?? true
          ),
          agent_continuity_reject_multi_agent_pair_tags: !!(
            liveCfg?.agent_continuity_reject_multi_agent_pair_tags ?? true
          ),
          live_pipeline_ids: selected,
          send_note_pipeline_ids: currentSendNoteIds,
          default_pipeline_id: selected[0] || "",
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
      setLiveMessage(nextEnabled ? "Unique-pair filter enabled." : "Unique-pair filter disabled.");
      await mutateLiveCfg();
    } catch (e: any) {
      setLiveMessageError(true);
      setLiveMessage(String(e?.message || "Failed to update unique-pair filter."));
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

  const toggleSendNotePipelineChecked = async (pipelineIdToToggle: string) => {
    const pid = String(pipelineIdToToggle || "").trim();
    if (!pid) return;
    if (liveReadOnly) {
      setLiveMessageError(true);
      setLiveMessage("Live mirror mode is read-only in this environment.");
      return;
    }
    const currentlyOn = sendNotePipelineIds.includes(pid);
    const action = currentlyOn ? "disable" : "enable";
    const name = pipelineNameById[pid] || pid;
    const ok = window.confirm(
      `Are you sure you want to ${action} automatic CRM note push for "${name}" (webhook runs only)?`,
    );
    if (!ok) return;

    const nextSendNoteIds = currentlyOn
      ? sendNotePipelineIds.filter((v) => v !== pid)
      : [...sendNotePipelineIds, pid];
    setSendNotePipelineIds(nextSendNoteIds);
    setLiveSaving(true);
    setLiveMessage("");
    try {
      const selectedLive = Array.from(
        new Set((liveSelectedPipelineIds || []).map((v) => String(v || "").trim()).filter(Boolean)),
      );
      const cleanedSend = Array.from(
        new Set((nextSendNoteIds || []).map((v) => String(v || "").trim()).filter(Boolean)),
      );
      const currentRunPayload = (liveCfg && typeof liveCfg.run_payload === "object" && liveCfg.run_payload)
        ? liveCfg.run_payload
        : { resume_partial: true };
      const res = await fetch("/api/pipelines/live-webhook/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          ingest_only: selectedLive.length === 0,
          trigger_pipeline: true,
          agent_continuity_filter_enabled: !!(liveCfg?.agent_continuity_filter_enabled ?? true),
          agent_continuity_pair_tag_fallback_enabled: !!(
            liveCfg?.agent_continuity_pair_tag_fallback_enabled ?? true
          ),
          agent_continuity_reject_multi_agent_pair_tags: !!(
            liveCfg?.agent_continuity_reject_multi_agent_pair_tags ?? true
          ),
          live_pipeline_ids: selectedLive,
          send_note_pipeline_ids: cleanedSend,
          default_pipeline_id: selectedLive[0] || "",
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
        cleanedSend.length
          ? `CRM note push enabled for ${cleanedSend.length} pipeline(s).`
          : "CRM note push disabled for all pipelines.",
      );
      await mutateLiveCfg();
    } catch (e: any) {
      setLiveMessageError(true);
      setLiveMessage(String(e?.message || "Failed to update CRM note push setting."));
    } finally {
      setLiveSaving(false);
    }
  };
  const moveRejectedToRun = async (item: RejectedWebhookItem) => {
    const rejectionId = String(item?.id || "").trim();
    if (!rejectionId) return;
    if (liveReadOnly) {
      setRejectionActionErr(true);
      setRejectionActionMsg("Read-only mirror mode: cannot enqueue rejected webhook from this environment.");
      return;
    }
    const selectedIds = (liveSelectedPipelineIds || []).map((v) => String(v || "").trim()).filter(Boolean);
    const runAll = selectedIds.length > 1;
    const preferredPipelineId = selectedIds[0] || String(item?.pipeline_ids?.[0] || "").trim();
    const pipelineLabel = runAll
      ? selectedIds.map((id) => pipelineNameById[id] || id).join(", ")
      : (pipelineNameById[preferredPipelineId] || preferredPipelineId || "(auto)");
    const ok = window.confirm(
      `Move rejected webhook ${rejectionId.slice(0, 8)} to run queue using: ${pipelineLabel}?`,
    );
    if (!ok) return;

    setRequeueingRejectedId(rejectionId);
    setRejectionActionMsg("");
    try {
      const res = await fetch(`/api/pipelines/live-webhook/rejections/${encodeURIComponent(rejectionId)}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pipeline_id: runAll ? "" : (preferredPipelineId || ""),
          run_all: runAll,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      }
      const runCount = Array.isArray(body?.run_ids) ? body.run_ids.length : 0;
      const nowIso = new Date().toISOString();
      const rid = rejectionId;
      await mutateRejected((current) => {
        const obj = (current && typeof current === "object") ? current : {};
        const prevItems = Array.isArray((obj as any).items) ? (obj as any).items as RejectedWebhookItem[] : [];
        const nextItems = prevItems.filter((r) => String((r as any)?.id || "") !== rid);
        const prevTotal = Number((obj as any).total_count ?? (obj as any).count ?? prevItems.length ?? 0) || 0;
        const nextTotal = Math.max(0, prevTotal - (prevItems.length !== nextItems.length ? 1 : 0));
        return {
          ...(obj as any),
          items: nextItems,
          count: nextTotal,
          total_count: nextTotal,
          returned_count: nextItems.length,
        } as any;
      }, { revalidate: false });
      setDismissedRejectedIds((prev) => ({ ...prev, [rid]: true }));
      await mutateRuns((current: PipelineRunRecord[]) => {
        const prevRows = Array.isArray(current) ? current : [];
        const existing = new Set(prevRows.map((r) => String(r.id || "")));
        const pipelineRows = Array.isArray(body?.pipelines) ? body.pipelines : [];
        const out: PipelineRunRecord[] = [...prevRows];
        for (const p of pipelineRows) {
          const newRunId = String((p && p.run_id) || "").trim();
          if (!newRunId || existing.has(newRunId)) continue;
          existing.add(newRunId);
          out.unshift({
            id: newRunId,
            pipeline_id: String((p && p.pipeline_id) || preferredPipelineId || ""),
            pipeline_name: String((p && p.pipeline_name) || pipelineNameById[String((p && p.pipeline_id) || "")] || ""),
            sales_agent: String(item.sales_agent || ""),
            customer: String(item.customer || ""),
            call_id: String(item.call_id || ""),
            crm_url: String(item.crm_url || ""),
            started_at: nowIso,
            finished_at: null,
            status: "queued",
            canvas_json: "",
            steps_json: "[]",
            log_json: JSON.stringify(
              [{ ts: nowIso, text: "Queued from rejected webhook replay.", level: "pipeline" }],
            ),
            run_origin: "webhook",
          });
        }
        return out;
      }, { revalidate: false });
      setRejectedDetailsById((prev) => {
        const next = { ...prev };
        delete next[rid];
        return next;
      });
      setExpandedRejectedId((prev) => (prev === rid ? "" : prev));
      setRejectionActionErr(false);
      setRejectionActionMsg(`Moved to run queue (${runCount} run${runCount === 1 ? "" : "s"}).`);
      void Promise.allSettled([mutateRejected(), mutateRuns()]);
    } catch (e: any) {
      setRejectionActionErr(true);
      setRejectionActionMsg(String(e?.message || "Failed moving rejected webhook to run queue."));
    } finally {
      setRequeueingRejectedId("");
    }
  };

  const toggleRejectedExpanded = async (item: RejectedWebhookItem) => {
    const rid = String(item.id || "").trim();
    if (!rid) return;
    if (expandedRejectedId === rid) {
      setExpandedRejectedId("");
      return;
    }
    setExpandedRejectedId(rid);
    if (rejectedDetailsById[rid]) return;
    setLoadingRejectedDetailId(rid);
    try {
      const res = await fetch(`/api/pipelines/live-webhook/rejections/${encodeURIComponent(rid)}?include_payload=1`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String((body as any)?.detail || (body as any)?.error || `HTTP ${res.status}`));
      }
      const full = ((body as any)?.item && typeof (body as any).item === "object")
        ? ((body as any).item as RejectedWebhookItem)
        : item;
      setRejectedDetailsById((prev) => ({ ...prev, [rid]: full }));
    } catch (e: any) {
      setRejectionActionErr(true);
      setRejectionActionMsg(String(e?.message || "Failed loading rejected webhook payload."));
    } finally {
      setLoadingRejectedDetailId((prev) => (prev === rid ? "" : prev));
    }
  };

  const moveFailedRunToRetry = async (run: PipelineRunRecord) => {
    const sourceRunId = String(run?.id || "").trim();
    if (!sourceRunId) return;
    if (liveReadOnly) {
      setFailedRunActionErr(true);
      setFailedRunActionMsg("Read-only mirror mode: cannot move failed run to retry from this environment.");
      return;
    }
    if (normalizeRunOrigin(run.run_origin) !== "webhook") {
      setFailedRunActionErr(true);
      setFailedRunActionMsg("Only production/webhook failed runs can be moved to retry.");
      return;
    }
    const ok = window.confirm(
      `Move failed run ${sourceRunId.slice(0, 8)} to run queue for pipeline "${run.pipeline_name}"?`,
    );
    if (!ok) return;

    setRetryingFailedRunId(sourceRunId);
    setFailedRunActionMsg("");
    try {
      const res = await fetch(`/api/pipelines/live-webhook/runs/${encodeURIComponent(sourceRunId)}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pipeline_id: String(run.pipeline_id || "").trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      }
      const retryRunId = String(body?.run_id || sourceRunId).trim();
      setFailedRunActionErr(false);
      setFailedRunActionMsg(
        retryRunId
          ? `Moved to queue as run ${retryRunId.slice(0, 8)}.`
          : "Moved failed run to queue.",
      );
      // Optimistically move the card out of the failed section immediately.
      mutateRuns((current: PipelineRunRecord[]) => {
        if (!Array.isArray(current)) return current;
        return current.map((r) =>
          String(r.id || "") === sourceRunId
            ? { ...r, status: "queued", finished_at: undefined }
            : r,
        );
      });
    } catch (e: any) {
      setFailedRunActionErr(true);
      setFailedRunActionMsg(String(e?.message || "Failed moving run to retry."));
    } finally {
      setRetryingFailedRunId("");
    }
  };

  const cancelLiveRun = async (run: PipelineRunRecord) => {
    const runId = String(run?.id || "").trim();
    if (!runId) return;
    if (liveReadOnly) {
      setRunControlActionErr(true);
      setRunControlActionMsg("Read-only mirror mode: cannot cancel runs from this environment.");
      return;
    }
    if (normalizeRunOrigin(run.run_origin) !== "webhook") {
      setRunControlActionErr(true);
      setRunControlActionMsg("Only production/webhook runs can be cancelled from Jobs.");
      return;
    }
    const ok = window.confirm(`Cancel run ${runId.slice(0, 8)}?`);
    if (!ok) return;

    setCancellingRunId(runId);
    setRunControlActionMsg("");
    try {
      const res = await fetch(`/api/pipelines/live-webhook/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "Cancelled by user from Jobs page.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      }
      setRunControlActionErr(false);
      setRunControlActionMsg(`Cancelled run ${runId.slice(0, 8)}.`);
      await mutateRuns();
    } catch (e: any) {
      setRunControlActionErr(true);
      setRunControlActionMsg(String(e?.message || "Failed cancelling run."));
    } finally {
      setCancellingRunId("");
    }
  };

  const filteredRuns = useMemo(() => {
    const fromTs = filterDateFrom ? new Date(`${filterDateFrom}T00:00:00`).getTime() : null;
    const toTs = filterDateTo ? new Date(`${filterDateTo}T23:59:59`).getTime() : null;
    return runs.filter((run) => {
      if (filterStatus) {
        const rs = String(getRunStatus(run) || "").toLowerCase();
        const fs = filterStatus.toLowerCase();
        if (fs === "success" && !["done", "completed", "success", "ok", "finished", "cached"].includes(rs)) return false;
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
  }, [runs, filterStatus, filterRunType, filterPipelineId, filterAgent, filterCustomer, filterDateFrom, filterDateTo, getRunStatus]);

  const queuedRuns = useMemo(
    () => filteredRuns.filter((r) => isQueuedRun(getRunStatus(r))),
    [filteredRuns, getRunStatus],
  );
  const runningRuns = useMemo(
    () => filteredRuns.filter((r) => !isCompletedRun(getRunStatus(r)) && !isQueuedRun(getRunStatus(r))),
    [filteredRuns, getRunStatus],
  );
  const completedRuns = useMemo(
    () => filteredRuns.filter((r) => isCompletedRun(getRunStatus(r))),
    [filteredRuns, getRunStatus],
  );
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
      const failedRuns = sorted.filter((r) => isFailedCompletedRun(getRunStatus(r)));
      const successRuns = sorted.filter((r) => isSuccessCompletedRun(getRunStatus(r)));
      return {
        dayId,
        label: dayId === "unknown" ? "Unknown date" : new Date(`${dayId}T00:00:00`).toLocaleDateString(),
        runs: sorted,
        failedRuns,
        successRuns,
      };
    });
    groups.sort((a, b) => (a.dayId < b.dayId ? 1 : a.dayId > b.dayId ? -1 : 0));
    return groups;
  }, [completedRuns, getRunStatus]);

  const completedFailedByDay = useMemo(
    () =>
      completedRunsByDay
        .map((group) => ({
          dayId: group.dayId,
          label: group.label,
          runs: group.failedRuns,
          productionRuns: group.failedRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "webhook"),
          testRuns: group.failedRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "local"),
        }))
        .filter((group) => group.runs.length > 0),
    [completedRunsByDay],
  );
  const completedSuccessByDay = useMemo(
    () =>
      completedRunsByDay
        .map((group) => ({
          dayId: group.dayId,
          label: group.label,
          runs: group.successRuns,
          productionRuns: group.successRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "webhook"),
          testRuns: group.successRuns.filter((r) => normalizeRunOrigin(r.run_origin) === "local"),
        }))
        .filter((group) => group.runs.length > 0),
    [completedRunsByDay],
  );
  const completedFailedCount = useMemo(
    () => completedFailedByDay.reduce((n, group) => n + group.runs.length, 0),
    [completedFailedByDay],
  );
  const completedSuccessCount = useMemo(
    () => completedSuccessByDay.reduce((n, group) => n + group.runs.length, 0),
    [completedSuccessByDay],
  );

  useEffect(() => {
    setCollapsedCompletedFailedDayIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const group of completedRunsByDay) {
        if (next[group.dayId] == null) {
          next[group.dayId] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setCollapsedCompletedSuccessDayIds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const group of completedRunsByDay) {
        if (next[group.dayId] == null) {
          next[group.dayId] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [completedRunsByDay]);

  const openRunInCanvas = (run: PipelineRunRecord) => {
    const runCallId = inferRunCallId(run);
    const runPipelineId = String(run.pipeline_id || "").trim();
    const runPipelineNameRaw = String(run.pipeline_name || "").trim();
    const resolvedById = runPipelineId ? pipelineList.find((p) => String(p.id || "").trim() === runPipelineId) : null;
    const resolvedByName = !resolvedById && runPipelineNameRaw
      ? pipelineList.find((p) => String(p.name || "").trim() === runPipelineNameRaw)
      : null;
    const resolvedPipelineId = resolvedById?.id || resolvedByName?.id || runPipelineId || "";
    const resolvedPipelineName = resolvedById?.name || resolvedByName?.name || runPipelineNameRaw || resolvedPipelineId;
    setCustomer(run.customer || "", run.sales_agent || "");
    setCallId(runCallId);
    setActivePipeline(resolvedPipelineId, resolvedPipelineName || "");
    const payload = {
      source: "live_page",
      run_id: run.id,
      pipeline_id: resolvedPipelineId,
      pipeline_name: resolvedPipelineName,
      sales_agent: run.sales_agent,
      customer: run.customer,
      call_id: runCallId,
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

  const renderRunCard = (run: PipelineRunRecord) => {
    const runStatus = getRunStatus(run);
    const runCallId = inferRunCallId(run);
    const notePush = inferNotePushState(run);
    const selectable = !!String(run.id || "").trim();
    return (
    <button
      key={run.id}
      onClick={() => { if (selectable) openRunInCanvas(run); }}
      disabled={!selectable}
      className={cn(
        "w-full text-left rounded-xl border border-gray-700/70 bg-gray-900 transition-colors px-3 py-2.5",
        selectable
          ? "hover:bg-gray-800 hover:border-indigo-600/60"
          : "opacity-70 cursor-not-allowed",
      )}
      title={selectable ? "Open this run in Pipeline canvas" : "Run id missing"}
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
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-semibold", statusTone(runStatus))}>
          {statusLabel(runStatus)}
        </span>
        {isCompletedRun(runStatus) && notePush.sent && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded border font-semibold text-cyan-200 border-cyan-700/60 bg-cyan-950/40"
            title={notePush.sentAt ? `CRM note sent at ${notePush.sentAt}` : "CRM note sent"}
          >
            NOTE SENT
          </span>
        )}
        <span className="text-xs text-gray-100 font-semibold truncate">{run.pipeline_name}</span>
      </div>
      <div className="mt-1.5 text-[11px] text-gray-400 flex flex-wrap gap-x-3 gap-y-1">
        <span>{run.sales_agent || "—"} · {run.customer || "—"}</span>
        <span>call {runCallId || "—"}</span>
        <span>{relativeTime(run.started_at, nowMs)}</span>
        <span>{durationStr(run.started_at, run.finished_at, nowMs)}</span>
      </div>
      {(() => {
        const phases = inferPhaseBadges(run, runStatus);
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
  };

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
        {runsError && (
          <div className="mt-2 text-[11px] text-red-300 border border-red-800/60 bg-red-950/40 rounded px-2 py-1">
            Live run history fetch failed: {String((runsError as any)?.message || "unknown error")}.
            {runs.length > 0 ? " Showing last known data." : ""}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center gap-2 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            Loading live runs…
          </div>
        ) : (
          <div
            className="h-full grid grid-cols-1 gap-0 2xl:grid-cols-[300px_340px_1fr_1fr_1fr_1fr]"
          >
            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <Workflow className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-semibold text-gray-100">Live Pipelines</p>
                <span className="text-xs text-gray-500">{pipelineList.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
                {pipelineList.map((p) => {
                  const checked = liveSelectedPipelineIds.includes(String(p.id || ""));
                  const sendNoteChecked = sendNotePipelineIds.includes(String(p.id || ""));
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "w-full flex items-center gap-2 text-xs rounded-lg border px-2 py-2 transition-colors",
                        checked
                          ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-200"
                          : "border-gray-800 bg-gray-900 text-gray-300 hover:bg-gray-800",
                      )}
                    >
                      <label className="min-w-0 flex-1 flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={liveSaving || liveReadOnly}
                          onChange={() => { void toggleLivePipelineChecked(String(p.id || "")); }}
                          className="accent-emerald-500"
                        />
                        <span className="truncate">{p.name}</span>
                      </label>
                      <label className="shrink-0 flex items-center gap-1 text-[10px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sendNoteChecked}
                          disabled={liveSaving || liveReadOnly}
                          onChange={() => { void toggleSendNotePipelineChecked(String(p.id || "")); }}
                          className="accent-cyan-500"
                        />
                        <span className={cn(sendNoteChecked ? "text-cyan-200" : "text-gray-400")}>Send note</span>
                      </label>
                    </div>
                  );
                })}
                {pipelineList.length === 0 && (
                  <p className="text-[11px] text-gray-500 italic">No pipelines found.</p>
                )}
                {liveMessage ? (
                  <p className={cn("pt-2 text-[11px]", liveMessageError ? "text-red-300" : "text-emerald-300")}>
                    {liveMessage}
                  </p>
                ) : null}
                {liveReadOnly ? (
                  <p className="pt-1 text-[11px] text-amber-300">
                    Read-only mirror from {String(liveCfg?.mirror_source || "production")}. Live toggles are locked in this environment.
                  </p>
                ) : null}

                <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-amber-200">Unique Pair Filter</span>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded border font-semibold",
                        !!(liveCfg?.agent_continuity_filter_enabled ?? true)
                          ? "text-emerald-300 border-emerald-700/60 bg-emerald-950/30"
                          : "text-gray-300 border-gray-700/60 bg-gray-900/40",
                      )}
                    >
                      {!!(liveCfg?.agent_continuity_filter_enabled ?? true) ? "ON" : "OFF"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={liveSaving || liveReadOnly}
                      onClick={() => { void toggleContinuityFilter(); }}
                      className="text-[11px] px-2 py-1 rounded border border-amber-700/70 bg-amber-950/30 text-amber-200 hover:bg-amber-900/40 disabled:opacity-60"
                    >
                      Toggle Unique Filter
                    </button>
                  </div>
                  <details className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1">
                    <summary className="cursor-pointer text-[11px] text-gray-300">Filter Logic</summary>
                    <div className="mt-1 space-y-1 text-[10px] text-gray-400">
                      <p>1. Unique filter OFF: webhook passes.</p>
                      <p>2. Unique filter ON: webhook runs only when the pair has a single canonical agent.</p>
                      <p>3. If historical/pair data shows multiple canonical agents: rejected.</p>
                      <p>4. If webhook agent mismatches the unique canonical agent: rejected.</p>
                    </div>
                  </details>
                  <p className="text-[10px] text-gray-500">
                    Unique-filter rejections tracked: <span className="text-amber-300 font-semibold">{continuityRejectedCount}</span>
                  </p>
                </div>

              </div>
            </section>

            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <XCircle className="w-4 h-4 text-red-400" />
                <p className="text-sm font-semibold text-gray-100">Rejected</p>
                <span className="text-xs text-gray-500">{rejectedDisplayCount}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {rejectionActionMsg ? (
                  <p className={cn("text-[11px]", rejectionActionErr ? "text-red-300" : "text-emerald-300")}>
                    {rejectionActionMsg}
                  </p>
                ) : null}
                {activeRejectedItems.length === 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-xs text-gray-600 italic">No active rejected webhooks.</p>
                    {rejectedStatsTotal > 0 && (
                      <>
                        <p className="text-[11px] text-amber-300">
                          Historical rejected count tracked: {rejectedStatsTotal}
                        </p>
                        {Object.keys(rejectedByReason).length > 0 && (
                          <div className="rounded border border-amber-800/50 bg-amber-950/20 px-2 py-1.5 space-y-1">
                            {Object.entries(rejectedByReason)
                              .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
                              .map(([reason, count]) => (
                                <div key={`rej-reason-${reason}`} className="flex items-center justify-between text-[10px]">
                                  <span className="text-amber-200">{reason}</span>
                                  <span className="text-amber-300 font-semibold">{Number(count || 0)}</span>
                                </div>
                              ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  rejectedByDay.map((group) => {
                    const collapsed = !!collapsedRejectedDayIds[group.dayId];
                    return (
                      <div key={`rejected-day-${group.dayId}`} className="space-y-1.5">
                        <button
                          type="button"
                          onClick={() => setCollapsedRejectedDayIds((prev) => ({ ...prev, [group.dayId]: !prev[group.dayId] }))}
                          className="w-full flex items-center gap-2 px-2 py-1 rounded border border-red-800/50 bg-red-950/20 hover:bg-red-900/20 text-left"
                          title={collapsed ? "Expand date folder" : "Collapse date folder"}
                        >
                          <ChevronRight className={cn("w-3.5 h-3.5 text-red-300 transition-transform", !collapsed && "rotate-90")} />
                          <span className="text-[11px] text-red-200 font-semibold">{group.label}</span>
                          <span className="ml-auto text-[10px] text-red-300">{group.items.length}</span>
                        </button>
                        {!collapsed && (
                          <div className="space-y-2 pl-2">
                            {group.items.map((item) => {
                              const rid = String(item.id || "");
                              const expanded = expandedRejectedId === rid;
                              const status = String(item.status || "rejected").toLowerCase();
                              const source = String((item as { source?: string }).source || "active").toLowerCase();
                              const statusCls = status === "queued_manual"
                                ? "text-emerald-300 border-emerald-700/60 bg-emerald-950/30"
                                : "text-red-300 border-red-700/60 bg-red-950/30";
                              const sourceCls = source === "archive"
                                ? "text-violet-300 border-violet-700/60 bg-violet-950/30"
                                : "text-sky-300 border-sky-700/60 bg-sky-950/30";
                              return (
                                <div key={rid} className="rounded border border-gray-800 bg-gray-950/50 p-2">
                                  <div className="flex items-start gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => { void toggleRejectedExpanded(item); }}
                                      className="mt-0.5 text-gray-500 hover:text-gray-300"
                                      title={expanded ? "Hide payload" : "View payload"}
                                    >
                                      <ChevronRight className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")} />
                                    </button>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1 flex-wrap">
                                        <span className="font-mono text-[10px] text-gray-300 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5">
                                          {rid.slice(0, 8)}
                                        </span>
                                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-semibold", statusCls)}>
                                          {status}
                                        </span>
                                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-semibold", sourceCls)}>
                                          {source}
                                        </span>
                                        <span className="text-[10px] text-gray-500">{String(item.reason || "rejected")}</span>
                                      </div>
                                      <div className="text-[10px] text-gray-500 mt-1 truncate">
                                        {String(item.sales_agent || "—")} · {String(item.customer || "—")} · call {String(item.call_id || "—")}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={requeueingRejectedId === rid}
                                      onClick={() => { void moveRejectedToRun(item); }}
                                      className="text-[10px] px-2 py-1 rounded border border-emerald-700/70 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-60"
                                      title="Move this rejected webhook to run queue"
                                    >
                                      {requeueingRejectedId === rid ? "Moving..." : "Move To Run"}
                                    </button>
                                  </div>
                                  {expanded ? (
                                    loadingRejectedDetailId === rid ? (
                                      <div className="mt-2 text-[11px] text-gray-400 flex items-center gap-1.5">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        Loading payload…
                                      </div>
                                    ) : (
                                      <pre className="mt-2 text-[10px] text-gray-300 bg-black/30 border border-gray-800 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
{JSON.stringify(rejectedDetailsById[rid] || item, null, 2)}
                                      </pre>
                                    )
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
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
                {runControlActionMsg ? (
                  <p className={cn("text-[11px]", runControlActionErr ? "text-red-300" : "text-emerald-300")}>
                    {runControlActionMsg}
                  </p>
                ) : null}
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
                      runningProductionRuns.map((run) => {
                        const canCancel = normalizeRunOrigin(run.run_origin) === "webhook";
                        const busy = cancellingRunId === run.id;
                        return (
                          <div key={`running-${run.id}`} className="space-y-1">
                            {renderRunCard(run)}
                            <div className="flex justify-end">
                              <button
                                type="button"
                                disabled={!canCancel || busy || liveReadOnly}
                                onClick={() => { void cancelLiveRun(run); }}
                                className="text-[10px] px-2 py-1 rounded border border-red-700/70 bg-red-950/30 text-red-200 hover:bg-red-900/40 disabled:opacity-50"
                                title="Cancel this running run"
                              >
                                {busy ? "Cancelling..." : "Cancel"}
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div className="pt-2 text-[10px] font-semibold text-fuchsia-200 border border-fuchsia-800/50 bg-fuchsia-950/20 rounded px-2 py-1">
                      TEST · local ({runningTestRuns.length})
                    </div>
                    {runningTestRuns.length === 0 ? (
                      <p className="text-[11px] text-gray-500 italic px-1">No test runs.</p>
                    ) : (
                      runningTestRuns.map((run) => (
                        <div key={`running-test-${run.id}`} className="space-y-1">
                          {renderRunCard(run)}
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="min-h-0 border-r border-gray-800 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <XCircle className="w-4 h-4 text-red-400" />
                <p className="text-sm font-semibold text-gray-100">Failed</p>
                <span className="text-xs text-gray-500">{completedFailedCount}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {failedRunActionMsg ? (
                  <p className={cn("text-[11px]", failedRunActionErr ? "text-red-300" : "text-emerald-300")}>
                    {failedRunActionMsg}
                  </p>
                ) : null}
                {completedFailedCount === 0 ? (
                  <p className="text-xs text-gray-600 italic">No failed runs.</p>
                ) : (
                  completedFailedByDay.map((group) => {
                    const collapsed = !!collapsedCompletedFailedDayIds[group.dayId];
                    return (
                      <div key={`failed-${group.dayId}`} className="space-y-1.5">
                        <button
                          onClick={() =>
                            setCollapsedCompletedFailedDayIds((prev) => ({
                              ...prev,
                              [group.dayId]: !prev[group.dayId],
                            }))}
                          className="w-full flex items-center gap-2 px-2 py-1 rounded border border-red-800/50 bg-red-950/20 hover:bg-red-900/20 text-left"
                          title={collapsed ? "Expand date folder" : "Collapse date folder"}
                        >
                          <ChevronRight
                            className={cn("w-3.5 h-3.5 text-red-300 transition-transform", !collapsed && "rotate-90")}
                          />
                          <span className="text-[11px] text-red-200 font-semibold">{group.label}</span>
                          <span className="ml-auto text-[10px] text-red-300">{group.runs.length}</span>
                        </button>
                        {!collapsed && (
                          <div className="space-y-2 pl-2">
                            {group.productionRuns.length > 0 && (
                              <>
                                <div className="text-[10px] font-semibold text-blue-200 border border-blue-800/50 bg-blue-950/30 rounded px-2 py-1">
                                  PRODUCTION · webhook ({group.productionRuns.length})
                                </div>
                                {group.productionRuns.map((run) => {
                                  const runKey = String(run.id || "").trim() || `${group.dayId}-${run.pipeline_id}-${run.call_id}-${run.started_at || ""}`;
                                  const busy = retryingFailedRunId === run.id;
                                  return (
                                    <div key={`failed-prod-${runKey}`} className="space-y-1">
                                      {renderRunCard(run)}
                                      <div className="flex justify-end">
                                        <button
                                          type="button"
                                          disabled={busy || liveReadOnly}
                                          onClick={() => { void moveFailedRunToRetry(run); }}
                                          className="text-[10px] px-2 py-1 rounded border border-amber-700/70 bg-amber-950/30 text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                                          title="Move failed run to run queue"
                                        >
                                          {busy ? "Moving..." : "Move To Queue"}
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </>
                            )}
                            {group.testRuns.length > 0 && (
                              <>
                                <div className="text-[10px] font-semibold text-fuchsia-200 border border-fuchsia-800/50 bg-fuchsia-950/20 rounded px-2 py-1">
                                  TEST · local ({group.testRuns.length})
                                </div>
                                {group.testRuns.map((run) => {
                                  const runKey = String(run.id || "").trim() || `${group.dayId}-${run.pipeline_id}-${run.call_id}-${run.started_at || ""}`;
                                  return (
                                    <div key={`failed-test-${runKey}`} className="space-y-1">
                                      {renderRunCard(run)}
                                    </div>
                                  );
                                })}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className="min-h-0 flex flex-col">
              <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/70 flex items-center gap-2 shrink-0">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <p className="text-sm font-semibold text-gray-100">Successful</p>
                <span className="text-xs text-gray-500">{completedSuccessCount}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                {completedSuccessCount === 0 ? (
                  <p className="text-xs text-gray-600 italic">No successful runs.</p>
                ) : (
                  completedSuccessByDay.map((group) => {
                    const collapsed = !!collapsedCompletedSuccessDayIds[group.dayId];
                    return (
                      <div key={`success-${group.dayId}`} className="space-y-1.5">
                        <button
                          onClick={() =>
                            setCollapsedCompletedSuccessDayIds((prev) => ({
                              ...prev,
                              [group.dayId]: !prev[group.dayId],
                            }))}
                          className="w-full flex items-center gap-2 px-2 py-1 rounded border border-emerald-800/50 bg-emerald-950/20 hover:bg-emerald-900/20 text-left"
                          title={collapsed ? "Expand date folder" : "Collapse date folder"}
                        >
                          <ChevronRight
                            className={cn("w-3.5 h-3.5 text-emerald-300 transition-transform", !collapsed && "rotate-90")}
                          />
                          <span className="text-[11px] text-emerald-200 font-semibold">{group.label}</span>
                          <span className="ml-auto text-[10px] text-emerald-300">{group.runs.length}</span>
                        </button>
                        {!collapsed && (
                          <div className="space-y-2 pl-2">
                            {group.productionRuns.length > 0 && (
                              <>
                                <div className="text-[10px] font-semibold text-blue-200 border border-blue-800/50 bg-blue-950/30 rounded px-2 py-1">
                                  PRODUCTION · webhook ({group.productionRuns.length})
                                </div>
                                {group.productionRuns.map(renderRunCard)}
                              </>
                            )}
                            {group.testRuns.length > 0 && (
                              <>
                                <div className="text-[10px] font-semibold text-fuchsia-200 border border-fuchsia-800/50 bg-fuchsia-950/20 rounded px-2 py-1">
                                  TEST · local ({group.testRuns.length})
                                </div>
                                {group.testRuns.map(renderRunCard)}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
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
