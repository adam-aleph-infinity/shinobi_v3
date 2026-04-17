"use client";
import { useState, useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp,
  X, Workflow, Download, ChevronRight,
  User, Star, StickyNote, Shield, Zap,
  Mic2, Layers, BookOpen, Link2, PenLine, TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppCtx } from "@/lib/app-context";

const API = "/api";
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

const INPUT_SOURCES = [
  { value: "transcript",        label: "Transcript",        icon: Mic2,       badge: "bg-blue-900/50 text-blue-300 border-blue-700/50",       desc: "Single call transcript" },
  { value: "merged_transcript", label: "Merged Transcript", icon: Layers,     badge: "bg-cyan-900/50 text-cyan-300 border-cyan-700/50",       desc: "All calls merged" },
  { value: "notes",             label: "Notes",             icon: StickyNote, badge: "bg-green-900/50 text-green-300 border-green-700/50",    desc: "Call notes" },
  { value: "merged_notes",      label: "Merged Notes",      icon: BookOpen,   badge: "bg-teal-900/50 text-teal-300 border-teal-700/50",       desc: "All notes aggregated" },
  { value: "agent_output",      label: "Agent Output",      icon: Bot,        badge: "bg-purple-900/50 text-purple-300 border-purple-700/50", desc: "Output of another agent" },
  { value: "chain_previous",    label: "Prev Step",         icon: Link2,      badge: "bg-amber-900/50 text-amber-300 border-amber-700/50",    desc: "Previous pipeline step" },
  { value: "manual",            label: "Manual",            icon: PenLine,    badge: "bg-gray-700/50 text-gray-300 border-gray-600/50",       desc: "Provided at run time" },
] as const;

type SourceValue = typeof INPUT_SOURCES[number]["value"];

function sourceBadge(source: string) {
  return INPUT_SOURCES.find(s => s.value === source) ?? INPUT_SOURCES[6];
}

// ── Agent class metadata ──────────────────────────────────────────────────────

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  persona: User, scorer: Star, notes: StickyNote, compliance: Shield, general: Zap,
};
const CLASS_ICON_BG: Record<string, string> = {
  persona: "bg-violet-900/60", scorer: "bg-violet-800/40",
  notes: "bg-teal-900/60", compliance: "bg-teal-800/40", general: "bg-sky-900/60",
};
const CLASS_REQUIRES_PREV: Record<string, string> = { scorer: "persona", compliance: "notes" };

const CLASS_META: Record<string, { label: string; textColor: string; borderColor: string; dotColor: string }> = {
  persona:    { label: "Persona",       textColor: "text-violet-300", borderColor: "border-violet-700/40", dotColor: "bg-violet-400" },
  scorer:     { label: "Scorer",        textColor: "text-violet-400", borderColor: "border-violet-700/30", dotColor: "bg-violet-500/70" },
  notes:      { label: "Notes",         textColor: "text-teal-300",   borderColor: "border-teal-700/40",   dotColor: "bg-teal-400" },
  compliance: { label: "Compliance",    textColor: "text-teal-400",   borderColor: "border-teal-700/30",   dotColor: "bg-teal-500/70" },
  general:    { label: "General",       textColor: "text-sky-300",    borderColor: "border-sky-700/40",    dotColor: "bg-sky-400" },
  "":         { label: "Uncategorized", textColor: "text-gray-400",   borderColor: "border-gray-700/40",   dotColor: "bg-gray-500" },
};

function classMeta(cls: string) {
  return CLASS_META[cls.toLowerCase()] ?? { label: cls, textColor: "text-gray-400", borderColor: "border-gray-700/40", dotColor: "bg-gray-500" };
}

function AgentClassIcon({ cls, size = "md" }: { cls: string; size?: "sm" | "md" | "lg" }) {
  const norm = cls.toLowerCase();
  const Icon = CLASS_ICON[norm] ?? Bot;
  const bg   = CLASS_ICON_BG[norm] ?? "bg-gray-800";
  const meta = classMeta(norm);
  const dims     = { sm: "w-6 h-6", md: "w-8 h-8", lg: "w-12 h-12" }[size];
  const iconDims = { sm: "w-3 h-3", md: "w-4 h-4", lg: "w-6 h-6" }[size];
  return (
    <div className={cn("rounded-xl flex items-center justify-center shrink-0", bg, dims)}>
      <Icon className={cn(iconDims, meta.textColor)} />
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentInput { key: string; source: SourceValue; agent_id?: string; }

interface UniversalAgent {
  id: string; name: string; description: string; agent_class: string;
  model: string; temperature: number; system_prompt: string; user_prompt: string;
  inputs: AgentInput[]; output_format: string; tags: string[];
  is_default: boolean; created_at: string;
}

const EMPTY_AGENT: Omit<UniversalAgent, "id" | "created_at"> = {
  name: "", description: "", agent_class: "", model: "gpt-5.4", temperature: 0,
  system_prompt: "", user_prompt: "", inputs: [], output_format: "markdown",
  tags: [], is_default: false,
};

interface PipelineStep {
  agent_id: string;
  input_overrides: Record<string, string>;
  _cls?: string; // frontend-only hint for the class picked from palette
}

interface Pipeline {
  id: string; name: string; description: string; scope: string;
  steps: PipelineStep[]; created_at: string;
}

const EMPTY_PIPELINE: Omit<Pipeline, "id" | "created_at"> = {
  name: "", description: "", scope: "per_pair", steps: [],
};

// ── Class palette cards (left panel) ─────────────────────────────────────────

const CLASS_TYPES = [
  { cls: "persona",    label: "Persona",    desc: "Personality analysis" },
  { cls: "scorer",     label: "Scorer",     desc: "Score based on persona" },
  { cls: "notes",      label: "Notes",      desc: "Extract key notes" },
  { cls: "compliance", label: "Compliance", desc: "Check requirements" },
  { cls: "general",    label: "General",    desc: "Custom analysis" },
];

function ClassPaletteCard({ cls, label, desc, onAdd }: {
  cls: string; label: string; desc: string; onAdd: () => void;
}) {
  const meta = classMeta(cls);
  const Icon = CLASS_ICON[cls] ?? Bot;
  const bg   = CLASS_ICON_BG[cls] ?? "bg-gray-800";
  return (
    <button
      onClick={onAdd}
      className="w-full flex items-center gap-2.5 p-2.5 rounded-xl border border-gray-800 hover:border-gray-600 bg-gray-900 hover:bg-gray-800 transition-all text-left group"
    >
      <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-105", bg)}>
        <Icon className={cn("w-[18px] h-[18px]", meta.textColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-gray-200">{label}</p>
        <p className="text-[9px] text-gray-600 leading-tight">{desc}</p>
      </div>
      <Plus className="w-3.5 h-3.5 text-gray-600 group-hover:text-teal-400 transition-colors shrink-0" />
    </button>
  );
}

// ── Canvas node card ──────────────────────────────────────────────────────────

function CanvasNode({ step, index, total, allAgents, prevStepClass, isSelected, onClick, onRemove, onMoveLeft, onMoveRight }: {
  step: PipelineStep; index: number; total: number;
  allAgents: UniversalAgent[]; prevStepClass?: string; isSelected: boolean;
  onClick: () => void; onRemove: () => void; onMoveLeft: () => void; onMoveRight: () => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);
  const cls   = agent?.agent_class ?? step._cls ?? "";
  const meta  = classMeta(cls);
  const Icon  = CLASS_ICON[cls.toLowerCase()] ?? Bot;
  const bg    = CLASS_ICON_BG[cls.toLowerCase()] ?? "bg-gray-800";

  const reqPrev = agent ? (CLASS_REQUIRES_PREV[cls.toLowerCase()] ?? null) : null;
  const compat  = !reqPrev || !prevStepClass || reqPrev === prevStepClass.toLowerCase();

  return (
    <div className="flex items-center shrink-0">
      <div
        onClick={onClick}
        className={cn(
          "group relative w-36 rounded-2xl border-2 cursor-pointer transition-all p-3 flex flex-col items-center gap-1.5 select-none",
          isSelected
            ? cn("shadow-xl shadow-black/50 bg-gray-800", meta.borderColor)
            : "border-gray-800 bg-gray-900 hover:border-gray-700 hover:bg-gray-850",
        )}
      >
        {/* Step number */}
        <span className="absolute top-2 left-2.5 text-[8px] font-mono text-gray-700">{index + 1}</span>

        {/* Compat warning badge */}
        {!compat && (
          <div className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-amber-500 rounded-full flex items-center justify-center z-10 shadow-md">
            <TriangleAlert className="w-3 h-3 text-white" />
          </div>
        )}

        {/* Controls (hover) */}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={e => { e.stopPropagation(); onMoveLeft(); }} disabled={index === 0}
            className="p-0.5 text-gray-700 hover:text-gray-400 disabled:opacity-20 transition-colors">
            <ChevronRight className="w-3 h-3 rotate-180" />
          </button>
          <button onClick={e => { e.stopPropagation(); onMoveRight(); }} disabled={index === total - 1}
            className="p-0.5 text-gray-700 hover:text-gray-400 disabled:opacity-20 transition-colors">
            <ChevronRight className="w-3 h-3" />
          </button>
          <button onClick={e => { e.stopPropagation(); onRemove(); }}
            className="p-0.5 text-gray-700 hover:text-red-400 transition-colors">
            <X className="w-3 h-3" />
          </button>
        </div>

        {/* Class icon */}
        <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mt-2", bg)}>
          <Icon className={cn("w-6 h-6", meta.textColor)} />
        </div>

        {/* Name */}
        <p className="text-[11px] font-semibold text-center text-white w-full truncate px-1">
          {agent?.name ?? "Tap to set up"}
        </p>

        {/* Class badge */}
        <span className={cn("text-[8px] px-1.5 py-0.5 rounded-full border", meta.textColor, meta.borderColor)}>
          {meta.label}
        </span>

        {/* Source pills */}
        {agent && (agent.inputs ?? []).length > 0 && (
          <div className="flex flex-wrap justify-center gap-0.5 mt-0.5">
            {agent.inputs.slice(0, 2).map(inp => {
              const s = sourceBadge(step.input_overrides[inp.key] ?? inp.source);
              const SrcIcon = s.icon;
              return (
                <span key={inp.key} className={cn("flex items-center gap-0.5 text-[8px] px-1 py-0.5 rounded-full border leading-none", s.badge)}>
                  <SrcIcon className="w-2 h-2 shrink-0" />{inp.key}
                </span>
              );
            })}
            {(agent.inputs ?? []).length > 2 && (
              <span className="text-[8px] text-gray-600">+{agent.inputs.length - 2}</span>
            )}
          </div>
        )}
      </div>

      {/* Arrow to next node */}
      {index < total - 1 && (
        <div className="flex items-center px-1 shrink-0 text-gray-700">
          <div className="w-5 h-px bg-gray-800" />
          <ChevronRight className="w-4 h-4 -ml-1" />
        </div>
      )}
    </div>
  );
}

// ── SourcePillGrid ────────────────────────────────────────────────────────────

function SourcePillGrid({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {INPUT_SOURCES.map(s => {
        const Icon = s.icon;
        const sel  = value === s.value;
        return (
          <button key={s.value} onClick={() => onChange(s.value)} title={s.desc}
            className={cn(
              "flex items-center gap-1 px-2 py-1.5 rounded-full text-[10px] font-medium border transition-all",
              sel ? s.badge : "border-gray-700 bg-gray-800/40 text-gray-500 hover:text-gray-300 hover:border-gray-600",
            )}>
            <Icon className="w-3 h-3 shrink-0" />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ── AgentPickerGrid ───────────────────────────────────────────────────────────

function AgentPickerGrid({ value, allAgents, prevStepClass, onPick }: {
  value: string; allAgents: UniversalAgent[]; prevStepClass?: string;
  onPick: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = allAgents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.agent_class ?? "").toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="space-y-1.5">
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search agents…"
        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
      <div className="grid grid-cols-2 gap-1 max-h-44 overflow-y-auto">
        {filtered.map(a => {
          const meta     = classMeta(a.agent_class ?? "");
          const reqPrev  = CLASS_REQUIRES_PREV[a.agent_class?.toLowerCase() ?? ""];
          const compat   = !reqPrev || !prevStepClass || reqPrev === prevStepClass.toLowerCase();
          const isSel    = value === a.id;
          return (
            <button key={a.id} onClick={() => onPick(a.id)}
              title={!compat ? `${meta.label} must follow a ${reqPrev} step` : a.description}
              className={cn(
                "flex items-center gap-1.5 p-2 rounded-lg border text-left transition-colors",
                isSel ? cn(meta.borderColor, "bg-gray-800") : compat
                  ? "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 hover:border-gray-600"
                  : "border-gray-800/30 bg-gray-900/40 opacity-40 hover:opacity-60",
              )}>
              <AgentClassIcon cls={a.agent_class ?? ""} size="sm" />
              <div className="min-w-0 flex-1">
                <p className={cn("text-[10px] font-medium truncate", isSel ? "text-white" : compat ? "text-gray-300" : "text-gray-600")}>{a.name}</p>
                <p className={cn("text-[9px]", meta.textColor)}>{meta.label}</p>
              </div>
              {isSel && <Check className="w-3 h-3 text-white shrink-0" />}
              {!compat && !isSel && <TriangleAlert className="w-3 h-3 text-amber-600 shrink-0" />}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-2 text-xs text-gray-600 italic text-center py-3">No agents match</p>
        )}
      </div>
    </div>
  );
}

// ── Node settings panel ───────────────────────────────────────────────────────

function NodeSettingsPanel({ step, allAgents, prevStepClass, onChangeStep, onSaveAgent, onClose }: {
  step: PipelineStep;
  allAgents: UniversalAgent[];
  prevStepClass?: string;
  onChangeStep: (s: PipelineStep) => void;
  onSaveAgent: (id: string, form: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
  onClose: () => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);

  const [draft, setDraft] = useState<Omit<UniversalAgent, "id" | "created_at">>(() =>
    agent ? {
      name: agent.name, description: agent.description ?? "",
      agent_class: agent.agent_class ?? "", model: agent.model,
      temperature: agent.temperature ?? 0, system_prompt: agent.system_prompt ?? "",
      user_prompt: agent.user_prompt ?? "", inputs: agent.inputs ?? [],
      output_format: agent.output_format ?? "markdown",
      tags: agent.tags ?? [], is_default: agent.is_default ?? false,
    } : { ...EMPTY_AGENT, agent_class: step._cls ?? "" }
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showModel, setShowModel] = useState(false);

  // Reload draft when the agent changes (user picked a different one)
  useEffect(() => {
    if (agent) {
      setDraft({
        name: agent.name, description: agent.description ?? "",
        agent_class: agent.agent_class ?? "", model: agent.model,
        temperature: agent.temperature ?? 0, system_prompt: agent.system_prompt ?? "",
        user_prompt: agent.user_prompt ?? "", inputs: agent.inputs ?? [],
        output_format: agent.output_format ?? "markdown",
        tags: agent.tags ?? [], is_default: agent.is_default ?? false,
      });
    }
  }, [step.agent_id]);

  async function save() {
    if (!step.agent_id || !draft.name.trim()) return;
    setSaving(true);
    try {
      await onSaveAgent(step.agent_id, draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  }

  const cls  = agent?.agent_class ?? step._cls ?? "";
  const meta = classMeta(cls);

  return (
    <div className="w-80 shrink-0 border-l border-gray-800 flex flex-col bg-gray-950">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <AgentClassIcon cls={cls} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{agent?.name ?? "New step"}</p>
          <p className={cn("text-[9px]", meta.textColor)}>{meta.label}</p>
        </div>
        <button onClick={onClose} className="p-1 text-gray-600 hover:text-white transition-colors shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Agent picker ── */}
        <div className="p-3 border-b border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wide mb-2">Agent</p>
          <AgentPickerGrid
            value={step.agent_id}
            allAgents={allAgents}
            prevStepClass={prevStepClass}
            onPick={id => onChangeStep({ ...step, agent_id: id, input_overrides: {} })}
          />
        </div>

        {/* ── Input sources (only when agent has inputs) ── */}
        {agent && (agent.inputs ?? []).length > 0 && (
          <div className="p-3 border-b border-gray-800 space-y-3">
            <p className="text-[9px] text-gray-600 uppercase tracking-wide">Inputs</p>
            {agent.inputs.map(inp => {
              const effectiveSource = step.input_overrides[inp.key] ?? inp.source;
              const isOverridden    = !!step.input_overrides[inp.key] && step.input_overrides[inp.key] !== inp.source;
              return (
                <div key={inp.key}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] text-amber-400 font-mono">{`{${inp.key}}`}</span>
                    {isOverridden && <span className="text-[8px] text-amber-500 border border-amber-700/40 rounded px-1">override</span>}
                  </div>
                  <SourcePillGrid
                    value={effectiveSource}
                    onChange={val => {
                      const overrides = { ...step.input_overrides };
                      if (val === inp.source) delete overrides[inp.key];
                      else overrides[inp.key] = val;
                      onChangeStep({ ...step, input_overrides: overrides });
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* ── Agent configuration ── */}
        <div className="p-3 space-y-3">
          <p className="text-[9px] text-gray-600 uppercase tracking-wide">Configure</p>

          <div>
            <label className="block text-[9px] text-gray-500 mb-1">Name</label>
            <input value={draft.name} onChange={e => setDraft(f => ({ ...f, name: e.target.value }))}
              placeholder="Agent name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
          </div>

          <div>
            <label className="block text-[9px] text-gray-500 mb-1">System Prompt</label>
            {/* Input variable chips */}
            {draft.inputs.filter(i => i.key).length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {draft.inputs.filter(i => i.key).map(i => (
                  <button key={i.key} type="button"
                    onClick={() => setDraft(f => ({ ...f, system_prompt: f.system_prompt + `{${i.key}}` }))}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 transition-colors font-mono">
                    {`{${i.key}}`}
                  </button>
                ))}
              </div>
            )}
            <textarea value={draft.system_prompt}
              onChange={e => setDraft(f => ({ ...f, system_prompt: e.target.value }))}
              rows={6} placeholder="You are a…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
          </div>

          <div>
            <label className="block text-[9px] text-gray-500 mb-1">User Prompt</label>
            {draft.inputs.filter(i => i.key).length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {draft.inputs.filter(i => i.key).map(i => (
                  <button key={i.key} type="button"
                    onClick={() => setDraft(f => ({ ...f, user_prompt: f.user_prompt + `{${i.key}}` }))}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 transition-colors font-mono">
                    {`{${i.key}}`}
                  </button>
                ))}
              </div>
            )}
            <textarea value={draft.user_prompt}
              onChange={e => setDraft(f => ({ ...f, user_prompt: e.target.value }))}
              rows={6} placeholder={"Analyse this:\n\n{transcript}"}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
          </div>

          {/* Model & settings collapsible */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button onClick={() => setShowModel(s => !s)}
              className="w-full flex items-center justify-between px-3 py-2 bg-gray-900 hover:bg-gray-800 transition-colors text-xs">
              <span className="text-gray-400">Model & settings</span>
              {showModel ? <ChevronUp className="w-3.5 h-3.5 text-gray-600" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-600" />}
            </button>
            {showModel && (
              <div className="p-3 space-y-2.5 border-t border-gray-800">
                <div>
                  <label className="block text-[9px] text-gray-500 mb-1">Model</label>
                  <ModelSelect value={draft.model} onChange={v => setDraft(f => ({ ...f, model: v }))} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[9px] text-gray-500 mb-1">Temperature</label>
                    <input type="number" min={0} max={2} step={0.1} value={draft.temperature}
                      onChange={e => setDraft(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="block text-[9px] text-gray-500 mb-1">Output</label>
                    <select value={draft.output_format} onChange={e => setDraft(f => ({ ...f, output_format: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500">
                      <option value="markdown">Markdown</option>
                      <option value="json">JSON</option>
                      <option value="text">Plain text</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Save agent */}
          {agent && (
            <button onClick={save} disabled={saving || !draft.name.trim()}
              className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
              {saved ? "Saved" : "Save agent"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const { mutate } = useSWRConfig();
  const { activePipelineId, setActivePipeline } = useAppCtx();

  const { data: agents } = useSWR<UniversalAgent[]>(`${API}/universal-agents`, fetcher);
  const { data: pipelines } = useSWR<Pipeline[]>(`${API}/pipelines`, fetcher);

  // Pipeline state
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null);
  const [pipelineForm, setPipelineForm] = useState({ ...EMPTY_PIPELINE });
  const [pipelineIsNew, setPipelineIsNew] = useState(false);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [pipelineSaved, setPipelineSaved] = useState(false);

  // Canvas selection
  const [selectedNodeIdx, setSelectedNodeIdx] = useState<number | null>(null);

  // Import
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created_agents: string[]; created_pipelines: string[]; skipped: string[] } | null>(null);

  const allAgents = agents ?? [];

  // ── Pipeline CRUD ────────────────────────────────────────────────────────────

  function openPipeline(p: Pipeline) {
    setSelectedPipeline(p.id);
    setPipelineForm({ name: p.name, description: p.description ?? "", scope: p.scope, steps: p.steps ?? [] });
    setPipelineIsNew(false);
    setPipelineSaved(false);
    setSelectedNodeIdx(null);
  }

  function newPipeline() {
    setSelectedPipeline(null);
    setPipelineForm({ ...EMPTY_PIPELINE });
    setPipelineIsNew(true);
    setPipelineSaved(false);
    setSelectedNodeIdx(null);
  }

  async function savePipeline() {
    if (!pipelineForm.name.trim()) return;
    setPipelineSaving(true);
    try {
      const method = pipelineIsNew ? "POST" : "PUT";
      const url    = pipelineIsNew ? `${API}/pipelines` : `${API}/pipelines/${selectedPipeline}`;
      // Strip frontend-only _cls field before saving
      const payload = { ...pipelineForm, steps: pipelineForm.steps.map(({ _cls: _c, ...rest }) => rest) };
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data   = await res.json();
      mutate(`${API}/pipelines`);
      if (pipelineIsNew) setSelectedPipeline(data.id ?? null);
      setPipelineIsNew(false);
      setPipelineSaved(true);
      setTimeout(() => setPipelineSaved(false), 2000);
    } finally { setPipelineSaving(false); }
  }

  async function deletePipeline() {
    if (!selectedPipeline || !confirm(`Delete pipeline "${pipelineForm.name}"?`)) return;
    await fetch(`${API}/pipelines/${selectedPipeline}`, { method: "DELETE" });
    mutate(`${API}/pipelines`);
    if (activePipelineId === selectedPipeline) setActivePipeline("", "");
    setSelectedPipeline(null);
    setPipelineIsNew(false);
    setSelectedNodeIdx(null);
  }

  // ── Steps ────────────────────────────────────────────────────────────────────

  function addStep(cls: string) {
    const newIdx = pipelineForm.steps.length;
    setPipelineForm(f => ({ ...f, steps: [...f.steps, { agent_id: "", input_overrides: {}, _cls: cls }] }));
    setSelectedNodeIdx(newIdx);
    // If no pipeline open yet, start a new one
    if (!pipelineIsNew && !selectedPipeline) newPipeline();
  }

  function updateStep(i: number, s: PipelineStep) {
    setPipelineForm(f => { const steps = [...f.steps]; steps[i] = s; return { ...f, steps }; });
  }

  function removeStep(i: number) {
    setPipelineForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) }));
    setSelectedNodeIdx(prev => prev === i ? null : prev !== null && prev > i ? prev - 1 : prev);
  }

  function moveStep(i: number, dir: -1 | 1) {
    setPipelineForm(f => {
      const steps = [...f.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return f;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...f, steps };
    });
    setSelectedNodeIdx(prev => prev === i ? i + dir : prev === i + dir ? i : prev);
  }

  // ── Agent save (from settings panel) ─────────────────────────────────────────

  async function saveNodeAgent(agentId: string, form: Omit<UniversalAgent, "id" | "created_at">) {
    await fetch(`${API}/universal-agents/${agentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    mutate(`${API}/universal-agents`);
  }

  // ── Import presets ────────────────────────────────────────────────────────────

  async function importPresets() {
    setImporting(true); setImportResult(null);
    try {
      const res  = await fetch(`${API}/universal-agents/import-presets`, { method: "POST" });
      const data = await res.json();
      mutate(`${API}/universal-agents`);
      mutate(`${API}/pipelines`);
      setImportResult(data);
      setTimeout(() => setImportResult(null), 6000);
    } finally { setImporting(false); }
  }

  const isActivePipeline = selectedPipeline === activePipelineId;
  const showCanvas = pipelineIsNew || !!selectedPipeline;
  const selectedStep = selectedNodeIdx !== null ? pipelineForm.steps[selectedNodeIdx] : null;

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex flex-col -m-6">

      {/* ── Top bar: pipeline controls ────────────────────────────────────────── */}
      <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0 flex-wrap bg-gray-950">
        <Workflow className="w-4 h-4 text-teal-400 shrink-0" />
        <select
          value={selectedPipeline ?? ""}
          onChange={e => {
            const p = (pipelines ?? []).find(x => x.id === e.target.value);
            if (p) openPipeline(p);
          }}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-teal-500"
        >
          <option value="">— Select pipeline —</option>
          {(pipelines ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={newPipeline}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-teal-800 hover:bg-teal-700 text-teal-100 text-xs rounded-lg border border-teal-700/60 transition-colors">
          <Plus className="w-3 h-3" /> New
        </button>

        {showCanvas && (
          <>
            <input
              value={pipelineForm.name}
              onChange={e => setPipelineForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Pipeline name…"
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-semibold text-white placeholder-gray-600 outline-none focus:border-teal-500 w-44"
            />
            <select value={pipelineForm.scope} onChange={e => setPipelineForm(f => ({ ...f, scope: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-teal-500">
              <option value="per_call">Per call</option>
              <option value="per_pair">Per pair</option>
            </select>
          </>
        )}

        <div className="flex-1" />

        <button onClick={importPresets} disabled={importing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-gray-500 hover:text-white text-xs transition-colors disabled:opacity-50">
          {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          Import presets
        </button>
        {importResult && (
          <span className="text-[10px] text-green-500">
            + {importResult.created_agents.length} agents, {importResult.created_pipelines.length} pipelines
          </span>
        )}

        {showCanvas && (
          <div className="flex items-center gap-2">
            {selectedPipeline && (
              <button
                onClick={() => setActivePipeline(isActivePipeline ? "" : selectedPipeline, isActivePipeline ? "" : pipelineForm.name)}
                className={cn("px-2 py-1 rounded text-[10px] font-medium border transition-colors",
                  isActivePipeline
                    ? "bg-teal-900/60 border-teal-700/50 text-teal-300 hover:bg-red-900/40 hover:border-red-700/50 hover:text-red-400"
                    : "bg-gray-800 border-gray-700 text-gray-400 hover:bg-teal-900/40 hover:text-teal-300",
                )}>
                {isActivePipeline ? "✓ Active" : "Set active"}
              </button>
            )}
            {selectedPipeline && (
              <button onClick={deletePipeline} className="p-1.5 text-red-500/60 hover:text-red-400 transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={savePipeline} disabled={pipelineSaving || !pipelineForm.name.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-teal-700 hover:bg-teal-600 text-white rounded-lg transition-colors disabled:opacity-50">
              {pipelineSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : pipelineSaved ? <Check className="w-3 h-3" /> : null}
              {pipelineSaved ? "Saved" : "Save"}
            </button>
          </div>
        )}
      </div>

      {/* ── Main layout: palette | canvas | settings ───────────────────────────── */}
      <div className="flex-1 min-h-0 flex bg-gray-950">

        {/* Left: class palette */}
        <div className="w-44 shrink-0 border-r border-gray-800 flex flex-col p-3 gap-2">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider font-semibold px-0.5 mb-1">Add element</p>
          {CLASS_TYPES.map(t => (
            <ClassPaletteCard
              key={t.cls}
              cls={t.cls}
              label={t.label}
              desc={t.desc}
              onAdd={() => addStep(t.cls)}
            />
          ))}
        </div>

        {/* Center: canvas */}
        <div
          className="flex-1 min-w-0 overflow-x-auto overflow-y-auto flex items-start pt-12 pb-8 px-8"
          onClick={e => { if (e.currentTarget === e.target) setSelectedNodeIdx(null); }}
        >
          {!showCanvas ? (
            <div className="flex-1 flex flex-col items-center justify-center min-h-full gap-3 text-gray-700 pointer-events-none">
              <Workflow className="w-14 h-14 opacity-10" />
              <p className="text-sm">Select a pipeline above or click New</p>
              <p className="text-xs text-gray-800">Then click an element on the left to add it to the canvas</p>
            </div>
          ) : pipelineForm.steps.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center min-h-48 gap-3 text-gray-700 pointer-events-none">
              <div className="border-2 border-dashed border-gray-800 rounded-3xl px-12 py-8 flex flex-col items-center gap-2">
                <Plus className="w-8 h-8 opacity-20" />
                <p className="text-sm">Click an element type on the left to add it here</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center flex-nowrap">
              {pipelineForm.steps.map((step, i) => (
                <CanvasNode
                  key={i}
                  step={step}
                  index={i}
                  total={pipelineForm.steps.length}
                  allAgents={allAgents}
                  prevStepClass={i > 0 ? allAgents.find(a => a.id === pipelineForm.steps[i - 1]?.agent_id)?.agent_class : undefined}
                  isSelected={selectedNodeIdx === i}
                  onClick={() => setSelectedNodeIdx(selectedNodeIdx === i ? null : i)}
                  onRemove={() => removeStep(i)}
                  onMoveLeft={() => moveStep(i, -1)}
                  onMoveRight={() => moveStep(i, 1)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right: node settings panel */}
        {selectedStep !== null && selectedNodeIdx !== null && (
          <NodeSettingsPanel
            key={selectedNodeIdx}
            step={selectedStep}
            allAgents={allAgents}
            prevStepClass={selectedNodeIdx > 0
              ? allAgents.find(a => a.id === pipelineForm.steps[selectedNodeIdx - 1]?.agent_id)?.agent_class
              : undefined}
            onChangeStep={s => updateStep(selectedNodeIdx, s)}
            onSaveAgent={saveNodeAgent}
            onClose={() => setSelectedNodeIdx(null)}
          />
        )}
      </div>
    </div>
  );
}
