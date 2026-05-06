"use client";

import React from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Star, User, StickyNote, BadgeCheck, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeData } from "../../types";
import { RUNTIME_BADGE } from "../../types";

type OutputNodeType = Node<CanvasNodeData, "output">;

const SUBTYPE_META: Record<string, {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  border: string; bg: string; text: string;
}> = {
  persona:          { label: "Persona Profile",    Icon: User,       border: "border-violet-600",  bg: "bg-violet-950/60",  text: "text-violet-200" },
  persona_score:    { label: "Persona Score",      Icon: BadgeCheck, border: "border-violet-700",  bg: "bg-violet-950/50",  text: "text-violet-300" },
  notes:            { label: "Call Notes",         Icon: StickyNote, border: "border-amber-600",   bg: "bg-amber-950/60",   text: "text-amber-200"  },
  notes_compliance: { label: "Compliance Notes",   Icon: ShieldCheck,border: "border-emerald-600", bg: "bg-emerald-950/60", text: "text-emerald-200"},
  custom:           { label: "Custom Output",      Icon: Star,       border: "border-yellow-600",  bg: "bg-yellow-950/60",  text: "text-yellow-200" },
};
const DEFAULT_META = { label: "Output", Icon: Star, border: "border-gray-600", bg: "bg-gray-900/60", text: "text-gray-200" };

export function OutputNode({ data, selected }: NodeProps<OutputNodeType>) {
  const sub  = String(data.outputSubType || "custom");
  const meta = SUBTYPE_META[sub] ?? DEFAULT_META;
  const Icon = meta.Icon;
  const status = data.runtimeStatus ?? "pending";
  const badge  = RUNTIME_BADGE[status];

  return (
    <div className={cn(
      "w-52 rounded-xl border-2 overflow-hidden transition-shadow",
      meta.bg,
      selected
        ? `${meta.border} shadow-[0_0_0_3px_rgba(99,102,241,0.2)]`
        : meta.border,
    )}>
      {/* Header */}
      <div className={cn("px-3 py-2 flex items-center gap-2 border-b opacity-90", meta.border.replace("border-", "border-b-"))}>
        <div className="bg-gray-800/60 rounded px-1.5 py-0.5 text-[9px] font-bold text-white uppercase shrink-0">
          Output
        </div>
        <Icon className={cn("w-3.5 h-3.5 shrink-0", meta.text)} />
        <span className={cn("text-xs font-bold truncate flex-1", meta.text)}>{meta.label}</span>
        <div className={cn("w-2 h-2 rounded-full shrink-0", badge.dot)} />
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        {data.outputFormat && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-500">format</span>
            <span className={cn("text-[10px] bg-gray-800/60 px-1.5 py-0.5 rounded", meta.text)}>
              {String(data.outputFormat)}
            </span>
          </div>
        )}
        {data.lastNoteId && (
          <div className="mt-1.5 bg-emerald-950/40 border border-emerald-700/30 rounded px-2 py-1">
            <span className="text-[9px] text-emerald-400">note saved ✓</span>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !bg-violet-600 !border-2 !border-gray-900 !left-[-6px]" />
    </div>
  );
}
