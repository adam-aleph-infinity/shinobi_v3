"use client";

import { useReactFlow, useViewport } from "@xyflow/react";
import { Undo2, Redo2, Plus, Trash2, Minus, Maximize2, Play, Save, Loader2, Download } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  undoLen:    number;
  redoLen:    number;
  isDirty:    boolean;
  saving:     boolean;
  running:    boolean;
  onUndo:     () => void;
  onRedo:     () => void;
  onAddNode:  () => void;
  onDelete:   () => void;
  onSave:     () => void;
  onRun:      () => void;
  onExport?:  () => void;
}

export function CanvasToolbar({
  undoLen, redoLen, isDirty, saving, running,
  onUndo, onRedo, onAddNode, onDelete, onSave, onRun, onExport,
}: Props) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-gray-900/90 backdrop-blur-sm border border-gray-700/60 rounded-3xl px-4 py-2 shadow-xl">

      {/* Undo / Redo */}
      <button onClick={onUndo} disabled={undoLen === 0}
        className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 text-indigo-400 transition-colors" title="Undo (Ctrl+Z)">
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button onClick={onRedo} disabled={redoLen === 0}
        className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 text-indigo-400 transition-colors" title="Redo (Ctrl+Y)">
        <Redo2 className="w-3.5 h-3.5" />
      </button>

      <div className="w-px h-4 bg-gray-700" />

      {/* Add / Delete */}
      <button onClick={onAddNode}
        className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-600/60 rounded-lg px-2.5 py-1 text-xs text-gray-200 transition-colors" title="Add node">
        <Plus className="w-3 h-3" /> Node
      </button>
      <button onClick={onDelete}
        className="flex items-center gap-1 bg-red-950/30 hover:bg-red-900/40 border border-red-800/40 rounded-lg px-2.5 py-1 text-xs text-red-400 transition-colors" title="Delete selected (Delete)">
        <Trash2 className="w-3 h-3" />
      </button>

      <div className="w-px h-4 bg-gray-700" />

      {/* Zoom */}
      <button onClick={() => zoomOut()} className="p-1 rounded hover:bg-gray-700 text-gray-400 transition-colors">
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="text-[10px] text-gray-500 w-8 text-center font-mono select-none">
        {Math.round(zoom * 100)}%
      </span>
      <button onClick={() => zoomIn()} className="p-1 rounded hover:bg-gray-700 text-gray-400 transition-colors">
        <Plus className="w-3 h-3" />
      </button>
      <button onClick={() => fitView({ padding: 0.15, duration: 300 })}
        className="p-1 rounded hover:bg-gray-700 text-gray-400 transition-colors" title="Fit to screen">
        <Maximize2 className="w-3.5 h-3.5" />
      </button>

      <div className="w-px h-4 bg-gray-700" />

      {/* Export */}
      {onExport && (
        <button onClick={onExport}
          className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-600/60 rounded-lg px-2.5 py-1 text-xs text-gray-400 transition-colors" title="Export bundle">
          <Download className="w-3 h-3" /> Export
        </button>
      )}

      {/* Save */}
      <button onClick={onSave} disabled={saving || !isDirty}
        className={cn(
          "flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-colors",
          isDirty && !saving
            ? "bg-gray-700 hover:bg-gray-600 border border-gray-500/60 text-white"
            : "bg-gray-800/40 border border-gray-700/30 text-gray-600 cursor-default",
        )} title="Save (Ctrl+S)">
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
        {saving ? "Saving…" : "Save"}
      </button>

      {/* Run */}
      <button onClick={onRun} disabled={running}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-colors",
          running
            ? "bg-amber-700/30 border border-amber-600/40 text-amber-300 cursor-default"
            : "bg-emerald-700/30 hover:bg-emerald-700/50 border border-emerald-600/50 text-emerald-300",
        )} title="Run pipeline">
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
        {running ? "Running…" : "Run"}
      </button>
    </div>
  );
}
