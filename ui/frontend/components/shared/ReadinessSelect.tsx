"use client";
import { useState, useRef, useEffect } from "react";
import { Search, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ReadinessItem {
  value: string;
  label: string;
  sublabel?: string;
  /** 0–1: fraction of items transcribed. 0 = no dot. 1 = full green dot. */
  readiness?: number;
}

/** Green circle whose opacity scales with readiness (0.15 → 1.0). */
export function ReadinessDot({ ratio, className }: { ratio: number; className?: string }) {
  if (!ratio || ratio <= 0) return null;
  const opacity = 0.15 + Math.min(ratio, 1) * 0.85;
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0", className)}
      style={{ opacity }}
      title={`${Math.round(Math.min(ratio, 1) * 100)}% transcribed`}
    />
  );
}

/**
 * Custom searchable dropdown showing a ReadinessDot next to each item.
 * Replaces native <select> where visual readiness indicators are needed.
 */
export function ReadinessSelect({
  items,
  value,
  onChange,
  placeholder = "Select…",
  className,
  disabled,
}: {
  items: ReadinessItem[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // When dropdown opens: focus search input + scroll selected item into view.
  // setTimeout instead of rAF so long lists (195+ items) finish layout first.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (searchRef.current) searchRef.current.focus();
      if (selectedRef.current) selectedRef.current.scrollIntoView({ block: "nearest" });
    }, 20);
    return () => clearTimeout(t);
  }, [open]);

  // Scroll list to top when search query changes so first match is always visible
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [q]);

  const selected = items.find(i => i.value === value);
  const filtered = q
    ? items.filter(i => i.label.toLowerCase().includes(q.toLowerCase()))
    : items;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) { setOpen(v => !v); setQ(""); } }}
        className={cn(
          "w-full flex items-center gap-2 bg-gray-800 border rounded-lg px-3 py-2 text-sm text-left focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors",
          disabled
            ? "border-gray-800 opacity-50 cursor-not-allowed"
            : "border-gray-700 hover:border-gray-600 cursor-pointer"
        )}
      >
        {selected ? (
          <>
            <ReadinessDot ratio={selected.readiness ?? 0} />
            <span className="flex-1 text-white truncate">{selected.label}</span>
            {selected.sublabel && (
              <span className="text-[10px] text-gray-500 shrink-0 font-mono">{selected.sublabel}</span>
            )}
          </>
        ) : (
          <span className="flex-1 text-gray-500">{placeholder}</span>
        )}
        <ChevronDown className={cn(
          "w-3.5 h-3.5 text-gray-500 shrink-0 transition-transform duration-150",
          open && "rotate-180"
        )} />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
          {/* Search — only when there are enough items */}
          {items.length > 5 && (
            <div className="p-2 border-b border-gray-800">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Search…"
                  className="w-full pl-8 pr-3 py-1.5 bg-gray-800 rounded text-xs text-white placeholder-gray-600 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div ref={listRef} className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-4">No matches</p>
            ) : (
              filtered.map(item => (
                <button
                  key={item.value}
                  ref={item.value === value ? selectedRef : undefined}
                  type="button"
                  onClick={() => { onChange(item.value); setOpen(false); setQ(""); }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-gray-800 transition-colors text-left",
                    item.value === value && "bg-indigo-900/30"
                  )}
                >
                  <ReadinessDot ratio={item.readiness ?? 0} />
                  <span className={cn(
                    "flex-1 truncate",
                    item.value === value ? "text-indigo-200 font-medium" : "text-gray-200"
                  )}>
                    {item.label}
                  </span>
                  {item.sublabel && (
                    <span className="text-[10px] text-gray-500 shrink-0 font-mono">{item.sublabel}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
