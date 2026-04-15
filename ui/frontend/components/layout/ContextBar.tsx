"use client";
import { useAppCtx, LLMAgentType } from "@/lib/app-context";
import useSWR from "swr";
import { User, ChevronRight, Bot, X, ChevronDown } from "lucide-react";
import { useRef, useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(r => r.json());
interface NotesAgent { name: string; model: string; is_default: boolean; }

export function ContextBar() {
  const { salesAgent, customer, callId, llmAgentName, setSalesAgent, setCustomer, setCallId, setLlmAgent } = useAppCtx();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: agents } = useSWR<NotesAgent[]>("/api/notes/agents", fetcher);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Always render a slim bar so the layout height stays constant
  const hasCtx = !!(salesAgent || llmAgentName);

  return (
    <div className={cn(
      "border-b border-gray-800 px-4 flex items-center gap-2 text-xs shrink-0 transition-all",
      hasCtx ? "bg-gray-900/90 h-9" : "bg-transparent h-0 overflow-hidden border-0"
    )}>
      {/* Breadcrumb: agent → customer → call */}
      {salesAgent && (
        <span className="flex items-center gap-1.5 text-gray-300 min-w-0">
          <User className="w-3 h-3 text-indigo-400 shrink-0" />
          <span className="font-medium truncate max-w-[140px]">{salesAgent}</span>
          <button onClick={() => setSalesAgent("")}
            className="text-gray-600 hover:text-gray-400 shrink-0 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}
      {salesAgent && customer && <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />}
      {customer && (
        <span className="flex items-center gap-1.5 text-gray-400 min-w-0">
          <span className="truncate max-w-[140px]">{customer}</span>
          <button onClick={() => setCustomer("")}
            className="text-gray-600 hover:text-gray-400 shrink-0 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}
      {customer && callId && <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />}
      {callId && (
        <span className="flex items-center gap-1.5 text-gray-500 min-w-0">
          <span className="font-mono truncate">{callId}</span>
          <button onClick={() => setCallId("")}
            className="text-gray-600 hover:text-gray-400 shrink-0 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}

      {/* LLM agent dropdown — right-aligned */}
      <div className="ml-auto relative shrink-0" ref={ref}>
        <button
          onClick={() => setOpen(o => !o)}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs transition-colors",
            llmAgentName
              ? "bg-indigo-900/50 border-indigo-700/60 text-indigo-300 hover:bg-indigo-900/70"
              : "bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300 hover:bg-gray-750"
          )}
        >
          <Bot className="w-3 h-3 shrink-0" />
          <span className="max-w-[160px] truncate">{llmAgentName || "Select agent…"}</span>
          <ChevronDown className="w-3 h-3 shrink-0" />
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-1 w-64 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden">
            <p className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800">
              Notes Agents
            </p>
            {llmAgentName && (
              <button
                onClick={() => { setLlmAgent("", ""); setOpen(false); }}
                className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
              >
                — Clear
              </button>
            )}
            {(agents ?? []).length === 0 && (
              <p className="px-3 py-3 text-xs text-gray-600 text-center">
                No agents yet. Create one in <span className="text-indigo-400">Agents</span>.
              </p>
            )}
            {(agents ?? []).map(a => (
              <button
                key={a.name}
                onClick={() => { setLlmAgent(a.name, "notes"); setOpen(false); }}
                className={cn(
                  "w-full px-3 py-2 text-left text-xs flex items-center justify-between transition-colors",
                  llmAgentName === a.name
                    ? "bg-indigo-900/40 text-indigo-300"
                    : "text-gray-300 hover:bg-gray-800 hover:text-white"
                )}
              >
                <span>{a.name}</span>
                {a.is_default && <span className="text-[10px] text-gray-600">default</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
