"use client";

import useSWR, { useSWRConfig } from "swr";
import { useCallback } from "react";
import type { PipelineDef, PipelineFolderDef, UniversalAgent } from "../types";

const fetcher = (url: string) => fetch(url).then(r => r.json());

export function usePipelineData() {
  const { mutate } = useSWRConfig();

  const { data: agents = [], isLoading: agentsLoading } =
    useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);

  const { data: pipelines = [], mutate: mutatePipelines } =
    useSWR<PipelineDef[]>("/api/pipelines", fetcher);

  const { data: folders = [], mutate: mutateFolders } =
    useSWR<PipelineFolderDef[]>("/api/pipelines/folders", fetcher);

  const revalidateAll = useCallback(() => {
    void mutate("/api/universal-agents");
    void mutate("/api/pipelines");
    void mutate("/api/pipelines/folders");
  }, [mutate]);

  // ── Pipeline CRUD ───────────────────────────────────────────────────────────

  async function savePipeline(
    pipeline: Partial<PipelineDef> & { name: string },
  ): Promise<PipelineDef> {
    const url    = pipeline.id ? `/api/pipelines/${pipeline.id}` : "/api/pipelines";
    const method = pipeline.id ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pipeline),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    const saved: PipelineDef = await res.json();
    void mutatePipelines();
    return saved;
  }

  async function deletePipeline(id: string): Promise<void> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    void mutatePipelines();
  }

  async function loadPipeline(id: string): Promise<PipelineDef> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Load failed (${res.status})`);
    return res.json();
  }

  // ── Folder CRUD ─────────────────────────────────────────────────────────────

  async function createFolder(name: string): Promise<PipelineFolderDef> {
    const res = await fetch("/api/pipelines/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "" }),
    });
    if (!res.ok) throw new Error(`Create folder failed (${res.status})`);
    const folder: PipelineFolderDef = await res.json();
    void mutateFolders();
    return folder;
  }

  async function renameFolder(id: string, name: string): Promise<void> {
    const res = await fetch(`/api/pipelines/folders/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename folder failed (${res.status})`);
    void mutateFolders();
  }

  async function deleteFolder(id: string): Promise<void> {
    const res = await fetch(`/api/pipelines/folders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Delete folder failed (${res.status})`);
    void mutatePipelines();
    void mutateFolders();
  }

  async function movePipelineToFolder(pipelineId: string, folderId: string): Promise<void> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/folder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    });
    if (!res.ok) throw new Error(`Move failed (${res.status})`);
    void mutatePipelines();
  }

  return {
    agents, agentsLoading,
    pipelines, folders,
    revalidateAll,
    savePipeline, deletePipeline, loadPipeline,
    createFolder, renameFolder, deleteFolder,
    movePipelineToFolder,
  };
}
