"use client";
import { useState, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp,
  Settings2, X, GripVertical, ArrowUp, ArrowDown, Workflow, Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  { value: "transcript",        label: "Transcript",         badge: "bg-blue-900/50 text-blue-300 border-blue-700/50",   desc: "Single call transcript" },
  { value: "merged_transcript", label: "Merged Transcript",  badge: "bg-cyan-900/50 text-cyan-300 border-cyan-700/50",   desc: "All calls for the pair merged into one document" },
  { value: "notes",             label: "Notes",              badge: "bg-green-900/50 text-green-300 border-green-700/50", desc: "Call notes for a specific call" },
  { value: "merged_notes",      label: "Merged Notes",       badge: "bg-teal-900/50 text-teal-300 border-teal-700/50",   desc: "All notes aggregated across the pair" },
  { value: "agent_output",      label: "Agent Output",       badge: "bg-purple-900/50 text-purple-300 border-purple-700/50", desc: "Output of another specific agent" },
  { value: "chain_previous",    label: "Previous Step",      badge: "bg-amber-900/50 text-amber-300 border-amber-700/50",  desc: "Output of the immediately preceding pipeline step" },
  { value: "manual",            label: "Manual Input",       badge: "bg-gray-700/50 text-gray-300 border-gray-600/50",   desc: "User provides content at run time" },
] as const;

type SourceValue = typeof INPUT_SOURCES[number]["value"];

function sourceBadge(source: string) {
  return INPUT_SOURCES.find(s => s.value === source) ?? INPUT_SOURCES[6];
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
  input,
  agents,
  onChange,
  onRemove,
}: {
  input: AgentInput;
  agents: UniversalAgent[];
  onChange: (updated: AgentInput) => void;
  onRemove: () => void;
}) {
  const info = sourceBadge(input.source);
  return (
    <div className="flex items-start gap-2 p-2.5 bg-gray-800/40 border border-gray-700/60 rounded-lg">
      {/* key */}
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

      {/* source */}
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <label className="text-[9px] text-gray-600 uppercase tracking-wide">Source</label>
        <select
          value={input.source}
          onChange={e => onChange({ ...input, source: e.target.value as SourceValue, agent_id: undefined })}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white outline-none focus:border-indigo-500"
        >
          {INPUT_SOURCES.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* agent picker — only when source === agent_output */}
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

      {/* remove */}
      <button
        onClick={onRemove}
        className="mt-4 text-gray-600 hover:text-red-400 transition-colors shrink-0"
      >
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

// ── Universal Agents Tab ──────────────────────────────────────────────────────

function AgentsTab() {
  const { mutate } = useSWRConfig();
  const { data: agents, isLoading } = useSWR<UniversalAgent[]>(`${API}/universal-agents`, fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created_agents: string[]; created_pipelines: string[]; skipped: string[] } | null>(null);
  const [form, setForm] = useState({ ...EMPTY_AGENT });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isNew, setIsNew] = useState(false);

  const selectedAgent = agents?.find(a => a.id === selected);

  function openNew() {
    setSelected(null); setIsNew(true);
    setForm({ ...EMPTY_AGENT }); setSaved(false);
  }

  function openEdit(a: UniversalAgent) {
    setSelected(a.id); setIsNew(false);
    setForm({
      name: a.name, description: a.description ?? "",
      model: a.model, temperature: a.temperature ?? 0,
      system_prompt: a.system_prompt ?? "", user_prompt: a.user_prompt ?? "",
      inputs: a.inputs ?? [], output_format: a.output_format ?? "markdown",
      tags: a.tags ?? [], is_default: a.is_default ?? false,
    });
    setSaved(false);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const method = isNew ? "POST" : "PUT";
      const url = isNew ? `${API}/universal-agents` : `${API}/universal-agents/${selected}`;
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await res.json();
      mutate(`${API}/universal-agents`);
      if (isNew) setSelected(data.id ?? null);
      setIsNew(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  }

  async function del() {
    if (!selected || !confirm(`Delete agent "${form.name}"?`)) return;
    await fetch(`${API}/universal-agents/${selected}`, { method: "DELETE" });
    mutate(`${API}/universal-agents`);
    setSelected(null); setIsNew(false);
  }

  async function setDefault() {
    if (!selected) return;
    await fetch(`${API}/universal-agents/${selected}/default`, { method: "PATCH" });
    mutate(`${API}/universal-agents`);
  }

  function addInput() {
    setForm(f => ({ ...f, inputs: [...f.inputs, { key: "", source: "transcript" as SourceValue }] }));
  }

  function updateInput(i: number, updated: AgentInput) {
    setForm(f => { const ins = [...f.inputs]; ins[i] = updated; return { ...f, inputs: ins }; });
  }

  function removeInput(i: number) {
    setForm(f => ({ ...f, inputs: f.inputs.filter((_, idx) => idx !== i) }));
  }

  async function importPresets() {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await fetch(`${API}/universal-agents/import-presets`, { method: "POST" });
      const data = await res.json();
      mutate(`${API}/universal-agents`);
      mutate(`${API}/pipelines`);
      setImportResult(data);
      setTimeout(() => setImportResult(null), 6000);
    } finally {
      setImporting(false);
    }
  }

  const showForm = isNew || selected !== null;

  return (
    <div className="flex h-full gap-0">
      {/* Sidebar */}
      <div className="w-56 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800 space-y-2">
          <button onClick={openNew}
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
              {importResult.skipped.length > 0 && (
                <p>Skipped {importResult.skipped.length} (already exist)</p>
              )}
              {importResult.created_agents.length === 0 && importResult.skipped.length === 0 && (
                <p>Nothing to import</p>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
          {(agents ?? []).map(a => (
            <button key={a.id} onClick={() => openEdit(a)}
              className={cn("w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors",
                selected === a.id ? "bg-indigo-600/20 border border-indigo-600/30 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white")}>
              <div className="flex items-center gap-1.5">
                <Bot className="w-3 h-3 text-indigo-400 shrink-0" />
                <span className="font-medium truncate flex-1">{a.name}</span>
                {a.is_default && <span className="text-[9px] bg-indigo-900 text-indigo-400 px-1 rounded">default</span>}
              </div>
              <div className="mt-1 pl-[18px] flex flex-wrap gap-0.5">
                {(a.inputs ?? []).slice(0, 3).map(inp => {
                  const s = sourceBadge(inp.source);
                  return <span key={inp.key} className={cn("text-[9px] px-1 py-0 rounded border", s.badge)}>{inp.key || s.label}</span>;
                })}
                {(a.inputs ?? []).length > 3 && <span className="text-[9px] text-gray-600">+{a.inputs.length - 3}</span>}
              </div>
            </button>
          ))}
          {!isLoading && (agents ?? []).length === 0 && (
            <p className="text-xs text-gray-600 text-center py-4">No agents yet</p>
          )}
        </div>
      </div>

      {/* Form */}
      {showForm ? (
        <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">{isNew ? "New Agent" : `Edit: ${selected ? form.name : ""}`}</h2>
            <div className="flex items-center gap-2">
              {selected && (
                <>
                  <button onClick={setDefault} disabled={selectedAgent?.is_default}
                    className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors disabled:opacity-50">
                    {selectedAgent?.is_default ? "Default ✓" : "Set default"}
                  </button>
                  <button onClick={del}
                    className="text-xs px-2.5 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-800/50 rounded-lg transition-colors">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
              <button onClick={save} disabled={saving || !form.name.trim()}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50">
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
                {saved ? "Saved" : "Save"}
              </button>
            </div>
          </div>

          {/* Name + Description */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Persona Scorer"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What does this agent do?"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
            </div>
          </div>

          {/* Inputs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400 font-medium">Inputs</label>
              <button onClick={addInput}
                className="flex items-center gap-1 text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors">
                <Plus className="w-3 h-3" /> Add Input
              </button>
            </div>
            {form.inputs.length === 0 && (
              <p className="text-xs text-gray-600 italic py-2">No inputs defined. Add inputs to reference data in your prompts.</p>
            )}
            <div className="space-y-2">
              {form.inputs.map((inp, i) => (
                <InputRow key={i} input={inp} agents={agents ?? []}
                  onChange={updated => updateInput(i, updated)} onRemove={() => removeInput(i)} />
              ))}
            </div>
            <div className="mt-1.5"><VariableHint inputs={form.inputs} /></div>
          </div>

          {/* Side-by-side prompts */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col">
              <label className="block text-xs text-gray-400 mb-1">System Prompt</label>
              <textarea value={form.system_prompt} onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))}
                rows={14} placeholder="You are a…"
                className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
            </div>
            <div className="flex flex-col">
              <label className="block text-xs text-gray-400 mb-1">User Prompt</label>
              <textarea value={form.user_prompt} onChange={e => setForm(f => ({ ...f, user_prompt: e.target.value }))}
                rows={14} placeholder={"Analyse this:\n\n{transcript}"}
                className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
              <div className="mt-1"><VariableHint inputs={form.inputs} /></div>
            </div>
          </div>

          {/* Settings collapsible */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button onClick={() => setShowSettings(s => !s)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-colors text-xs">
              <span className="flex items-center gap-2 text-gray-300 font-medium">
                <Settings2 className="w-3.5 h-3.5 text-gray-400" /> Settings
              </span>
              {showSettings ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
            </button>
            {showSettings && (
              <div className="p-4 grid grid-cols-3 gap-4 border-t border-gray-800">
                <div className="col-span-1">
                  <label className="block text-xs text-gray-400 mb-1">Temperature</label>
                  <input type="number" min={0} max={2} step={0.1} value={form.temperature}
                    onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500" />
                </div>
                <div className="col-span-1">
                  <label className="block text-xs text-gray-400 mb-1">Output Format</label>
                  <select value={form.output_format} onChange={e => setForm(f => ({ ...f, output_format: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
                    <option value="markdown">Markdown</option>
                    <option value="json">JSON</option>
                    <option value="text">Plain text</option>
                  </select>
                </div>
                <div className="col-span-1">
                  <label className="block text-xs text-gray-400 mb-1">Tags</label>
                  <input value={form.tags.join(", ")}
                    onChange={e => setForm(f => ({ ...f, tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) }))}
                    placeholder="notes, compliance, persona"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
                </div>
                <div className="col-span-3">
                  <label className="block text-xs text-gray-400 mb-1">Model</label>
                  <ModelSelect value={form.model} onChange={v => setForm(f => ({ ...f, model: v }))} />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          <div className="text-center space-y-3">
            <Bot className="w-12 h-12 mx-auto opacity-20" />
            <p className="text-sm">Select an agent or create a new one</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pipeline Step Row ─────────────────────────────────────────────────────────

function StepRow({
  step, index, total, agents, allAgents,
  onChange, onRemove, onMove,
}: {
  step: PipelineStep;
  index: number;
  total: number;
  agents: UniversalAgent[];
  allAgents: UniversalAgent[];
  onChange: (s: PipelineStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const agent = allAgents.find(a => a.id === step.agent_id);
  return (
    <div className="flex items-start gap-2 p-3 bg-gray-800/40 border border-gray-700/60 rounded-xl">
      {/* Step number */}
      <div className="flex flex-col items-center gap-1 shrink-0 mt-0.5">
        <span className="w-5 h-5 rounded-full bg-indigo-900/60 text-indigo-300 text-[9px] font-bold flex items-center justify-center">{index + 1}</span>
        <button onClick={() => onMove(-1)} disabled={index === 0}
          className="text-gray-600 hover:text-gray-400 disabled:opacity-30"><ArrowUp className="w-3 h-3" /></button>
        <button onClick={() => onMove(1)} disabled={index === total - 1}
          className="text-gray-600 hover:text-gray-400 disabled:opacity-30"><ArrowDown className="w-3 h-3" /></button>
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        {/* Agent picker */}
        <div>
          <label className="block text-[9px] text-gray-600 uppercase tracking-wide mb-0.5">Agent</label>
          <select value={step.agent_id} onChange={e => onChange({ ...step, agent_id: e.target.value })}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500">
            <option value="">— pick agent —</option>
            {allAgents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        {/* Show agent's inputs + allow overrides */}
        {agent && (agent.inputs ?? []).length > 0 && (
          <div className="space-y-1">
            <label className="block text-[9px] text-gray-600 uppercase tracking-wide">Input overrides</label>
            {agent.inputs.map(inp => {
              const overrideVal = step.input_overrides[inp.key] ?? "";
              return (
                <div key={inp.key} className="flex items-center gap-2">
                  <span className="text-[10px] text-amber-400 w-20 truncate shrink-0">{`{${inp.key}}`}</span>
                  <select
                    value={overrideVal || inp.source}
                    onChange={e => {
                      const val = e.target.value;
                      const overrides = { ...step.input_overrides };
                      if (val === inp.source) delete overrides[inp.key];
                      else overrides[inp.key] = val;
                      onChange({ ...step, input_overrides: overrides });
                    }}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[10px] text-white outline-none focus:border-indigo-500"
                  >
                    {INPUT_SOURCES.map(s => (
                      <option key={s.value} value={s.value}>
                        {s.label}{s.value === inp.source ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                  {overrideVal && (
                    <span className="text-[9px] text-amber-500 shrink-0">overridden</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Input badges */}
        {agent && (agent.inputs ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {agent.inputs.map(inp => {
              const effectiveSource = step.input_overrides[inp.key] ?? inp.source;
              const s = sourceBadge(effectiveSource);
              return (
                <span key={inp.key} className={cn("text-[9px] px-1.5 py-0.5 rounded border", s.badge)}>
                  {`{${inp.key}}`} ← {s.label}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <button onClick={onRemove} className="text-gray-600 hover:text-red-400 transition-colors shrink-0 mt-1">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Pipelines Tab ─────────────────────────────────────────────────────────────

function PipelinesTab() {
  const { mutate } = useSWRConfig();
  const { data: pipelines, isLoading } = useSWR<Pipeline[]>(`${API}/pipelines`, fetcher);
  const { data: agents } = useSWR<UniversalAgent[]>(`${API}/universal-agents`, fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_PIPELINE });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isNew, setIsNew] = useState(false);

  function openNew() {
    setSelected(null); setIsNew(true);
    setForm({ ...EMPTY_PIPELINE }); setSaved(false);
  }

  function openEdit(p: Pipeline) {
    setSelected(p.id); setIsNew(false);
    setForm({ name: p.name, description: p.description ?? "", scope: p.scope ?? "per_pair", steps: p.steps ?? [] });
    setSaved(false);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const method = isNew ? "POST" : "PUT";
      const url = isNew ? `${API}/pipelines` : `${API}/pipelines/${selected}`;
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await res.json();
      mutate(`${API}/pipelines`);
      if (isNew) setSelected(data.id ?? null);
      setIsNew(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  }

  async function del() {
    if (!selected || !confirm(`Delete pipeline "${form.name}"?`)) return;
    await fetch(`${API}/pipelines/${selected}`, { method: "DELETE" });
    mutate(`${API}/pipelines`);
    setSelected(null); setIsNew(false);
  }

  function addStep() {
    setForm(f => ({ ...f, steps: [...f.steps, { agent_id: "", input_overrides: {} }] }));
  }

  function updateStep(i: number, s: PipelineStep) {
    setForm(f => { const steps = [...f.steps]; steps[i] = s; return { ...f, steps }; });
  }

  function removeStep(i: number) {
    setForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) }));
  }

  function moveStep(i: number, dir: -1 | 1) {
    setForm(f => {
      const steps = [...f.steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return f;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...f, steps };
    });
  }

  const showForm = isNew || selected !== null;
  const allAgents = agents ?? [];

  return (
    <div className="flex h-full gap-0">
      {/* Sidebar */}
      <div className="w-56 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <button onClick={openNew}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-teal-700 hover:bg-teal-600 text-white text-xs font-medium rounded-lg transition-colors">
            <Plus className="w-3.5 h-3.5" /> New Pipeline
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
          {(pipelines ?? []).map(p => (
            <button key={p.id} onClick={() => openEdit(p)}
              className={cn("w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors",
                selected === p.id ? "bg-teal-600/20 border border-teal-600/30 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white")}>
              <div className="flex items-center gap-1.5">
                <Workflow className="w-3 h-3 text-teal-400 shrink-0" />
                <span className="font-medium truncate flex-1">{p.name}</span>
              </div>
              <p className="text-[10px] text-gray-600 mt-0.5 pl-[18px]">
                {(p.steps ?? []).length} step{(p.steps ?? []).length !== 1 ? "s" : ""} · {p.scope}
              </p>
            </button>
          ))}
          {!isLoading && (pipelines ?? []).length === 0 && (
            <p className="text-xs text-gray-600 text-center py-4">No pipelines yet</p>
          )}
        </div>
      </div>

      {/* Form */}
      {showForm ? (
        <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">{isNew ? "New Pipeline" : `Edit: ${form.name}`}</h2>
            <div className="flex items-center gap-2">
              {selected && (
                <button onClick={del}
                  className="text-xs px-2.5 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-800/50 rounded-lg transition-colors">
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
              <button onClick={save} disabled={saving || !form.name.trim()}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-teal-700 hover:bg-teal-600 text-white rounded-lg transition-colors disabled:opacity-50">
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
                {saved ? "Saved" : "Save"}
              </button>
            </div>
          </div>

          {/* Name + Description + Scope */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Full Analysis"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-teal-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What does this pipeline do?"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-teal-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Scope</label>
              <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-teal-500">
                <option value="per_call">Per Call — runs once per call</option>
                <option value="per_pair">Per Pair — runs on merged data for an agent/customer pair</option>
              </select>
            </div>
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs text-gray-400 font-medium">Steps</label>
              <button onClick={addStep}
                className="flex items-center gap-1 text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors">
                <Plus className="w-3 h-3" /> Add Step
              </button>
            </div>

            {/* Visual chain */}
            {form.steps.length > 0 && (
              <div className="mb-4 flex items-center gap-1 flex-wrap">
                {form.steps.map((step, i) => {
                  const a = allAgents.find(x => x.id === step.agent_id);
                  return (
                    <div key={i} className="flex items-center gap-1">
                      <span className="text-[10px] px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-gray-300">
                        {a ? a.name : <span className="text-gray-600 italic">unset</span>}
                      </span>
                      {i < form.steps.length - 1 && <span className="text-gray-700 text-xs">→</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {form.steps.length === 0 && (
              <p className="text-xs text-gray-600 italic py-2">No steps yet. Add agents to build the chain.</p>
            )}

            <div className="space-y-3">
              {form.steps.map((step, i) => (
                <StepRow key={i} step={step} index={i} total={form.steps.length}
                  agents={allAgents} allAgents={allAgents}
                  onChange={s => updateStep(i, s)} onRemove={() => removeStep(i)} onMove={dir => moveStep(i, dir)} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          <div className="text-center space-y-3">
            <Workflow className="w-12 h-12 mx-auto opacity-20" />
            <p className="text-sm">Select a pipeline or create a new one</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = "agents" | "pipelines";

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>("agents");

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex flex-col -m-6">
      <div className="px-6 pt-5 pb-0 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3 mb-4">
          <Bot className="w-5 h-5 text-indigo-400" />
          <h1 className="text-lg font-semibold text-white">Agents</h1>
          <p className="text-sm text-gray-500">Build and chain analysis agents</p>
        </div>
        <div className="flex gap-1">
          {(["agents", "pipelines"] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
                tab === t ? "bg-gray-950 text-white border-t border-x border-gray-800" : "text-gray-500 hover:text-gray-300")}>
              {t === "agents" ? "Agents" : "Pipelines"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-gray-950">
        {tab === "agents"    && <AgentsTab />}
        {tab === "pipelines" && <PipelinesTab />}
      </div>
    </div>
  );
}
