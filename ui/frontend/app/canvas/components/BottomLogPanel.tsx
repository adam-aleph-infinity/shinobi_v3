"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasLogLine } from "../types";

interface Props {
  lines:    CanvasLogLine[];
  running:  boolean;
  onClear:  () => void;
}

export function BottomLogPanel({ lines, running, onClear }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (running) setExpanded(true);
  }, [running]);

  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, expanded]);

  const levelColor: Record<CanvasLogLine["level"], string> = {
    pipeline: "text-blue-400",
    llm:      "text-purple-400",
    error:    "text-red-400",
    warn:     "text-amber-400",
    info:     "text-gray-400",
  };

  const latest = lines[lines.length - 1];

  return (
    <div className={cn(
      "border-t border-gray-800 bg-gray-950/95 transition-all duration-200 shrink-0",
      expanded ? "h-48" : "h-8",
    )}>
      {/* Strip header */}
      <div className="h-8 flex items-center px-3 gap-3">
        {!expanded && latest && (
          <span className={cn("text-[10px] font-mono truncate flex-1", levelColor[latest.level])}>
            [{latest.ts}] {latest.text}
          </span>
        )}
        {expanded && (
          <span className="text-[10px] text-gray-500 font-mono">
            Execution Log ({lines.length} lines)
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto shrink-0">
          {expanded && (
            <button onClick={onClear} className="text-gray-600 hover:text-gray-400 p-0.5">
              <X className="w-3 h-3" />
            </button>
          )}
          <button onClick={() => setExpanded(e => !e)} className="text-gray-500 hover:text-gray-300 p-0.5">
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5" />
              : <ChevronUp   className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Expanded log */}
      {expanded && (
        <div className="h-[calc(100%-2rem)] overflow-y-auto px-3 pb-2 space-y-0.5">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 font-mono text-[10px] leading-5">
              <span className="text-gray-600 shrink-0">[{l.ts}]</span>
              <span className={levelColor[l.level]}>{l.text}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
