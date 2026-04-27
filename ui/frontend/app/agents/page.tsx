"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp,
  X, Download, Mic2, Layers, BookOpen, PenLine, StickyNote,
  User, Star, Shield, Zap, Play, FileText, Braces, AlignLeft, Copy,
  BadgeCheck, ShieldCheck,
  Boxes, SlidersHorizontal, Sparkles,
  Maximize2, Minimize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppCtx } from "@/lib/app-context";

const fetcher = (url: string) => fetch(url).then(r => r.json());

// ── Models ────────────────────────────────────────────────────────────────────

const MODEL_GROUPS = [
  { provider: "OpenAI",    models: ["gpt-5.4", "gpt-4.1", "gpt-4.1-mini"] },
  { provider: "Anthropic", models: ["claude-opus-4-6", "claude-sonnet-4-6"] },
  { provider: "Google",    models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { provider: "xAI",       models: ["grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"] },
];

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500">
      {MODEL_GROUPS.map(g => (
        <optgroup key={g.provider} label={g.provider}>
          {g.models.map(m => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// ── Input sources ─────────────────────────────────────────────────────────────

type InputCategory = "input" | "artifact";

const INPUT_SOURCES_BY_CAT = {
  input: [
    { value: "transcript",        label: "Transcript",        icon: Mic2,      badge: "bg-blue-900/50 text-blue-300 border-blue-700/50",       needsCall: true  },
    { value: "merged_transcript", label: "Merged Transcript", icon: Layers,    badge: "bg-cyan-900/50 text-cyan-300 border-cyan-700/50",       needsCall: false },
    { value: "notes",             label: "Call Notes",        icon: StickyNote,badge: "bg-green-900/50 text-green-300 border-green-700/50",    needsCall: true  },
    { value: "merged_notes",      label: "Merged Notes",      icon: BookOpen,  badge: "bg-teal-900/50 text-teal-300 border-teal-700/50",      needsCall: false },
    { value: "manual",            label: "Manual",            icon: PenLine,   badge: "bg-gray-700/50 text-gray-300 border-gray-600/50",      needsCall: false },
  ],
  artifact: [
    { value: "artifact_persona",          label: "Persona",          icon: User,       badge: "bg-violet-900/50 text-violet-300 border-violet-700/50",  needsCall: false },
    { value: "artifact_persona_score",    label: "Persona Score",    icon: BadgeCheck, badge: "bg-violet-900/40 text-violet-400 border-violet-700/40",  needsCall: false },
    { value: "artifact_notes",            label: "Notes",            icon: StickyNote, badge: "bg-amber-900/50 text-amber-300 border-amber-700/50",    needsCall: false },
    { value: "artifact_notes_compliance", label: "Compliance Notes", icon: ShieldCheck,badge: "bg-emerald-900/50 text-emerald-300 border-emerald-700/50", needsCall: false },
  ],
} as const;

const ALL_INPUT_SOURCES = [...INPUT_SOURCES_BY_CAT.input, ...INPUT_SOURCES_BY_CAT.artifact];

type SourceValue = typeof ALL_INPUT_SOURCES[number]["value"];

// Map each source value to its category
const SOURCE_CATEGORY: Record<string, InputCategory> = {
  transcript: "input", merged_transcript: "input", notes: "input",
  merged_notes: "input", manual: "input",
  artifact_persona: "artifact", artifact_persona_score: "artifact",
  artifact_notes: "artifact", artifact_notes_compliance: "artifact",
};

function srcMeta(source: string) {
  return ALL_INPUT_SOURCES.find(s => s.value === source) ?? ALL_INPUT_SOURCES[4];
}

function srcCategory(source: string): InputCategory {
  return SOURCE_CATEGORY[source] ?? "input";
}

// ── Output formats ────────────────────────────────────────────────────────────

const OUTPUT_FMT: Record<string, {
  label: string; icon: React.ComponentType<{ className?: string }>;
  bg: string; text: string; border: string;
}> = {
  markdown: { label: "Markdown", icon: FileText,  bg: "bg-indigo-900/50", text: "text-indigo-300",  border: "border-indigo-700/40" },
  json:     { label: "JSON",     icon: Braces,    bg: "bg-yellow-900/50", text: "text-yellow-300", border: "border-yellow-700/40" },
  text:     { label: "Text",     icon: AlignLeft, bg: "bg-gray-700/50",   text: "text-gray-300",   border: "border-gray-600/40"   },
};

// ── Agent class metadata ──────────────────────────────────────────────────────

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  persona: User, scorer: Star, notes: StickyNote, compliance: Shield, general: Zap,
};
const CLASS_ICON_BG: Record<string, string> = {
  persona: "bg-violet-900/60", scorer: "bg-violet-800/40",
  notes: "bg-teal-900/60", compliance: "bg-teal-800/40", general: "bg-sky-900/60",
};
const CLASS_META: Record<string, { label: string; textColor: string; borderColor: string }> = {
  persona:    { label: "Persona",    textColor: "text-violet-300", borderColor: "border-violet-700/40" },
  scorer:     { label: "Scorer",     textColor: "text-violet-400", borderColor: "border-violet-700/30" },
  notes:      { label: "Notes",      textColor: "text-teal-300",   borderColor: "border-teal-700/40"   },
  compliance: { label: "Compliance", textColor: "text-teal-400",   borderColor: "border-teal-700/30"   },
  general:    { label: "General",    textColor: "text-sky-300",    borderColor: "border-sky-700/40"    },
  "":         { label: "Agent",      textColor: "text-gray-400",   borderColor: "border-gray-700/40"   },
};
const CLASS_TYPES = [
  { cls: "persona",    label: "Persona" },
  { cls: "scorer",     label: "Scorer" },
  { cls: "notes",      label: "Notes" },
  { cls: "compliance", label: "Compliance" },
  { cls: "general",    label: "General" },
];

function classMeta(cls: string) {
  return CLASS_META[(cls ?? "").toLowerCase()] ?? { label: cls || "Agent", textColor: "text-gray-400", borderColor: "border-gray-700/40" };
}

function ClassIcon({ cls }: { cls: string }) {
  const norm = (cls ?? "").toLowerCase();
  const Icon = CLASS_ICON[norm] ?? Bot;
  const bg   = CLASS_ICON_BG[norm] ?? "bg-gray-800";
  const meta = classMeta(norm);
  return (
    <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", bg)}>
      <Icon className={cn("w-4 h-4", meta.textColor)} />
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type MergedScope = "auto" | "all" | "upto_call";
interface AgentInput {
  key: string;
  source: SourceValue;
  agent_id?: string;
  merged_scope?: MergedScope;
  merged_until_call_id?: string;
}

interface Persona {
  id: string; type: string; agent: string; customer?: string; label?: string;
  content_md: string; score_json?: string; model: string; created_at: string; version: number;
}
interface Note {
  id: string; agent: string; customer: string; call_id: string;
  content_md: string; score_json?: string; created_at: string;
}

interface UniversalAgent {
  id: string; name: string; description: string; agent_class: string;
  model: string; temperature: number; system_prompt: string; user_prompt: string;
  inputs: AgentInput[]; output_format: string; tags: string[];
  artifact_type?: string;
  artifact_class?: string;
  output_schema?: string;
  output_taxonomy?: string[];
  output_contract_mode?: "off" | "soft" | "strict";
  output_fit_strategy?: "structured" | "raw";
  is_default: boolean; created_at: string;
  updated_at?: string;
  folder?: string;
}

interface PipelineDef {
  id: string;
  name: string;
  description?: string;
  folder?: string;
  scope?: string;
  steps: { agent_id: string; input_overrides: Record<string, string> }[];
  canvas?: { nodes: any[]; edges: any[]; stages: string[] };
}

const BLANK_AGENT = {
  name: "New Agent", description: "", agent_class: "general",
  model: "gpt-5.4", temperature: 0,
  system_prompt: "", user_prompt: "",
  inputs: [{ key: "transcript", source: "transcript" as SourceValue, merged_scope: "auto" as MergedScope, merged_until_call_id: "" }],
  output_format: "markdown", tags: [], is_default: false, folder: "",
  artifact_type: "",
  artifact_class: "",
  output_schema: "",
  output_taxonomy: [] as string[],
  output_contract_mode: "soft" as "off" | "soft" | "strict",
  output_fit_strategy: "structured" as "structured" | "raw",
};

const MERGED_SCOPE_OPTIONS: { value: MergedScope; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Use selected call when available" },
  { value: "all", label: "All Calls", hint: "Always use full merged history" },
  { value: "upto_call", label: "Up To Call", hint: "Use selected/fixed call cutoff" },
];

const OUTPUT_CONTRACT_MODES = [
  { value: "off", label: "Off" },
  { value: "soft", label: "Soft" },
  { value: "strict", label: "Strict" },
] as const;

const OUTPUT_FIT_STRATEGIES = [
  { value: "structured", label: "Structured first" },
  { value: "raw", label: "Raw first" },
] as const;

function normalizeAgentInput(inp: AgentInput): AgentInput {
  const mergedScope = (inp.merged_scope ?? "auto") as MergedScope;
  return {
    ...inp,
    merged_scope: ["auto", "all", "upto_call"].includes(mergedScope) ? mergedScope : "auto",
    merged_until_call_id: inp.merged_until_call_id ?? "",
  };
}

function normalizeAgent(a: UniversalAgent): UniversalAgent {
  return {
    ...a,
    inputs: (a.inputs ?? []).map(normalizeAgentInput),
    artifact_type: a.artifact_type ?? "",
    artifact_class: a.artifact_class ?? "",
    output_schema: a.output_schema ?? "",
    output_taxonomy: a.output_taxonomy ?? [],
    output_contract_mode: (a.output_contract_mode ?? "soft"),
    output_fit_strategy: (a.output_fit_strategy ?? "structured"),
  };
}

// ── AgentEditor ───────────────────────────────────────────────────────────────

function AgentEditor({
  agent, allAgents, onSave, onDelete, onCopy, onToggleExpand, isExpanded,
}: {
  agent: UniversalAgent; allAgents: UniversalAgent[];
  onSave: (draft: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
  onDelete: () => void;
  onCopy: () => void;
  onToggleExpand: () => void;
  isExpanded: boolean;
}) {
  const [draft, setDraft] = useState<Omit<UniversalAgent, "id" | "created_at">>({
    name: agent.name, description: agent.description ?? "",
    agent_class: agent.agent_class, model: agent.model,
    temperature: agent.temperature, system_prompt: agent.system_prompt,
    user_prompt: agent.user_prompt, inputs: (agent.inputs ?? []).map(normalizeAgentInput),
    output_format: agent.output_format ?? "markdown",
    artifact_type: agent.artifact_type ?? "",
    artifact_class: agent.artifact_class ?? "",
    output_schema: agent.output_schema ?? "",
    output_taxonomy: agent.output_taxonomy ?? [],
    output_contract_mode: agent.output_contract_mode ?? "soft",
    output_fit_strategy: agent.output_fit_strategy ?? "structured",
    tags: agent.tags ?? [], is_default: agent.is_default ?? false,
    folder: agent.folder ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [showModel, setShowModel] = useState(false);

  useEffect(() => {
    setDraft({
      name: agent.name, description: agent.description ?? "",
      agent_class: agent.agent_class, model: agent.model,
      temperature: agent.temperature, system_prompt: agent.system_prompt,
      user_prompt: agent.user_prompt, inputs: (agent.inputs ?? []).map(normalizeAgentInput),
      output_format: agent.output_format ?? "markdown",
      artifact_type: agent.artifact_type ?? "",
      artifact_class: agent.artifact_class ?? "",
      output_schema: agent.output_schema ?? "",
      output_taxonomy: agent.output_taxonomy ?? [],
      output_contract_mode: agent.output_contract_mode ?? "soft",
      output_fit_strategy: agent.output_fit_strategy ?? "structured",
      tags: agent.tags ?? [], is_default: agent.is_default ?? false,
      folder: agent.folder ?? "",
    });
    setSaved(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.folder]);

  async function save() {
    setSaving(true);
    try { await onSave(draft); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    finally { setSaving(false); }
  }

  const varKeys = draft.inputs.filter(i => i.key);
  const cm = classMeta(draft.agent_class);

  function insertVar(field: "system_prompt" | "user_prompt", key: string) {
    setDraft(f => ({ ...f, [field]: f[field] + `{${key}}` }));
  }

  function addInput() {
    const newKey = `input_${draft.inputs.length + 1}`;
    setDraft(f => ({
      ...f,
      inputs: [...f.inputs, { key: newKey, source: "manual" as SourceValue, merged_scope: "auto", merged_until_call_id: "" }],
    }));
  }

  function removeInput(idx: number) {
    setDraft(f => ({ ...f, inputs: f.inputs.filter((_, i) => i !== idx) }));
  }

  function updateInput(idx: number, patch: Partial<AgentInput>) {
    setDraft(f => {
      const inputs = [...f.inputs];
      inputs[idx] = { ...inputs[idx], ...patch };
      return { ...f, inputs };
    });
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
        <ClassIcon cls={draft.agent_class} />
        <div className="flex-1 min-w-0">
          <input
            value={draft.name}
            onChange={e => setDraft(f => ({ ...f, name: e.target.value }))}
            className="w-full bg-transparent text-sm font-bold text-white outline-none placeholder-gray-600 border-b border-transparent focus:border-gray-600 pb-0.5 transition-colors"
            placeholder="Agent name…"
          />
          <p className={cn("text-[10px] mt-0.5", cm.textColor)}>{cm.label || "—"}</p>
        </div>
        <button
          onClick={onToggleExpand}
          className="p-1.5 text-gray-500 hover:text-indigo-300 transition-colors shrink-0"
          title={isExpanded ? "Restore split view" : "Expand properties panel"}
        >
          {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
        <button
          onClick={onCopy}
          className="p-1.5 text-gray-500 hover:text-indigo-300 transition-colors shrink-0"
          title="Copy agent">
          <Copy className="w-4 h-4" />
        </button>
        <button
          onClick={() => { if (confirm(`Delete "${agent.name}"? This cannot be undone.`)) onDelete(); }}
          className="p-1.5 text-red-500/50 hover:text-red-400 transition-colors shrink-0"
          title="Delete agent">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 p-4 space-y-4 min-h-0">

        {/* Class pills */}
        <div>
          <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1.5">Class</label>
          <div className="flex flex-wrap gap-1">
            {CLASS_TYPES.map(t => {
              const m = classMeta(t.cls);
              const isSel = draft.agent_class === t.cls;
              return (
                <button key={t.cls} onClick={() => setDraft(f => ({ ...f, agent_class: t.cls }))}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-[10px] font-medium border transition-all",
                    isSel ? cn(m.borderColor, "text-white bg-gray-800") : "border-gray-700/50 text-gray-500 hover:text-gray-300 hover:border-gray-600",
                  )}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* System prompt */}
        <div>
          <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">System Prompt</label>
          {varKeys.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {varKeys.map(inp => (
                <button key={inp.key} type="button"
                  onClick={() => insertVar("system_prompt", inp.key)}
                  className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 font-mono transition-colors">
                  {`{${inp.key}}`}
                </button>
              ))}
            </div>
          )}
          <textarea value={draft.system_prompt}
            onChange={e => setDraft(f => ({ ...f, system_prompt: e.target.value }))}
            rows={5} placeholder="You are a…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
        </div>

        {/* User prompt */}
        <div>
          <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">User Prompt</label>
          {varKeys.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1.5">
              {varKeys.map(inp => (
                <button key={inp.key} type="button"
                  onClick={() => insertVar("user_prompt", inp.key)}
                  className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 font-mono transition-colors">
                  {`{${inp.key}}`}
                </button>
              ))}
            </div>
          )}
          <textarea value={draft.user_prompt}
            onChange={e => setDraft(f => ({ ...f, user_prompt: e.target.value }))}
            rows={6} placeholder={"Analyse this:\n\n{transcript}"}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
        </div>

        {/* Inputs */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[9px] text-gray-500 uppercase tracking-wide">Inputs</label>
            <button onClick={addInput}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-0.5">
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <div className="space-y-2">
            {draft.inputs.map((inp, i) => {
              const cat = srcCategory(inp.source);
              const sm  = srcMeta(inp.source);
              const SrcIcon = sm.icon;
              const catSources = INPUT_SOURCES_BY_CAT[cat];
              return (
                <div key={i} className="rounded-lg border border-gray-700/50 bg-gray-800/40 overflow-hidden">
                  {/* Row 1: key + category toggle + remove */}
                  <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
                    <span className={cn("p-0.5 rounded border shrink-0", sm.badge)}>
                      <SrcIcon className="w-3 h-3" />
                    </span>
                    <input
                      value={inp.key}
                      onChange={e => updateInput(i, { key: e.target.value })}
                      placeholder="key"
                      className="w-20 bg-transparent text-[10px] text-amber-300 font-mono outline-none border-b border-transparent focus:border-amber-700"
                    />
                    <div className="flex items-center rounded border border-gray-700 overflow-hidden text-[9px] font-medium ml-auto">
                      {(["input", "artifact"] as InputCategory[]).map(c => (
                        <button key={c} onClick={() => {
                          const defaultSrc = INPUT_SOURCES_BY_CAT[c][0].value as SourceValue;
                          updateInput(i, {
                            source: defaultSrc,
                            agent_id: undefined,
                            merged_scope: "auto",
                            merged_until_call_id: "",
                          });
                        }}
                          className={cn(
                            "px-2 py-0.5 transition-colors capitalize",
                            cat === c
                              ? c === "input"
                                ? "bg-cyan-800/60 text-cyan-300"
                                : "bg-purple-800/60 text-purple-300"
                              : "text-gray-600 hover:text-gray-400",
                          )}>
                          {c}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => removeInput(i)}
                      className="p-0.5 text-gray-600 hover:text-red-400 transition-colors shrink-0">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  {/* Row 2: source within category */}
                  <div className="flex items-center gap-1.5 px-2 pb-2">
                    <select value={inp.source}
                      onChange={e => updateInput(i, {
                        source: e.target.value as SourceValue,
                        agent_id: undefined,
                        merged_scope: inp.merged_scope ?? "auto",
                        merged_until_call_id: inp.merged_until_call_id ?? "",
                      })}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 outline-none focus:border-indigo-500">
                      {catSources.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  {(inp.source === "merged_transcript" || inp.source === "merged_notes") && (
                    <div className="px-2 pb-2 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <select
                          value={inp.merged_scope ?? "auto"}
                          onChange={e => updateInput(i, { merged_scope: e.target.value as MergedScope })}
                          className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 outline-none focus:border-indigo-500"
                        >
                          {MERGED_SCOPE_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <span className="text-[9px] text-gray-600 whitespace-nowrap">Merged scope</span>
                      </div>
                      {(inp.merged_scope ?? "auto") === "upto_call" && (
                        <input
                          value={inp.merged_until_call_id ?? ""}
                          onChange={e => updateInput(i, { merged_until_call_id: e.target.value })}
                          placeholder="Optional fixed call id (else selected call)"
                          className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-300 font-mono outline-none focus:border-indigo-500"
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {draft.inputs.length === 0 && (
              <p className="text-[10px] text-gray-700 italic px-1">No inputs — click Add</p>
            )}
          </div>
        </div>

        {/* Model & settings */}
        <div className="border border-gray-800 rounded-xl overflow-hidden">
          <button onClick={() => setShowModel(s => !s)}
            className="w-full flex items-center justify-between px-3 py-2 bg-gray-900 hover:bg-gray-800 transition-colors text-xs">
            <span className="text-gray-400">
              Model &amp; settings · <span className="text-gray-600">{draft.model}</span>
            </span>
            {showModel
              ? <ChevronUp className="w-3.5 h-3.5 text-gray-600" />
              : <ChevronDown className="w-3.5 h-3.5 text-gray-600" />}
          </button>
          {showModel && (
            <div className="p-3 space-y-2.5 border-t border-gray-800">
              <div>
                <label className="block text-[9px] text-gray-500 mb-1">Model</label>
                <ModelSelect value={draft.model} onChange={v => setDraft(f => ({ ...f, model: v }))} />
              </div>
              <div>
                <label className="block text-[9px] text-gray-500 mb-1">Temperature</label>
                <input type="number" min={0} max={2} step={0.1} value={draft.temperature}
                  onChange={e => setDraft(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="block text-[9px] text-gray-500 mb-1.5">Output Format</label>
                <div className="flex gap-1.5">
                  {Object.entries(OUTPUT_FMT).map(([k, m]) => {
                    const FmtIcon = m.icon;
                    const sel = draft.output_format === k;
                    return (
                      <button key={k} onClick={() => setDraft(f => ({ ...f, output_format: k }))}
                        className={cn(
                          "flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg border text-[9px] transition-all",
                          sel ? cn(m.border, m.bg) : "border-gray-800 bg-gray-900 hover:border-gray-700",
                        )}>
                        <FmtIcon className={cn("w-3.5 h-3.5", sel ? m.text : "text-gray-600")} />
                        <span className={sel ? m.text : "text-gray-500"}>{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Save */}
        <button onClick={save} disabled={saving || !draft.name.trim()}
          className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
          {saved ? "Saved" : "Save agent"}
        </button>
      </div>
    </div>
  );
}

function InputContractsPanel({
  agent,
  allAgents,
  onSave,
}: {
  agent: UniversalAgent;
  allAgents: UniversalAgent[];
  onSave: (draft: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
}) {
  const { salesAgent, customer, callId } = useAppCtx();
  const [inputs, setInputs] = useState<AgentInput[]>((agent.inputs ?? []).map(normalizeAgentInput));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [previews, setPreviews] = useState<Record<string, { loading: boolean; chars: number; content: string; err?: string }>>({});
  const inputKeyOptions = useMemo(() => {
    const out = new Set<string>();
    for (const a of allAgents) {
      for (const inp of (a.inputs ?? [])) {
        const k = String(inp?.key || "").trim();
        if (k) out.add(k);
      }
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
  }, [allAgents]);

  useEffect(() => {
    setInputs((agent.inputs ?? []).map(normalizeAgentInput));
    setPreviews({});
  }, [agent.id, agent.updated_at, agent.inputs]);

  function updateInput(idx: number, patch: Partial<AgentInput>) {
    setInputs(prev => {
      const next = [...prev];
      next[idx] = normalizeAgentInput({ ...next[idx], ...patch });
      return next;
    });
  }

  function addInput() {
    setInputs(prev => [
      ...prev,
      { key: `input_${prev.length + 1}`, source: "manual", merged_scope: "auto", merged_until_call_id: "" },
    ]);
  }

  function removeInput(idx: number) {
    setInputs(prev => prev.filter((_, i) => i !== idx));
  }

  async function previewInput(inp: AgentInput) {
    if (!salesAgent || !customer) return;
    const previewKey = inp.key || String(Math.random());
    setPreviews(prev => ({ ...prev, [previewKey]: { loading: true, chars: 0, content: "" } }));
    try {
      const params = new URLSearchParams({
        source: inp.source,
        sales_agent: salesAgent,
        customer,
        call_id: callId || "",
      });
      if (inp.agent_id) params.set("agent_id", inp.agent_id);
      if (inp.source === "merged_transcript" || inp.source === "merged_notes") {
        params.set("merged_scope", inp.merged_scope ?? "auto");
        if (inp.merged_until_call_id) params.set("merged_until_call_id", inp.merged_until_call_id);
      }
      const res = await fetch(`/api/universal-agents/raw-input?${params.toString()}`);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `${res.status}`);
      }
      const data = await res.json();
      const content = String(data.content || "");
      setPreviews(prev => ({
        ...prev,
        [previewKey]: { loading: false, chars: content.length, content },
      }));
    } catch (e: any) {
      setPreviews(prev => ({
        ...prev,
        [previewKey]: { loading: false, chars: 0, content: "", err: String(e?.message || e || "failed") },
      }));
    }
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({
        name: agent.name,
        description: agent.description ?? "",
        agent_class: agent.agent_class ?? "general",
        model: agent.model ?? "gpt-5.4",
        temperature: agent.temperature ?? 0,
        system_prompt: agent.system_prompt ?? "",
        user_prompt: agent.user_prompt ?? "",
        inputs,
        output_format: agent.output_format ?? "markdown",
        artifact_type: agent.artifact_type ?? "",
        artifact_class: agent.artifact_class ?? "",
        output_schema: agent.output_schema ?? "",
        output_taxonomy: agent.output_taxonomy ?? [],
        output_contract_mode: agent.output_contract_mode ?? "soft",
        output_fit_strategy: agent.output_fit_strategy ?? "structured",
        tags: agent.tags ?? [],
        is_default: agent.is_default ?? false,
        folder: agent.folder ?? "",
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-800 shrink-0">
        <p className="text-xs font-semibold text-white">Input Contracts</p>
        <p className="text-[10px] text-gray-500 mt-0.5">Define each input and how merged sources resolve (all calls vs up-to-call).</p>
      </div>
      <div className="flex-1 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide">Inputs</p>
          <button onClick={addInput} className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1">
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>

        {inputs.map((inp, i) => {
          const cat = srcCategory(inp.source);
          const catSources = INPUT_SOURCES_BY_CAT[cat];
          const meta = srcMeta(inp.source);
          const previewKey = inp.key || `${i}`;
          const pv = previews[previewKey];
          return (
            <div key={`${inp.key}-${i}`} className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-2 space-y-2">
              <div className="flex items-center gap-1.5">
                <input
                  value={inp.key}
                  onChange={e => updateInput(i, { key: e.target.value })}
                  placeholder="input key"
                  list="agents-artifacts-input-keys"
                  className="w-36 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-amber-300 font-mono outline-none focus:border-indigo-500"
                />
                <select
                  value={inp.source}
                  onChange={e => updateInput(i, { source: e.target.value as SourceValue, agent_id: undefined })}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-300 outline-none focus:border-indigo-500"
                >
                  {catSources.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <button onClick={() => removeInput(i)} className="p-1 text-gray-600 hover:text-red-400 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>

              {(inp.source === "merged_transcript" || inp.source === "merged_notes") && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[9px] text-gray-500 mb-1">Merged scope</label>
                    <select
                      value={inp.merged_scope ?? "auto"}
                      onChange={e => updateInput(i, { merged_scope: e.target.value as MergedScope })}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-300 outline-none focus:border-indigo-500"
                    >
                      {MERGED_SCOPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] text-gray-500 mb-1">Fixed cutoff call id (optional)</label>
                    <input
                      value={inp.merged_until_call_id ?? ""}
                      onChange={e => updateInput(i, { merged_until_call_id: e.target.value })}
                      placeholder="e.g. 66213"
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-300 font-mono outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={() => previewInput(inp)}
                  disabled={!salesAgent || !customer}
                  className="text-[10px] px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40 transition-colors"
                >
                  Preview Input
                </button>
                <span className="text-[9px] text-gray-600">{meta.label}</span>
              </div>
              {pv && (
                <div className="rounded border border-gray-800 bg-gray-900/60 p-2">
                  {pv.loading ? (
                    <p className="text-[9px] text-gray-500 flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" /> Loading preview…</p>
                  ) : pv.err ? (
                    <p className="text-[9px] text-amber-400 break-words">{pv.err}</p>
                  ) : (
                    <>
                      <p className="text-[9px] text-emerald-400">Loaded {pv.chars.toLocaleString()} chars</p>
                      <pre className="mt-1 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words max-h-80 overflow-y-auto">{pv.content}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <datalist id="agents-artifacts-input-keys">
          {inputKeyOptions.map(k => <option key={k} value={k} />)}
        </datalist>

        {inputs.length === 0 && (
          <p className="text-[10px] text-gray-700 italic">No inputs defined.</p>
        )}

        <button
          onClick={save}
          disabled={saving}
          className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
          {saved ? "Saved" : "Save input contracts"}
        </button>
      </div>
    </div>
  );
}

function OutputContractsPanel({
  agent,
  allAgents,
  onSave,
}: {
  agent: UniversalAgent;
  allAgents: UniversalAgent[];
  onSave: (draft: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
}) {
  const [artifactType, setArtifactType] = useState(agent.artifact_type ?? "");
  const [artifactClass, setArtifactClass] = useState(agent.artifact_class ?? "");
  const [schema, setSchema] = useState(agent.output_schema ?? "");
  const [taxonomyText, setTaxonomyText] = useState((agent.output_taxonomy ?? []).join("\n"));
  const [contractMode, setContractMode] = useState<"off" | "soft" | "strict">(agent.output_contract_mode ?? "soft");
  const [fitStrategy, setFitStrategy] = useState<"structured" | "raw">(agent.output_fit_strategy ?? "structured");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [rawOutput, setRawOutput] = useState("");
  const [fitLoading, setFitLoading] = useState(false);
  const [fitResult, setFitResult] = useState<any>(null);
  const [fitError, setFitError] = useState("");
  const artifactTypeOptions = useMemo(() => {
    const defaults = ["notes", "persona", "persona_score", "notes_compliance", "compliance", "summary"];
    const out = new Set<string>(defaults);
    for (const a of allAgents) {
      const t = String(a.artifact_type || "").trim();
      if (t) out.add(t);
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
  }, [allAgents]);
  const artifactClassOptions = useMemo(() => {
    const defaults = ["call_level_tracking", "summary", "score", "compliance", "json_schema"];
    const out = new Set<string>(defaults);
    for (const a of allAgents) {
      const t = String(a.artifact_class || "").trim();
      if (t) out.add(t);
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
  }, [allAgents]);

  useEffect(() => {
    setArtifactType(agent.artifact_type ?? "");
    setArtifactClass(agent.artifact_class ?? "");
    setSchema(agent.output_schema ?? "");
    setTaxonomyText((agent.output_taxonomy ?? []).join("\n"));
    setContractMode(agent.output_contract_mode ?? "soft");
    setFitStrategy(agent.output_fit_strategy ?? "structured");
    setFitResult(null);
    setFitError("");
  }, [agent.id, agent.updated_at, agent.artifact_type, agent.artifact_class, agent.output_schema, agent.output_taxonomy, agent.output_contract_mode, agent.output_fit_strategy]);

  function taxonomyList() {
    return taxonomyText
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
  }

  function inferArtifactSubType() {
    const cls = (artifactClass || "").trim().toLowerCase();
    if (cls) return cls.replace(/\s+/g, "_");
    const acls = (agent.agent_class || "").toLowerCase();
    if (acls === "scorer") return "persona_score";
    if (acls === "notes") return "notes";
    if (acls === "persona") return "persona";
    return "output";
  }

  async function autoInferSchema() {
    setSchemaLoading(true);
    try {
      const subType = inferArtifactSubType();
      const res = await fetch(`/api/pipelines/artifact-template?agent_id=${encodeURIComponent(agent.id)}&artifact_sub_type=${encodeURIComponent(subType)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSchema(String(data.schema_template || ""));
      const tax = Array.isArray(data.taxonomy) ? data.taxonomy.map((x: any) => String(x || "").trim()).filter(Boolean) : [];
      if (tax.length > 0) setTaxonomyText(tax.join("\n"));
    } catch (e: any) {
      setFitError(`Schema inference failed: ${String(e?.message || e || "error")}`);
    } finally {
      setSchemaLoading(false);
    }
  }

  async function runFit(prefer: "structured" | "raw") {
    if (!rawOutput.trim()) return;
    setFitLoading(true);
    setFitError("");
    try {
      const res = await fetch(`/api/universal-agents/${agent.id}/test-fit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_output: rawOutput, prefer }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFitResult(data);
    } catch (e: any) {
      setFitError(String(e?.message || e || "fit failed"));
      setFitResult(null);
    } finally {
      setFitLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({
        name: agent.name,
        description: agent.description ?? "",
        agent_class: agent.agent_class ?? "general",
        model: agent.model ?? "gpt-5.4",
        temperature: agent.temperature ?? 0,
        system_prompt: agent.system_prompt ?? "",
        user_prompt: agent.user_prompt ?? "",
        inputs: (agent.inputs ?? []).map(normalizeAgentInput),
        output_format: agent.output_format ?? "markdown",
        artifact_type: artifactType.trim(),
        artifact_class: artifactClass.trim(),
        output_schema: schema,
        output_taxonomy: taxonomyList(),
        output_contract_mode: contractMode,
        output_fit_strategy: fitStrategy,
        tags: agent.tags ?? [],
        is_default: agent.is_default ?? false,
        folder: agent.folder ?? "",
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-800 shrink-0">
        <p className="text-xs font-semibold text-white">Output Artifact Contract</p>
        <p className="text-[10px] text-gray-500 mt-0.5">Define artifact type/class, schema, taxonomy, and fit behavior for this agent output.</p>
      </div>
      <div className="flex-1 p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">Artifact Type</label>
            <input
              value={artifactType}
              onChange={e => setArtifactType(e.target.value)}
              list="agents-artifacts-output-types"
              placeholder="notes / persona / compliance / custom"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">Artifact Class</label>
            <input
              value={artifactClass}
              onChange={e => setArtifactClass(e.target.value)}
              list="agents-artifacts-output-classes"
              placeholder="call_level_tracking / summary / score / custom"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>
        </div>
        <datalist id="agents-artifacts-output-types">
          {artifactTypeOptions.map(t => <option key={t} value={t} />)}
        </datalist>
        <datalist id="agents-artifacts-output-classes">
          {artifactClassOptions.map(t => <option key={t} value={t} />)}
        </datalist>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">Contract Mode</label>
            <select
              value={contractMode}
              onChange={e => setContractMode(e.target.value as "off" | "soft" | "strict")}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
            >
              {OUTPUT_CONTRACT_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">Fit Preference</label>
            <select
              value={fitStrategy}
              onChange={e => setFitStrategy(e.target.value as "structured" | "raw")}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
            >
              {OUTPUT_FIT_STRATEGIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[9px] text-gray-500 uppercase tracking-wide">Required Output Schema</label>
            <button
              onClick={autoInferSchema}
              disabled={schemaLoading}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-40 flex items-center gap-1"
            >
              {schemaLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Auto from prompts
            </button>
          </div>
          <textarea
            value={schema}
            onChange={e => setSchema(e.target.value)}
            rows={14}
            placeholder="Paste the exact output schema you require..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
          />
        </div>

        <div>
          <label className="block text-[9px] text-gray-500 uppercase tracking-wide mb-1">Output Taxonomy (one per line)</label>
          <textarea
            value={taxonomyText}
            onChange={e => setTaxonomyText(e.target.value)}
            rows={5}
            placeholder={"CALL_ANCHOR_START\nCompany Procedures\nCall Summary\nNext Call Actions"}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
          />
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2">
          <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide">Test Fit (Raw vs Required Schema)</p>
          <textarea
            value={rawOutput}
            onChange={e => setRawOutput(e.target.value)}
            rows={7}
            placeholder="Paste raw agent output here, then run fit."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[10px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => runFit("structured")}
              disabled={fitLoading || !rawOutput.trim()}
              className="text-[10px] px-2.5 py-1 rounded border border-indigo-700 text-indigo-300 hover:bg-indigo-900/30 disabled:opacity-40 transition-colors"
            >
              Fit Structured
            </button>
            <button
              onClick={() => runFit("raw")}
              disabled={fitLoading || !rawOutput.trim()}
              className="text-[10px] px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 transition-colors"
            >
              Fit Raw-First
            </button>
            {fitLoading && <span className="text-[9px] text-gray-500 flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" /> running...</span>}
          </div>

          {fitError && <p className="text-[10px] text-amber-400 break-words">{fitError}</p>}

          {fitResult && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div className="rounded border border-gray-800 bg-gray-950/70 p-2">
                  <p className="text-gray-500">Before fit</p>
                  <p className="text-red-300 font-semibold">{fitResult?.fit_before?.overall ?? 0}%</p>
                </div>
                <div className="rounded border border-gray-800 bg-gray-950/70 p-2">
                  <p className="text-gray-500">After fit</p>
                  <p className="text-emerald-300 font-semibold">{fitResult?.fit_after?.overall ?? 0}%</p>
                </div>
              </div>
              <textarea
                value={String(fitResult?.fitted_output || "")}
                readOnly
                rows={10}
                className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-[10px] text-gray-300 font-mono"
              />
            </div>
          )}
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
          {saved ? "Saved" : "Save output contract"}
        </button>
      </div>
    </div>
  );
}

// ── TestPanel ─────────────────────────────────────────────────────────────────

type PreviewState = { status: "idle" | "loading" | "ok" | "error"; chars: number; snippet: string; errMsg?: string };

function TestPanel({
  agent,
}: {
  agent: UniversalAgent;
}) {
  const {
    salesAgent: ctxSalesAgent,
    customer: ctxCustomer,
    callId: ctxCallId,
    setCallId: setCtxCallId,
  } = useAppCtx();

  const testAgent = ctxSalesAgent || "";
  const testCustomer = ctxCustomer || "";
  const testCallId = ctxCallId || "";

  const { data: callDates } = useSWR<Record<string, { date: string; has_audio: boolean }>>(
    testAgent && testCustomer
      ? `/api/crm/call-dates?agent=${encodeURIComponent(testAgent)}&customer=${encodeURIComponent(testCustomer)}`
      : null,
    fetcher,
  );

  // Per-input preview: auto-fetched content from backend
  const [previews, setPreviews]       = useState<Record<string, PreviewState>>({});
  const [generating, setGenerating]   = useState<Record<string, boolean>>({});
  const [genStatus, setGenStatus]     = useState<Record<string, string>>({});
  // Per-input override: when user pastes custom text
  const [customMode, setCustomMode]   = useState<Record<string, boolean>>({});
  const [customText, setCustomText]   = useState<Record<string, string>>({});
  const [showPreview, setShowPreview] = useState<Record<string, boolean>>({});

  // Run state
  const [running, setRunning]       = useState(false);
  const [status, setStatus]         = useState("");
  const [streamText, setStreamText] = useState("");
  const [thinking, setThinking]     = useState("");
  const [result, setResult]         = useState<string | null>(null);
  const [runError, setRunError]     = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Reset on agent change
  useEffect(() => {
    setPreviews({}); setCustomMode({}); setCustomText({}); setShowPreview({});
    setStreamText(""); setThinking(""); setResult(null);
    setRunError(""); setStatus("");
  }, [agent.id]);

  async function fetchArtifact(inp: AgentInput) {
    if (!testAgent || !testCustomer) return;
    setPreviews(p => ({ ...p, [inp.key]: { status: "loading", chars: 0, snippet: "" } }));
    try {
      let content = "";
      const qs = new URLSearchParams({ agent: testAgent, customer: testCustomer });

      if (inp.source === "artifact_persona") {
        const res = await fetch(`/api/personas?${qs}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const list: Persona[] = await res.json();
        const sorted = list.sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (sorted.length === 0) throw new Error("No persona cached for this context");
        content = sorted[0].content_md ?? "";

      } else if (inp.source === "artifact_persona_score") {
        const res = await fetch(`/api/personas?${qs}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const list: Persona[] = await res.json();
        const scored = list.filter(p => p.score_json).sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (scored.length === 0) throw new Error("No scored persona cached for this context");
        try { content = JSON.stringify(JSON.parse(scored[0].score_json!), null, 2); }
        catch { content = scored[0].score_json!; }

      } else if (inp.source === "artifact_notes") {
        const res = await fetch(`/api/notes/rollup?${qs}`);
        if (res.status === 404) throw new Error("not_cached");
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        content = typeof data === "string" ? data : JSON.stringify(data, null, 2);

      } else if (inp.source === "artifact_notes_compliance") {
        const res = await fetch(`/api/notes?${qs}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const list: Note[] = await res.json();
        const scored = list.filter(n => n.score_json);
        if (scored.length === 0) throw new Error("No compliance-scored notes cached for this context");
        content = scored.map(n => {
          try { return `### Call ${n.call_id}\n\n${JSON.stringify(JSON.parse(n.score_json!), null, 2)}`; }
          catch { return `### Call ${n.call_id}\n\n${n.score_json}`; }
        }).join("\n\n---\n\n");
      }

      setPreviews(p => ({ ...p, [inp.key]: { status: "ok", chars: content.length, snippet: content.slice(0, 300) } }));
      setCustomText(p => ({ ...p, [inp.key]: content }));
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      let clean = msg;
      try { const j = JSON.parse(msg); clean = j.detail ?? msg; } catch { /* not JSON */ }
      setPreviews(p => ({ ...p, [inp.key]: { status: "error", chars: 0, snippet: "", errMsg: clean } }));
    }
  }

  async function generateMergedNotes(inp: AgentInput) {
    if (!testAgent || !testCustomer) return;
    setGenerating(p => ({ ...p, [inp.key]: true }));
    setGenStatus(p => ({ ...p, [inp.key]: "Starting…" }));
    try {
      const res = await fetch("/api/notes/rollup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: testAgent, customer: testCustomer }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.startsWith("data: ") ? part.slice(6) : part;
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "progress") setGenStatus(p => ({ ...p, [inp.key]: evt.data?.msg ?? "Running…" }));
            if (evt.type === "done") setGenStatus(p => ({ ...p, [inp.key]: "Done — loading…" }));
          } catch { /* partial */ }
        }
      }
      await fetchArtifact(inp);
    } catch (e: unknown) {
      setGenStatus(p => ({ ...p, [inp.key]: `Error: ${(e as Error).message}` }));
    } finally {
      setGenerating(p => ({ ...p, [inp.key]: false }));
    }
  }

  // Auto-fetch inputs when context changes
  useEffect(() => {
    if (!testAgent || !testCustomer) {
      setPreviews({});
      return;
    }
    for (const inp of agent.inputs) {
      if (srcCategory(inp.source) === "artifact") {
        fetchArtifact(inp);
        continue;
      }
      if (customMode[inp.key]) continue;
      const needsCall = srcMeta(inp.source).needsCall;
      if (needsCall && !testCallId) {
        setPreviews(p => ({ ...p, [inp.key]: { status: "idle", chars: 0, snippet: "", errMsg: "Select a call" } }));
        continue;
      }
      fetchPreview(inp);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testAgent, testCustomer, testCallId, agent.id]);

  async function fetchPreview(inp: AgentInput) {
    setPreviews(p => ({ ...p, [inp.key]: { status: "loading", chars: 0, snippet: "" } }));
    const params = new URLSearchParams({ source: inp.source, sales_agent: testAgent, customer: testCustomer, call_id: testCallId });
    if (inp.agent_id) params.set("agent_id", inp.agent_id);
    if (inp.source === "merged_transcript" || inp.source === "merged_notes") {
      params.set("merged_scope", inp.merged_scope ?? "auto");
      if (inp.merged_until_call_id) params.set("merged_until_call_id", inp.merged_until_call_id);
    }
    try {
      const res = await fetch(`/api/universal-agents/raw-input?${params}`);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `${res.status}`);
      }
      const data: { content: string; chars: number } = await res.json();
      setPreviews(p => ({ ...p, [inp.key]: { status: "ok", chars: data.chars, snippet: (data.content ?? "").slice(0, 300) } }));
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      // Strip FastAPI detail wrapper if present
      let clean = msg;
      try { const j = JSON.parse(msg); clean = j.detail ?? msg; } catch { /* not JSON */ }
      setPreviews(p => ({ ...p, [inp.key]: { status: "error", chars: 0, snippet: "", errMsg: clean } }));
    }
  }

  // Does any auto-mode data input need a call_id?
  const needsCallId = agent.inputs.some(
    inp => srcCategory(inp.source) === "input" && !customMode[inp.key] && srcMeta(inp.source).needsCall,
  );

  const dataInputs     = agent.inputs.filter(inp => srcCategory(inp.source) === "input");
  const artifactInputs = agent.inputs.filter(inp => srcCategory(inp.source) === "artifact");

  const callList = Object.entries(callDates ?? {}).sort((a, b) => (b[1].date ?? "").localeCompare(a[1].date ?? ""));

  async function runTest() {
    if (running) { abortRef.current?.abort(); return; }

    setRunning(true);
    setStreamText(""); setThinking(""); setResult(null);
    setRunError(""); setStatus("Starting…");

    const manual_inputs: Record<string, string> = {};
    const source_overrides: Record<string, string> = {};
    for (const inp of agent.inputs) {
      // Artifact inputs are always injected as manual in test mode
      if (srcCategory(inp.source) === "artifact" || customMode[inp.key]) {
        manual_inputs[inp.key] = customText[inp.key] ?? "";
        source_overrides[inp.key] = "manual";
      }
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/universal-agents/${agent.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sales_agent: testAgent, customer: testCustomer, call_id: testCallId, manual_inputs, source_overrides }),
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.startsWith("data: ") ? part.slice(6) : part;
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "progress") setStatus(evt.data?.msg ?? "");
            if (evt.type === "stream")   setStreamText(t => t + (evt.data?.text ?? ""));
            if (evt.type === "thinking") setThinking(evt.data?.content ?? "");
            if (evt.type === "done")     { setResult(evt.data?.content ?? ""); setStatus(""); }
            if (evt.type === "error")    { setRunError(evt.data?.msg ?? "Unknown error"); setStatus(""); }
          } catch { /* partial */ }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== "AbortError") setRunError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const displayText = result ?? streamText;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full border-l border-gray-800 bg-gray-950">
      <div className="px-3 py-2.5 border-b border-gray-800 shrink-0">
        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Quick Test</p>
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── Context picker ──────────────────────────────────────── */}
        <div className="p-3 border-b border-gray-800 space-y-1.5">
          <p className="text-[9px] text-gray-600 uppercase tracking-wide font-semibold mb-1.5">Context</p>
          <div className="rounded-lg border border-gray-700 bg-gray-800/70 px-2 py-1.5">
            <p className="text-[9px] text-gray-500 uppercase tracking-wide">Sales Agent</p>
            <p className={cn("text-[11px] mt-0.5 truncate", testAgent ? "text-white" : "text-gray-600 italic")}>
              {testAgent || "Select in top context bar"}
            </p>
          </div>
          <div className="rounded-lg border border-gray-700 bg-gray-800/70 px-2 py-1.5">
            <p className="text-[9px] text-gray-500 uppercase tracking-wide">Customer</p>
            <p className={cn("text-[11px] mt-0.5 truncate", testCustomer ? "text-white" : "text-gray-600 italic")}>
              {testCustomer || "Select in top context bar"}
            </p>
          </div>
          {needsCallId && (
            <select value={testCallId} onChange={e => {
              const next = e.target.value;
              setCtxCallId(next);
            }}
            disabled={!testCustomer}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[11px] text-white outline-none focus:border-indigo-500 disabled:opacity-40">
              <option value="">— Call (transcript/notes) —</option>
              {callList.map(([cid, info]) => (
                <option key={cid} value={cid}>{info.date ? info.date.slice(0, 10) : "?"} · {cid.slice(-8)}</option>
              ))}
            </select>
          )}
        </div>

        {/* ── Data inputs ─────────────────────────────────────────── */}
        {dataInputs.length > 0 && (
          <div className="p-3 border-b border-gray-800 space-y-2.5">
            <p className="text-[9px] text-gray-600 uppercase tracking-wide font-semibold">Data Inputs</p>
            {dataInputs.map((inp, i) => {
              const sm = srcMeta(inp.source);
              const SrcIcon = sm.icon;
              const isCustom = customMode[inp.key];
              const pv = previews[inp.key];
              const expanded = showPreview[inp.key];
              return (
                <div key={i} className="rounded-lg border border-gray-800 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-2.5 py-2 bg-gray-900/60">
                    <span className={cn("p-0.5 rounded border shrink-0", sm.badge)}>
                      <SrcIcon className="w-3 h-3" />
                    </span>
                    <span className="text-[10px] text-amber-300 font-mono flex-1 truncate">{`{${inp.key}}`}</span>
                    <span className="text-[9px] text-gray-600 shrink-0">{sm.label}</span>
                    <button
                      onClick={() => {
                        const next = !isCustom;
                        setCustomMode(p => ({ ...p, [inp.key]: next }));
                        if (!next && testAgent && testCustomer) fetchPreview(inp);
                      }}
                      className={cn(
                        "text-[9px] px-1.5 py-0.5 rounded border transition-colors shrink-0 ml-0.5",
                        isCustom
                          ? "border-amber-600/60 bg-amber-900/30 text-amber-400"
                          : "border-gray-700 text-gray-500 hover:text-gray-300",
                      )}>
                      {isCustom ? "paste" : "auto"}
                    </button>
                  </div>
                  {!isCustom && (
                    <div className="px-2.5 py-2 space-y-1.5">
                      {!testAgent || !testCustomer ? (
                        <p className="text-[9px] text-gray-700 italic">Select context above to load</p>
                      ) : pv?.status === "loading" ? (
                        <div className="flex items-center gap-1.5 text-[9px] text-gray-500">
                          <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" /> Fetching…
                        </div>
                      ) : pv?.status === "ok" ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] text-emerald-400">✓ cached</span>
                            <span className="text-[9px] text-gray-600">{pv.chars.toLocaleString()} chars</span>
                            <button onClick={() => setShowPreview(p => ({ ...p, [inp.key]: !p[inp.key] }))}
                              className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors ml-auto">
                              {expanded ? "hide" : "preview"}
                            </button>
                            <button onClick={() => { setCustomMode(p => ({ ...p, [inp.key]: true })); setCustomText(p => ({ ...p, [inp.key]: pv.snippet + (pv.chars > 300 ? "\n…" : "") })); }}
                              className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">
                              edit
                            </button>
                          </div>
                          {expanded && (
                            <pre className="text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words bg-gray-900 rounded p-2 max-h-32 overflow-y-auto">{pv.snippet}{pv.chars > 300 ? "\n…" : ""}</pre>
                          )}
                        </div>
                      ) : pv?.status === "error" ? (
                        <div className="space-y-1.5">
                          <p className="text-[9px] text-amber-400">⚠ {pv.errMsg ?? "Not found"}</p>
                          <button onClick={() => { setCustomMode(p => ({ ...p, [inp.key]: true })); setCustomText(p => ({ ...p, [inp.key]: "" })); }}
                            className="text-[9px] px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors">
                            Paste manually
                          </button>
                        </div>
                      ) : (
                        <p className="text-[9px] text-gray-700 italic">Idle</p>
                      )}
                    </div>
                  )}
                  {isCustom && (
                    <div className="px-2.5 py-2">
                      <textarea value={customText[inp.key] ?? ""}
                        onChange={e => setCustomText(p => ({ ...p, [inp.key]: e.target.value }))}
                        placeholder={`Paste ${inp.key} content…`} rows={4}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[10px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
                      <p className="text-[9px] text-gray-700 mt-1">{(customText[inp.key] ?? "").length.toLocaleString()} chars</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Artifact inputs ──────────────────────────────────────── */}
        {artifactInputs.length > 0 && (
          <div className="p-3 border-b border-gray-800 space-y-2.5">
            <p className="text-[9px] text-gray-600 uppercase tracking-wide font-semibold">Artifacts</p>
            {artifactInputs.map((inp, i) => {
              const sm = srcMeta(inp.source);
              const SrcIcon = sm.icon;
              const pv = previews[inp.key];
              const text = customText[inp.key] ?? "";
              const expanded = showPreview[inp.key];
              const isViolet = sm.badge.includes("violet");
              const isAmber  = sm.badge.includes("amber");
              const textCls  = sm.badge.split(" ").find(c => c.startsWith("text-")) ?? "text-gray-300";
              return (
                <div key={i} className={cn("rounded-lg border overflow-hidden",
                  isViolet ? "border-violet-800/40" : isAmber ? "border-amber-800/40" : "border-emerald-800/40")}>

                  {/* Header: type + status */}
                  <div className={cn("flex items-center gap-2 px-2.5 py-2",
                    isViolet ? "bg-violet-950/50" : isAmber ? "bg-amber-950/50" : "bg-emerald-950/50")}>
                    <span className={cn("p-0.5 rounded border shrink-0", sm.badge)}>
                      <SrcIcon className="w-3 h-3" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-[10px] font-semibold", textCls)}>{sm.label}</p>
                      <p className="text-[9px] text-gray-600 font-mono">{`{${inp.key}}`}</p>
                    </div>

                    {/* Fetch status */}
                    {(!testAgent || !testCustomer) ? (
                      <span className="text-[9px] text-gray-700 shrink-0 italic">select context</span>
                    ) : pv?.status === "loading" ? (
                      <div className="flex items-center gap-1 text-[9px] text-gray-500 shrink-0">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> loading
                      </div>
                    ) : pv?.status === "ok" ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[9px] text-emerald-400">✓ cached</span>
                        <span className="text-[9px] text-gray-600">{pv.chars.toLocaleString()} chars</span>
                        <button onClick={() => setShowPreview(p => ({ ...p, [inp.key]: !p[inp.key] }))}
                          className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">
                          {expanded ? "hide" : "peek"}
                        </button>
                        <button onClick={() => fetchArtifact(inp)} title="Reload from cache"
                          className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">↺</button>
                      </div>
                    ) : pv?.status === "error" ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[9px] text-amber-400">⚠ not cached</span>
                        <button onClick={() => fetchArtifact(inp)} title="Retry"
                          className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">↺</button>
                      </div>
                    ) : null}
                  </div>

                  {/* Error detail + generate actions */}
                  {pv?.status === "error" && (
                    <div className="px-2.5 py-1.5 border-b border-gray-800/50 space-y-1.5">
                      {pv.errMsg && pv.errMsg !== "not_cached" && (
                        <p className="text-[9px] text-gray-600 italic">{pv.errMsg}</p>
                      )}
                      {/* Generate actions per artifact type */}
                      {inp.source === "artifact_notes" && testAgent && testCustomer && (
                        <button
                          onClick={() => generateMergedNotes(inp)}
                          disabled={generating[inp.key]}
                          className={cn(
                            "flex items-center gap-1.5 text-[9px] px-2 py-1 rounded border transition-colors",
                            generating[inp.key]
                              ? "border-gray-700 text-gray-600 cursor-wait"
                              : "border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40",
                          )}>
                          {generating[inp.key]
                            ? <><Loader2 className="w-2.5 h-2.5 animate-spin" /> {genStatus[inp.key] ?? "Generating…"}</>
                            : <><Layers className="w-2.5 h-2.5" /> Generate merged notes</>}
                        </button>
                      )}
                      {(inp.source === "artifact_persona" || inp.source === "artifact_persona_score") && (
                        <p className="text-[9px] text-gray-700">
                          Generate from{" "}
                          <a href="/personas" className="text-indigo-400 hover:text-indigo-300 underline">Personas page</a>
                        </p>
                      )}
                    </div>
                  )}

                  {/* Peek preview */}
                  {expanded && pv?.status === "ok" && (
                    <pre className="px-2.5 py-2 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words bg-gray-900 max-h-28 overflow-y-auto border-b border-gray-800">
                      {text.slice(0, 500)}{text.length > 500 ? "\n…" : ""}
                    </pre>
                  )}

                  {/* Editable content area */}
                  <div className="px-2.5 py-2">
                    <textarea value={text}
                      onChange={e => setCustomText(p => ({ ...p, [inp.key]: e.target.value }))}
                      placeholder={
                        !testAgent || !testCustomer ? "Select context to auto-load…"
                        : pv?.status === "error" ? `No ${sm.label} cached — paste manually`
                        : pv?.status === "loading" ? "Loading from cache…"
                        : `${sm.label} content…`
                      }
                      rows={text.length > 0 ? 2 : 3}
                      className="w-full bg-gray-900/60 border border-gray-700/50 rounded-lg px-2 py-1.5 text-[10px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y placeholder-gray-700"
                    />
                    {text.length > 0 && (
                      <div className="flex items-center justify-between mt-0.5">
                        <p className="text-[9px] text-gray-700">{text.length.toLocaleString()} chars</p>
                        <button onClick={() => setCustomText(p => ({ ...p, [inp.key]: "" }))}
                          className="text-[9px] text-gray-700 hover:text-red-400 transition-colors">clear</button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {agent.inputs.length === 0 && (
          <div className="p-3 border-b border-gray-800">
            <p className="text-[10px] text-gray-700 italic">No inputs defined on this agent</p>
          </div>
        )}

        {/* ── Run button ──────────────────────────────────────────── */}
        <div className="p-3 border-b border-gray-800">
          <button onClick={runTest}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-colors",
              running
                ? "bg-red-900/40 border border-red-800 text-red-300 hover:bg-red-900/60"
                : "bg-indigo-700 hover:bg-indigo-600 text-white",
            )}>
            {running ? <><X className="w-3.5 h-3.5" /> Stop</> : <><Play className="w-3.5 h-3.5" /> Run test</>}
          </button>
          {status && <p className="text-[10px] text-gray-500 mt-1.5 text-center animate-pulse">{status}</p>}
          {runError && <p className="text-[10px] text-red-400 mt-1.5 bg-red-950/30 rounded p-2 border border-red-900/50 break-words">{runError}</p>}
        </div>

        {/* ── Output ─────────────────────────────────────────────── */}
        {(displayText || thinking) && (
          <div className="p-3 space-y-2">
            {thinking && (
              <details className="border border-gray-800 rounded-lg overflow-hidden">
                <summary className="px-3 py-1.5 text-[10px] text-gray-500 font-semibold bg-gray-900/60 cursor-pointer list-none flex items-center gap-1.5">
                  <span className="text-gray-600">▶</span> Thinking
                </summary>
                <pre className="p-3 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{thinking}</pre>
              </details>
            )}
            {displayText && (
              <div className="prose prose-invert prose-sm max-w-none text-[12px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
              </div>
            )}
            {result && (
              <button onClick={() => navigator.clipboard.writeText(result)}
                className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors mt-1">
                <Copy className="w-3 h-3" /> Copy output
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const { mutate } = useSWRConfig();
  const { activeAgentId, setActiveAgent } = useAppCtx();
  const { data: agents } = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);
  const { data: pipelinesData } = useSWR<PipelineDef[]>("/api/pipelines", fetcher);
  const { data: foldersData } = useSWR<string[]>("/api/universal-agents/folders", fetcher);
  const allAgents = (agents ?? []).map(normalizeAgent);
  const allPipelines = pipelinesData ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(() => activeAgentId || null);
  const [panelMode, setPanelMode] = useState<"split" | "editor">("split");
  const [workspaceSection, setWorkspaceSection] = useState<"inputs" | "processing" | "outputs">("processing");
  const [testPanelWidth, setTestPanelWidth] = useState(320);
  const [isResizingTestPanel, setIsResizingTestPanel] = useState(false);
  const testPanelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [importing, setImporting]   = useState(false);
  const [importMsg, setImportMsg]   = useState("");
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  function startTestPanelResize(clientX: number) {
    testPanelResizeRef.current = { startX: clientX, startWidth: testPanelWidth };
    setIsResizingTestPanel(true);
  }

  useEffect(() => {
    if (!isResizingTestPanel) return;
    const onMove = (e: MouseEvent) => {
      const drag = testPanelResizeRef.current;
      if (!drag) return;
      const delta = drag.startX - e.clientX;
      const draftWidth = drag.startWidth + delta;
      const minWidth = 280;
      const maxWidth = Math.max(minWidth, Math.min(760, window.innerWidth - 420));
      const clamped = Math.max(minWidth, Math.min(maxWidth, draftWidth));
      setTestPanelWidth(clamped);
    };
    const onUp = () => {
      testPanelResizeRef.current = null;
      setIsResizingTestPanel(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingTestPanel]);

  useEffect(() => {
    if (!activeAgentId) return;
    setSelectedId(activeAgentId);
  }, [activeAgentId]);

  const selected = allAgents.find(a => a.id === selectedId) ?? null;
  const normalizedFolder = (name?: string | null) => (name ?? "").trim();

  const folderNames = useMemo(() => {
    const fromAgents = allAgents
      .map(a => normalizedFolder(a.folder))
      .filter(Boolean);
    const fromFolders = (foldersData ?? [])
      .map(f => normalizedFolder(f))
      .filter(Boolean);
    return [...new Set([...fromFolders, ...fromAgents])]
      .sort((a, b) => a.localeCompare(b));
  }, [allAgents, foldersData]);

  const agentsByFolder = useMemo(() => {
    const grouped: Record<string, UniversalAgent[]> = {};
    for (const a of allAgents) {
      const folder = normalizedFolder(a.folder);
      (grouped[folder] ??= []).push(a);
    }
    for (const k of Object.keys(grouped)) {
      grouped[k].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    return grouped;
  }, [allAgents]);

  async function createAgent() {
    const res = await fetch("/api/universal-agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BLANK_AGENT),
    });
    const created: UniversalAgent = await res.json();
    mutate("/api/universal-agents");
    setSelectedId(created.id);
    setActiveAgent(created.id, created.name, created.agent_class || "general");
  }

  async function copyAgent(agentId: string) {
    const res = await fetch(`/api/universal-agents/${agentId}/copy`, { method: "POST" });
    if (!res.ok) return;
    const created: UniversalAgent = await res.json();
    mutate("/api/universal-agents");
    mutate("/api/universal-agents/folders");
    setSelectedId(created.id);
    setActiveAgent(created.id, created.name, created.agent_class || "general");
  }

  async function saveAgent(draft: Omit<UniversalAgent, "id" | "created_at">) {
    if (!selectedId) return;
    try {
      const current = allAgents.find(a => a.id === selectedId);
      if (!current) return;
    const currentCmp = {
      name: current.name,
      description: current.description ?? "",
      agent_class: current.agent_class ?? "",
      model: current.model ?? "gpt-5.4",
      temperature: current.temperature ?? 0,
      system_prompt: current.system_prompt ?? "",
      user_prompt: current.user_prompt ?? "",
      inputs: current.inputs ?? [],
      output_format: current.output_format ?? "markdown",
      artifact_type: current.artifact_type ?? "",
      artifact_class: current.artifact_class ?? "",
      output_schema: current.output_schema ?? "",
      output_taxonomy: current.output_taxonomy ?? [],
      output_contract_mode: current.output_contract_mode ?? "soft",
      output_fit_strategy: current.output_fit_strategy ?? "structured",
      tags: current.tags ?? [],
      is_default: current.is_default ?? false,
      folder: current.folder ?? "",
    };
    const nextCmp = {
      ...draft,
      folder: draft.folder ?? "",
      inputs: (draft.inputs ?? []).map(normalizeAgentInput),
      tags: draft.tags ?? [],
      output_taxonomy: draft.output_taxonomy ?? [],
      output_contract_mode: draft.output_contract_mode ?? "soft",
      output_fit_strategy: draft.output_fit_strategy ?? "structured",
      artifact_type: draft.artifact_type ?? "",
      artifact_class: draft.artifact_class ?? "",
      output_schema: draft.output_schema ?? "",
    };
    if (JSON.stringify(currentCmp) === JSON.stringify(nextCmp)) return;

    const usagePipelines = allPipelines.filter(p =>
      (p.steps ?? []).some(s => String(s.agent_id || "") === selectedId),
    );

    async function putAgent(agentId: string, payload: Omit<UniversalAgent, "id" | "created_at">) {
      const res = await fetch(`/api/universal-agents/${agentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
    }

    async function createCopyWithDraft(payload: Omit<UniversalAgent, "id" | "created_at">) {
      const copyRes = await fetch(`/api/universal-agents/${selectedId}/copy`, { method: "POST" });
      if (!copyRes.ok) throw new Error(`copy failed (${copyRes.status})`);
      const copied: UniversalAgent = await copyRes.json();
      await putAgent(copied.id, payload);
      return copied;
    }

    async function rewirePipelineToAgent(pipelineId: string, newAgent: UniversalAgent, oldAgentId: string) {
      const getRes = await fetch(`/api/pipelines/${pipelineId}`);
      if (!getRes.ok) throw new Error(`pipeline load failed (${getRes.status})`);
      const pl: PipelineDef = await getRes.json();

      const nextSteps = (pl.steps ?? []).map(s =>
        String(s.agent_id || "") === oldAgentId ? { ...s, agent_id: newAgent.id } : s,
      );
      const nextCanvas = pl.canvas
        ? {
            ...pl.canvas,
            nodes: (pl.canvas.nodes ?? []).map((n: any) => {
              if (String(n?.type || "") !== "processing") return n;
              const d = (n?.data ?? {}) as Record<string, any>;
              if (String(d.agentId || "") !== oldAgentId) return n;
              const prevLabel = String(d.label || "");
              const prevAgentName = String(d.agentName || "");
              const shouldSyncLabel = !prevLabel || prevLabel === prevAgentName || prevLabel === oldAgentId;
              return {
                ...n,
                data: {
                  ...d,
                  agentId: newAgent.id,
                  agentClass: newAgent.agent_class ?? "",
                  agentName: newAgent.name,
                  ...(shouldSyncLabel ? { label: newAgent.name } : {}),
                },
              };
            }),
          }
        : pl.canvas;

      const putRes = await fetch(`/api/pipelines/${pipelineId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pl.name,
          description: pl.description ?? "",
          scope: pl.scope ?? "per_pair",
          steps: nextSteps,
          canvas: nextCanvas ?? {},
          folder: pl.folder ?? "",
        }),
      });
      if (!putRes.ok) throw new Error(`pipeline update failed (${putRes.status})`);
    }

      if (usagePipelines.length <= 1) {
        await putAgent(selectedId, draft);
        mutate("/api/universal-agents");
        return;
      }

      const choice = window.prompt(
        `This agent is used in ${usagePipelines.length} workflows.\n` +
        "How should this update be applied?\n" +
        "1 = Apply to ALL workflows\n" +
        "2 = Select specific workflow(s)\n" +
        "3 = Make a COPY (keep existing workflows unchanged)\n" +
        "Anything else = Cancel",
        "3",
      );
      if (!choice || !["1", "2", "3"].includes(choice.trim())) return;

      if (choice.trim() === "1") {
        await putAgent(selectedId, draft);
        mutate("/api/universal-agents");
        mutate("/api/pipelines");
        return;
      }

      const copied = await createCopyWithDraft(draft);

      if (choice.trim() === "2") {
        const numbered = usagePipelines
          .map((p, i) => `${i + 1}. ${p.name} (${p.id.slice(0, 8)})`)
          .join("\n");
        const raw = window.prompt(
          `Select workflows by number (comma separated):\n\n${numbered}\n\nExample: 1,3`,
          "",
        );
        const pickedIdx = new Set(
          String(raw || "")
            .split(",")
            .map(x => parseInt(x.trim(), 10))
            .filter(n => Number.isFinite(n) && n >= 1 && n <= usagePipelines.length),
        );
        const targets = usagePipelines.filter((_, i) => pickedIdx.has(i + 1));
        for (const p of targets) {
          await rewirePipelineToAgent(p.id, copied, selectedId);
        }
        mutate("/api/pipelines");
      }

      mutate("/api/universal-agents");
      mutate("/api/universal-agents/folders");
      setSelectedId(copied.id);
      setActiveAgent(copied.id, draft.name || copied.name, draft.agent_class || copied.agent_class || "general");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      window.alert(`Agent update failed: ${msg}`);
    }
  }

  async function deleteAgent() {
    if (!selectedId) return;
    await fetch(`/api/universal-agents/${selectedId}`, { method: "DELETE" });
    mutate("/api/universal-agents");
    setSelectedId(null);
    if (activeAgentId === selectedId) setActiveAgent("", "", "");
  }

  async function importPresets() {
    setImporting(true); setImportMsg("");
    try {
      const res  = await fetch("/api/universal-agents/import-presets", { method: "POST" });
      const data = await res.json();
      mutate("/api/universal-agents");
      mutate("/api/universal-agents/folders");
      setImportMsg(`+${data.created_agents?.length ?? 0} agents`);
      setTimeout(() => setImportMsg(""), 4000);
    } finally { setImporting(false); }
  }

  async function createFolder() {
    const raw = window.prompt("Folder name");
    const name = (raw ?? "").trim();
    if (!name) return;
    const res = await fetch("/api/universal-agents/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    mutate("/api/universal-agents/folders");
  }

  async function moveAgentToFolder(agentId: string, folder: string) {
    await fetch(`/api/universal-agents/${agentId}/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    mutate("/api/universal-agents");
    mutate("/api/universal-agents/folders");
  }

  function renderAgentRow(a: UniversalAgent) {
    const clsMeta = classMeta((a.agent_class || "general").toLowerCase());
    return (
      <div key={a.id} className="flex items-center group">
        <button
          draggable
          onDragStart={e => {
            e.dataTransfer.setData("application/x-agent-id", a.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => {
            setSelectedId(a.id);
            setActiveAgent(a.id, a.name, a.agent_class || "general");
          }}
          className={cn(
            "flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] transition-colors",
            selectedId === a.id
              ? "bg-indigo-900/40 text-white border border-indigo-700/40"
              : "text-gray-400 hover:text-white hover:bg-gray-800/60",
          )}>
          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", clsMeta.textColor.replace("text-", "bg-"))} />
          <span className="truncate flex-1">{a.name}</span>
        </button>
        <button
          onClick={() => copyAgent(a.id)}
          title="Copy agent"
          className="shrink-0 p-1 text-gray-700 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-all">
          <Copy className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex -m-6">

      {/* ── Left: agent list ─────────────────────────────────────── */}
      <aside className="w-52 shrink-0 border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="px-3 py-2.5 border-b border-gray-800 flex items-center justify-between shrink-0">
          <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Agents &amp; Artifacts</p>
          <div className="flex items-center gap-1.5">
            <button onClick={importPresets} disabled={importing} title="Import presets"
              className="p-1 text-gray-600 hover:text-indigo-400 transition-colors disabled:opacity-40">
              {importing
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Download className="w-3 h-3" />}
            </button>
            <button onClick={createFolder} title="New folder"
              className="p-1 text-gray-600 hover:text-indigo-400 transition-colors">
              <Layers className="w-3 h-3" />
            </button>
            <button onClick={createAgent} title="New agent"
              className="p-1 text-gray-600 hover:text-indigo-400 transition-colors">
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>

        {importMsg && (
          <p className="text-[9px] text-emerald-400 text-center py-1 border-b border-gray-800">{importMsg}</p>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          <div
            onDragOver={e => { e.preventDefault(); setDragOverFolder(""); }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={async e => {
              e.preventDefault();
              const id = e.dataTransfer.getData("application/x-agent-id");
              setDragOverFolder(null);
              if (!id) return;
              await moveAgentToFolder(id, "");
            }}
            className={cn(
              "rounded-lg border p-1.5 transition-colors",
              dragOverFolder === "" ? "border-indigo-500 bg-indigo-900/20" : "border-gray-800",
            )}>
            <p className="text-[9px] font-bold uppercase tracking-widest px-1.5 mb-1 text-gray-500">Unfiled</p>
            {(agentsByFolder[""] ?? []).map(a => renderAgentRow(a))}
            {!(agentsByFolder[""] ?? []).length && (
              <p className="text-[9px] text-gray-700 italic px-2 py-1">Drop agents here</p>
            )}
          </div>

          {folderNames.map(folder => (
            <div
              key={folder}
              onDragOver={e => { e.preventDefault(); setDragOverFolder(folder); }}
              onDragLeave={() => setDragOverFolder(null)}
              onDrop={async e => {
                e.preventDefault();
                const id = e.dataTransfer.getData("application/x-agent-id");
                setDragOverFolder(null);
                if (!id) return;
                await moveAgentToFolder(id, folder);
              }}
              className={cn(
                "rounded-lg border p-1.5 transition-colors",
                dragOverFolder === folder ? "border-indigo-500 bg-indigo-900/20" : "border-gray-800",
              )}>
              <p className="text-[9px] font-bold uppercase tracking-widest px-1.5 mb-1 text-gray-400">{folder}</p>
              {(agentsByFolder[folder] ?? []).map(a => renderAgentRow(a))}
              {!(agentsByFolder[folder] ?? []).length && (
                <p className="text-[9px] text-gray-700 italic px-2 py-1">Empty folder</p>
              )}
            </div>
          ))}

          {allAgents.length === 0 && folderNames.length === 0 && (
            <p className="text-[10px] text-gray-700 italic px-2 py-4 text-center">
              No agents yet — click +, create a folder, or import presets
            </p>
          )}
        </div>
      </aside>

      {/* ── Center: editor ───────────────────────────────────────── */}
      <div className="min-w-0 flex-1 flex flex-col bg-gray-900 overflow-hidden">
        <div className="shrink-0 border-b border-gray-800 px-3 py-2 flex items-center gap-1.5">
          {[
            { id: "inputs", label: "Inputs", icon: SlidersHorizontal },
            { id: "processing", label: "Processing", icon: Boxes },
            { id: "outputs", label: "Outputs", icon: Sparkles },
          ].map(tab => {
            const Icon = tab.icon;
            const selectedTab = workspaceSection === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setWorkspaceSection(tab.id as "inputs" | "processing" | "outputs")}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] transition-colors",
                  selectedTab
                    ? "border-indigo-700/60 bg-indigo-900/30 text-indigo-300"
                    : "border-gray-800 text-gray-500 hover:text-gray-300 hover:border-gray-700",
                )}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
              </button>
            );
          })}
        </div>
        {selected ? (
          workspaceSection === "processing" ? (
            <AgentEditor
              key={selected.id}
              agent={selected}
              allAgents={allAgents}
              onSave={saveAgent}
              onDelete={deleteAgent}
              onCopy={() => copyAgent(selected.id)}
              isExpanded={panelMode === "editor"}
              onToggleExpand={() => setPanelMode(prev => prev === "editor" ? "split" : "editor")}
            />
          ) : workspaceSection === "inputs" ? (
            <InputContractsPanel key={`${selected.id}-inputs`} agent={selected} allAgents={allAgents} onSave={saveAgent} />
          ) : (
            <OutputContractsPanel key={`${selected.id}-outputs`} agent={selected} allAgents={allAgents} onSave={saveAgent} />
          )
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-700">
            <Bot className="w-12 h-12 opacity-10" />
            <p className="text-sm">Select an agent to edit</p>
            <button onClick={createAgent}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-white hover:border-gray-500 text-xs transition-colors">
              <Plus className="w-3 h-3" /> New agent
            </button>
          </div>
        )}
      </div>

      {panelMode !== "editor" && workspaceSection === "processing" && (
        <div
          onMouseDown={e => startTestPanelResize(e.clientX)}
          className="w-1.5 shrink-0 cursor-col-resize bg-gray-900 hover:bg-indigo-500/40 transition-colors"
          title="Drag to resize quick test panel"
        />
      )}

      {/* ── Right: test panel ────────────────────────────────────── */}
      <div className={cn(
        "overflow-hidden flex flex-col shrink-0",
        (panelMode === "editor" || workspaceSection !== "processing") && "hidden",
      )} style={(panelMode === "editor" || workspaceSection !== "processing") ? undefined : { width: `${testPanelWidth}px` }}>
        {selected
          ? (
            <TestPanel
              key={selected.id}
              agent={selected}
            />
          )
          : (
            <div className="h-full border-l border-gray-800 bg-gray-950 flex items-center justify-center">
              <p className="text-[10px] text-gray-700 italic">Select an agent to test</p>
            </div>
          )}
      </div>

    </div>
  );
}
