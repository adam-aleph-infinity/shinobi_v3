"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Cpu, RefreshCw, Trash2, Loader2, CheckCircle2,
  Settings, RotateCcw, Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUserProfile } from "@/lib/user-profile";

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

interface LiveWebhookConfig {
  enabled: boolean;
  ingest_only: boolean;
  trigger_pipeline: boolean;
  agent_continuity_filter_enabled: boolean;
  agent_continuity_pair_tag_fallback_enabled: boolean;
  agent_continuity_reject_multi_agent_pair_tags: boolean;
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
  rejected_webhooks_total?: number;
  rejected_by_reason?: Record<string, number>;
  rejected_updated_at?: string;
}

interface ManagedUser {
  email: string;
  name: string;
  role: string;
  enabled: boolean;
  environments: string[];
  permissions: {
    can_view: boolean;
    can_create_pipelines: boolean;
    can_edit_pipelines: boolean;
    can_run_pipelines: boolean;
    can_manage_jobs: boolean;
    can_manage_live_jobs: boolean;
    can_manage_users: boolean;
    can_sync_pipelines: boolean;
  };
}

interface ManagedUsersResponse {
  ok: boolean;
  users: ManagedUser[];
}

export default function SettingsPage() {
  const { profile: currentUser } = useUserProfile();
  const { data: config, mutate: mutateConfig } = useSWR<{ max_workers: number }>(
    `${API}/jobs/config`, fetcher, { refreshInterval: 0 }
  );
  const { data: sysStats } = useSWR<{ cpu_pct: number | null; mem_pct: number | null; active_workers: number | null }>(
    `${API}/jobs/stats`, fetcher, { refreshInterval: 3000 }
  );
  const { data: liveCfg, mutate: mutateLiveCfg } = useSWR<LiveWebhookConfig>(
    `${API}/pipelines/live-webhook/config`, fetcher, { refreshInterval: 0 }
  );
  const canManageUsers = !!currentUser?.permissions?.can_manage_users;
  const canSyncPipelines = !!currentUser?.permissions?.can_sync_pipelines;
  const { data: usersResp, mutate: mutateUsers } = useSWR<ManagedUsersResponse>(
    canManageUsers ? `${API}/users` : null,
    fetcher,
    { refreshInterval: 0 },
  );

  const [workerInput, setWorkerInput] = useState("");
  const [workerSaving, setWorkerSaving] = useState(false);
  const [workerSaved, setWorkerSaved] = useState(false);

  const [clearingHistory, setClearingHistory] = useState(false);
  const [clearResult, setClearResult] = useState<number | null>(null);

  const [clearingBuffer, setClearingBuffer] = useState(false);
  const [bufferCleared, setBufferCleared] = useState(false);
  const [settingMaxLiveRunning, setSettingMaxLiveRunning] = useState(5);
  const [settingAutoRetry, setSettingAutoRetry] = useState(true);
  const [settingRetryMaxAttempts, setSettingRetryMaxAttempts] = useState(2);
  const [settingRetryDelay, setSettingRetryDelay] = useState(45);
  const [settingRetryOnServerError, setSettingRetryOnServerError] = useState(true);
  const [settingRetryOnRateLimit, setSettingRetryOnRateLimit] = useState(true);
  const [settingRetryOnTimeout, setSettingRetryOnTimeout] = useState(true);
  const [settingBackfillEnabled, setSettingBackfillEnabled] = useState(true);
  const [settingBackfillTimeout, setSettingBackfillTimeout] = useState(5400);
  const [settingSaving, setSettingSaving] = useState(false);
  const [settingSaved, setSettingSaved] = useState(false);
  const [settingError, setSettingError] = useState("");
  const [userDrafts, setUserDrafts] = useState<Record<string, ManagedUser>>({});
  const [savingUserEmail, setSavingUserEmail] = useState("");
  const [deletingUserEmail, setDeletingUserEmail] = useState("");
  const [userMsg, setUserMsg] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserRole, setNewUserRole] = useState("viewer");
  const [creatingUser, setCreatingUser] = useState(false);
  const [syncOwnerEmail, setSyncOwnerEmail] = useState("");
  const [syncingPipelines, setSyncingPipelines] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  const maxWorkers = config?.max_workers ?? 10;
  const displayWorkers = workerInput !== "" ? parseInt(workerInput) || maxWorkers : maxWorkers;

  useEffect(() => {
    if (!liveCfg) return;
    setSettingMaxLiveRunning(Number(liveCfg.max_live_running || 5));
    setSettingAutoRetry(Boolean(liveCfg.auto_retry_enabled ?? true));
    setSettingRetryMaxAttempts(Number(liveCfg.retry_max_attempts || 2));
    setSettingRetryDelay(Number(liveCfg.retry_delay_s || 45));
    setSettingRetryOnServerError(Boolean(liveCfg.retry_on_server_error ?? true));
    setSettingRetryOnRateLimit(Boolean(liveCfg.retry_on_rate_limit ?? true));
    setSettingRetryOnTimeout(Boolean(liveCfg.retry_on_timeout ?? true));
    setSettingBackfillEnabled(Boolean(liveCfg.backfill_historical_transcripts ?? true));
    setSettingBackfillTimeout(Number(liveCfg.backfill_timeout_s || 5400));
  }, [
    liveCfg?.max_live_running,
    liveCfg?.auto_retry_enabled,
    liveCfg?.retry_max_attempts,
    liveCfg?.retry_delay_s,
    liveCfg?.retry_on_server_error,
    liveCfg?.retry_on_rate_limit,
    liveCfg?.retry_on_timeout,
    liveCfg?.backfill_historical_transcripts,
    liveCfg?.backfill_timeout_s,
  ]);

  useEffect(() => {
    const users = Array.isArray(usersResp?.users) ? usersResp?.users : [];
    if (!users.length) return;
    const next: Record<string, ManagedUser> = {};
    for (const user of users) {
      if (!user?.email) continue;
      next[user.email] = JSON.parse(JSON.stringify(user));
    }
    setUserDrafts(next);
  }, [usersResp?.users]);

  function updateUserDraft(email: string, patch: Partial<ManagedUser>) {
    setUserDrafts((prev) => {
      const base = prev[email];
      if (!base) return prev;
      return { ...prev, [email]: { ...base, ...patch } };
    });
  }

  function updateUserPerm(
    email: string,
    key: keyof ManagedUser["permissions"],
    value: boolean,
  ) {
    setUserDrafts((prev) => {
      const base = prev[email];
      if (!base) return prev;
      return {
        ...prev,
        [email]: {
          ...base,
          permissions: {
            ...base.permissions,
            [key]: value,
          },
        },
      };
    });
  }

  async function saveUser(email: string) {
    const draft = userDrafts[email];
    if (!draft) return;
    setSavingUserEmail(email);
    setUserMsg("");
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(draft.name || "").trim(),
          role: String(draft.role || "viewer"),
          enabled: !!draft.enabled,
          environments: Array.isArray(draft.environments) ? draft.environments : ["dev", "prod"],
          permissions: {
            create_pipelines: !!draft.permissions?.can_create_pipelines,
            edit_pipelines: !!draft.permissions?.can_edit_pipelines,
            run_pipelines: !!draft.permissions?.can_run_pipelines,
            manage_jobs: !!draft.permissions?.can_manage_jobs,
            manage_live: !!draft.permissions?.can_manage_live_jobs,
            manage_users: !!draft.permissions?.can_manage_users,
            sync_pipelines: !!draft.permissions?.can_sync_pipelines,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateUsers();
      setUserMsg(`Saved ${email}`);
    } catch (e: any) {
      setUserMsg(String(e?.message || "Failed to save user."));
    } finally {
      setSavingUserEmail("");
    }
  }

  async function createUser() {
    const email = String(newUserEmail || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setUserMsg("Valid email is required.");
      return;
    }
    setCreatingUser(true);
    setUserMsg("");
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(newUserName || "").trim(),
          role: String(newUserRole || "viewer"),
          enabled: true,
          environments: ["dev"],
          permissions: {},
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateUsers();
      setNewUserEmail("");
      setNewUserName("");
      setNewUserRole("viewer");
      setUserMsg(`Added ${email}`);
    } catch (e: any) {
      setUserMsg(String(e?.message || "Failed to add user."));
    } finally {
      setCreatingUser(false);
    }
  }

  async function deleteUser(email: string) {
    if (!email) return;
    if (!window.confirm(`Delete user ${email}?`)) return;
    setDeletingUserEmail(email);
    setUserMsg("");
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateUsers();
      setUserMsg(`Deleted ${email}`);
    } catch (e: any) {
      setUserMsg(String(e?.message || "Failed to delete user."));
    } finally {
      setDeletingUserEmail("");
    }
  }

  async function syncDevPipelinesToProd() {
    setSyncingPipelines(true);
    setSyncMsg("");
    try {
      const res = await fetch(`${API}/users/sync/dev-pipelines`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_email: String(syncOwnerEmail || "").trim().toLowerCase(),
          overwrite_existing: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      setSyncMsg(
        `Synced ${Number(data?.synced || 0)} pipeline(s)` +
          (Number(data?.skipped_existing || 0) ? `, skipped ${Number(data?.skipped_existing || 0)}` : ""),
      );
    } catch (e: any) {
      setSyncMsg(String(e?.message || "Failed syncing pipelines from dev."));
    } finally {
      setSyncingPipelines(false);
    }
  }

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

  async function saveLiveExecutionSettings() {
    if (!liveCfg) return;
    setSettingSaving(true);
    setSettingSaved(false);
    setSettingError("");
    try {
      const runPayload = (liveCfg.run_payload && typeof liveCfg.run_payload === "object")
        ? liveCfg.run_payload
        : { resume_partial: true };
      const res = await fetch(`${API}/pipelines/live-webhook/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: Boolean(liveCfg.enabled),
          ingest_only: Boolean(liveCfg.ingest_only),
          trigger_pipeline: Boolean(liveCfg.trigger_pipeline),
          agent_continuity_filter_enabled: Boolean(liveCfg.agent_continuity_filter_enabled ?? true),
          agent_continuity_pair_tag_fallback_enabled: Boolean(
            liveCfg.agent_continuity_pair_tag_fallback_enabled ?? true,
          ),
          agent_continuity_reject_multi_agent_pair_tags: Boolean(
            liveCfg.agent_continuity_reject_multi_agent_pair_tags ?? true,
          ),
          live_pipeline_ids: Array.isArray(liveCfg.live_pipeline_ids) ? liveCfg.live_pipeline_ids : [],
          default_pipeline_id: String(liveCfg.default_pipeline_id || ""),
          pipeline_by_agent: (liveCfg.pipeline_by_agent && typeof liveCfg.pipeline_by_agent === "object")
            ? liveCfg.pipeline_by_agent
            : {},
          run_payload: runPayload,
          transcription_model: String(liveCfg.transcription_model || "gpt-5.4"),
          transcription_timeout_s: Number(liveCfg.transcription_timeout_s || 900),
          transcription_poll_interval_s: Number(liveCfg.transcription_poll_interval_s || 2),
          max_live_running: Math.max(1, Math.min(64, Number(settingMaxLiveRunning || 5))),
          auto_retry_enabled: !!settingAutoRetry,
          retry_max_attempts: Math.max(0, Math.min(10, Number(settingRetryMaxAttempts || 2))),
          retry_delay_s: Math.max(5, Math.min(3600, Number(settingRetryDelay || 45))),
          backfill_historical_transcripts: !!settingBackfillEnabled,
          backfill_timeout_s: Math.max(120, Math.min(21600, Number(settingBackfillTimeout || 5400))),
          retry_on_server_error: !!settingRetryOnServerError,
          retry_on_rate_limit: !!settingRetryOnRateLimit,
          retry_on_timeout: !!settingRetryOnTimeout,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateLiveCfg();
      setSettingSaved(true);
      setTimeout(() => setSettingSaved(false), 2000);
    } catch (e: any) {
      setSettingError(String(e?.message || "Failed to save live execution settings."));
    } finally {
      setSettingSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="w-5 h-5 text-indigo-400" />
        <h1 className="text-lg font-semibold text-white">Settings</h1>
      </div>

      <Section title="Current User">
        <Row
          label="Signed in user"
          sub="Resolved from request headers and user profile policy."
        >
          <div className="text-right">
            <p className="text-sm text-white font-medium">
              {String(currentUser?.name || currentUser?.email || "Unknown user")}
            </p>
            <p className="text-[11px] text-gray-500">
              {String(currentUser?.email || "No email detected")}
            </p>
          </div>
        </Row>
        <Row
          label="Role / environment"
          sub="This controls what can be changed in production and development."
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide",
                currentUser?.role === "admin"
                  ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300"
                  : currentUser?.role === "editor"
                  ? "border-indigo-700/60 bg-indigo-950/40 text-indigo-300"
                  : "border-gray-700/60 bg-gray-900/70 text-gray-300",
              )}
            >
              {String(currentUser?.role || "viewer")}
            </span>
            <span className="inline-flex rounded border border-gray-700/60 bg-gray-900/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">
              {String(currentUser?.environment || "unknown")}
            </span>
          </div>
        </Row>
        <Row
          label="User management"
          sub="Enable admin role + permission to edit users in production settings."
        >
          <span
            className={cn(
              "inline-flex rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide",
              canManageUsers
                ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-300"
                : "border-amber-700/60 bg-amber-950/40 text-amber-300",
            )}
          >
            {canManageUsers ? "Allowed" : "Read only"}
          </span>
        </Row>
      </Section>

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

      {/* Live execution */}
      <Section title="Live Execution">
        <Row
          label="Max live running"
          sub="Maximum number of webhook-triggered pipelines running at once. Additional runs stay queued."
        >
          <input
            type="number"
            min={1}
            max={64}
            value={settingMaxLiveRunning}
            onChange={(e) => setSettingMaxLiveRunning(Number(e.target.value || 5))}
            className="w-20 h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
          />
        </Row>
        <Row
          label="Auto retry"
          sub="Automatically retry technical failures using the conditions and limits below."
        >
          <input
            type="checkbox"
            checked={settingAutoRetry}
            onChange={(e) => setSettingAutoRetry(e.target.checked)}
            className="accent-indigo-500"
          />
        </Row>
        <Row label="Retry attempts" sub="Maximum retry attempts per failed live pipeline run.">
          <input
            type="number"
            min={0}
            max={10}
            value={settingRetryMaxAttempts}
            onChange={(e) => setSettingRetryMaxAttempts(Number(e.target.value || 2))}
            className="w-20 h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
          />
        </Row>
        <Row label="Retry delay (seconds)" sub="Delay before retrying a retryable failure.">
          <input
            type="number"
            min={5}
            max={3600}
            value={settingRetryDelay}
            onChange={(e) => setSettingRetryDelay(Number(e.target.value || 45))}
            className="w-20 h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
          />
        </Row>
        <Row label="Retry on server errors" sub="Retry on upstream/provider 5xx failures.">
          <input
            type="checkbox"
            checked={settingRetryOnServerError}
            onChange={(e) => setSettingRetryOnServerError(e.target.checked)}
            className="accent-indigo-500"
          />
        </Row>
        <Row label="Retry on rate limits" sub="Retry on 429/quota/tokens-per-minute style failures.">
          <input
            type="checkbox"
            checked={settingRetryOnRateLimit}
            onChange={(e) => setSettingRetryOnRateLimit(e.target.checked)}
            className="accent-indigo-500"
          />
        </Row>
        <Row label="Retry on timeout/network" sub="Retry on timeout and transient network errors.">
          <input
            type="checkbox"
            checked={settingRetryOnTimeout}
            onChange={(e) => setSettingRetryOnTimeout(e.target.checked)}
            className="accent-indigo-500"
          />
        </Row>
        <Row
          label="Agent continuity filter"
          sub="Only allows webhook jobs when the customer's first and latest CRM calls are under the same sales agent."
        >
          <div className="text-xs">
            <span
              className={cn(
                "inline-flex rounded border px-2 py-0.5",
                liveCfg?.agent_continuity_filter_enabled
                  ? "text-emerald-300 border-emerald-800/60 bg-emerald-950/30"
                  : "text-amber-300 border-amber-800/60 bg-amber-950/30",
              )}
            >
              {liveCfg?.agent_continuity_filter_enabled ? "ON" : "OFF"}
            </span>
            <span className="ml-2 text-gray-500">
              rejected: {Number(liveCfg?.rejected_webhooks_total || 0)}
            </span>
          </div>
        </Row>
        <Row
          label="Backfill historical transcripts"
          sub="Before a live run starts, transcribe all missing historical calls for that pair (skips existing transcripts)."
        >
          <input
            type="checkbox"
            checked={settingBackfillEnabled}
            onChange={(e) => setSettingBackfillEnabled(e.target.checked)}
            className="accent-indigo-500"
          />
        </Row>
        <Row label="Backfill timeout (seconds)" sub="Max wait for backfill transcription jobs before marking preflight failed.">
          <input
            type="number"
            min={120}
            max={21600}
            value={settingBackfillTimeout}
            onChange={(e) => setSettingBackfillTimeout(Number(e.target.value || 5400))}
            className="w-24 h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
          />
        </Row>
        <div className="flex items-center justify-between pt-3">
          <div className="text-xs">
            {settingError ? (
              <span className="text-red-400">{settingError}</span>
            ) : settingSaved ? (
              <span className="text-emerald-400">Live execution settings saved</span>
            ) : (
              <span className="text-gray-600">Applies to webhook-triggered live pipeline execution.</span>
            )}
          </div>
          <button
            onClick={saveLiveExecutionSettings}
            disabled={settingSaving || !liveCfg}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors border",
              "bg-indigo-900/40 hover:bg-indigo-900/60 border-indigo-800/50 text-indigo-200",
              (settingSaving || !liveCfg) && "opacity-50 cursor-not-allowed",
            )}
          >
            {settingSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Save live settings
          </button>
        </div>
      </Section>

      {canManageUsers && currentUser?.environment === "prod" && (
        <Section title="User Profile Management">
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2 px-2 text-[10px] uppercase tracking-widest text-gray-600">
              <div className="col-span-3">User</div>
              <div className="col-span-2">Role</div>
              <div className="col-span-2">Environment</div>
              <div className="col-span-4">Abilities</div>
              <div className="col-span-1 text-right">Actions</div>
            </div>
            {(usersResp?.users || []).map((user) => {
              const draft = userDrafts[user.email] || user;
              const busy = savingUserEmail === user.email;
              const deleting = deletingUserEmail === user.email;
              const envs = Array.isArray(draft.environments) ? draft.environments : ["dev", "prod"];
              return (
                <div key={user.email} className="grid grid-cols-12 gap-2 items-center rounded-lg border border-gray-800 bg-gray-950/40 p-2">
                  <div className="col-span-3 min-w-0">
                    <input
                      value={draft.name || ""}
                      onChange={(e) => updateUserDraft(user.email, { name: e.target.value })}
                      className="w-full h-7 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
                    />
                    <p className="mt-1 text-[10px] text-gray-500 truncate">{user.email}</p>
                  </div>
                  <div className="col-span-2">
                    <select
                      value={draft.role || "viewer"}
                      onChange={(e) => updateUserDraft(user.email, { role: e.target.value })}
                      className="w-full h-7 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                      <option value="admin">admin</option>
                    </select>
                    <label className="mt-1 flex items-center gap-1 text-[10px] text-gray-500">
                      <input
                        type="checkbox"
                        checked={!!draft.enabled}
                        onChange={(e) => updateUserDraft(user.email, { enabled: e.target.checked })}
                        className="accent-indigo-500"
                      />
                      enabled
                    </label>
                  </div>
                  <div className="col-span-2">
                    <label className="flex items-center gap-1 text-[10px] text-gray-400">
                      <input
                        type="checkbox"
                        checked={envs.includes("dev")}
                        onChange={(e) => {
                          const next = new Set(envs);
                          if (e.target.checked) next.add("dev");
                          else next.delete("dev");
                          updateUserDraft(user.email, { environments: Array.from(next) });
                        }}
                        className="accent-indigo-500"
                      />
                      dev
                    </label>
                    <label className="mt-1 flex items-center gap-1 text-[10px] text-gray-400">
                      <input
                        type="checkbox"
                        checked={envs.includes("prod")}
                        onChange={(e) => {
                          const next = new Set(envs);
                          if (e.target.checked) next.add("prod");
                          else next.delete("prod");
                          updateUserDraft(user.email, { environments: Array.from(next) });
                        }}
                        className="accent-indigo-500"
                      />
                      prod
                    </label>
                  </div>
                  <div className="col-span-4 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-gray-400">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!draft.permissions?.can_create_pipelines}
                        onChange={(e) => updateUserPerm(user.email, "can_create_pipelines", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      create pipelines
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!draft.permissions?.can_edit_pipelines}
                        onChange={(e) => updateUserPerm(user.email, "can_edit_pipelines", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      edit pipelines
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!draft.permissions?.can_run_pipelines}
                        onChange={(e) => updateUserPerm(user.email, "can_run_pipelines", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      run pipelines
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!draft.permissions?.can_manage_jobs}
                        onChange={(e) => updateUserPerm(user.email, "can_manage_jobs", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      manage jobs
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!draft.permissions?.can_manage_live_jobs}
                        onChange={(e) => updateUserPerm(user.email, "can_manage_live_jobs", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      manage live
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={!!draft.permissions?.can_sync_pipelines}
                        onChange={(e) => updateUserPerm(user.email, "can_sync_pipelines", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      sync pipelines
                    </label>
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <div className="flex items-center gap-1">
                      <a
                        href={`/user?email=${encodeURIComponent(user.email)}`}
                        className="h-7 px-2 inline-flex items-center rounded border border-gray-700 bg-gray-900/60 text-gray-300 text-[10px] hover:bg-gray-800"
                        title="View this user's work"
                      >
                        Work
                      </a>
                      <button
                        onClick={() => { void saveUser(user.email); }}
                        disabled={busy}
                        className="h-7 px-2 rounded border border-indigo-800/50 bg-indigo-900/30 text-indigo-200 text-[10px] hover:bg-indigo-900/50 disabled:opacity-50"
                      >
                        {busy ? "..." : "Save"}
                      </button>
                      <button
                        onClick={() => { void deleteUser(user.email); }}
                        disabled={deleting}
                        className="h-7 px-2 rounded border border-red-800/50 bg-red-900/30 text-red-200 text-[10px] hover:bg-red-900/50 disabled:opacity-50"
                        title="Delete user"
                      >
                        {deleting ? "..." : "Del"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 border-t border-gray-800 pt-3 grid grid-cols-12 gap-2 items-end">
            <div className="col-span-4">
              <label className="text-[10px] text-gray-500 uppercase tracking-widest">New User Email</label>
              <input
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                placeholder="user@shinobigrp.com"
                className="mt-1 w-full h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
              />
            </div>
            <div className="col-span-3">
              <label className="text-[10px] text-gray-500 uppercase tracking-widest">Name</label>
              <input
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="Display name"
                className="mt-1 w-full h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
              />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] text-gray-500 uppercase tracking-widest">Role</label>
              <select
                value={newUserRole}
                onChange={(e) => setNewUserRole(e.target.value)}
                className="mt-1 w-full h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
              >
                <option value="viewer">viewer</option>
                <option value="editor">editor</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div className="col-span-3 flex justify-end">
              <button
                onClick={() => { void createUser(); }}
                disabled={creatingUser}
                className="h-8 px-3 rounded border border-emerald-800/50 bg-emerald-900/30 text-emerald-200 text-xs hover:bg-emerald-900/50 disabled:opacity-50"
              >
                {creatingUser ? "Adding..." : "Add user"}
              </button>
            </div>
          </div>

          {canSyncPipelines && (
            <div className="mt-4 border-t border-gray-800 pt-3">
              <p className="text-xs text-white mb-2">Sync User Pipelines: Dev → Prod</p>
              <div className="flex items-center gap-2">
                <input
                  value={syncOwnerEmail}
                  onChange={(e) => setSyncOwnerEmail(e.target.value)}
                  placeholder="Optional owner email filter"
                  className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100 min-w-[250px]"
                />
                <button
                  onClick={() => { void syncDevPipelinesToProd(); }}
                  disabled={syncingPipelines}
                  className="h-8 px-3 rounded border border-indigo-800/50 bg-indigo-900/30 text-indigo-200 text-xs hover:bg-indigo-900/50 disabled:opacity-50"
                >
                  {syncingPipelines ? "Syncing..." : "Sync from Dev"}
                </button>
              </div>
            </div>
          )}

          <p className="mt-2 text-xs text-gray-500 min-h-[18px]">
            {userMsg || syncMsg || "Manage user workspaces and permissions from production settings."}
          </p>
        </Section>
      )}
    </div>
  );
}
