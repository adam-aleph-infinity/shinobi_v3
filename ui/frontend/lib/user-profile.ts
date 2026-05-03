"use client";

import useSWR from "swr";

export interface UserPermissions {
  can_view: boolean;
  can_create_pipelines: boolean;
  can_edit_pipelines: boolean;
  can_run_pipelines: boolean;
  can_manage_jobs: boolean;
  can_manage_live_jobs: boolean;
  can_manage_users: boolean;
  can_sync_pipelines: boolean;
}

export interface UserProfile {
  email: string;
  name: string;
  role: string;
  enabled: boolean;
  environment: "dev" | "prod" | string;
  environments: string[];
  is_admin: boolean;
  permissions: UserPermissions;
  restricted_reason?: string;
}

const DEFAULT_PERMISSIONS: UserPermissions = {
  can_view: false,
  can_create_pipelines: false,
  can_edit_pipelines: false,
  can_run_pipelines: false,
  can_manage_jobs: false,
  can_manage_live_jobs: false,
  can_manage_users: false,
  can_sync_pipelines: false,
};

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
  return data as UserProfile;
};

export function useUserProfile() {
  const swr = useSWR<UserProfile>("/api/users/me", fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
  });
  const profile = swr.data;
  const permissions = profile?.permissions || DEFAULT_PERMISSIONS;
  return {
    ...swr,
    profile,
    permissions,
    isLoading: swr.isLoading,
  };
}

