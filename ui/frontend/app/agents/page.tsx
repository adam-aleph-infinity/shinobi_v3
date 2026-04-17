"use client";
import { useState, useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp,
  X, Workflow, Download, ChevronRight,
  User, Star, StickyNote, Shield, Zap,
  Mic2, Layers, BookOpen, Link2, PenLine, TriangleAlert,
  FileText, Braces, AlignLeft,
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
  { value: "transcript",        label: "Transcript",   shortLabel: "Transcript",  icon: Mic2,
    badge: "bg-blue-900/50 text-blue-300 border-blue-700/50",
    card:  "bg-blue-950 border-blue-700 text-blue-300",
    dot:   "bg-blue-500",
    desc: "Single call transcript" },
  { value: "merged_transcript", label: "Merged Transcript", shortLabel: "Merged",  icon: Layers,
    badge: "bg-cyan-900/50 text-cyan-300 border-cyan-700/50",
    card:  "bg-cyan-950 border-cyan-700 text-cyan-300",
    dot:   "bg-cyan-500",
    desc: "All calls merged" },
  { value: "notes",             label: "Notes",        shortLabel: "Notes",       icon: StickyNote,
    badge: "bg-green-900/50 text-green-300 border-green-700/50",
    card:  "bg-green-950 border-green-700 text-green-300",
    dot:   "bg-green-500",
    desc: "Call notes" },
  { value: "merged_notes",      label: "Merged Notes", shortLabel: "All Notes",   icon: BookOpen,
    badge: "bg-teal-900/50 text-teal-300 border-teal-700/50",
    card:  "bg-teal-950 border-teal-700 text-teal-300",
    dot:   "bg-teal-500",
    desc: "All notes aggregated" },
  { value: "agent_output",      label: "Agent Output", shortLabel: "Agent",       icon: Bot,
    badge: "bg-purple-900/50 text-purple-300 border-purple-700/50",
    card:  "bg-purple-950 border-purple-700 text-purple-300",
    dot:   "bg-purple-500",
    desc: "Output of another agent" },
  { value: "chain_previous",    label: "Prev Step",    shortLabel: "Prev",        icon: Link2,
    badge: "bg-amber-900/50 text-amber-300 border-amber-700/50",
    card:  "bg-amber-950 border-amber-700 text-amber-300",
    dot:   "bg-amber-500",
    desc: "Previous pipeline step" },
  { value: "manual",            label: "Manual",       shortLabel: "Manual",      icon: PenLine,
    badge: "bg-gray-700/50 text-gray-300 border-gray-600/50",
    card:  "bg-gray-800 border-gray-600 text-gray-300",
    dot:   "bg-gray-500",
    desc: "Provided at run time" },
] as const;

type SourceValue = typeof INPUT_SOURCES[number]["value"];

function sourceMeta(source: string) {
  return INPUT_SOURCES.find(s => s.value === source) ?? INPUT_SOURCES[6];
}

// ── Output format ─────────────────────────────────────────────────────────────

const OUTPUT_FMT: Record<string, {
  label: string; desc: string;
  icon: React.ComponentType<{ className?: string }>;
  bg: string; text: string; border: string; card: string;
}> = {
  markdown: { label: "Markdown", desc: "Structured text",     icon: FileText,  bg: "bg-indigo-900/50", text: "text-indigo-300",  border: "border-indigo-700/40", card: "bg-indigo-950 border-indigo-700 text-indigo-300" },
  json:     { label: "JSON",     desc: "Machine-readable",    icon: Braces,    bg: "bg-yellow-900/50", text: "text-yellow-300", border: "border-yellow-700/40", card: "bg-yellow-950 border-yellow-700 text-yellow-300" },
  text:     { label: "Text",     desc: "Plain unformatted",   icon: AlignLeft, bg: "bg-gray-700/50",   text: "text-gray-300",   border: "border-gray-600/40",   card: "bg-gray-800   border-gray-600   text-gray-300" },
};

// ── Agent class metadata ──────────────────────────────────────────────────────

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  persona: User, scorer: Star, notes: StickyNote, compliance: Shield, general: Zap,
};
const CLASS_ICON_BG: Record<string, string> = {
  persona: "bg-violet-900/60", scorer: "bg-violet-800/40",
  notes: "bg-teal-900/60", compliance: "bg-teal-800/40", general: "bg-sky-900/60",
};
const CLASS_REQUIRES_PREV: Record<string, string> = { scorer: "persona", compliance: "notes" };
const CLASS_META: Record<string, { label: string; textColor: string; borderColor: string }> = {
  persona:    { label: "Persona",    textColor: "text-violet-300", borderColor: "border-violet-700/40" },
  scorer:     { label: "Scorer",     textColor: "text-violet-400", borderColor: "border-violet-700/30" },
  notes:      { label: "Notes",      textColor: "text-teal-300",   borderColor: "border-teal-700/40"   },
  compliance: { label: "Compliance", textColor: "text-teal-400",   borderColor: "border-teal-700/30"   },
  general:    { label: "General",    textColor: "text-sky-300",    borderColor: "border-sky-700/40"    },
  "":         { label: "—",          textColor: "text-gray-400",   borderColor: "border-gray-700/40"   },
};

function classMeta(cls: string) {
  return CLASS_META[cls.toLowerCase()] ?? { label: cls, textColor: "text-gray-400", borderColor: "border-gray-700/40" };
}

function AgentClassIcon({ cls, size = "md" }: { cls: string; size?: "sm" | "md" }) {
  const norm = cls.toLowerCase();
  const Icon = CLASS_ICON[norm] ?? Bot;
  const bg   = CLASS_ICON_BG[norm] ?? "bg-gray-800";
  const meta = classMeta(norm);
  const dims     = size === "sm" ? "w-6 h-6" : "w-10 h-10";
  const iconDims = size === "sm" ? "w-3 h-3" : "w-5 h-5";
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
  _cls?: string;
}

interface Pipeline {
  id: string; name: string; description: string; scope: string;
  steps: PipelineStep[]; created_at: string;
}

const EMPTY_PIPELINE: Omit<Pipeline, "id" | "created_at"> = {
  name: "", description: "", scope: "per_pair", steps: [],
};

type NodeSelection =
  | { type: "agent"; stepIdx: number }
  | { type: "input"; stepIdx: number; inputKey: string }
  | { type: "output"; stepIdx: number }
  | { type: "add_input"; stepIdx: number }
  | null;

// ── Scope inference ───────────────────────────────────────────────────────────

function inferScope(steps: PipelineStep[], allAgents: UniversalAgent[]): string {
  const callSources = new Set(["transcript", "merged_transcript"]);
  for (const s of steps) {
    const agent = allAgents.find(a => a.id === s.agent_id);
    if (!agent) continue;
    for (const inp of agent.inputs ?? []) {
      const src = s.input_overrides[inp.key] ?? inp.source;
      if (callSources.has(src)) return "per_call";
    }
  }
  return "per_pair";
}

// ── Class palette ─────────────────────────────────────────────────────────────

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
    <button onClick={onAdd}
      className="w-full flex items-center gap-2 p-2 rounded-xl border border-gray-800 hover:border-gray-600 bg-gray-900 hover:bg-gray-800 transition-all text-left group">
      <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform", bg)}>
        <Icon className={cn("w-3.5 h-3.5", meta.textColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold text-gray-200">{label}</p>
        <p className="text-[9px] text-gray-600 leading-tight">{desc}</p>
      </div>
      <Plus className="w-3 h-3 text-gray-600 group-hover:text-teal-400 transition-colors shrink-0" />
    </button>
  );
}

// ── Source pill grid (in settings panel) ──────────────────────────────────────

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
            <Icon className="w-3 h-3 shrink-0" />{s.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Agent picker grid ─────────────────────────────────────────────────────────

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
          const meta    = classMeta(a.agent_class ?? "");
          const reqPrev = CLASS_REQUIRES_PREV[a.agent_class?.toLowerCase() ?? ""];
          const compat  = !reqPrev || !prevStepClass || reqPrev === prevStepClass.toLowerCase();
          const isSel   = value === a.id;
          return (
            <button key={a.id} onClick={() => onPick(a.id)}
              title={!compat ? `${meta.label} must follow a ${reqPrev} step` : a.description}
              className={cn(
                "flex items-center gap-1.5 p-2 rounded-lg border text-left transition-colors",
                isSel ? cn(meta.borderColor, "bg-gray-800")
                  : compat ? "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 hover:border-gray-600"
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

// ── Canvas: input source element ──────────────────────────────────────────────
// Each input is its own distinct mini-card node, colored by source type.

function InputSourceCard({ inp, step, isSelected, onClick, onRemove }: {
  inp: AgentInput; step: PipelineStep; isSelected: boolean;
  onClick: () => void; onRemove: () => void;
}) {
  const src  = sourceMeta(step.input_overrides[inp.key] ?? inp.source);
  const Icon = src.icon;
  return (
    <div className="flex flex-col items-center">
      {/* Mini source card */}
      <div
        onClick={onClick}
        className={cn(
          "relative rounded-xl border-2 flex flex-col items-center gap-1 px-2 py-2.5 w-[58px] cursor-pointer transition-all group select-none",
          isSelected
            ? cn(src.card, "shadow-lg shadow-black/40 scale-105")
            : cn(src.card, "opacity-60 hover:opacity-100 hover:scale-[1.04]"),
        )}
      >
        <Icon className="w-5 h-5 shrink-0" />
        <span className="text-[8px] font-semibold leading-tight text-center break-words w-full">{src.shortLabel}</span>
        <span className="text-[7px] font-mono opacity-60 leading-tight text-center truncate w-full">{inp.key}</span>
        {/* Remove × */}
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:border-red-500 hover:bg-red-950 z-10"
        >
          <X className="w-2 h-2 text-gray-500 hover:text-red-400" />
        </button>
      </div>
      {/* Wire down to card */}
      <div className={cn("w-px flex-1 min-h-[10px] transition-colors", isSelected ? "bg-gray-400" : "bg-gray-700/60")} />
    </div>
  );
}

// ── Canvas: output format element ─────────────────────────────────────────────

function OutputFormatCard({ agent, isSelected, onClick }: {
  agent: UniversalAgent; isSelected: boolean; onClick: () => void;
}) {
  const fmt  = agent.output_format ?? "markdown";
  const m    = OUTPUT_FMT[fmt] ?? OUTPUT_FMT.markdown;
  const Icon = m.icon;
  return (
    <div className="flex flex-col items-center">
      {/* Wire up from card */}
      <div className={cn("w-px h-3 transition-colors", isSelected ? "bg-gray-400" : "bg-gray-700/60")} />
      {/* Mini format card */}
      <div
        onClick={onClick}
        className={cn(
          "rounded-xl border-2 flex flex-col items-center gap-1 px-2 py-2.5 w-[58px] cursor-pointer transition-all select-none",
          isSelected
            ? cn(m.card, "shadow-lg shadow-black/40 scale-105")
            : cn(m.card, "opacity-60 hover:opacity-100 hover:scale-[1.04]"),
        )}
      >
        <Icon className="w-5 h-5 shrink-0" />
        <span className="text-[8px] font-semibold leading-tight text-center">{m.label}</span>
      </div>
    </div>
  );
}

// ── Canvas: "add input" placeholder ──────────────────────────────────────────

function AddInputCard({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col items-center">
      <button
        onClick={onClick}
        title="Add input"
        className="rounded-xl border-2 border-dashed border-gray-700 flex flex-col items-center justify-center gap-1 w-[48px] py-3 hover:border-teal-600 hover:bg-teal-950/40 transition-all group"
      >
        <Plus className="w-4 h-4 text-gray-700 group-hover:text-teal-400 transition-colors" />
        <span className="text-[7px] text-gray-700 group-hover:text-teal-400 transition-colors">add</span>
      </button>
      {/* Spacer (no wire — not connected) */}
      <div className="flex-1 min-h-[10px]" />
    </div>
  );
}

// ── Step card ─────────────────────────────────────────────────────────────────
//
// Fixed-height port regions keep all card bodies at the same Y so arrows align.

const INPUT_AREA_H  = 100; // px — tall enough for source mini-cards + wire
const OUTPUT_AREA_H = 80;  // px — space for output mini-card + wire

function StepCard({
  step, index, total, allAgents, prevStepClass,
  selection, onSelect,
  onRemove, onMoveLeft, onMoveRight,
  onRemoveInput,
}: {
  step: PipelineStep; index: number; total: number;
  allAgents: UniversalAgent[]; prevStepClass?: string;
  selection: NodeSelection;
  onSelect: (s: NodeSelection) => void;
  onRemove: () => void; onMoveLeft: () => void; onMoveRight: () => void;
  onRemoveInput: (key: string) => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);
  const cls   = agent?.agent_class ?? step._cls ?? "";
  const meta  = classMeta(cls);

  const reqPrev = agent ? (CLASS_REQUIRES_PREV[cls.toLowerCase()] ?? null) : null;
  const compat  = !reqPrev || !prevStepClass || reqPrev === prevStepClass.toLowerCase();

  const agentSel  = selection?.type === "agent"  && selection.stepIdx === index;
  const outputSel = selection?.type === "output" && selection.stepIdx === index;
  const inputSel  = (key: string) =>
    selection?.type === "input" && selection.stepIdx === index &&
    (selection as { type: "input"; stepIdx: number; inputKey: string }).inputKey === key;

  const inputs = agent?.inputs ?? [];

  return (
    <div className="flex items-start shrink-0">
      {/* Node column */}
      <div className="flex flex-col items-center shrink-0">

        {/* Controls pill */}
        <div className="flex items-center bg-gray-900 border border-gray-800 rounded-full px-1.5 py-0.5 shadow-sm mb-1">
          <button onClick={onMoveLeft} disabled={index === 0}
            className="p-0.5 text-gray-700 hover:text-gray-400 disabled:opacity-20 transition-colors">
            <ChevronRight className="w-3 h-3 rotate-180" />
          </button>
          <span className="text-[8px] font-mono text-gray-600 px-1">{index + 1}</span>
          <button onClick={onMoveRight} disabled={index === total - 1}
            className="p-0.5 text-gray-700 hover:text-gray-400 disabled:opacity-20 transition-colors">
            <ChevronRight className="w-3 h-3" />
          </button>
          <button onClick={onRemove} className="p-0.5 text-gray-700 hover:text-red-400 ml-0.5 transition-colors">
            <X className="w-2.5 h-2.5" />
          </button>
        </div>

        {/* ── Input source elements (fixed height) ── */}
        <div
          className="flex items-end justify-center gap-2 w-full pb-0"
          style={{ height: INPUT_AREA_H }}
        >
          {inputs.map(inp => (
            <InputSourceCard
              key={inp.key}
              inp={inp}
              step={step}
              isSelected={inputSel(inp.key)}
              onClick={() => onSelect(inputSel(inp.key) ? null : { type: "input", stepIdx: index, inputKey: inp.key })}
              onRemove={() => onRemoveInput(inp.key)}
            />
          ))}
          {/* + Add input card */}
          <AddInputCard onClick={() => onSelect({ type: "add_input", stepIdx: index })} />
        </div>

        {/* ── Agent card body ── */}
        <div className={cn(
          "rounded-2xl border-2 bg-gray-900/60 w-48 overflow-hidden transition-all",
          agentSel ? cn(meta.borderColor, "shadow-xl shadow-black/40") : "border-gray-800",
        )}>
          {!compat && (
            <div className="flex items-center gap-1 text-[9px] text-amber-400 px-3 py-1.5 bg-amber-900/20 border-b border-amber-700/30">
              <TriangleAlert className="w-3 h-3 shrink-0" /> needs {reqPrev}
            </div>
          )}
          <div
            onClick={() => onSelect(agentSel ? null : { type: "agent", stepIdx: index })}
            className="flex flex-col items-center gap-1.5 p-4 cursor-pointer hover:bg-gray-800/30 transition-colors"
          >
            <AgentClassIcon cls={cls} size="md" />
            <p className="text-[11px] font-semibold text-white text-center truncate w-full">
              {agent?.name ?? "Tap to configure"}
            </p>
            <span className={cn("text-[8px] px-1.5 py-0.5 rounded-full border", meta.textColor, meta.borderColor)}>
              {meta.label}
            </span>
          </div>
        </div>

        {/* ── Output format element (fixed height) ── */}
        <div
          className="flex items-start justify-center w-full"
          style={{ height: OUTPUT_AREA_H }}
        >
          {agent && (
            <OutputFormatCard
              agent={agent}
              isSelected={outputSel}
              onClick={() => onSelect(outputSel ? null : { type: "output", stepIdx: index })}
            />
          )}
        </div>

      </div>

      {/* Connecting arrow — offset to align with card body center */}
      {index < total - 1 && (
        <div
          className="flex items-center px-2 shrink-0 text-gray-700 self-start"
          style={{ marginTop: INPUT_AREA_H + 24 + 20 /* controls + top of card + half body */ }}
        >
          <div className="w-6 h-px bg-gray-700" />
          <ChevronRight className="w-3.5 h-3.5 -ml-1" />
        </div>
      )}
    </div>
  );
}

// ── Settings panels ───────────────────────────────────────────────────────────

function AgentSettingsPanel({ step, allAgents, prevStepClass, onChangeStep, onSaveAgent, onClose }: {
  step: PipelineStep; allAgents: UniversalAgent[]; prevStepClass?: string;
  onChangeStep: (s: PipelineStep) => void;
  onSaveAgent: (id: string, form: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
  onClose: () => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);
  const cls   = agent?.agent_class ?? step._cls ?? "";
  const meta  = classMeta(cls);

  const [draft, setDraft] = useState<Omit<UniversalAgent, "id" | "created_at">>(() =>
    agent
      ? { name: agent.name, description: agent.description ?? "", agent_class: agent.agent_class ?? "",
          model: agent.model, temperature: agent.temperature ?? 0,
          system_prompt: agent.system_prompt ?? "", user_prompt: agent.user_prompt ?? "",
          inputs: agent.inputs ?? [], output_format: agent.output_format ?? "markdown",
          tags: agent.tags ?? [], is_default: agent.is_default ?? false }
      : { ...EMPTY_AGENT, agent_class: step._cls ?? "" }
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [showModel, setShowModel] = useState(false);

  useEffect(() => {
    if (agent) {
      setDraft({ name: agent.name, description: agent.description ?? "", agent_class: agent.agent_class ?? "",
        model: agent.model, temperature: agent.temperature ?? 0,
        system_prompt: agent.system_prompt ?? "", user_prompt: agent.user_prompt ?? "",
        inputs: agent.inputs ?? [], output_format: agent.output_format ?? "markdown",
        tags: agent.tags ?? [], is_default: agent.is_default ?? false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.agent_id]);

  async function save() {
    if (!step.agent_id || !draft.name.trim()) return;
    setSaving(true);
    try { await onSaveAgent(step.agent_id, draft); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    finally { setSaving(false); }
  }

  function addInput() {
    const key = `input_${draft.inputs.length + 1}`;
    setDraft(f => ({ ...f, inputs: [...f.inputs, { key, source: "transcript" }] }));
  }

  function removeInput(i: number) {
    setDraft(f => ({ ...f, inputs: f.inputs.filter((_, j) => j !== i) }));
  }

  function updateInputKey(i: number, key: string) {
    setDraft(f => { const inputs = [...f.inputs]; inputs[i] = { ...inputs[i], key }; return { ...f, inputs }; });
  }

  function updateInputSource(i: number, source: SourceValue) {
    setDraft(f => { const inputs = [...f.inputs]; inputs[i] = { ...inputs[i], source }; return { ...f, inputs }; });
  }

  const varKeys = draft.inputs.filter(i => i.key);

  return (
    <div className="w-80 shrink-0 border-l border-gray-800 flex flex-col bg-gray-950">
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <AgentClassIcon cls={cls} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{agent?.name ?? "Configure agent"}</p>
          <p className={cn("text-[9px]", meta.textColor)}>{meta.label}</p>
        </div>
        <button onClick={onClose} className="p-1 text-gray-600 hover:text-white transition-colors shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Agent picker */}
        <div className="p-3 border-b border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wide mb-2">Agent</p>
          <AgentPickerGrid value={step.agent_id} allAgents={allAgents} prevStepClass={prevStepClass}
            onPick={id => onChangeStep({ ...step, agent_id: id, input_overrides: {} })} />
        </div>

        {/* Inputs */}
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[9px] text-gray-600 uppercase tracking-wide">Inputs</p>
            <button onClick={addInput}
              className="flex items-center gap-0.5 text-[9px] text-teal-400 hover:text-teal-300 transition-colors font-medium">
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          {draft.inputs.length === 0 && (
            <p className="text-[9px] text-gray-700 italic text-center py-2">No inputs — click + Add</p>
          )}
          <div className="space-y-2">
            {draft.inputs.map((inp, i) => {
              const src    = sourceMeta(inp.source);
              const SrcIco = src.icon;
              return (
                <div key={i} className="rounded-xl border border-gray-800 bg-gray-900/60 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-gray-800/60">
                    <span className="text-[10px] text-gray-600 font-mono shrink-0">{"{"}</span>
                    <input
                      value={inp.key}
                      onChange={e => updateInputKey(i, e.target.value)}
                      placeholder="variable_name"
                      className="flex-1 bg-transparent text-[11px] font-mono text-white outline-none placeholder-gray-600 min-w-0"
                    />
                    <span className="text-[10px] text-gray-600 font-mono shrink-0">{"}"}</span>
                    <button onClick={() => removeInput(i)}
                      className="p-0.5 text-gray-600 hover:text-red-400 transition-colors shrink-0 ml-1">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="px-2.5 py-2">
                    <p className="text-[8px] text-gray-700 uppercase tracking-wide mb-1.5">Source type</p>
                    <div className="flex flex-wrap gap-1">
                      {INPUT_SOURCES.map(s => {
                        const Ico   = s.icon;
                        const isSel = inp.source === s.value;
                        return (
                          <button key={s.value} onClick={() => updateInputSource(i, s.value)} title={s.desc}
                            className={cn(
                              "flex items-center gap-1 px-1.5 py-1 rounded-lg text-[9px] border transition-all",
                              isSel ? cn(s.badge, "shadow-sm") : "border-gray-700/50 bg-gray-800/30 text-gray-500 hover:text-gray-300 hover:border-gray-600",
                            )}>
                            <Ico className="w-2.5 h-2.5 shrink-0" />{s.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className={cn("mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[9px]", src.badge)}>
                      <SrcIco className="w-2.5 h-2.5 shrink-0" />
                      <span className="font-medium">{src.label}</span>
                      <span className="opacity-60 ml-0.5">— {src.desc}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Configure */}
        <div className="p-3 space-y-3">
          <p className="text-[9px] text-gray-600 uppercase tracking-wide">Configure</p>
          <div>
            <label className="block text-[9px] text-gray-500 mb-1">Name</label>
            <input value={draft.name} onChange={e => setDraft(f => ({ ...f, name: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
          </div>

          <div>
            <label className="block text-[9px] text-gray-500 mb-1">System Prompt</label>
            {varKeys.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {varKeys.map(inp => (
                  <button key={inp.key} type="button"
                    onClick={() => setDraft(f => ({ ...f, system_prompt: f.system_prompt + `{${inp.key}}` }))}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 font-mono transition-colors">
                    {`{${inp.key}}`}
                  </button>
                ))}
              </div>
            )}
            <textarea value={draft.system_prompt} onChange={e => setDraft(f => ({ ...f, system_prompt: e.target.value }))}
              rows={5} placeholder="You are a…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
          </div>

          <div>
            <label className="block text-[9px] text-gray-500 mb-1">User Prompt</label>
            {varKeys.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {varKeys.map(inp => (
                  <button key={inp.key} type="button"
                    onClick={() => setDraft(f => ({ ...f, user_prompt: f.user_prompt + `{${inp.key}}` }))}
                    className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 font-mono transition-colors">
                    {`{${inp.key}}`}
                  </button>
                ))}
              </div>
            )}
            <textarea value={draft.user_prompt} onChange={e => setDraft(f => ({ ...f, user_prompt: e.target.value }))}
              rows={5} placeholder={"Analyse this:\n\n{transcript}"}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
          </div>

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
                <div>
                  <label className="block text-[9px] text-gray-500 mb-1">Temperature</label>
                  <input type="number" min={0} max={2} step={0.1} value={draft.temperature}
                    onChange={e => setDraft(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
                </div>
              </div>
            )}
          </div>

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

// ── Input settings panel ──────────────────────────────────────────────────────

function InputSettingsPanel({ inp, step, agent, onChangeStep, onClose }: {
  inp: AgentInput; step: PipelineStep; agent: UniversalAgent;
  onChangeStep: (s: PipelineStep) => void; onClose: () => void;
}) {
  const effectiveSource = step.input_overrides[inp.key] ?? inp.source;
  const src             = sourceMeta(effectiveSource);
  const defaultSrc      = sourceMeta(inp.source);
  const isOverridden    = !!step.input_overrides[inp.key] && step.input_overrides[inp.key] !== inp.source;
  const Icon            = src.icon;
  const DefaultIcon     = defaultSrc.icon;

  return (
    <div className="w-80 shrink-0 border-l border-gray-800 flex flex-col bg-gray-950">
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center border shrink-0", src.badge)}>
          <Icon className="w-3.5 h-3.5 shrink-0" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white font-mono">{`{${inp.key}}`}</p>
          <p className="text-[9px] text-gray-500">{agent.name} · input</p>
        </div>
        <button onClick={onClose} className="p-1 text-gray-600 hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-3 space-y-4 overflow-y-auto">
        <div>
          <p className="text-[9px] text-gray-600 uppercase tracking-wide mb-2.5">Select source</p>
          <SourcePillGrid value={effectiveSource} onChange={val => {
            const overrides = { ...step.input_overrides };
            if (val === inp.source) delete overrides[inp.key];
            else overrides[inp.key] = val;
            onChangeStep({ ...step, input_overrides: overrides });
          }} />
        </div>
        <div className="flex items-center gap-1.5 text-[9px] text-gray-600 pt-1 border-t border-gray-800">
          <span>Default:</span>
          <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded-full border", defaultSrc.badge)}>
            <DefaultIcon className="w-2.5 h-2.5 shrink-0" />{defaultSrc.label}
          </span>
          {isOverridden && <span className="text-amber-500 ml-1">overridden</span>}
        </div>
        <div className="space-y-1 pt-1 border-t border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wide mb-1.5">Sources</p>
          {INPUT_SOURCES.map(s => {
            const SIcon = s.icon;
            return (
              <div key={s.value} className={cn(
                "flex items-center gap-2 px-2 py-1.5 rounded-lg text-[10px]",
                effectiveSource === s.value ? cn(s.badge, "border") : "text-gray-600",
              )}>
                <SIcon className="w-3 h-3 shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-1.5 opacity-60">{s.desc}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Output settings panel ─────────────────────────────────────────────────────

function OutputSettingsPanel({ agent, onSaveAgent, onClose }: {
  agent: UniversalAgent;
  onSaveAgent: (id: string, form: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
  onClose: () => void;
}) {
  const [fmt, setFmt]       = useState(agent.output_format ?? "markdown");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSaveAgent(agent.id, { ...agent, output_format: fmt });
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className="w-72 shrink-0 border-l border-gray-800 flex flex-col bg-gray-950">
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-gray-800 flex items-center justify-center shrink-0">
          <FileText className="w-3.5 h-3.5 text-gray-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white">Output format</p>
          <p className="text-[9px] text-gray-500">{agent.name}</p>
        </div>
        <button onClick={onClose} className="p-1 text-gray-600 hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto">
        <p className="text-[9px] text-gray-600 uppercase tracking-wide mb-2">Response format</p>
        {Object.entries(OUTPUT_FMT).map(([key, m]) => {
          const FmtIcon = m.icon;
          const isSel   = fmt === key;
          return (
            <button key={key} onClick={() => setFmt(key)}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left",
                isSel ? cn("shadow-md", m.border, "bg-gray-800") : "border-gray-800 bg-gray-900 hover:border-gray-700",
              )}>
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", m.bg)}>
                <FmtIcon className={cn("w-4 h-4", m.text)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={cn("text-xs font-semibold", isSel ? m.text : "text-gray-300")}>{m.label}</p>
                <p className="text-[9px] text-gray-600 leading-tight">{m.desc}</p>
              </div>
              {isSel && <Check className="w-3.5 h-3.5 text-white shrink-0" />}
            </button>
          );
        })}
        <button onClick={save} disabled={saving || fmt === (agent.output_format ?? "markdown")}
          className="w-full flex items-center justify-center gap-1.5 mt-3 py-2 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Add-input picker panel ────────────────────────────────────────────────────
// Shown in the right panel when the user clicks the + card on a canvas node.
// The user picks a source type, then the colored mini-card is created.

function AddInputPickerPanel({ stepIdx, step, allAgents, onAdd, onClose }: {
  stepIdx: number; step: PipelineStep; allAgents: UniversalAgent[];
  onAdd: (src: SourceValue) => void; onClose: () => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);
  return (
    <div className="w-72 shrink-0 border-l border-gray-800 flex flex-col bg-gray-950">
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded-lg bg-teal-900/60 border border-teal-700/50 flex items-center justify-center shrink-0">
          <Plus className="w-3.5 h-3.5 text-teal-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white">Add input</p>
          <p className="text-[9px] text-gray-500">
            {agent?.name ?? `Step ${stepIdx + 1}`} · choose source type
          </p>
        </div>
        <button onClick={onClose} className="p-1 text-gray-600 hover:text-white transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-3 space-y-1.5 overflow-y-auto flex-1">
        <p className="text-[9px] text-gray-600 uppercase tracking-wide mb-2.5">Choose source type</p>
        {INPUT_SOURCES.map(s => {
          const Icon = s.icon;
          return (
            <button key={s.value} onClick={() => onAdd(s.value)}
              className={cn(
                "w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all text-left group",
                "border-gray-800 bg-gray-900 hover:bg-gray-800/80 hover:border-gray-700",
              )}>
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border", s.badge)}>
                <Icon className="w-4 h-4 shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-gray-200 group-hover:text-white transition-colors">{s.label}</p>
                <p className="text-[9px] text-gray-600 leading-tight">{s.desc}</p>
              </div>
              <Plus className="w-3 h-3 text-gray-700 group-hover:text-teal-400 transition-colors shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const { mutate } = useSWRConfig();
  const { activePipelineId, setActivePipeline } = useAppCtx();

  const { data: agents }    = useSWR<UniversalAgent[]>(`${API}/universal-agents`, fetcher);
  const { data: pipelines } = useSWR<Pipeline[]>(`${API}/pipelines`, fetcher);

  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null);
  const [pipelineForm, setPipelineForm]         = useState({ ...EMPTY_PIPELINE });
  const [pipelineIsNew, setPipelineIsNew]       = useState(false);
  const [pipelineSaving, setPipelineSaving]     = useState(false);
  const [pipelineSaved, setPipelineSaved]       = useState(false);

  const [selection, setSelection] = useState<NodeSelection>(null);

  const [importing, setImporting]       = useState(false);
  const [importResult, setImportResult] = useState<{ created_agents: string[]; created_pipelines: string[]; skipped: string[] } | null>(null);

  const allAgents = agents ?? [];

  function openPipeline(p: Pipeline) {
    setSelectedPipeline(p.id);
    setPipelineForm({ name: p.name, description: p.description ?? "", scope: p.scope, steps: p.steps ?? [] });
    setPipelineIsNew(false); setPipelineSaved(false); setSelection(null);
  }

  function newPipeline() {
    setSelectedPipeline(null);
    setPipelineForm({ ...EMPTY_PIPELINE });
    setPipelineIsNew(true); setPipelineSaved(false); setSelection(null);
  }

  async function savePipeline() {
    if (!pipelineForm.name.trim()) return;
    setPipelineSaving(true);
    try {
      const method  = pipelineIsNew ? "POST" : "PUT";
      const url     = pipelineIsNew ? `${API}/pipelines` : `${API}/pipelines/${selectedPipeline}`;
      const scope   = inferScope(pipelineForm.steps, allAgents);
      const payload = { ...pipelineForm, scope, steps: pipelineForm.steps.map(({ _cls: _c, ...rest }) => rest) };
      const res     = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data    = await res.json();
      mutate(`${API}/pipelines`);
      if (pipelineIsNew) setSelectedPipeline(data.id ?? null);
      setPipelineIsNew(false); setPipelineSaved(true);
      setTimeout(() => setPipelineSaved(false), 2000);
    } finally { setPipelineSaving(false); }
  }

  async function deletePipeline() {
    if (!selectedPipeline || !confirm(`Delete pipeline "${pipelineForm.name}"?`)) return;
    await fetch(`${API}/pipelines/${selectedPipeline}`, { method: "DELETE" });
    mutate(`${API}/pipelines`);
    if (activePipelineId === selectedPipeline) setActivePipeline("", "");
    setSelectedPipeline(null); setPipelineIsNew(false); setSelection(null);
    setPipelineForm({ ...EMPTY_PIPELINE });
  }

  function addStep(cls: string) {
    const newIdx = pipelineForm.steps.length;
    setPipelineForm(f => ({ ...f, steps: [...f.steps, { agent_id: "", input_overrides: {}, _cls: cls }] }));
    setSelection({ type: "agent", stepIdx: newIdx });
    if (!pipelineIsNew && !selectedPipeline) newPipeline();
  }

  function updateStep(i: number, s: PipelineStep) {
    setPipelineForm(f => { const steps = [...f.steps]; steps[i] = s; return { ...f, steps }; });
  }

  function removeStep(i: number) {
    setPipelineForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) }));
    setSelection(prev => {
      if (!prev) return null;
      if (prev.stepIdx === i) return null;
      if (prev.stepIdx > i) return { ...prev, stepIdx: prev.stepIdx - 1 };
      return prev;
    });
  }

  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= pipelineForm.steps.length) return;
    setPipelineForm(f => {
      const steps = [...f.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...f, steps };
    });
    setSelection(prev => {
      if (!prev) return null;
      if (prev.stepIdx === i) return { ...prev, stepIdx: j };
      if (prev.stepIdx === j) return { ...prev, stepIdx: i };
      return prev;
    });
  }

  async function saveNodeAgent(agentId: string, form: Omit<UniversalAgent, "id" | "created_at">) {
    await fetch(`${API}/universal-agents/${agentId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
    });
    mutate(`${API}/universal-agents`);
  }

  // Called after the user picks a source type in AddInputPickerPanel
  async function addInputToStep(stepIdx: number, sourceType: SourceValue) {
    const step  = pipelineForm.steps[stepIdx];
    const agent = allAgents.find(a => a.id === step.agent_id);
    if (!agent) {
      // No agent yet — open agent settings so they can pick one first
      setSelection({ type: "agent", stepIdx });
      return;
    }
    const newKey    = `input_${agent.inputs.length + 1}`;
    const newInputs = [...agent.inputs, { key: newKey, source: sourceType }];
    await saveNodeAgent(agent.id, { ...agent, inputs: newInputs });
    setSelection({ type: "input", stepIdx, inputKey: newKey });
  }

  // Remove an input directly from the canvas × button
  async function removeInputFromStep(stepIdx: number, inputKey: string) {
    const step  = pipelineForm.steps[stepIdx];
    const agent = allAgents.find(a => a.id === step.agent_id);
    if (!agent) return;
    const newInputs = agent.inputs.filter(i => i.key !== inputKey);
    await saveNodeAgent(agent.id, { ...agent, inputs: newInputs });
    // Clear selection if this input was selected
    if (
      selection?.type === "input" &&
      selection.stepIdx === stepIdx &&
      (selection as { type: "input"; stepIdx: number; inputKey: string }).inputKey === inputKey
    ) setSelection(null);
  }

  async function importPresets() {
    setImporting(true); setImportResult(null);
    try {
      const res  = await fetch(`${API}/universal-agents/import-presets`, { method: "POST" });
      const data = await res.json();
      mutate(`${API}/universal-agents`); mutate(`${API}/pipelines`);
      setImportResult(data);
      setTimeout(() => setImportResult(null), 6000);
    } finally { setImporting(false); }
  }

  const isActivePipeline = selectedPipeline === activePipelineId;
  const showCanvas        = pipelineIsNew || !!selectedPipeline;

  const selStep    = selection !== null ? pipelineForm.steps[selection.stepIdx] : null;
  const selAgent   = selStep ? allAgents.find(a => a.id === selStep.agent_id) : undefined;
  const selInpMeta = selection?.type === "input" && selStep && selAgent
    ? selAgent.inputs.find(inp => inp.key === (selection as { type: "input"; stepIdx: number; inputKey: string }).inputKey)
    : undefined;

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex flex-col -m-6">

      {/* Top bar */}
      <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2 shrink-0 bg-gray-950">
        <Workflow className="w-4 h-4 text-teal-400 shrink-0" />
        {showCanvas ? (
          <input
            value={pipelineForm.name}
            onChange={e => setPipelineForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Pipeline name…"
            className="bg-transparent border-b border-gray-700 focus:border-teal-500 px-1 py-0.5 text-sm font-semibold text-white placeholder-gray-600 outline-none w-48 transition-colors"
          />
        ) : (
          <span className="text-sm text-gray-600">Pipeline builder</span>
        )}
        <div className="flex-1" />
        <button onClick={importPresets} disabled={importing}
          className="flex items-center gap-1.5 px-2 py-1.5 text-gray-500 hover:text-white text-xs transition-colors disabled:opacity-50">
          {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          Import presets
        </button>
        {importResult && <span className="text-[10px] text-green-500">+{importResult.created_agents.length} agents</span>}
        {showCanvas && (
          <div className="flex items-center gap-1.5">
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

      {/* Main layout */}
      <div className="flex-1 min-h-0 flex bg-gray-950">

        {/* Left: pipeline list + class palette */}
        <div className="w-44 shrink-0 border-r border-gray-800 flex flex-col">
          <div className="p-2 border-b border-gray-800">
            <div className="flex items-center justify-between mb-2 px-0.5">
              <p className="text-[9px] text-gray-600 uppercase tracking-wider font-semibold">Pipelines</p>
              <button onClick={newPipeline}
                className="flex items-center gap-0.5 text-[9px] text-teal-500 hover:text-teal-300 transition-colors font-medium">
                <Plus className="w-3 h-3" /> New
              </button>
            </div>
            <div className="space-y-0.5 max-h-36 overflow-y-auto">
              {(pipelines ?? []).length === 0 && (
                <p className="text-[9px] text-gray-700 italic px-1 py-2">No pipelines yet</p>
              )}
              {(pipelines ?? []).map(p => (
                <button key={p.id} onClick={() => openPipeline(p)}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-[10px] transition-colors",
                    selectedPipeline === p.id
                      ? "bg-teal-900/30 text-teal-200 border border-teal-700/30"
                      : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/60",
                  )}>
                  <Workflow className="w-3 h-3 shrink-0 opacity-60" />
                  <span className="truncate flex-1">{p.name}</span>
                  {p.id === activePipelineId && <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider font-semibold px-0.5 mb-1">Add element</p>
            {CLASS_TYPES.map(t => (
              <ClassPaletteCard key={t.cls} cls={t.cls} label={t.label} desc={t.desc} onAdd={() => addStep(t.cls)} />
            ))}
          </div>
        </div>

        {/* Center: canvas */}
        <div
          className="flex-1 min-w-0 overflow-auto flex items-start pt-8 pb-8 px-8"
          onClick={e => { if (e.currentTarget === e.target) setSelection(null); }}
        >
          {!showCanvas ? (
            <div className="flex-1 flex flex-col items-center justify-center min-h-full gap-3 text-gray-700 pointer-events-none">
              <Workflow className="w-14 h-14 opacity-10" />
              <p className="text-sm">Select a pipeline or click New</p>
              <p className="text-xs text-gray-800">Then click an element type on the left to add it</p>
            </div>
          ) : pipelineForm.steps.length === 0 ? (
            <div className="flex-1 flex items-center justify-center min-h-48 pointer-events-none">
              <div className="border-2 border-dashed border-gray-800 rounded-3xl px-12 py-10 flex flex-col items-center gap-2 text-gray-700">
                <Plus className="w-8 h-8 opacity-20" />
                <p className="text-sm">Click an element type on the left to add it here</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start flex-nowrap gap-0">
              {pipelineForm.steps.map((step, i) => (
                <StepCard
                  key={i}
                  step={step} index={i} total={pipelineForm.steps.length}
                  allAgents={allAgents}
                  prevStepClass={i > 0 ? allAgents.find(a => a.id === pipelineForm.steps[i - 1]?.agent_id)?.agent_class : undefined}
                  selection={selection}
                  onSelect={setSelection}
                  onRemove={() => removeStep(i)}
                  onMoveLeft={() => moveStep(i, -1)}
                  onMoveRight={() => moveStep(i, 1)}
                  onRemoveInput={key => removeInputFromStep(i, key)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right: settings panel */}
        {selection !== null && selStep !== null && (
          <>
            {selection.type === "add_input" && (
              <AddInputPickerPanel
                key={`add_input-${selection.stepIdx}`}
                stepIdx={selection.stepIdx}
                step={selStep}
                allAgents={allAgents}
                onAdd={src => addInputToStep(selection.stepIdx, src)}
                onClose={() => setSelection(null)}
              />
            )}
            {selection.type === "agent" && (
              <AgentSettingsPanel
                key={`agent-${selection.stepIdx}`}
                step={selStep}
                allAgents={allAgents}
                prevStepClass={selection.stepIdx > 0
                  ? allAgents.find(a => a.id === pipelineForm.steps[selection.stepIdx - 1]?.agent_id)?.agent_class
                  : undefined}
                onChangeStep={s => updateStep(selection.stepIdx, s)}
                onSaveAgent={saveNodeAgent}
                onClose={() => setSelection(null)}
              />
            )}
            {selection.type === "input" && selAgent && selInpMeta && (
              <InputSettingsPanel
                key={`input-${selection.stepIdx}-${(selection as { type: "input"; stepIdx: number; inputKey: string }).inputKey}`}
                inp={selInpMeta}
                step={selStep}
                agent={selAgent}
                onChangeStep={s => updateStep(selection.stepIdx, s)}
                onClose={() => setSelection(null)}
              />
            )}
            {selection.type === "output" && selAgent && (
              <OutputSettingsPanel
                key={`output-${selection.stepIdx}`}
                agent={selAgent}
                onSaveAgent={saveNodeAgent}
                onClose={() => setSelection(null)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
