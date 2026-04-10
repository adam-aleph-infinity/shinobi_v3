"use client";
import { useState, useEffect, useCallback } from "react";
import { Bookmark, Star, ChevronLeft, ChevronRight, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonaSection } from "./SectionBuilder";

const API = "/api";

export interface PresetSettings {
  id?: string;
  name: string;
  system_prompt: string;
  user_prompt?: string;
  model: string;
  temperature: number;
  is_default?: boolean;
  persona_type?: string;
  sections?: PersonaSection[];
  created_at: string;
}

interface Props {
  onLoad: (preset: PresetSettings) => void;
  currentSettings: () => Omit<PresetSettings, "name" | "created_at" | "is_default">;
  onDefaultApplied?: () => void;
}

export function AnalyzerPresetsPanel({ onLoad, currentSettings, onDefaultApplied }: Props) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("presets-panel-open") !== "false"; } catch { return true; }
  });
  const [agents, setAgents] = useState<PresetSettings[]>([]);
  const [tick, setTick] = useState(0);
  const [search, setSearch] = useState("");
  const defaultApplied = { current: false };

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    fetch(`${API}/persona-agents`)
      .then(r => r.json())
      .then((data: any[]) => {
        const mapped: PresetSettings[] = data.map(a => ({
          id: a.id,
          name: a.name,
          system_prompt: a.system_prompt || "",
          user_prompt: a.user_prompt || "",
          model: a.model || "gpt-5.4",
          temperature: a.temperature ?? 0.3,
          is_default: a.is_default ?? false,
          persona_type: a.persona_type || "agent_overall",
          sections: a.sections ?? [],
          created_at: a.created_at || "",
        }));
        setAgents(mapped);
        // Auto-apply default once on mount
        if (!defaultApplied.current) {
          const def = mapped.find(p => p.is_default);
          if (def) { onLoad(def); onDefaultApplied?.(); }
          defaultApplied.current = true;
        }
      })
      .catch(() => {});
  }, [tick]);

  useEffect(() => {
    try { localStorage.setItem("presets-panel-open", String(open)); } catch {}
  }, [open]);

  const setDefault = async (id: string, currentlyDefault: boolean) => {
    if (currentlyDefault) {
      await fetch(`${API}/persona-agents/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: false }),
      });
    } else {
      await fetch(`${API}/persona-agents/${id}/default`, { method: "PATCH" });
    }
    reload();
  };

  const filtered = agents.filter(a =>
    !search || a.name.toLowerCase().includes(search.toLowerCase())
  );

  const formatDate = (iso: string) => {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const TYPE_COLOR: Record<string, string> = {
    agent_overall: "text-violet-400",
    pair: "text-indigo-400",
    customer: "text-emerald-400",
  };

  if (!open) {
    return (
      <div className="flex flex-col items-center py-4 w-8 shrink-0">
        <button onClick={() => setOpen(true)}
          className="flex flex-col items-center gap-1 text-gray-600 hover:text-gray-300 transition-colors" title="Open agents panel">
          <Bot className="w-4 h-4" />
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-56 shrink-0 flex flex-col bg-gray-900 border border-gray-800 rounded-xl overflow-hidden self-start sticky top-4">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800">
        <Bot className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="text-xs font-semibold text-gray-300 flex-1">Persona Agents</span>
        <button onClick={() => setOpen(false)}
          className="p-1 text-gray-600 hover:text-gray-300 transition-colors" title="Collapse">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search */}
      {agents.length > 4 && (
        <div className="px-3 py-2 border-b border-gray-800">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500" />
        </div>
      )}

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto max-h-[60vh]">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-600 px-3 py-4 text-center">
            {agents.length === 0
              ? "No persona agents yet — create one in Persona Agents"
              : "No matches"}
          </p>
        ) : (
          filtered.map(a => (
            <div key={a.id ?? a.name}
              className={`group border-b border-gray-800/60 last:border-0 px-3 py-2.5 hover:bg-gray-800/50 transition-colors ${a.is_default ? "bg-indigo-900/10" : ""}`}>
              <button onClick={() => onLoad(a)} className="w-full text-left">
                <span className={cn("block text-xs font-medium truncate", a.is_default ? "text-indigo-300" : "text-white")}>
                  {a.is_default && <span className="text-yellow-400 mr-1">★</span>}
                  {a.name}
                </span>
                <span className="text-[10px] text-gray-500 flex items-center gap-1.5 mt-0.5">
                  <span className={cn("font-medium", TYPE_COLOR[a.persona_type ?? "agent_overall"])}>
                    {a.persona_type === "agent_overall" ? "Agent" : a.persona_type === "pair" ? "Pair" : "Customer"}
                  </span>
                  <span>·</span>
                  <span>{a.model}</span>
                  {a.sections && a.sections.length > 0 && (
                    <><span>·</span><span>{a.sections.length}§</span></>
                  )}
                  {a.created_at && <><span>·</span><span>{formatDate(a.created_at)}</span></>}
                </span>
              </button>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1">
                <button
                  onClick={() => setDefault(a.id!, !!a.is_default)}
                  className={cn("p-0.5 transition-colors", a.is_default ? "text-yellow-400 hover:text-yellow-300" : "text-gray-600 hover:text-yellow-400")}
                  title={a.is_default ? "Remove default" : "Set as default"}>
                  <Star className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-gray-800">
        <a href="/persona-agents"
          className="block text-center text-[10px] text-gray-600 hover:text-violet-400 transition-colors">
          Manage agents →
        </a>
      </div>
    </div>
  );
}
