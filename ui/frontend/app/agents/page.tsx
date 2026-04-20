"use client";

import { useState, useEffect, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp,
  X, Download, Mic2, Layers, BookOpen, PenLine, StickyNote,
  User, Star, Shield, Zap, Play, FileText, Braces, AlignLeft, Copy,
  BadgeCheck, ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";

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

interface AgentInput { key: string; source: SourceValue; agent_id?: string; }

interface UniversalAgent {
  id: string; name: string; description: string; agent_class: string;
  model: string; temperature: number; system_prompt: string; user_prompt: string;
  inputs: AgentInput[]; output_format: string; tags: string[];
  is_default: boolean; created_at: string;
}

const BLANK_AGENT = {
  name: "New Agent", description: "", agent_class: "general",
  model: "gpt-5.4", temperature: 0,
  system_prompt: "", user_prompt: "",
  inputs: [{ key: "transcript", source: "transcript" as SourceValue }],
  output_format: "markdown", tags: [], is_default: false,
};

// ── AgentEditor ───────────────────────────────────────────────────────────────

function AgentEditor({
  agent, allAgents, onSave, onDelete,
}: {
  agent: UniversalAgent; allAgents: UniversalAgent[];
  onSave: (draft: Omit<UniversalAgent, "id" | "created_at">) => Promise<void>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Omit<UniversalAgent, "id" | "created_at">>({
    name: agent.name, description: agent.description ?? "",
    agent_class: agent.agent_class, model: agent.model,
    temperature: agent.temperature, system_prompt: agent.system_prompt,
    user_prompt: agent.user_prompt, inputs: agent.inputs ?? [],
    output_format: agent.output_format ?? "markdown",
    tags: agent.tags ?? [], is_default: agent.is_default ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [showModel, setShowModel] = useState(false);

  useEffect(() => {
    setDraft({
      name: agent.name, description: agent.description ?? "",
      agent_class: agent.agent_class, model: agent.model,
      temperature: agent.temperature, system_prompt: agent.system_prompt,
      user_prompt: agent.user_prompt, inputs: agent.inputs ?? [],
      output_format: agent.output_format ?? "markdown",
      tags: agent.tags ?? [], is_default: agent.is_default ?? false,
    });
    setSaved(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

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
    setDraft(f => ({ ...f, inputs: [...f.inputs, { key: newKey, source: "manual" as SourceValue }] }));
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
                          updateInput(i, { source: defaultSrc, agent_id: undefined });
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
                      onChange={e => updateInput(i, { source: e.target.value as SourceValue, agent_id: undefined })}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 outline-none focus:border-indigo-500">
                      {catSources.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
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

// ── TestPanel ─────────────────────────────────────────────────────────────────

type PreviewState = { status: "idle" | "loading" | "ok" | "error"; chars: number; snippet: string; errMsg?: string };

function TestPanel({ agent }: { agent: UniversalAgent }) {
  // CRM context
  const { data: navAgents } = useSWR<{ agent: string; count: number }[]>("/api/crm/nav/agents", fetcher);
  const [testAgent, setTestAgent]       = useState("");
  const [testCustomer, setTestCustomer] = useState("");
  const [testCallId, setTestCallId]     = useState("");

  const { data: navCustomers } = useSWR<{ customer: string; call_count: number }[]>(
    testAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(testAgent)}` : null, fetcher,
  );
  const { data: callDates } = useSWR<Record<string, { date: string; has_audio: boolean }>>(
    testAgent && testCustomer
      ? `/api/crm/call-dates?agent=${encodeURIComponent(testAgent)}&customer=${encodeURIComponent(testCustomer)}`
      : null,
    fetcher,
  );

  // Per-input preview: auto-fetched content from backend
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  // Per-input override: when user pastes custom text
  const [customMode, setCustomMode]     = useState<Record<string, boolean>>({});
  const [customText, setCustomText]     = useState<Record<string, string>>({});
  const [showPreview, setShowPreview]   = useState<Record<string, boolean>>({});

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

  // Auto-fetch previews for data inputs (not artifacts) when context changes
  useEffect(() => {
    if (!testAgent || !testCustomer) {
      setPreviews({});
      return;
    }
    for (const inp of agent.inputs) {
      if (srcCategory(inp.source) === "artifact") continue; // artifacts are always pasted
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
          <select value={testAgent}
            onChange={e => { setTestAgent(e.target.value); setTestCustomer(""); setTestCallId(""); setPreviews({}); }}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[11px] text-white outline-none focus:border-indigo-500">
            <option value="">— Sales agent —</option>
            {(navAgents ?? []).map(a => <option key={a.agent} value={a.agent}>{a.agent} ({a.count})</option>)}
          </select>
          <select value={testCustomer}
            onChange={e => { setTestCustomer(e.target.value); setTestCallId(""); setPreviews({}); }}
            disabled={!testAgent}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[11px] text-white outline-none focus:border-indigo-500 disabled:opacity-40">
            <option value="">— Customer —</option>
            {(navCustomers ?? []).map(c => <option key={c.customer} value={c.customer}>{c.customer}</option>)}
          </select>
          {needsCallId && (
            <select value={testCallId} onChange={e => setTestCallId(e.target.value)}
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
            <div className="flex items-center justify-between">
              <p className="text-[9px] text-gray-600 uppercase tracking-wide font-semibold">Artifacts</p>
              <span className="text-[9px] text-gray-700 italic">paste pipeline output below</span>
            </div>
            {artifactInputs.map((inp, i) => {
              const sm = srcMeta(inp.source);
              const SrcIcon = sm.icon;
              const text = customText[inp.key] ?? "";
              const expanded = showPreview[inp.key];
              return (
                <div key={i} className={cn("rounded-lg border overflow-hidden", sm.badge.includes("violet") ? "border-violet-800/40" : sm.badge.includes("amber") ? "border-amber-800/40" : "border-emerald-800/40")}>
                  {/* Artifact type header */}
                  <div className={cn(
                    "flex items-center gap-2 px-2.5 py-2",
                    sm.badge.includes("violet") ? "bg-violet-950/50" : sm.badge.includes("amber") ? "bg-amber-950/50" : "bg-emerald-950/50",
                  )}>
                    <span className={cn("p-0.5 rounded border shrink-0", sm.badge)}>
                      <SrcIcon className="w-3 h-3" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-[10px] font-semibold", sm.badge.split(" ").find(c => c.startsWith("text-")))}>{sm.label}</p>
                      <p className="text-[9px] text-gray-600 font-mono">{`{${inp.key}}`}</p>
                    </div>
                    {text.length > 0 && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[9px] text-emerald-400">✓</span>
                        <span className="text-[9px] text-gray-600">{text.length.toLocaleString()} chars</span>
                        <button onClick={() => setShowPreview(p => ({ ...p, [inp.key]: !p[inp.key] }))}
                          className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">
                          {expanded ? "hide" : "peek"}
                        </button>
                      </div>
                    )}
                    {text.length === 0 && (
                      <span className="text-[9px] text-gray-700 shrink-0">empty</span>
                    )}
                  </div>
                  {/* Peek preview */}
                  {expanded && text.length > 0 && (
                    <pre className="px-2.5 py-2 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words bg-gray-900 max-h-28 overflow-y-auto border-b border-gray-800">{text.slice(0, 400)}{text.length > 400 ? "\n…" : ""}</pre>
                  )}
                  {/* Paste area */}
                  <div className="px-2.5 py-2">
                    <textarea value={text}
                      onChange={e => setCustomText(p => ({ ...p, [inp.key]: e.target.value }))}
                      placeholder={`Paste ${sm.label} output here…`}
                      rows={text.length > 0 ? 2 : 4}
                      className="w-full bg-gray-900/60 border border-gray-700/50 rounded-lg px-2 py-1.5 text-[10px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y placeholder-gray-700"
                    />
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
  const { data: agents } = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);
  const allAgents = agents ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing, setImporting]   = useState(false);
  const [importMsg, setImportMsg]   = useState("");

  const selected = allAgents.find(a => a.id === selectedId) ?? null;

  // Group by class
  const grouped: Record<string, UniversalAgent[]> = {};
  for (const a of allAgents) {
    const cls = (a.agent_class || "general").toLowerCase();
    (grouped[cls] ??= []).push(a);
  }
  const knownOrder = ["persona", "scorer", "notes", "compliance", "general"];
  const orderedGroups = [
    ...knownOrder.filter(c => grouped[c]?.length),
    ...Object.keys(grouped).filter(c => !knownOrder.includes(c) && grouped[c]?.length),
  ];

  async function createAgent() {
    const res = await fetch("/api/universal-agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BLANK_AGENT),
    });
    const created: UniversalAgent = await res.json();
    mutate("/api/universal-agents");
    setSelectedId(created.id);
  }

  async function saveAgent(draft: Omit<UniversalAgent, "id" | "created_at">) {
    if (!selectedId) return;
    await fetch(`/api/universal-agents/${selectedId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    mutate("/api/universal-agents");
  }

  async function deleteAgent() {
    if (!selectedId) return;
    await fetch(`/api/universal-agents/${selectedId}`, { method: "DELETE" });
    mutate("/api/universal-agents");
    setSelectedId(null);
  }

  async function importPresets() {
    setImporting(true); setImportMsg("");
    try {
      const res  = await fetch("/api/universal-agents/import-presets", { method: "POST" });
      const data = await res.json();
      mutate("/api/universal-agents");
      setImportMsg(`+${data.created_agents?.length ?? 0} agents`);
      setTimeout(() => setImportMsg(""), 4000);
    } finally { setImporting(false); }
  }

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex -m-6">

      {/* ── Left: agent list ─────────────────────────────────────── */}
      <aside className="w-52 shrink-0 border-r border-gray-800 flex flex-col bg-gray-950">
        <div className="px-3 py-2.5 border-b border-gray-800 flex items-center justify-between shrink-0">
          <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Agents</p>
          <div className="flex items-center gap-1.5">
            <button onClick={importPresets} disabled={importing} title="Import presets"
              className="p-1 text-gray-600 hover:text-indigo-400 transition-colors disabled:opacity-40">
              {importing
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Download className="w-3 h-3" />}
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

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {orderedGroups.map(cls => {
            const m = classMeta(cls);
            const Icon = CLASS_ICON[cls] ?? Bot;
            return (
              <div key={cls}>
                <p className={cn("text-[9px] font-bold uppercase tracking-widest px-1.5 mb-0.5 flex items-center gap-1", m.textColor)}>
                  <Icon className="w-2.5 h-2.5" /> {m.label}
                </p>
                {(grouped[cls] ?? []).map(a => (
                  <button key={a.id} onClick={() => setSelectedId(a.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[11px] transition-colors",
                      selectedId === a.id
                        ? "bg-indigo-900/40 text-white border border-indigo-700/40"
                        : "text-gray-400 hover:text-white hover:bg-gray-800/60",
                    )}>
                    <span className="truncate flex-1">{a.name}</span>
                  </button>
                ))}
              </div>
            );
          })}

          {allAgents.length === 0 && (
            <p className="text-[10px] text-gray-700 italic px-2 py-4 text-center">
              No agents yet — click + or import presets
            </p>
          )}
        </div>
      </aside>

      {/* ── Center: editor ───────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col bg-gray-900 overflow-hidden">
        {selected ? (
          <AgentEditor
            key={selected.id}
            agent={selected}
            allAgents={allAgents}
            onSave={saveAgent}
            onDelete={deleteAgent}
          />
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

      {/* ── Right: test panel ────────────────────────────────────── */}
      <div className="w-80 shrink-0 overflow-hidden flex flex-col">
        {selected
          ? <TestPanel key={selected.id} agent={selected} />
          : (
            <div className="h-full border-l border-gray-800 bg-gray-950 flex items-center justify-center">
              <p className="text-[10px] text-gray-700 italic">Select an agent to test</p>
            </div>
          )}
      </div>

    </div>
  );
}
