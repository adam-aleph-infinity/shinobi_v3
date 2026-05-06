"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Play, Eye, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeData } from "../../types";
import { RUNTIME_BADGE } from "../../types";

type AgentNodeType = Node<CanvasNodeData, "agent">;

export function AgentNode({ data, selected }: NodeProps<AgentNodeType>) {
  const status  = data.runtimeStatus ?? "pending";
  const badge   = RUNTIME_BADGE[status];
  const dur     = data.lastRunDurationS != null ? `${Number(data.lastRunDurationS).toFixed(1)}s` : "";
  const preview = String(data.lastOutputPreview || "");

  return (
    <div className={cn(
      "w-56 rounded-xl border-2 bg-indigo-950/60 overflow-hidden transition-shadow",
      selected
        ? "border-indigo-400 shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
        : "border-indigo-700",
    )}>
      {/* Header */}
      <div className="bg-indigo-950/80 px-3 py-2 flex items-center gap-2 border-b border-indigo-700/40">
        <div className="bg-indigo-700 rounded-lg w-6 h-6 flex items-center justify-center shrink-0">
          <Bot className="w-3.5 h-3.5 text-indigo-200" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-indigo-100 text-xs font-bold truncate">
            {String(data.agentName || data.label || "Agent")}
          </div>
          {data.agentClass && (
            <div className="text-indigo-400 text-[9px]">{String(data.agentClass)}</div>
          )}
        </div>
        {/* Status badge */}
        <div className={cn(
          "flex items-center gap-1 border rounded-full px-1.5 py-0.5 shrink-0",
          badge.badge,
        )}>
          <div className={cn("w-1.5 h-1.5 rounded-full", badge.dot,
            status === "loading" && "animate-pulse")} />
          <span className="text-[8px] font-bold">{badge.label}</span>
        </div>
      </div>

      {/* Config summary */}
      <div className="px-3 py-2 space-y-1">
        {data.model && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-500">model</span>
            <span className="text-[10px] text-indigo-300 bg-gray-800/60 px-1.5 py-0.5 rounded">
              {String(data.model)}
            </span>
          </div>
        )}
        {data.inputSource && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-500">input</span>
            <span className="text-[10px] text-blue-300 bg-gray-800/60 px-1.5 py-0.5 rounded">
              {String(data.inputSource)}
            </span>
          </div>
        )}
      </div>

      {/* Running progress bar */}
      {status === "loading" && (
        <div className="h-0.5 bg-indigo-950">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-400 animate-[progressBar_2s_ease-in-out_infinite]" />
        </div>
      )}

      {/* Output preview */}
      {preview && (
        <div className="mx-2.5 mb-2 bg-gray-900/60 border border-gray-700/40 rounded-lg px-2.5 py-1.5">
          <p className="text-[9px] text-gray-400 leading-relaxed line-clamp-2">{preview}</p>
        </div>
      )}

      {/* Footer actions */}
      <div className="bg-indigo-950/60 px-2.5 py-1.5 flex items-center gap-1.5 border-t border-indigo-700/30">
        <button className="flex items-center gap-1 bg-indigo-700/30 border border-indigo-600/40 rounded px-2 py-0.5 text-[9px] text-indigo-300 hover:bg-indigo-700/50 transition-colors">
          <Play className="w-2.5 h-2.5" /> Run
        </button>
        <button className="flex items-center gap-1 bg-gray-800/40 border border-gray-700/40 rounded px-2 py-0.5 text-[9px] text-gray-400 hover:bg-gray-800/60 transition-colors">
          <Eye className="w-2.5 h-2.5" /> View
        </button>
        <button className="ml-auto bg-gray-800/40 border border-gray-700/40 rounded p-0.5 text-gray-500 hover:bg-gray-800/60 transition-colors">
          <MoreHorizontal className="w-3 h-3" />
        </button>
        {dur && <span className="text-[9px] text-gray-600 ml-1">{dur}</span>}
      </div>

      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !bg-indigo-600 !border-2 !border-gray-900 !left-[-6px]" />
      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !bg-indigo-600 !border-2 !border-gray-900 !right-[-6px]" />
    </div>
  );
}
