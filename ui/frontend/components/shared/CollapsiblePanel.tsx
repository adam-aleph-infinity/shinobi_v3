"use client";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
  width: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Extra classes forwarded to the outer div (e.g. "min-h-0") */
  className?: string;
  /** bare=true: no bg/border on expanded wrapper (use when children have their own styling) */
  bare?: boolean;
}

export function CollapsiblePanel({ title, children, width, collapsed, onToggle, className = "", bare = false }: Props) {
  if (collapsed) {
    return (
      <div
        style={{ width: 28 }}
        className={`flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col ${className}`}
      >
        <button
          onClick={onToggle}
          title={`Expand ${title}`}
          className="flex-1 flex flex-col items-center justify-center gap-2 hover:bg-gray-800/40 transition-colors group"
        >
          <ChevronsRight className="w-3 h-3 text-gray-600 group-hover:text-gray-400 shrink-0" />
          <span
            className="text-[8px] font-bold text-gray-600 group-hover:text-gray-400 uppercase tracking-widest select-none"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            {title}
          </span>
        </button>
      </div>
    );
  }

  if (bare) {
    return (
      <div
        style={{ width }}
        className={`flex-shrink-0 flex flex-col relative ${className}`}
      >
        <button
          onClick={onToggle}
          title={`Collapse ${title}`}
          className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded transition-colors text-gray-500 hover:text-gray-200 hover:bg-gray-700"
        >
          <ChevronsLeft className="w-3 h-3" />
        </button>
        {children}
      </div>
    );
  }

  return (
    <div
      style={{ width }}
      className={`flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col relative ${className}`}
    >
      {/* Collapse button */}
      <button
        onClick={onToggle}
        title={`Collapse ${title}`}
        className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded transition-colors text-gray-500 hover:text-gray-200 hover:bg-gray-700"
      >
        <ChevronsLeft className="w-3 h-3" />
      </button>
      {children}
    </div>
  );
}
