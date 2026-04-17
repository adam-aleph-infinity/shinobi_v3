"use client";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp,
  Settings2, X, ArrowUp, ArrowDown, Workflow, Download,
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

function ModelSelect({ value, onChange, accentColor = "indigo" }: {
  value: string; onChange: (v: string) => void; accentColor?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-${accentColor}-500`}
    >
      {MODEL_GROUPS.map(g => (
        <optgroup key={g.provider} label={g.provider}>
          {g.models.map(m => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// ── Input source definitions ──────────────────────────────────────────────────

const INPUT_SOURCES = [
  { value: "transcript",        label: "Transcript",        icon: Mic2,       badge: "bg-blue-900/50 text-blue-300 border-blue-700/50",       desc: "Single call transcript" },
  { value: "merged_transcript", label: "Merged Transcript", icon: Layers,     badge: "bg-cyan-900/50 text-cyan-300 border-cyan-700/50",       desc: "All calls for the pair merged into one document" },
  { value: "notes",             label: "Notes",             icon: StickyNote, badge: "bg-green-900/50 text-green-300 border-green-700/50",    desc: "Call notes for a specific call" },
  { value: "merged_notes",      label: "Merged Notes",      icon: BookOpen,   badge: "bg-teal-900/50 text-teal-300 border-teal-700/50",       desc: "All notes aggregated across the pair" },
  { value: "agent_output",      label: "Agent Output",      icon: Bot,        badge: "bg-purple-900/50 text-purple-300 border-purple-700/50", desc: "Output of another specific agent" },
  { value: "chain_previous",    label: "Prev Step",         icon: Link2,      badge: "bg-amber-900/50 text-amber-300 border-amber-700/50",    desc: "Output of the immediately preceding pipeline step" },
  { value: "manual",            label: "Manual",            icon: PenLine,    badge: "bg-gray-700/50 text-gray-300 border-gray-600/50",       desc: "User provides content at run time" },
] as const;

type SourceValue = typeof INPUT_SOURCES[number]["value"];

function sourceBadge(source: string) {
  return INPUT_SOURCES.find(s => s.value === source) ?? INPUT_SOURCES[6];
}

// ── Agent class icons + connection rules ──────────────────────────────────────

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  persona:    User,
  scorer:     Star,
  notes:      StickyNote,
  compliance: Shield,
  general:    Zap,
};

const CLASS_ICON_BG: Record<string, string> = {
  persona:    "bg-violet-900/60",
  scorer:     "bg-violet-800/40",
  notes:      "bg-teal-900/60",
  compliance: "bg-teal-800/40",
  general:    "bg-sky-900/60",
};

// A step of these classes must follow the specified upstream class
const CLASS_REQUIRES_PREV: Record<string, string> = {
  scorer:     "persona",
  compliance: "notes",
};

function AgentClassIcon({ cls, size = "md" }: { cls: string; size?: "sm" | "md" | "lg" }) {
  const norm = cls.toLowerCase();
  const Icon = CLASS_ICON[norm] ?? Bot;
  const bg   = CLASS_ICON_BG[norm] ?? "bg-gray-800";
  const meta = classMeta(norm);
  const dims     = { sm: "w-6 h-6", md: "w-8 h-8", lg: "w-10 h-10" }[size];
  const iconDims = { sm: "w-3 h-3", md: "w-4 h-4", lg: "w-5 h-5" }[size];
  return (
    <div className={cn("rounded-lg flex items-center justify-center shrink-0", bg, dims)}>
      <Icon className={cn(iconDims, meta.textColor)} />
    </div>
  );
}

// ── Universal Agent types ─────────────────────────────────────────────────────

interface AgentInput {
  key: string;
  source: SourceValue;
  agent_id?: string;
  label?: string;
}

interface UniversalAgent {
  id: string;
  name: string;
  description: string;
  agent_class: string;
  model: string;
  temperature: number;
  system_prompt: string;
  user_prompt: string;
  inputs: AgentInput[];
  output_format: string;
  tags: string[];
  is_default: boolean;
  created_at: string;
}

const EMPTY_AGENT: Omit<UniversalAgent, "id" | "created_at"> = {
  name: "",
  description: "",
  agent_class: "",
  model: "gpt-5.4",
  temperature: 0,
  system_prompt: "",
  user_prompt: "",
  inputs: [],
  output_format: "markdown",
  tags: [],
  is_default: false,
};

// ── Pipeline types ────────────────────────────────────────────────────────────

interface PipelineStep {
  agent_id: string;
  input_overrides: Record<string, string>;
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  scope: string;
  steps: PipelineStep[];
  created_at: string;
}

const EMPTY_PIPELINE: Omit<Pipeline, "id" | "created_at"> = {
  name: "",
  description: "",
  scope: "per_pair",
  steps: [],
};

// ── InputRow — one input entry in the agent builder ──────────────────────────

function InputRow({
  input, agents, onChange, onRemove,
}: {
  input: AgentInput; agents: UniversalAgent[];
  onChange: (updated: AgentInput) => void; onRemove: () => void;
}) {
  return (
    <div className="flex items-start gap-2 p-2.5 bg-gray-800/40 border border-gray-700/60 rounded-lg">
      <div className="flex flex-col gap-0.5 w-28 shrink-0">
        <label className="text-[9px] text-gray-600 uppercase tracking-wide">Variable</label>
        <div className="flex items-center">
          <span className="text-gray-500 text-xs mr-0.5">{"{"}</span>
          <input
            value={input.key}
            onChange={e => onChange({ ...input, key: e.target.value.replace(/\s/g, "_") })}
            placeholder="key"
            className="flex-1 min-w-0 bg-transparent border-b border-gray-700 text-xs text-amber-300 outline-none py-0.5 placeholder-gray-600"
          />
          <span className="text-gray-500 text-xs ml-0.5">{"}"}</span>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <label className="text-[9px] text-gray-600 uppercase tracking-wide">Source</label>
        <select
          value={input.source}
          onChange={e => onChange({ ...input, source: e.target.value as SourceValue, agent_id: undefined })}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500"
        >
          {INPUT_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>
      {input.source === "agent_output" && (
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <label className="text-[9px] text-gray-600 uppercase tracking-wide">Agent</label>
          <select
            value={input.agent_id ?? ""}
            onChange={e => onChange({ ...input, agent_id: e.target.value || undefined })}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-purple-500"
          >
            <option value="">— pick agent —</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}
      <button onClick={onRemove} className="mt-4 text-gray-600 hover:text-red-400 transition-colors shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── VariableHint ─────────────────────────────────────────────────────────────

function VariableHint({ inputs }: { inputs: AgentInput[] }) {
  if (inputs.length === 0) return null;
  return (
    <p className="text-[10px] text-gray-600">
      Available: {inputs.filter(i => i.key).map(i => (
        <span key={i.key} className="text-amber-400 mr-1">{`{${i.key}}`}</span>
      ))}
    </p>
  );
}

// ── Agent class grouping ──────────────────────────────────────────────────────

const CLASS_PARENT: Record<string, string> = {
  scorer:     "persona",
  compliance: "notes",
};

const CLASS_META: Record<string, { label: string; textColor: string; borderColor: string; dotColor: string }> = {
  persona:    { label: "Persona",       textColor: "text-violet-300", borderColor: "border-violet-700/40", dotColor: "bg-violet-400" },
  scorer:     { label: "Scorer",        textColor: "text-violet-400", borderColor: "border-violet-700/30", dotColor: "bg-violet-500/70" },
  notes:      { label: "Notes",         textColor: "text-teal-300",   borderColor: "border-teal-700/40",   dotColor: "bg-teal-400" },
  compliance: { label: "Compliance",    textColor: "text-teal-400",   borderColor: "border-teal-700/30",   dotColor: "bg-teal-500/70" },
  general:    { label: "General",       textColor: "text-sky-300",    borderColor: "border-sky-700/40",    dotColor: "bg-sky-400" },
  "":         { label: "Uncategorized", textColor: "text-gray-400",   borderColor: "border-gray-700/40",   dotColor: "bg-gray-500" },
};

function classMeta(cls: string) {
  return CLASS_META[cls.toLowerCase()] ?? {
    label: cls, textColor: "text-gray-400", borderColor: "border-gray-700/40", dotColor: "bg-gray-500",
  };
}

interface AgentGroup {
  cls: string;
  agents: UniversalAgent[];
  subGroups: { cls: string; agents: UniversalAgent[] }[];
}

function groupAgents(agents: UniversalAgent[]): AgentGroup[] {
  const byClass: Record<string, UniversalAgent[]> = {};
  for (const a of agents) {
    const cls = (a.agent_class ?? "").toLowerCase().trim();
    if (!byClass[cls]) byClass[cls] = [];
    byClass[cls].push(a);
  }
  const PARENT_ORDER = ["persona", "notes", "general"];
  const usedClasses = new Set<string>();
  const result: AgentGroup[] = [];
  for (const parentCls of PARENT_ORDER) {
    const children = Object.entries(CLASS_PARENT)
      .filter(([, p]) => p === parentCls)
      .map(([child]) => ({ cls: child, agents: byClass[child] ?? [] }))
      .filter(g => g.agents.length > 0);
    const direct = byClass[parentCls] ?? [];
    if (direct.length === 0 && children.length === 0) continue;
    result.push({ cls: parentCls, agents: direct, subGroups: children });
    usedClasses.add(parentCls);
    children.forEach(c => usedClasses.add(c.cls));
  }
  for (const [cls, list] of Object.entries(byClass)) {
    if (!usedClasses.has(cls)) result.push({ cls, agents: list, subGroups: [] });
  }
  return result;
}

// ── Agent Library Card ────────────────────────────────────────────────────────

function AgentLibraryCard({ agent, isEditing, onEdit, onAdd }: {
  agent: UniversalAgent;
  isEditing: boolean;
  onEdit: () => void;
  onAdd: () => void;
}) {
  const { setActiveAgent, activeAgentId } = useAppCtx();
  const isActive = activeAgentId === agent.id;
  const meta = classMeta(agent.agent_class ?? "");

  return (
    <div className={cn(
      "group flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors",
      isEditing ? "bg-indigo-900/20" : "hover:bg-gray-800/60",
    )}>
      <AgentClassIcon cls={agent.agent_class ?? ""} size="sm" />
      <div className="flex-1 min-w-0">
        <p className={cn("text-[11px] font-medium truncate", isEditing ? "text-white" : "text-gray-300")}>
          {agent.name}
        </p>
        <div className="flex items-center gap-1">
          <span className={cn("text-[8px]", meta.textColor)}>{meta.label}</span>
          {isActive && <span className="text-[8px] bg-violet-900/60 text-violet-400 border border-violet-700/50 px-0.5 rounded">active</span>}
          {agent.is_default && !isActive && <span className="text-[8px] bg-indigo-900 text-indigo-400 px-0.5 rounded">default</span>}
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={() => setActiveAgent(isActive ? "" : agent.id, isActive ? "" : agent.name, isActive ? "" : (agent.agent_class ?? ""))}
          title={isActive ? "Deselect" : "Set as active agent"}
          className={cn(
            "p-1 rounded transition-colors",
            isActive ? "text-violet-400" : "text-gray-600 hover:text-violet-400",
          )}
        >
          <Check className="w-2.5 h-2.5" />
        </button>
        <button onClick={onEdit} title="Edit agent" className="p-1 text-gray-600 hover:text-gray-300 transition-colors">
          <Settings2 className="w-3 h-3" />
        </button>
        <button onClick={onAdd} title="Add to pipeline" className="p-1 text-gray-600 hover:text-teal-400 transition-colors">
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function LibrarySubGroup({ sub, editingId, onEdit, onAdd }: {
  sub: { cls: string; agents: UniversalAgent[] };
  editingId: string | null;
  onEdit: (a: UniversalAgent) => void;
  onAdd: (id: string) => void;
}) {
  const meta = classMeta(sub.cls);
  const [open, setOpen] = useState(true);
  return (
    <div className={cn("ml-2.5 pl-2.5 border-l border-dashed mt-1.5", meta.borderColor)}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-gray-800/40 transition-colors text-left mb-0.5">
        <div className={cn("w-1 h-1 rounded-full shrink-0", meta.dotColor)} />
        <span className={cn("flex-1 text-[9px] font-semibold uppercase tracking-wider", meta.textColor)}>{meta.label}</span>
        <span className="text-[9px] text-gray-600 mr-0.5">{sub.agents.length}</span>
        {open ? <ChevronUp className="w-3 h-3 text-gray-600" /> : <ChevronDown className="w-3 h-3 text-gray-600" />}
      </button>
      {open && (
        <div className="space-y-0.5">
          {sub.agents.map(a => (
            <AgentLibraryCard key={a.id} agent={a} isEditing={editingId === a.id}
              onEdit={() => onEdit(a)} onAdd={() => onAdd(a.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryGroup({ group, editingId, onEdit, onAdd }: {
  group: AgentGroup; editingId: string | null;
  onEdit: (a: UniversalAgent) => void; onAdd: (id: string) => void;
}) {
  const meta = classMeta(group.cls);
  const total = group.agents.length + group.subGroups.reduce((s, g) => s + g.agents.length, 0);
  const [open, setOpen] = useState(total > 0);
  return (
    <div className="mb-2">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-800/60 transition-colors text-left">
        <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", meta.dotColor)} />
        <span className={cn("flex-1 text-[10px] font-semibold uppercase tracking-wider", meta.textColor)}>{meta.label}</span>
        <span className="text-[9px] text-gray-600 tabular-nums mr-0.5">{total}</span>
        {open ? <ChevronUp className="w-3 h-3 text-gray-600" /> : <ChevronDown className="w-3 h-3 text-gray-600" />}
      </button>
      {open && (
        <div className="space-y-0.5 ml-1 mt-0.5">
          {group.agents.map(a => (
            <AgentLibraryCard key={a.id} agent={a} isEditing={editingId === a.id}
              onEdit={() => onEdit(a)} onAdd={() => onAdd(a.id)} />
          ))}
          {group.subGroups.map(sub => (
            <LibrarySubGroup key={sub.cls} sub={sub} editingId={editingId} onEdit={onEdit} onAdd={onAdd} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── StepConnector ─────────────────────────────────────────────────────────────

function StepConnector() {
  return (
    <div className="flex flex-col items-center my-0.5 pointer-events-none">
      <div className="w-px h-3 bg-gray-700" />
      <ChevronDown className="w-3 h-3 text-gray-700" />
      <div className="w-px h-3 bg-gray-700" />
    </div>
  );
}

// ── SourcePillGrid ────────────────────────────────────────────────────────────

function SourcePillGrid({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {INPUT_SOURCES.map(s => {
        const Icon = s.icon;
        const isSelected = value === s.value;
        return (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            title={s.desc}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] font-medium border transition-all",
              isSelected
                ? s.badge
                : "border-gray-700 bg-gray-800/40 text-gray-500 hover:text-gray-300 hover:border-gray-600",
            )}
          >
            <Icon className="w-3 h-3 shrink-0" />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ── AgentPickerGrid ───────────────────────────────────────────────────────────

function AgentPickerGrid({
  value, allAgents, prevStepClass, onPick,
}: {
  value: string; allAgents: UniversalAgent[]; prevStepClass?: string;
  onPick: (agentId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = allAgents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    (a.agent_class ?? "").toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="space-y-2">
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search agents…"
        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500"
      />
      <div className="grid grid-cols-2 gap-1.5 max-h-52 overflow-y-auto">
        {filtered.map(a => {
          const meta      = classMeta(a.agent_class ?? "");
          const reqPrev   = CLASS_REQUIRES_PREV[a.agent_class?.toLowerCase() ?? ""];
          const compatible = !reqPrev || !prevStepClass || reqPrev === prevStepClass.toLowerCase();
          const isSelected = value === a.id;
          return (
            <button
              key={a.id}
              onClick={() => onPick(a.id)}
              title={!compatible ? `${meta.label} agents must follow a ${reqPrev} step` : a.description}
              className={cn(
                "flex items-center gap-2 p-2 rounded-lg border text-left transition-colors",
                isSelected
                  ? cn(meta.borderColor, "bg-gray-800")
                  : compatible
                    ? "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 hover:border-gray-600"
                    : "border-gray-800/30 bg-gray-900/40 opacity-40 hover:opacity-60",
              )}
            >
              <AgentClassIcon cls={a.agent_class ?? ""} size="sm" />
              <div className="min-w-0 flex-1">
                <p className={cn("text-[10px] font-medium truncate leading-tight", isSelected ? "text-white" : compatible ? "text-gray-300" : "text-gray-600")}>
                  {a.name}
                </p>
                <p className={cn("text-[9px] leading-tight", meta.textColor)}>{meta.label}</p>
              </div>
              {isSelected    && <Check className="w-3 h-3 text-white shrink-0" />}
              {!compatible && !isSelected && <TriangleAlert className="w-3 h-3 text-amber-600 shrink-0" />}
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

// ── Pipeline Step Card ────────────────────────────────────────────────────────

function PipelineStepCard({
  step, index, total, allAgents, prevStepClass,
  onChange, onRemove, onMove,
}: {
  step: PipelineStep; index: number; total: number;
  allAgents: UniversalAgent[]; prevStepClass?: string;
  onChange: (s: PipelineStep) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);
  const [expanded, setExpanded] = useState(!step.agent_id);
  const meta = agent ? classMeta(agent.agent_class ?? "") : null;

  const reqPrev = agent ? (CLASS_REQUIRES_PREV[agent.agent_class?.toLowerCase() ?? ""] ?? null) : null;
  const compatibleWithPrev = !reqPrev || !prevStepClass || reqPrev === prevStepClass.toLowerCase();

  return (
    <div className={cn(
      "group border rounded-xl overflow-hidden bg-gray-900 border-l-2",
      meta ? meta.borderColor : "border-gray-700/60",
      !compatibleWithPrev && "!border-amber-600/60",
    )}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none hover:bg-gray-800/40 transition-colors"
        onClick={() => agent && setExpanded(e => !e)}
      >
        <AgentClassIcon cls={agent?.agent_class ?? ""} size="md" />
        <div className="flex-1 min-w-0">
          {agent ? (
            <>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-semibold text-white">{agent.name}</span>
                {meta && (
                  <span className={cn("text-[9px] px-1 rounded border shrink-0", meta.textColor, meta.borderColor)}>
                    {meta.label}
                  </span>
                )}
                {!compatibleWithPrev && (
                  <span className="flex items-center gap-0.5 text-[9px] text-amber-400 bg-amber-900/30 border border-amber-700/40 rounded px-1 shrink-0">
                    <TriangleAlert className="w-2.5 h-2.5" /> needs {reqPrev}
                  </span>
                )}
              </div>
              {!expanded && (agent.inputs ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {agent.inputs.map(inp => {
                    const s = sourceBadge(step.input_overrides[inp.key] ?? inp.source);
                    const SrcIcon = s.icon;
                    return (
                      <span key={inp.key} className={cn("flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full border font-medium", s.badge)}>
                        <SrcIcon className="w-2.5 h-2.5 shrink-0" />{inp.key}
                      </span>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <span className="text-xs italic text-gray-500">No agent — click + in the left panel</span>
          )}
        </div>

        {/* Move / remove */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button onClick={e => { e.stopPropagation(); onMove(-1); }} disabled={index === 0}
            className="p-0.5 text-gray-500 hover:text-gray-300 disabled:opacity-30 transition-colors">
            <ArrowUp className="w-3 h-3" />
          </button>
          <button onClick={e => { e.stopPropagation(); onMove(1); }} disabled={index === total - 1}
            className="p-0.5 text-gray-500 hover:text-gray-300 disabled:opacity-30 transition-colors">
            <ArrowDown className="w-3 h-3" />
          </button>
          <button onClick={e => { e.stopPropagation(); onRemove(); }}
            className="p-0.5 text-gray-600 hover:text-red-400 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {agent && (
          <ChevronDown className={cn("w-3.5 h-3.5 text-gray-600 shrink-0 transition-transform duration-150", expanded && "rotate-180")} />
        )}
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-gray-800 px-3 pb-3 pt-2.5 bg-gray-950/60 space-y-3">
          {!agent && (
            <AgentPickerGrid
              value={step.agent_id}
              allAgents={allAgents}
              prevStepClass={prevStepClass}
              onPick={id => { onChange({ agent_id: id, input_overrides: {} }); if (id) setExpanded(false); }}
            />
          )}
          {agent && (agent.inputs ?? []).length > 0 && (
            <div className="space-y-2.5">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide">Input sources</p>
              {agent.inputs.map(inp => {
                const effectiveSource = step.input_overrides[inp.key] ?? inp.source;
                const isOverridden = !!step.input_overrides[inp.key] && step.input_overrides[inp.key] !== inp.source;
                return (
                  <div key={inp.key}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[10px] text-amber-400 font-mono">{`{${inp.key}}`}</span>
                      {isOverridden && <span className="text-[9px] text-amber-500 border border-amber-700/40 rounded px-1">overridden</span>}
                    </div>
                    <SourcePillGrid
                      value={effectiveSource}
                      onChange={val => {
                        const overrides = { ...step.input_overrides };
                        if (val === inp.source) delete overrides[inp.key];
                        else overrides[inp.key] = val;
                        onChange({ ...step, input_overrides: overrides });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {agent && (agent.inputs ?? []).length === 0 && (
            <p className="text-[11px] text-gray-600 italic">No inputs configured for this agent</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const { mutate } = useSWRConfig();
  const { activePipelineId, setActivePipeline } = useAppCtx();

  // Data
  const { data: agents, isLoading: agentsLoading } = useSWR<UniversalAgent[]>(`${API}/universal-agents`, fetcher);
  const { data: pipelines } = useSWR<Pipeline[]>(`${API}/pipelines`, fetcher);

  // Agent editor state
  const [editingAgent, setEditingAgent] = useState<string | "new" | null>(null);
  const [agentForm, setAgentForm] = useState({ ...EMPTY_AGENT });
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentSaved, setAgentSaved] = useState(false);
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created_agents: string[]; created_pipelines: string[]; skipped: string[] } | null>(null);
  const [agentSearch, setAgentSearch] = useState("");

  // Pipeline canvas state
  const [selectedPipeline, setSelectedPipeline] = useState<string | null>(null);
  const [pipelineForm, setPipelineForm] = useState({ ...EMPTY_PIPELINE });
  const [pipelineIsNew, setPipelineIsNew] = useState(false);
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [pipelineSaved, setPipelineSaved] = useState(false);

  const allAgents = agents ?? [];
  const selectedAgentObj = editingAgent && editingAgent !== "new"
    ? allAgents.find(a => a.id === editingAgent)
    : undefined;

  // ── Agent functions ──────────────────────────────────────────────────────────

  function openNewAgent() {
    setEditingAgent("new");
    setAgentForm({ ...EMPTY_AGENT });
    setAgentSaved(false);
  }

  function openEditAgent(a: UniversalAgent) {
    setEditingAgent(a.id);
    setAgentForm({
      name: a.name, description: a.description ?? "",
      agent_class: a.agent_class ?? "",
      model: a.model, temperature: a.temperature ?? 0,
      system_prompt: a.system_prompt ?? "", user_prompt: a.user_prompt ?? "",
      inputs: a.inputs ?? [], output_format: a.output_format ?? "markdown",
      tags: a.tags ?? [], is_default: a.is_default ?? false,
    });
    setAgentSaved(false);
  }

  async function saveAgent() {
    if (!agentForm.name.trim()) return;
    setAgentSaving(true);
    try {
      const isNew = editingAgent === "new";
      const method = isNew ? "POST" : "PUT";
      const url = isNew ? `${API}/universal-agents` : `${API}/universal-agents/${editingAgent}`;
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(agentForm) });
      const data = await res.json();
      mutate(`${API}/universal-agents`);
      if (isNew) setEditingAgent(data.id ?? null);
      setAgentSaved(true);
      setTimeout(() => setAgentSaved(false), 2000);
    } finally { setAgentSaving(false); }
  }

  async function deleteAgent() {
    if (!editingAgent || editingAgent === "new" || !confirm(`Delete agent "${agentForm.name}"?`)) return;
    await fetch(`${API}/universal-agents/${editingAgent}`, { method: "DELETE" });
    mutate(`${API}/universal-agents`);
    setEditingAgent(null);
  }

  async function setAgentDefault() {
    if (!editingAgent || editingAgent === "new") return;
    await fetch(`${API}/universal-agents/${editingAgent}/default`, { method: "PATCH" });
    mutate(`${API}/universal-agents`);
  }

  function addAgentInput() {
    setAgentForm(f => ({ ...f, inputs: [...f.inputs, { key: "", source: "transcript" as SourceValue }] }));
  }

  function updateAgentInput(i: number, updated: AgentInput) {
    setAgentForm(f => { const ins = [...f.inputs]; ins[i] = updated; return { ...f, inputs: ins }; });
  }

  function removeAgentInput(i: number) {
    setAgentForm(f => ({ ...f, inputs: f.inputs.filter((_, idx) => idx !== i) }));
  }

  async function importPresets() {
    setImporting(true); setImportResult(null);
    try {
      const res = await fetch(`${API}/universal-agents/import-presets`, { method: "POST" });
      const data = await res.json();
      mutate(`${API}/universal-agents`);
      mutate(`${API}/pipelines`);
      setImportResult(data);
      setTimeout(() => setImportResult(null), 6000);
    } finally { setImporting(false); }
  }

  // ── Pipeline functions ───────────────────────────────────────────────────────

  function openNewPipeline() {
    setSelectedPipeline(null);
    setPipelineForm({ ...EMPTY_PIPELINE });
    setPipelineIsNew(true);
    setPipelineSaved(false);
    setEditingAgent(null);
  }

  function openEditPipeline(p: Pipeline) {
    setSelectedPipeline(p.id);
    setPipelineForm({ name: p.name, description: p.description ?? "", scope: p.scope, steps: p.steps ?? [] });
    setPipelineIsNew(false);
    setPipelineSaved(false);
    setEditingAgent(null);
  }

  async function savePipeline() {
    if (!pipelineForm.name.trim()) return;
    setPipelineSaving(true);
    try {
      const method = pipelineIsNew ? "POST" : "PUT";
      const url = pipelineIsNew ? `${API}/pipelines` : `${API}/pipelines/${selectedPipeline}`;
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(pipelineForm) });
      const data = await res.json();
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
  }

  function addAgentToCanvas(agentId: string) {
    setEditingAgent(null);
    if (!pipelineIsNew && !selectedPipeline) {
      // Auto-open a new pipeline with this agent as first step
      setPipelineIsNew(true);
      setSelectedPipeline(null);
      setPipelineForm({ ...EMPTY_PIPELINE, steps: [{ agent_id: agentId, input_overrides: {} }] });
    } else {
      setPipelineForm(f => ({ ...f, steps: [...f.steps, { agent_id: agentId, input_overrides: {} }] }));
    }
  }

  function updateStep(i: number, s: PipelineStep) {
    setPipelineForm(f => { const steps = [...f.steps]; steps[i] = s; return { ...f, steps }; });
  }

  function removeStep(i: number) {
    setPipelineForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) }));
  }

  function moveStep(i: number, dir: -1 | 1) {
    setPipelineForm(f => {
      const steps = [...f.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return f;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...f, steps };
    });
  }

  const filteredAgents = agentSearch
    ? allAgents.filter(a =>
        a.name.toLowerCase().includes(agentSearch.toLowerCase()) ||
        (a.agent_class ?? "").toLowerCase().includes(agentSearch.toLowerCase())
      )
    : allAgents;

  const isActivePipeline = selectedPipeline === activePipelineId;
  const showCanvas = pipelineIsNew || !!selectedPipeline;

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex flex-col -m-6">
      {/* Page header */}
      <div className="px-6 pt-5 pb-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
        <Bot className="w-5 h-5 text-indigo-400" />
        <h1 className="text-lg font-semibold text-white">Agents & Pipelines</h1>
        <p className="text-sm text-gray-500">Build agents · chain them into pipelines</p>
      </div>

      <div className="flex-1 min-h-0 flex bg-gray-950">

        {/* ── Left: Agent library ────────────────────────────────────────────── */}
        <div className="w-60 shrink-0 border-r border-gray-800 flex flex-col">
          <div className="p-3 border-b border-gray-800 space-y-2">
            <button onClick={openNewAgent}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors">
              <Plus className="w-3.5 h-3.5" /> New Agent
            </button>
            <button onClick={importPresets} disabled={importing}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white text-xs border border-gray-700 rounded-lg transition-colors disabled:opacity-50">
              {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Import presets
            </button>
            {importResult && (
              <div className="text-[10px] text-gray-500 space-y-0.5">
                {importResult.created_agents.length > 0 && (
                  <p className="text-green-500">+ {importResult.created_agents.length} agents, {importResult.created_pipelines.length} pipelines</p>
                )}
                {importResult.skipped.length > 0 && <p>Skipped {importResult.skipped.length} (already exist)</p>}
                {importResult.created_agents.length === 0 && importResult.skipped.length === 0 && <p>Nothing to import</p>}
              </div>
            )}
            <input
              value={agentSearch}
              onChange={e => setAgentSearch(e.target.value)}
              placeholder="Search agents…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {agentsLoading && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
            {!agentsLoading && filteredAgents.length === 0 && (
              <p className="text-xs text-gray-600 text-center py-4">{agentSearch ? "No agents match" : "No agents yet"}</p>
            )}
            {groupAgents(filteredAgents).map(group => (
              <LibraryGroup
                key={group.cls}
                group={group}
                editingId={editingAgent === "new" ? null : editingAgent}
                onEdit={openEditAgent}
                onAdd={addAgentToCanvas}
              />
            ))}
          </div>
        </div>

        {/* ── Right: Agent editor OR Pipeline canvas ─────────────────────────── */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">

          {editingAgent !== null ? (
            /* ── Agent editor ────────────────────────────────────────────────── */
            <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button onClick={() => setEditingAgent(null)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors">
                    <ChevronDown className="w-3.5 h-3.5 rotate-90" /> Back
                  </button>
                  <h2 className="text-sm font-semibold text-white">
                    {editingAgent === "new" ? "New Agent" : `Edit: ${agentForm.name}`}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  {editingAgent !== "new" && selectedAgentObj && (
                    <>
                      <button onClick={setAgentDefault} disabled={selectedAgentObj.is_default}
                        className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors disabled:opacity-50">
                        {selectedAgentObj.is_default ? "Default ✓" : "Set default"}
                      </button>
                      <button onClick={deleteAgent}
                        className="text-xs px-2.5 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-800/50 rounded-lg transition-colors">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  <button onClick={saveAgent} disabled={agentSaving || !agentForm.name.trim()}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50">
                    {agentSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : agentSaved ? <Check className="w-3 h-3" /> : null}
                    {agentSaved ? "Saved" : "Save"}
                  </button>
                </div>
              </div>

              {/* Identity */}
              <div className="border border-gray-800 rounded-xl p-4">
                <label className="block text-[10px] text-gray-600 font-semibold uppercase tracking-wider mb-3">Identity</label>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Name</label>
                    <input value={agentForm.name} onChange={e => setAgentForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="e.g. Persona Scorer"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Class</label>
                    <input value={agentForm.agent_class} onChange={e => setAgentForm(f => ({ ...f, agent_class: e.target.value }))}
                      placeholder="persona / notes / compliance…" list="agent-class-list"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
                    <datalist id="agent-class-list">
                      <option value="persona" /><option value="notes" /><option value="compliance" />
                      <option value="scorer" /><option value="general" />
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Description</label>
                    <input value={agentForm.description} onChange={e => setAgentForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="What does this agent do?"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
                  </div>
                </div>
              </div>

              {/* Inputs */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-gray-400 font-medium">Inputs</label>
                  <button onClick={addAgentInput}
                    className="flex items-center gap-1 text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors">
                    <Plus className="w-3 h-3" /> Add Input
                  </button>
                </div>
                {agentForm.inputs.length === 0 && (
                  <p className="text-xs text-gray-600 italic py-2">No inputs defined. Add inputs to reference data in your prompts.</p>
                )}
                <div className="space-y-2">
                  {agentForm.inputs.map((inp, i) => (
                    <InputRow key={i} input={inp} agents={allAgents}
                      onChange={updated => updateAgentInput(i, updated)}
                      onRemove={() => removeAgentInput(i)} />
                  ))}
                </div>
                <div className="mt-1.5"><VariableHint inputs={agentForm.inputs} /></div>
              </div>

              {/* Prompts */}
              <div className="border border-gray-800 rounded-xl p-4">
                <label className="block text-[10px] text-gray-600 font-semibold uppercase tracking-wider mb-3">Prompts</label>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col">
                    <label className="block text-xs text-gray-400 mb-1">System Prompt</label>
                    {agentForm.inputs.filter(i => i.key).length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {agentForm.inputs.filter(i => i.key).map(i => (
                          <button key={i.key} type="button"
                            onClick={() => setAgentForm(f => ({ ...f, system_prompt: f.system_prompt + `{${i.key}}` }))}
                            className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 transition-colors font-mono">
                            {`{${i.key}}`}
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea value={agentForm.system_prompt}
                      onChange={e => setAgentForm(f => ({ ...f, system_prompt: e.target.value }))}
                      rows={14} placeholder="You are a…"
                      className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
                  </div>
                  <div className="flex flex-col">
                    <label className="block text-xs text-gray-400 mb-1">User Prompt</label>
                    {agentForm.inputs.filter(i => i.key).length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {agentForm.inputs.filter(i => i.key).map(i => (
                          <button key={i.key} type="button"
                            onClick={() => setAgentForm(f => ({ ...f, user_prompt: f.user_prompt + `{${i.key}}` }))}
                            className="text-[9px] px-1.5 py-0.5 rounded border border-amber-700/50 bg-amber-900/20 text-amber-400 hover:bg-amber-900/40 transition-colors font-mono">
                            {`{${i.key}}`}
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea value={agentForm.user_prompt}
                      onChange={e => setAgentForm(f => ({ ...f, user_prompt: e.target.value }))}
                      rows={14} placeholder={"Analyse this:\n\n{transcript}"}
                      className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
                    <div className="mt-1"><VariableHint inputs={agentForm.inputs} /></div>
                  </div>
                </div>
              </div>

              {/* Settings */}
              <div className="border border-gray-800 rounded-xl overflow-hidden">
                <button onClick={() => setShowAgentSettings(s => !s)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-colors text-xs">
                  <span className="flex items-center gap-2 text-gray-300 font-medium">
                    <Settings2 className="w-3.5 h-3.5 text-gray-400" /> Settings
                  </span>
                  {showAgentSettings ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
                </button>
                {showAgentSettings && (
                  <div className="p-4 grid grid-cols-3 gap-4 border-t border-gray-800">
                    <div className="col-span-1">
                      <label className="block text-xs text-gray-400 mb-1">Temperature</label>
                      <input type="number" min={0} max={2} step={0.1} value={agentForm.temperature}
                        onChange={e => setAgentForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500" />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs text-gray-400 mb-1">Output Format</label>
                      <select value={agentForm.output_format} onChange={e => setAgentForm(f => ({ ...f, output_format: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
                        <option value="markdown">Markdown</option>
                        <option value="json">JSON</option>
                        <option value="text">Plain text</option>
                      </select>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs text-gray-400 mb-1">Tags</label>
                      <input value={agentForm.tags.join(", ")}
                        onChange={e => setAgentForm(f => ({ ...f, tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) }))}
                        placeholder="notes, compliance, persona"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-xs text-gray-400 mb-1">Model</label>
                      <ModelSelect value={agentForm.model} onChange={v => setAgentForm(f => ({ ...f, model: v }))} />
                    </div>
                  </div>
                )}
              </div>
            </div>

          ) : (
            /* ── Pipeline canvas ─────────────────────────────────────────────── */
            <div className="flex-1 min-h-0 flex flex-col">

              {/* Toolbar */}
              <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0 flex-wrap">
                <Workflow className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                <select
                  value={selectedPipeline ?? ""}
                  onChange={e => {
                    const p = (pipelines ?? []).find(x => x.id === e.target.value);
                    if (p) openEditPipeline(p);
                  }}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-teal-500"
                >
                  <option value="">— Select pipeline —</option>
                  {(pipelines ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={openNewPipeline}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-teal-800 hover:bg-teal-700 text-teal-100 text-xs rounded-lg border border-teal-700/60 transition-colors">
                  <Plus className="w-3 h-3" /> New
                </button>
                <div className="flex-1" />
                {showCanvas && (
                  <div className="flex items-center gap-2">
                    {selectedPipeline && (
                      <button
                        onClick={() => setActivePipeline(
                          isActivePipeline ? "" : selectedPipeline,
                          isActivePipeline ? "" : pipelineForm.name,
                        )}
                        className={cn(
                          "px-2 py-1 rounded text-[10px] font-medium border transition-colors",
                          isActivePipeline
                            ? "bg-teal-900/60 border-teal-700/50 text-teal-300 hover:bg-red-900/40 hover:border-red-700/50 hover:text-red-400"
                            : "bg-gray-800 border-gray-700 text-gray-400 hover:bg-teal-900/40 hover:text-teal-300",
                        )}
                      >
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

              {showCanvas ? (
                <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                  {/* Pipeline meta */}
                  <div className="flex items-center gap-3">
                    <input
                      value={pipelineForm.name}
                      onChange={e => setPipelineForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="Pipeline name…"
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-semibold text-white placeholder-gray-600 outline-none focus:border-teal-500"
                    />
                    <select
                      value={pipelineForm.scope}
                      onChange={e => setPipelineForm(f => ({ ...f, scope: e.target.value }))}
                      className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-teal-500"
                    >
                      <option value="per_call">Per call</option>
                      <option value="per_pair">Per pair</option>
                    </select>
                  </div>

                  {/* Step cards */}
                  {pipelineForm.steps.length === 0 ? (
                    <div className="flex flex-col items-center py-16 gap-3 text-gray-700 border border-dashed border-gray-800 rounded-2xl">
                      <Workflow className="w-10 h-10 opacity-20" />
                      <p className="text-sm">Click <span className="text-teal-400 font-medium">+</span> next to any agent on the left to add it here</p>
                    </div>
                  ) : (
                    <div>
                      {pipelineForm.steps.map((step, i) => (
                        <div key={i}>
                          <PipelineStepCard
                            step={step} index={i} total={pipelineForm.steps.length}
                            allAgents={allAgents}
                            prevStepClass={i > 0 ? allAgents.find(a => a.id === pipelineForm.steps[i - 1]?.agent_id)?.agent_class : undefined}
                            onChange={s => updateStep(i, s)}
                            onRemove={() => removeStep(i)}
                            onMove={dir => moveStep(i, dir)}
                          />
                          {i < pipelineForm.steps.length - 1 && <StepConnector />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-gray-600">
                  <div className="text-center space-y-3">
                    <Workflow className="w-12 h-12 mx-auto opacity-20" />
                    <p className="text-sm">Select a pipeline above or create a new one</p>
                    <p className="text-xs text-gray-700">Then click + next to any agent to add it to the chain</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
