"use client";
import { useAppCtx } from "@/lib/app-context";
import useSWR from "swr";
import { User, ChevronRight, X, ChevronDown, Bot } from "lucide-react";
import { useRef, useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface UniversalAgent {
  id: string;
  name: string;
  agent_class: string;
  is_default: boolean;
}

// ── Universal Agent Picker ─────────────────────────────────────────────────────
function AgentPicker({
  value,
  agents,
  onSelect,
  onClear,
}: {
  value: string;
  agents: UniversalAgent[] | undefined;
  onSelect: (agent: UniversalAgent) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Group agents by agent_class
  const grouped: Record<string, UniversalAgent[]> = {};
  for (const a of agents ?? []) {
    const cls = a.agent_class || "general";
    if (!grouped[cls]) grouped[cls] = [];
    grouped[cls].push(a);
  }
  const classes = Object.keys(grouped).sort();

  return (
    <div className="relative shrink-0 flex items-center gap-1" ref={ref}>
      <span className="text-[10px] text-gray-600 font-medium">Agent</span>
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors",
          value
            ? "bg-violet-900/50 border-violet-700/60 text-violet-300 hover:bg-violet-900/70"
            : "bg-gray-800/60 border-gray-700/60 text-gray-500 hover:text-gray-300 hover:bg-gray-800"
        )}
      >
        <Bot className="w-2.5 h-2.5 shrink-0" />
        <span className="max-w-[130px] truncate">{value || "none"}</span>
        <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-60" />
      </button>
      {value && (
        <button onClick={onClear} className="text-gray-600 hover:text-gray-400 transition-colors -ml-0.5">
          <X className="w-2.5 h-2.5" />
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden max-h-80 overflow-y-auto">
          <p className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800 sticky top-0 bg-gray-900">
            Active Agent
          </p>
          {value && (
            <button
              onClick={() => { onClear(); setOpen(false); }}
              className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
            >
              — Clear
            </button>
          )}
          {(agents ?? []).length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-600 text-center">
              No agents yet. Create one in <span className="text-violet-400">Agents</span>.
            </p>
          )}
          {classes.map(cls => (
            <div key={cls}>
              <p className="px-3 pt-2 pb-0.5 text-[9px] text-gray-600 uppercase tracking-widest font-bold">
                {cls}
              </p>
              {grouped[cls].map(agent => (
                <button
                  key={agent.id}
                  onClick={() => { onSelect(agent); setOpen(false); }}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-xs flex items-center justify-between transition-colors",
                    value === agent.name
                      ? "bg-violet-900/40 text-violet-300"
                      : "text-gray-300 hover:bg-gray-800 hover:text-white"
                  )}
                >
                  <span className="truncate">{agent.name}</span>
                  {agent.is_default && (
                    <span className="text-[10px] text-gray-600 shrink-0 ml-1">default</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ContextBar ─────────────────────────────────────────────────────────────────
export function ContextBar() {
  const {
    salesAgent, customer, callId,
    activeAgentName,
    setSalesAgent, setCustomer, setCallId,
    setActiveAgent,
  } = useAppCtx();

  const { data: agents } = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);

  const hasCtx = !!(salesAgent || activeAgentName);

  return (
    <div className={cn(
      "border-b border-gray-800 px-4 flex items-center gap-2 text-xs shrink-0 transition-all",
      hasCtx ? "bg-gray-900/90 h-9" : "bg-transparent h-0 overflow-hidden border-0"
    )}>

      {/* ── Breadcrumb: sales agent → customer → call ── */}
      {salesAgent && (
        <span className="flex items-center gap-1.5 text-gray-300 min-w-0">
          <User className="w-3 h-3 text-indigo-400 shrink-0" />
          <span className="font-medium truncate max-w-[140px]">{salesAgent}</span>
          <button onClick={() => setSalesAgent("")} className="text-gray-600 hover:text-gray-400 shrink-0 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}
      {salesAgent && customer && <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />}
      {customer && (
        <span className="flex items-center gap-1.5 text-gray-400 min-w-0">
          <span className="truncate max-w-[140px]">{customer}</span>
          <button onClick={() => setCustomer("")} className="text-gray-600 hover:text-gray-400 shrink-0 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}
      {customer && callId && <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />}
      {callId && (
        <span className="flex items-center gap-1.5 text-gray-500 min-w-0">
          <span className="font-mono truncate max-w-[100px]">{callId}</span>
          <button onClick={() => setCallId("")} className="text-gray-600 hover:text-gray-400 shrink-0 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </span>
      )}

      {/* ── Agent picker — right-aligned ── */}
      <div className="ml-auto flex items-center gap-3">
        <AgentPicker
          value={activeAgentName}
          agents={agents}
          onSelect={a => setActiveAgent(a.id, a.name, a.agent_class || "general")}
          onClear={() => setActiveAgent("", "", "")}
        />
      </div>
    </div>
  );
}
