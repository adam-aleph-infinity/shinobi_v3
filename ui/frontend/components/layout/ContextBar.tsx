"use client";
import { useAppCtx, LLMAgentType } from "@/lib/app-context";
import useSWR from "swr";
import { User, ChevronRight, X, ChevronDown, StickyNote, Users } from "lucide-react";
import { useRef, useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface NotesAgent   { name: string; model: string; is_default: boolean; }
interface PersonaAgent { id: string; name: string; persona_type: string; is_default: boolean; }

// ── Reusable compact agent picker ─────────────────────────────────────────────
function AgentPicker({
  label,
  icon,
  value,
  items,
  idKey,
  nameKey,
  accentClass,
  onSelect,
  onClear,
  emptyMsg,
  linkLabel,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  items: any[] | undefined;
  idKey: string;
  nameKey: string;
  accentClass: string;
  onSelect: (item: any) => void;
  onClear: () => void;
  emptyMsg: string;
  linkLabel: string;
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

  return (
    <div className="relative shrink-0 flex items-center gap-1" ref={ref}>
      <span className="text-[10px] text-gray-600 font-medium">{label}</span>
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] transition-colors",
          value
            ? accentClass
            : "bg-gray-800/60 border-gray-700/60 text-gray-500 hover:text-gray-300 hover:bg-gray-800"
        )}
      >
        {icon}
        <span className="max-w-[110px] truncate">{value || "none"}</span>
        <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-60" />
      </button>
      {value && (
        <button onClick={onClear} className="text-gray-600 hover:text-gray-400 transition-colors -ml-0.5">
          <X className="w-2.5 h-2.5" />
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 py-1 overflow-hidden">
          <p className="px-3 py-1.5 text-[10px] text-gray-500 uppercase tracking-wider font-semibold border-b border-gray-800">
            {label}
          </p>
          {value && (
            <button
              onClick={() => { onClear(); setOpen(false); }}
              className="w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-800 hover:text-white transition-colors"
            >
              — Clear
            </button>
          )}
          {(items ?? []).length === 0 && (
            <p className="px-3 py-3 text-xs text-gray-600 text-center">
              No agents yet. Create one in <span className="text-indigo-400">{linkLabel}</span>.
            </p>
          )}
          {(items ?? []).map(item => {
            const id   = item[idKey];
            const name = item[nameKey];
            return (
              <button
                key={id}
                onClick={() => { onSelect(item); setOpen(false); }}
                className={cn(
                  "w-full px-3 py-2 text-left text-xs flex items-center justify-between transition-colors",
                  value === name
                    ? "bg-indigo-900/40 text-indigo-300"
                    : "text-gray-300 hover:bg-gray-800 hover:text-white"
                )}
              >
                <span className="truncate">{name}</span>
                {item.is_default && <span className="text-[10px] text-gray-600 shrink-0 ml-1">default</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── ContextBar ─────────────────────────────────────────────────────────────────
export function ContextBar() {
  const {
    salesAgent, customer, callId,
    llmAgentName, personaAgentName,
    setSalesAgent, setCustomer, setCallId,
    setLlmAgent, setPersonaAgent,
  } = useAppCtx();

  const { data: notesAgents }   = useSWR<NotesAgent[]>("/api/notes/agents", fetcher);
  const { data: personaAgents } = useSWR<PersonaAgent[]>("/api/persona-agents", fetcher);

  const hasCtx = !!(salesAgent || llmAgentName || personaAgentName);

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

      {/* ── Agent pickers — right-aligned ── */}
      <div className="ml-auto flex items-center gap-3">

        {/* Notes agent */}
        <AgentPicker
          label="Notes"
          icon={<StickyNote className="w-2.5 h-2.5 shrink-0" />}
          value={llmAgentName}
          items={notesAgents}
          idKey="name"
          nameKey="name"
          accentClass="bg-indigo-900/50 border-indigo-700/60 text-indigo-300 hover:bg-indigo-900/70"
          onSelect={a => setLlmAgent(a.name, "notes")}
          onClear={() => setLlmAgent("", "")}
          emptyMsg="No notes agents"
          linkLabel="Agents"
        />

        {/* Persona agent */}
        <AgentPicker
          label="Persona"
          icon={<Users className="w-2.5 h-2.5 shrink-0" />}
          value={personaAgentName}
          items={personaAgents}
          idKey="id"
          nameKey="name"
          accentClass="bg-teal-900/50 border-teal-700/60 text-teal-300 hover:bg-teal-900/70"
          onSelect={a => setPersonaAgent(a.id, a.name)}
          onClear={() => setPersonaAgent("", "")}
          emptyMsg="No persona agents"
          linkLabel="Agents"
        />

      </div>
    </div>
  );
}
