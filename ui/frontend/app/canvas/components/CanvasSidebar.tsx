"use client";

import { useState, useRef, useEffect } from "react";
import { Folder, Plus, MoreVertical, Pencil, Trash2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PipelineDef, PipelineFolderDef } from "../types";

interface Props {
  folders:         PipelineFolderDef[];
  pipelines:       PipelineDef[];
  activeFolderId:  string;
  activePipelineId: string;
  onSelectFolder:  (id: string) => void;
  onSelectPipeline:(id: string) => void;
  onCreateFolder:  () => void;
  onRenameFolder:  (id: string, name: string) => void;
  onDeleteFolder:  (id: string) => void;
  onCreatePipeline: () => void;
  onRenamePipeline: (id: string, name: string) => void;
  onDeletePipeline: (id: string) => void;
  onDuplicatePipeline: (id: string) => void;
}

export function CanvasSidebar({
  folders, pipelines,
  activeFolderId, activePipelineId,
  onSelectFolder, onSelectPipeline,
  onCreateFolder,
  onRenameFolder, onDeleteFolder,
  onCreatePipeline,
  onRenamePipeline, onDeletePipeline, onDuplicatePipeline,
}: Props) {
  const [editingFolderId,   setEditingFolderId]   = useState<string | null>(null);
  const [editingPipelineId, setEditingPipelineId] = useState<string | null>(null);
  const [editName,          setEditName]           = useState("");
  const [folderMenuId,      setFolderMenuId]       = useState<string | null>(null);
  const [pipelineMenuId,    setPipelineMenuId]     = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const activeFolder = folders.find(f => f.id === activeFolderId);
  const folderPipelines = pipelines.filter(p =>
    activeFolderId ? p.folder_id === activeFolderId : !p.folder_id,
  );

  useEffect(() => {
    if (editingFolderId || editingPipelineId) editInputRef.current?.focus();
  }, [editingFolderId, editingPipelineId]);

  function startEditFolder(f: PipelineFolderDef) {
    setEditingFolderId(f.id);
    setEditName(f.name);
    setFolderMenuId(null);
  }

  function commitFolderRename() {
    if (editingFolderId && editName.trim()) onRenameFolder(editingFolderId, editName.trim());
    setEditingFolderId(null);
  }

  function startEditPipeline(p: PipelineDef) {
    setEditingPipelineId(p.id);
    setEditName(p.name);
    setPipelineMenuId(null);
  }

  function commitPipelineRename() {
    if (editingPipelineId && editName.trim()) onRenamePipeline(editingPipelineId, editName.trim());
    setEditingPipelineId(null);
  }

  return (
    <div className="flex h-full" onClick={() => { setFolderMenuId(null); setPipelineMenuId(null); }}>

      {/* Icon rail */}
      <div className="w-12 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-3 gap-2 shrink-0">
        {folders.map(f => (
          <button
            key={f.id}
            title={f.name}
            onClick={() => onSelectFolder(f.id)}
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
              f.id === activeFolderId
                ? "bg-indigo-600/30 border border-indigo-500"
                : "bg-gray-800/50 hover:bg-gray-800 border border-transparent",
            )}
          >
            <Folder className={cn("w-4 h-4", f.id === activeFolderId ? "text-indigo-400" : "text-gray-500")} />
          </button>
        ))}
        <button
          title="New folder"
          onClick={onCreateFolder}
          className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-800/30 hover:bg-blue-900/30 border border-dashed border-gray-700 hover:border-blue-600 transition-colors mt-auto"
        >
          <Plus className="w-3.5 h-3.5 text-gray-500 hover:text-blue-400" />
        </button>
      </div>

      {/* Pipeline list */}
      <div className="w-44 bg-gray-950/80 border-r border-gray-800 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-800 shrink-0">
          <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest truncate block">
            {activeFolder?.name ?? "All Pipelines"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {folderPipelines.map(p => (
            <div key={p.id} className="relative px-2">
              {editingPipelineId === p.id ? (
                <div className="flex items-center gap-1 px-1 py-1">
                  <input
                    ref={editInputRef}
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") commitPipelineRename(); if (e.key === "Escape") setEditingPipelineId(null); }}
                    className="flex-1 bg-gray-800 border border-indigo-500 rounded px-1.5 py-0.5 text-xs text-white outline-none min-w-0"
                  />
                  <button onClick={commitPipelineRename}><Check className="w-3 h-3 text-emerald-400" /></button>
                  <button onClick={() => setEditingPipelineId(null)}><X className="w-3 h-3 text-gray-500" /></button>
                </div>
              ) : (
                <button
                  onClick={() => onSelectPipeline(p.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors group",
                    p.id === activePipelineId
                      ? "bg-indigo-600/20 border border-indigo-600/40 text-white"
                      : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200 border border-transparent",
                  )}
                >
                  {p.id === activePipelineId && (
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                  )}
                  <span className="text-xs truncate flex-1">{p.name}</span>
                  <button
                    onClick={e => { e.stopPropagation(); setPipelineMenuId(p.id === pipelineMenuId ? null : p.id); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-700 rounded transition-all"
                  >
                    <MoreVertical className="w-3 h-3 text-gray-500" />
                  </button>
                </button>
              )}

              {/* Pipeline context menu */}
              {pipelineMenuId === p.id && (
                <div className="absolute right-0 top-7 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 w-36 text-xs"
                  onClick={e => e.stopPropagation()}>
                  <button onClick={() => startEditPipeline(p)} className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                    <Pencil className="w-3 h-3" /> Rename
                  </button>
                  <button onClick={() => { onDuplicatePipeline(p.id); setPipelineMenuId(null); }} className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                    <Plus className="w-3 h-3" /> Duplicate
                  </button>
                  <div className="h-px bg-gray-700 my-1" />
                  <button onClick={() => { onDeletePipeline(p.id); setPipelineMenuId(null); }} className="w-full px-3 py-1.5 text-left hover:bg-red-900/40 flex items-center gap-2 text-red-400">
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}

          {folderPipelines.length === 0 && (
            <p className="text-center text-gray-600 text-xs py-4 italic">No pipelines</p>
          )}
        </div>

        <div className="p-2 border-t border-gray-800 shrink-0">
          <button
            onClick={onCreatePipeline}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-dashed border-blue-700/50 text-blue-500 text-xs hover:bg-blue-900/20 hover:border-blue-600 transition-colors"
          >
            <Plus className="w-3 h-3" /> New Pipeline
          </button>
        </div>
      </div>
    </div>
  );
}
