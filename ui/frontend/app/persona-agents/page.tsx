"use client";
import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Bot, Plus, Trash2, Save, Star, RefreshCw, Pencil, Check, X, Brain, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { SectionBuilder, PersonaSection } from "@/components/personas/SectionBuilder";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

interface PersonaAgent {
  id: string;
  name: string;
  description: string;
  persona_type: string;
  system_prompt: string;
  user_prompt: string;
  temperature: number;
  model: string;
  is_default?: boolean;
  sections: PersonaSection[];
  created_at: string;
  updated_at: string;
}

const TYPE_META: Record<string, { label: string; color: string }> = {
  agent_overall: { label: "Agent",    color: "text-violet-400 bg-violet-500/10 border-violet-500/30" },
  pair:          { label: "Pair",     color: "text-indigo-400 bg-indigo-500/10 border-indigo-500/30" },
  customer:      { label: "Customer", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
};

const MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5", "gpt-4.1", "gpt-4o", "claude-opus-4-6", "claude-sonnet-4-6", "gemini-2.5-pro"];

const BLANK: Partial<PersonaAgent> = {
  name: "", description: "", persona_type: "agent_overall",
  system_prompt: "", user_prompt: "", temperature: 0.3, model: "gpt-5.4", sections: [],
};

export default function PersonaAgentsPage() {
  const [panelW, panelDrag] = useResize(280, 200, 420);
  const { data: agents, mutate } = useSWR<PersonaAgent[]>(`${API}/persona-agents`, fetcher);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<PersonaAgent>>(BLANK);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null); // name as it was when loaded/saved
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Auto-select the starred (default) agent on first load
  useEffect(() => {
    if (!agents || selectedId || isNew) return;
    const starred = agents.find(a => a.is_default) ?? agents[0];
    if (starred) { setSelectedId(starred.id); setForm({ ...starred, sections: starred.sections ?? [] }); setSavedName(starred.name); }
  }, [agents]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  const set = (k: keyof PersonaAgent, v: any) => setForm(f => ({ ...f, [k]: v }));

  function selectAgent(a: PersonaAgent) {
    setSelectedId(a.id);
    setForm({ ...a, sections: a.sections ?? [] });
    setIsNew(false);
    setError(null);
    setEditingName(false);
    setSavedName(a.name);
  }

  function startNew() {
    setSelectedId(null);
    setForm(BLANK);
    setIsNew(true);
    setError(null);
    setEditingName(true);
    setNameDraft("");
  }

  async function loadDefaults() {
    const type = form.persona_type ?? "agent_overall";
    setLoadingDefaults(true);
    try {
      const res = await fetch(`${API}/personas/default-sections/${type}`);
      if (!res.ok) return;
      const data = await res.json();
      setForm(f => ({
        ...f,
        sections: data.sections ?? [],
        system_prompt: f.system_prompt || data.preamble || "",
      }));
    } catch {}
    finally { setLoadingDefaults(false); }
  }

  async function save() {
    if (!form.name?.trim()) { setError("Name is required"); return; }
    setSaving(true); setError(null);
    // If name changed on an existing agent, create a new one instead of overwriting
    const nameChanged = !isNew && savedName !== null && form.name.trim() !== savedName;
    const isCreate = isNew || nameChanged;
    try {
      const url = isCreate ? `${API}/persona-agents` : `${API}/persona-agents/${selectedId}`;
      const method = isCreate ? "POST" : "PUT";
      const res = await fetch(url, {
        method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, sections: form.sections ?? [] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved: PersonaAgent = await res.json();
      await mutate();
      setSelectedId(saved.id);
      setForm({ ...saved, sections: saved.sections ?? [] });
      setIsNew(false);
      setSavedName(saved.name);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!selectedId) return;
    setDeleting(true);
    try {
      await fetch(`${API}/persona-agents/${selectedId}`, { method: "DELETE" });
      await mutate();
      setSelectedId(null); setForm(BLANK); setIsNew(false);
    } catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  }

  async function toggleDefault(id: string, currentlyDefault: boolean) {
    if (currentlyDefault) {
      const agent = agents?.find(a => a.id === id);
      if (!agent) return;
      await fetch(`${API}/persona-agents/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_default: false }),
      });
    } else {
      await fetch(`${API}/persona-agents/${id}/default`, { method: "PATCH" });
    }
    const refreshed = await mutate();
    if (id === selectedId && refreshed) {
      const updated = refreshed.find(a => a.id === id);
      if (updated) setForm({ ...updated, sections: updated.sections ?? [] });
    }
  }

  const selectedMeta = TYPE_META[form.persona_type ?? "agent_overall"] ?? TYPE_META.agent_overall;
  const sections: PersonaSection[] = (form.sections as PersonaSection[]) ?? [];

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col">
      <div className="flex items-center gap-3 px-1 pb-3 shrink-0">
        <Link href="/analyzer" className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-indigo-400 transition-colors">
          <ChevronLeft className="w-3.5 h-3.5" />
          <Brain className="w-3.5 h-3.5" />
          Back to Analyzer
        </Link>
      </div>
    <div className="flex flex-1 min-h-0">

      {/* ── Left: agent list ── */}
      <div style={{ width: panelW }} className="flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
        <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-violet-400" />
          <h2 className="text-xs font-semibold text-white flex-1">Persona Agents</h2>
          <button onClick={startNew}
            className="p-1 rounded text-gray-500 hover:text-violet-300 hover:bg-violet-900/30 transition-colors" title="New persona agent">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {(agents ?? []).length === 0 && !isNew && (
            <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-2 p-4">
              <Bot className="w-8 h-8 opacity-20" />
              <p className="text-xs text-center">No persona agents yet.<br />Click + to create one.</p>
            </div>
          )}
          {isNew && (
            <div className="px-2 py-2 rounded-lg bg-violet-900/20 border border-violet-500/30 text-xs text-violet-300 font-medium">
              New agent…
            </div>
          )}
          {(agents ?? []).map(a => {
            const meta = TYPE_META[a.persona_type] ?? TYPE_META.agent_overall;
            return (
              <div key={a.id} className="group relative">
                <button onClick={() => selectAgent(a)}
                  className={cn(
                    "w-full text-left px-2 py-2 rounded-lg text-xs transition-colors pr-7",
                    selectedId === a.id && !isNew
                      ? "bg-violet-600/20 border border-violet-500/30 text-white"
                      : "text-gray-400 hover:bg-gray-800 hover:text-white"
                  )}>
                  <div className="font-medium truncate mb-0.5 flex items-center gap-1">
                    {a.is_default && <span className="text-yellow-400 text-[10px]">★</span>}
                    {a.name}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`px-1 py-0.5 rounded border text-[9px] font-semibold ${meta.color}`}>{meta.label}</span>
                    <span className="text-[10px] text-gray-600">{a.model}</span>
                    {(a.sections?.length ?? 0) > 0 && (
                      <span className="text-[9px] text-gray-600">{a.sections.length} sections</span>
                    )}
                  </div>
                </button>
                <button
                  onClick={() => toggleDefault(a.id, !!a.is_default)}
                  title={a.is_default ? "Remove default" : "Set as default"}
                  className={cn(
                    "absolute right-1.5 top-2 p-0.5 rounded transition-colors opacity-0 group-hover:opacity-100",
                    a.is_default ? "text-yellow-400 hover:text-yellow-300 opacity-100" : "text-gray-600 hover:text-yellow-400"
                  )}
                >
                  <Star className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <DragHandle onMouseDown={panelDrag} />

      {/* ── Right: edit form ── */}
      <div className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
        {!isNew && !selectedId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 gap-3">
            <Bot className="w-12 h-12 opacity-20" />
            <p className="text-sm">Select a persona agent or create a new one</p>
            <button onClick={startNew}
              className="flex items-center gap-2 px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white text-sm font-medium rounded-lg transition-colors">
              <Plus className="w-4 h-4" /> New Persona Agent
            </button>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2">
              <h2 className="text-xs font-semibold text-white flex-1 flex items-center gap-1.5">
                {form.is_default && <span className="text-yellow-400">★</span>}
                {isNew ? "New Persona Agent" : (form.name || "Edit")}
              </h2>
              {!isNew && selectedId && (
                <button onClick={() => toggleDefault(selectedId, !!form.is_default)}
                  title={form.is_default ? "Remove default" : "Set as default (loads first)"}
                  className={cn("p-1.5 rounded transition-colors",
                    form.is_default ? "text-yellow-400 hover:text-yellow-300 bg-yellow-900/20" : "text-gray-600 hover:text-yellow-400 hover:bg-yellow-900/10"
                  )}>
                  <Star className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={save} disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-700 hover:bg-violet-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors">
                <Save className="w-3 h-3" />
                {saving ? "Saving…" : "Save"}
              </button>
              {!isNew && (
                <button onClick={del} disabled={deleting}
                  className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {error && (
              <div className="mx-4 mt-3 px-3 py-2 bg-red-900/30 border border-red-700/50 rounded text-xs text-red-300">{error}</div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-5">

              {/* Name & Description */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Name *</label>
                  {editingName ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") { set("name", nameDraft); setEditingName(false); }
                          if (e.key === "Escape") { setNameDraft(form.name ?? ""); setEditingName(false); }
                        }}
                        placeholder="e.g. Sales Pattern Analyzer"
                        className="flex-1 px-2.5 py-1.5 bg-gray-800 border border-violet-500 rounded-md text-xs text-white placeholder-gray-600 focus:outline-none"
                      />
                      <button
                        onClick={() => { set("name", nameDraft); setEditingName(false); }}
                        className="p-1.5 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-900/20 rounded transition-colors" title="Save name">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => { setNameDraft(form.name ?? ""); setEditingName(false); }}
                        className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors" title="Cancel">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div
                      onClick={() => { setNameDraft(form.name ?? ""); setEditingName(true); }}
                      className="group flex items-center gap-2 px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-md cursor-pointer hover:border-violet-500/50 transition-colors"
                    >
                      <span className={cn("flex-1 text-xs truncate", form.name ? "text-white" : "text-gray-600 italic")}>
                        {form.name || "Click to set name…"}
                      </span>
                      <Pencil className="w-3 h-3 text-gray-600 group-hover:text-violet-400 shrink-0 transition-colors" />
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Description</label>
                  <input value={form.description ?? ""} onChange={e => set("description", e.target.value)}
                    placeholder="What this agent does"
                    className="w-full px-2.5 py-1.5 bg-gray-800 border border-gray-700 rounded-md text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500" />
                </div>
              </div>

              {/* Type + Model + Temperature */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Persona Type</label>
                  <select value={form.persona_type ?? "agent_overall"} onChange={e => set("persona_type", e.target.value)}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-md text-xs text-gray-200 focus:outline-none focus:border-violet-500">
                    <option value="agent_overall">Agent Overall</option>
                    <option value="pair">Pair</option>
                    <option value="customer">Customer</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">Model</label>
                  <select value={form.model ?? "gpt-5.4"} onChange={e => set("model", e.target.value)}
                    className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-md text-xs text-gray-200 focus:outline-none focus:border-violet-500">
                    {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider block mb-1">
                    Temperature: {form.temperature ?? 0.3}
                  </label>
                  <input type="range" min={0} max={1} step={0.05}
                    value={form.temperature ?? 0.3}
                    onChange={e => set("temperature", parseFloat(e.target.value))}
                    className="w-full accent-violet-500 h-1.5 mt-2" />
                  <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
                    <span>Precise</span><span>Creative</span>
                  </div>
                </div>
              </div>

              {/* Sections */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex-1">
                    Sections <span className="normal-case font-normal text-gray-600">— define what the LLM analyzes and how each section is scored</span>
                  </label>
                  <button onClick={loadDefaults} disabled={loadingDefaults}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-gray-500 hover:text-violet-400 hover:bg-violet-900/20 border border-gray-700 rounded transition-colors disabled:opacity-50">
                    <RefreshCw className={cn("w-3 h-3", loadingDefaults && "animate-spin")} />
                    Load Defaults
                  </button>
                </div>
                <SectionBuilder
                  sections={sections}
                  onChange={s => set("sections", s)}
                />
              </div>

              {/* Advanced: base preamble */}
              <div>
                <button onClick={() => setShowAdvanced(v => !v)}
                  className="flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors mb-2">
                  <span>{showAdvanced ? "▲" : "▼"}</span>
                  Advanced — Base Instructions (optional preamble prepended before sections)
                </button>
                {showAdvanced && (
                  <textarea
                    value={form.system_prompt ?? ""}
                    onChange={e => set("system_prompt", e.target.value)}
                    rows={4}
                    placeholder="You are a senior sales performance analyst… (leave empty to use the built-in default)"
                    className="w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded-md text-xs text-white placeholder-gray-600 focus:outline-none focus:border-violet-500 resize-y font-mono"
                  />
                )}
              </div>

            </div>
          </>
        )}
      </div>
    </div>
    </div>
  );
}
