"use client";

import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Zap, Layers, StickyNote, BookOpen, Bot, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeData } from "../../types";
import { RUNTIME_BADGE } from "../../types";

const SOURCE_META: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  transcript:        { label: "Transcript",        Icon: Zap },
  merged_transcript: { label: "Merged Transcript", Icon: Layers },
  notes:             { label: "Notes",             Icon: StickyNote },
  merged_notes:      { label: "Merged Notes",      Icon: BookOpen },
  agent_output:      { label: "Agent Output",      Icon: Bot },
  manual:            { label: "Manual",            Icon: PenLine },
};

export function InputNode({ data, selected }: NodeProps) {
  const nodeData = data as CanvasNodeData;
  const src = String(nodeData.inputSource || "transcript");
  const meta = SOURCE_META[src] ?? SOURCE_META.transcript;
  const Icon = meta.Icon;
  const status = nodeData.runtimeStatus ?? "pending";
  const badge = RUNTIME_BADGE[status];

  return (
    <div className={cn(
      "w-52 rounded-xl border-2 bg-blue-950/60 overflow-hidden transition-shadow",
      selected ? "border-blue-400 shadow-[0_0_0_3px_rgba(96,165,250,0.2)]" : "border-blue-700",
    )}>
      {/* Header */}
      <div className="bg-blue-950/80 px-3 py-2 flex items-center gap-2 border-b border-blue-700/50">
        <div className="bg-blue-700 rounded px-1.5 py-0.5 text-[9px] font-bold text-white uppercase tracking-wider shrink-0">
          Input
        </div>
        <span className="text-blue-200 text-xs font-bold truncate flex-1">{meta.label}</span>
        <div className={cn("w-2 h-2 rounded-full shrink-0", badge.dot,
          status === "loading" && "animate-pulse")} />
      </div>

      {/* Body */}
      <div className="px-3 py-2 flex items-center gap-2">
        <Icon className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-blue-300 text-[11px]">{String(nodeData.label || meta.label)}</span>
      </div>

      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !bg-blue-600 !border-2 !border-gray-900 !right-[-6px]" />
    </div>
  );
}
