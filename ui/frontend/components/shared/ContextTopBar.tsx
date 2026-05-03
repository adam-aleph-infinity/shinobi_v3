"use client";

import { ChevronRight, PhoneCall, User, Users } from "lucide-react";
import { cn } from "@/lib/utils";

type ContextTopBarProps = {
  salesAgent: string;
  customer: string;
  callId: string;
  runNeedsCall?: boolean;
  onOpenCrm: () => void;
  onOpenCalls: () => void;
  disabled?: boolean;
  lockedBadge?: React.ReactNode;
  className?: string;
};

export default function ContextTopBar({
  salesAgent,
  customer,
  callId,
  runNeedsCall = true,
  onOpenCrm,
  onOpenCalls,
  disabled = false,
  lockedBadge,
  className,
}: ContextTopBarProps) {
  return (
    <div className={cn("flex flex-nowrap items-center gap-2 px-3 py-2 overflow-x-auto border-b border-gray-800/70", className)}>
      <Users className="w-4 h-4 text-indigo-400 shrink-0" />
      <span className="text-sm font-bold text-white shrink-0">Context</span>
      {lockedBadge}

      <button
        type="button"
        onClick={onOpenCrm}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-800 bg-gray-950/40 hover:bg-gray-900 transition-colors min-w-[170px] disabled:opacity-50 disabled:cursor-not-allowed"
        title="Pick sales agent + customer from CRM"
      >
        <Users className="w-3 h-3 text-indigo-400 shrink-0" />
        <span className="text-[11px] text-gray-200 truncate">{salesAgent || "Sales agent…"}</span>
      </button>

      <button
        type="button"
        onClick={onOpenCrm}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-800 bg-gray-950/40 hover:bg-gray-900 transition-colors min-w-[170px] disabled:opacity-50 disabled:cursor-not-allowed"
        title="Pick customer from CRM"
      >
        <User className="w-3 h-3 text-cyan-400 shrink-0" />
        <span className="text-[11px] text-gray-200 truncate">
          {customer || (salesAgent ? "Customer…" : "Select agent first")}
        </span>
      </button>

      <button
        type="button"
        onClick={onOpenCalls}
        disabled={disabled}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-800 bg-gray-950/40 hover:bg-gray-900 transition-colors min-w-[190px] disabled:opacity-50 disabled:cursor-not-allowed"
        title="Open calls browser"
      >
        <PhoneCall className="w-3 h-3 text-amber-400 shrink-0" />
        <span className="text-[11px] text-gray-200 truncate">
          {callId ? `Call ${callId}` : (!runNeedsCall ? "Per-pair scope" : "Call ID…")}
        </span>
        <ChevronRight className="w-3 h-3 text-gray-500 ml-auto" />
      </button>
    </div>
  );
}

