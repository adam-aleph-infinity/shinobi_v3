"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Loader2, Save, Trash2, User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUserProfile } from "@/lib/user-profile";

const API = "/api";

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
  }
  return data;
};

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

interface UserWorkResponse {
  ok: boolean;
  email: string;
  environment: string;
  pipeline_count: number;
  run_count: number;
  pipelines: Array<{
    id: string;
    name: string;
    folder?: string;
    updated_at?: string;
    created_at?: string;
    workspace_user_email?: string;
    workspace_user_name?: string;
  }>;
  runs: Array<{
    id: string;
    pipeline_id: string;
    pipeline_name: string;
    sales_agent: string;
    customer: string;
    call_id: string;
    status: string;
    started_at?: string | null;
    finished_at?: string | null;
  }>;
}

function fmtDate(v?: string | null): string {
  const raw = String(v || "").trim();
  if (!raw) return "—";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString();
}

export default function UserPage() {
  const params = useSearchParams();
  const requestedEmail = String(params.get("email") || "").trim().toLowerCase();
  const { profile: me, permissions } = useUserProfile();
  const canManageUsers = !!permissions.can_manage_users;

  const { data: usersResp, mutate: mutateUsers } = useSWR<ManagedUsersResponse>(
    canManageUsers ? `${API}/users` : null,
    fetcher,
    { refreshInterval: 0 },
  );

  const [userDrafts, setUserDrafts] = useState<Record<string, ManagedUser>>({});
  const [selectedEmail, setSelectedEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState("");
  const [msgErr, setMsgErr] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserRole, setNewUserRole] = useState("viewer");

  useEffect(() => {
    const users = Array.isArray(usersResp?.users) ? usersResp?.users : [];
    if (!users.length) return;
    const next: Record<string, ManagedUser> = {};
    for (const u of users) {
      if (!u?.email) continue;
      next[String(u.email)] = JSON.parse(JSON.stringify(u));
    }
    setUserDrafts(next);
  }, [usersResp?.users]);

  const selectableUsers = useMemo(() => {
    if (canManageUsers) {
      const users = Array.isArray(usersResp?.users) ? usersResp?.users : [];
      return users
        .map((u) => ({ email: String(u.email || ""), label: String(u.name || u.email || "") }))
        .filter((u) => u.email)
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    const email = String(me?.email || "").trim();
    const label = String(me?.name || me?.email || "Current User");
    return email ? [{ email, label }] : [];
  }, [canManageUsers, usersResp?.users, me?.email, me?.name]);

  useEffect(() => {
    if (!selectableUsers.length) return;
    if (selectedEmail && selectableUsers.some((u) => u.email === selectedEmail)) return;
    if (requestedEmail && selectableUsers.some((u) => u.email === requestedEmail)) {
      setSelectedEmail(requestedEmail);
      return;
    }
    const meEmail = String(me?.email || "").trim().toLowerCase();
    if (meEmail && selectableUsers.some((u) => u.email.toLowerCase() === meEmail)) {
      const found = selectableUsers.find((u) => u.email.toLowerCase() === meEmail);
      setSelectedEmail(found?.email || selectableUsers[0].email);
      return;
    }
    setSelectedEmail(selectableUsers[0].email);
  }, [selectableUsers, selectedEmail, requestedEmail, me?.email]);

  const selectedUser = useMemo(() => {
    if (!selectedEmail) return null;
    const users = Array.isArray(usersResp?.users) ? usersResp?.users : [];
    const fromList = users.find((u) => String(u.email || "") === selectedEmail);
    if (fromList) return userDrafts[selectedEmail] || fromList;
    if (!canManageUsers && me && String(me.email || "").trim().toLowerCase() === selectedEmail.toLowerCase()) {
      return {
        email: String(me.email || ""),
        name: String(me.name || me.email || ""),
        role: String(me.role || "viewer"),
        enabled: !!me.enabled,
        environments: Array.isArray(me.environments) ? me.environments : [String(me.environment || "dev")],
        permissions: {
          can_view: !!permissions.can_view,
          can_create_pipelines: !!permissions.can_create_pipelines,
          can_edit_pipelines: !!permissions.can_edit_pipelines,
          can_run_pipelines: !!permissions.can_run_pipelines,
          can_manage_jobs: !!permissions.can_manage_jobs,
          can_manage_live_jobs: !!permissions.can_manage_live_jobs,
          can_manage_users: !!permissions.can_manage_users,
          can_sync_pipelines: !!permissions.can_sync_pipelines,
        },
      } as ManagedUser;
    }
    return null;
  }, [selectedEmail, usersResp?.users, userDrafts, canManageUsers, me, permissions]);

  const canEditSelected = canManageUsers && !!selectedUser;
  const isSelfSelected = !!(selectedUser && me && String(selectedUser.email || "").toLowerCase() === String(me.email || "").toLowerCase());

  function updateSelected(patch: Partial<ManagedUser>) {
    if (!selectedEmail) return;
    setUserDrafts((prev) => {
      const base = prev[selectedEmail];
      if (!base) return prev;
      return { ...prev, [selectedEmail]: { ...base, ...patch } };
    });
  }

  function updatePerm(key: keyof ManagedUser["permissions"], value: boolean) {
    if (!selectedEmail) return;
    setUserDrafts((prev) => {
      const base = prev[selectedEmail];
      if (!base) return prev;
      return {
        ...prev,
        [selectedEmail]: {
          ...base,
          permissions: { ...base.permissions, [key]: value },
        },
      };
    });
  }

  async function saveSelected() {
    if (!selectedUser || !canManageUsers) return;
    setSaving(true);
    setMsg("");
    setMsgErr(false);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(selectedUser.email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(selectedUser.name || "").trim(),
          role: String(selectedUser.role || "viewer"),
          enabled: !!selectedUser.enabled,
          environments: Array.isArray(selectedUser.environments) ? selectedUser.environments : ["dev", "prod"],
          permissions: {
            create_pipelines: !!selectedUser.permissions?.can_create_pipelines,
            edit_pipelines: !!selectedUser.permissions?.can_edit_pipelines,
            run_pipelines: !!selectedUser.permissions?.can_run_pipelines,
            manage_jobs: !!selectedUser.permissions?.can_manage_jobs,
            manage_live: !!selectedUser.permissions?.can_manage_live_jobs,
            manage_users: !!selectedUser.permissions?.can_manage_users,
            sync_pipelines: !!selectedUser.permissions?.can_sync_pipelines,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateUsers();
      setMsg("User saved.");
    } catch (e: any) {
      setMsgErr(true);
      setMsg(String(e?.message || "Failed to save user."));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelected() {
    if (!selectedUser || !canManageUsers || isSelfSelected) return;
    if (!window.confirm(`Delete user ${selectedUser.email}?`)) return;
    setDeleting(true);
    setMsg("");
    setMsgErr(false);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(selectedUser.email)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateUsers();
      setMsg("User deleted.");
      setSelectedEmail("");
    } catch (e: any) {
      setMsgErr(true);
      setMsg(String(e?.message || "Failed to delete user."));
    } finally {
      setDeleting(false);
    }
  }

  async function createUser() {
    if (!canManageUsers) return;
    const email = String(newUserEmail || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setMsgErr(true);
      setMsg("Valid email is required.");
      return;
    }
    setCreating(true);
    setMsg("");
    setMsgErr(false);
    try {
      const res = await fetch(`${API}/users/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(newUserName || "").trim(),
          role: String(newUserRole || "viewer"),
          enabled: true,
          environments: ["dev", "prod"],
          permissions: {},
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data?.detail || data?.error || `HTTP ${res.status}`));
      await mutateUsers();
      setSelectedEmail(email);
      setNewUserEmail("");
      setNewUserName("");
      setNewUserRole("viewer");
      setMsg("User created.");
    } catch (e: any) {
      setMsgErr(true);
      setMsg(String(e?.message || "Failed to create user."));
    } finally {
      setCreating(false);
    }
  }

  const workUrl = selectedEmail
    ? `${API}/users/${encodeURIComponent(selectedEmail)}/work?runs_limit=200`
    : null;
  const { data: workData, isLoading: workLoading } = useSWR<UserWorkResponse>(workUrl, fetcher, {
    refreshInterval: 15000,
    keepPreviousData: true,
  });

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-5 h-5 text-indigo-400" />
        <h1 className="text-lg font-semibold text-white">User</h1>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-500 uppercase tracking-wider">Select user</label>
          <select
            value={selectedEmail}
            onChange={(e) => setSelectedEmail(e.target.value)}
            className="h-8 min-w-[260px] rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
          >
            {selectableUsers.map((u) => (
              <option key={u.email} value={u.email}>
                {u.label} · {u.email}
              </option>
            ))}
          </select>
          {selectedUser && (
            <span className="text-[10px] px-2 py-1 rounded border border-gray-700 bg-gray-950/70 text-gray-300 uppercase tracking-wide">
              {selectedUser.role}
            </span>
          )}
        </div>
      </div>

      {selectedUser ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Profile</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">Name</p>
                <input
                  value={selectedUser.name || ""}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                  disabled={!canEditSelected}
                  className="w-full h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100 disabled:opacity-60"
                />
              </div>
              <div>
                <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">Role</p>
                <select
                  value={selectedUser.role || "viewer"}
                  onChange={(e) => updateSelected({ role: e.target.value })}
                  disabled={!canEditSelected}
                  className="w-full h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100 disabled:opacity-60"
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-gray-300">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!!selectedUser.enabled}
                  onChange={(e) => updateSelected({ enabled: e.target.checked })}
                  disabled={!canEditSelected}
                  className="accent-indigo-500"
                />
                enabled
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={(selectedUser.environments || []).includes("dev")}
                  onChange={(e) => {
                    const next = new Set(selectedUser.environments || []);
                    if (e.target.checked) next.add("dev");
                    else next.delete("dev");
                    updateSelected({ environments: Array.from(next) });
                  }}
                  disabled={!canEditSelected}
                  className="accent-indigo-500"
                />
                dev
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={(selectedUser.environments || []).includes("prod")}
                  onChange={(e) => {
                    const next = new Set(selectedUser.environments || []);
                    if (e.target.checked) next.add("prod");
                    else next.delete("prod");
                    updateSelected({ environments: Array.from(next) });
                  }}
                  disabled={!canEditSelected}
                  className="accent-indigo-500"
                />
                prod
              </label>
            </div>

            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
              <p className="text-[10px] text-gray-600 uppercase tracking-widest mb-2">Permissions</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-300">
                {[
                  ["can_create_pipelines", "create pipelines"],
                  ["can_edit_pipelines", "edit pipelines"],
                  ["can_run_pipelines", "run pipelines"],
                  ["can_manage_jobs", "manage jobs"],
                  ["can_manage_live_jobs", "manage live jobs"],
                  ["can_manage_users", "manage users"],
                  ["can_sync_pipelines", "sync pipelines"],
                ].map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!!(selectedUser.permissions as any)?.[k]}
                      onChange={(e) => updatePerm(k as keyof ManagedUser["permissions"], e.target.checked)}
                      disabled={!canEditSelected}
                      className="accent-indigo-500"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => { void saveSelected(); }}
                disabled={!canEditSelected || saving}
                className="h-8 px-3 rounded border border-indigo-800/50 bg-indigo-900/30 text-indigo-200 text-xs hover:bg-indigo-900/50 disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </button>
              <button
                onClick={() => { void deleteSelected(); }}
                disabled={!canEditSelected || isSelfSelected || deleting}
                className="h-8 px-3 rounded border border-red-800/50 bg-red-900/30 text-red-200 text-xs hover:bg-red-900/50 disabled:opacity-50 flex items-center gap-1.5"
                title={isSelfSelected ? "Cannot delete the current user." : "Delete selected user"}
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Delete
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">User Work</p>
            {workLoading ? (
              <div className="h-28 flex items-center justify-center text-gray-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Loading work summary...
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <span className="px-2 py-1 rounded border border-gray-700 bg-gray-950/70 text-gray-300">
                    Pipelines: {Number(workData?.pipeline_count || 0)}
                  </span>
                  <span className="px-2 py-1 rounded border border-gray-700 bg-gray-950/70 text-gray-300">
                    Runs: {Number(workData?.run_count || 0)}
                  </span>
                </div>
                <div className="max-h-[220px] overflow-auto rounded-lg border border-gray-800">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-900 sticky top-0">
                      <tr className="text-gray-500">
                        <th className="text-left px-2 py-1">Pipeline</th>
                        <th className="text-left px-2 py-1">Folder</th>
                        <th className="text-left px-2 py-1">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(workData?.pipelines || []).slice(0, 100).map((p) => (
                        <tr key={p.id} className="border-t border-gray-800 text-gray-200">
                          <td className="px-2 py-1.5">{p.name || p.id}</td>
                          <td className="px-2 py-1.5 text-gray-400">{p.folder || "Unfiled"}</td>
                          <td className="px-2 py-1.5 text-gray-500">{fmtDate(p.updated_at || p.created_at || "")}</td>
                        </tr>
                      ))}
                      {(!workData?.pipelines || workData.pipelines.length === 0) && (
                        <tr>
                          <td colSpan={3} className="px-2 py-4 text-center text-gray-600">No pipelines for this user.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="max-h-[220px] overflow-auto rounded-lg border border-gray-800">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-900 sticky top-0">
                      <tr className="text-gray-500">
                        <th className="text-left px-2 py-1">Run</th>
                        <th className="text-left px-2 py-1">Pipeline</th>
                        <th className="text-left px-2 py-1">Status</th>
                        <th className="text-left px-2 py-1">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(workData?.runs || []).slice(0, 200).map((r) => (
                        <tr key={r.id} className="border-t border-gray-800 text-gray-200">
                          <td className="px-2 py-1.5 font-mono text-indigo-300">{String(r.id || "").slice(0, 8)}</td>
                          <td className="px-2 py-1.5">{r.pipeline_name || r.pipeline_id}</td>
                          <td className="px-2 py-1.5">
                            <span className={cn(
                              "px-1.5 py-0.5 rounded border text-[10px]",
                              String(r.status || "").toLowerCase().includes("fail")
                                ? "text-red-300 border-red-700/60 bg-red-950/40"
                                : "text-emerald-300 border-emerald-700/60 bg-emerald-950/40",
                            )}>
                              {r.status || "unknown"}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-gray-500">{fmtDate(r.started_at)}</td>
                        </tr>
                      ))}
                      {(!workData?.runs || workData.runs.length === 0) && (
                        <tr>
                          <td colSpan={4} className="px-2 py-4 text-center text-gray-600">No runs mapped to this user's pipelines.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center text-gray-500">
          <User className="w-5 h-5 mx-auto mb-2 text-gray-600" />
          Select a user to view profile and work.
        </div>
      )}

      {canManageUsers && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Add User</p>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <input
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
              placeholder="user@shinobigrp.com"
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            />
            <input
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
              placeholder="Display name"
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            />
            <select
              value={newUserRole}
              onChange={(e) => setNewUserRole(e.target.value)}
              className="h-8 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100"
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
            <button
              onClick={() => { void createUser(); }}
              disabled={creating}
              className="h-8 rounded border border-emerald-800/50 bg-emerald-900/30 text-emerald-200 text-xs hover:bg-emerald-900/50 disabled:opacity-50"
            >
              {creating ? "Adding..." : "Add user"}
            </button>
          </div>
        </div>
      )}

      <p className={cn("text-xs min-h-[18px]", msgErr ? "text-red-400" : "text-gray-500")}>
        {msg || "Each logged-in email gets a user profile automatically. Admin can manage users and privileges here."}
      </p>
    </div>
  );
}

