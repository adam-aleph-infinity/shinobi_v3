"use client";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Bot, Plus, Trash2, Check, Loader2, ChevronDown, ChevronUp, AlertTriangle, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

const MODEL_GROUPS = [
  { provider: "OpenAI",    models: ["gpt-5.4", "gpt-4.1", "gpt-4.1-mini"] },
  { provider: "Anthropic", models: ["claude-opus-4-6", "claude-sonnet-4-6"] },
  { provider: "Google",    models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { provider: "xAI",       models: ["grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"] },
];

const DEFAULT_NOTES_SYSTEM = `You are a senior call analyst reviewing a single sales call transcript.

Produce a concise call note with EXACTLY these sections (each preceded by ##):

## Summary
What was discussed, key outcomes, the customer's stance at the end.

## Sales Techniques Used
Specific tactics, objection handling, persuasion methods observed in this call.

## Compliance & Risk
Required disclosures given or missed, any red flags, risk rating (Low / Medium / High).

## Communication Quality
Tone, clarity, active listening, rapport, pacing.

## Next Steps
Agreed next actions, follow-ups, open items.

Rules:
- Use the exact ## headings — do not rename, add, or remove sections.
- Be specific; quote the transcript directly where relevant.
- Keep each section concise (3–6 bullet points).
- Do not add a title or preamble before the first ## heading.`;

const DEFAULT_NOTES_PROMPT = "Analyse this call and produce a concise call note:";

const DEFAULT_COMPLIANCE_SYSTEM = `You are a regulatory compliance analyst reviewing a single sales call note.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

{
  "Compliance Risk":     {"score": 80, "reasoning": "brief justification"},
  "Disclosure Quality":  {"score": 75, "reasoning": "brief justification"},
  "Regulatory Language": {"score": 85, "reasoning": "brief justification"},
  "Sales Ethics":        {"score": 90, "reasoning": "brief justification"},
  "_overall": 82,
  "_summary": "One sentence overall compliance assessment",
  "_risk_level": "Low",
  "_violations": []
}

Rules: scores 0–100 (higher=better), _risk_level is Low/Medium/High, _violations is a list.`;

const DEFAULT_COMPLIANCE_PROMPT = "Score the compliance of this call note:";

// ── Reusable grouped model select ─────────────────────────────────────────────

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
    >
      {MODEL_GROUPS.map(g => (
        <optgroup key={g.provider} label={g.provider}>
          {g.models.map(m => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// ── Notes Agent types ─────────────────────────────────────────────────────────

interface NotesAgent {
  name: string;
  model: string;
  temperature: number;
  system_prompt: string;
  user_prompt: string;
  is_default: boolean;
  run_compliance: boolean;
  compliance_model: string;
  compliance_system_prompt: string;
  compliance_user_prompt: string;
  created_at: string;
}

const EMPTY_NOTES_AGENT: Omit<NotesAgent, "created_at"> = {
  name: "",
  model: "gpt-5.4",
  temperature: 0,
  system_prompt: DEFAULT_NOTES_SYSTEM,
  user_prompt: DEFAULT_NOTES_PROMPT,
  is_default: false,
  run_compliance: true,
  compliance_model: "gpt-5.4",
  compliance_system_prompt: DEFAULT_COMPLIANCE_SYSTEM,
  compliance_user_prompt: DEFAULT_COMPLIANCE_PROMPT,
};

// ── Persona Agent types ───────────────────────────────────────────────────────

interface PersonaAgent {
  id: string;
  name: string;
  model: string;
  temperature: number;
  system_prompt: string;
  agent_type: string;
  is_default: boolean;
  created_at?: string;
}

const EMPTY_PERSONA_AGENT: Omit<PersonaAgent, "id" | "created_at"> = {
  name: "",
  model: "gpt-5.4",
  temperature: 0.3,
  system_prompt: "",
  agent_type: "agent_overall",
  is_default: false,
};

// ── Notes Agents tab ─────────────────────────────────────────────────────────

function NotesAgentsTab() {
  const { mutate } = useSWRConfig();
  const { data: agents, isLoading } = useSWR<NotesAgent[]>(`${API}/notes/agents`, fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_NOTES_AGENT });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCompliance, setShowCompliance] = useState(false);
  const [isNew, setIsNew] = useState(false);

  const selectedAgent = agents?.find(a => a.name === selected);

  function openNew() {
    setSelected(null);
    setIsNew(true);
    setForm({ ...EMPTY_NOTES_AGENT });
    setSaved(false);
  }

  function openEdit(a: NotesAgent) {
    setSelected(a.name);
    setIsNew(false);
    setForm({
      name: a.name,
      model: a.model,
      temperature: a.temperature ?? 0,
      system_prompt: a.system_prompt ?? DEFAULT_NOTES_SYSTEM,
      user_prompt: a.user_prompt ?? DEFAULT_NOTES_PROMPT,
      is_default: a.is_default ?? false,
      run_compliance: a.run_compliance ?? true,
      compliance_model: a.compliance_model ?? "gpt-5.4",
      compliance_system_prompt: a.compliance_system_prompt ?? DEFAULT_COMPLIANCE_SYSTEM,
      compliance_user_prompt: a.compliance_user_prompt ?? DEFAULT_COMPLIANCE_PROMPT,
    });
    setSaved(false);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await fetch(`${API}/notes/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      mutate(`${API}/notes/agents`);
      setSelected(form.name);
      setIsNew(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(name: string) {
    await fetch(`${API}/notes/agents/${encodeURIComponent(name)}/default`, { method: "PATCH" });
    mutate(`${API}/notes/agents`);
  }

  async function deleteAgent(name: string) {
    if (!confirm(`Delete notes agent "${name}"?`)) return;
    await fetch(`${API}/notes/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
    mutate(`${API}/notes/agents`);
    if (selected === name) { setSelected(null); setIsNew(false); }
  }

  const showForm = isNew || selected !== null;

  return (
    <div className="flex h-full gap-0">
      {/* List */}
      <div className="w-56 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <button
            onClick={openNew}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Notes Agent
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
          {(agents ?? []).map(a => (
            <button
              key={a.name}
              onClick={() => openEdit(a)}
              className={cn(
                "w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors",
                selected === a.name
                  ? "bg-indigo-600/20 border border-indigo-600/30 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              )}
            >
              <div className="flex items-center gap-1.5">
                <Bot className="w-3 h-3 text-indigo-400 shrink-0" />
                <span className="font-medium truncate flex-1">{a.name}</span>
                {a.is_default && <span className="text-[9px] bg-indigo-900 text-indigo-400 px-1.5 py-0.5 rounded">default</span>}
              </div>
              <p className="text-[10px] text-gray-600 mt-0.5 pl-[18px] truncate">{a.model}</p>
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
            <h2 className="text-sm font-semibold text-white">
              {isNew ? "New Notes Agent" : `Edit: ${selected}`}
            </h2>
            <div className="flex items-center gap-2">
              {selected && (
                <>
                  <button
                    onClick={() => setDefault(selected)}
                    disabled={selectedAgent?.is_default}
                    className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {selectedAgent?.is_default ? "Default ✓" : "Set as default"}
                  </button>
                  <button
                    onClick={() => deleteAgent(selected)}
                    className="text-xs px-2.5 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-800/50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
              <button
                onClick={save}
                disabled={saving || !form.name.trim()}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
                {saved ? "Saved" : "Save"}
              </button>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. call_notes_agent"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500"
            />
          </div>

          {/* Side-by-side prompts */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col">
              <label className="block text-xs text-gray-400 mb-1">System Prompt</label>
              <textarea
                value={form.system_prompt}
                onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))}
                rows={16}
                className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
              />
            </div>
            <div className="flex flex-col">
              <label className="block text-xs text-gray-400 mb-1">User Prompt</label>
              <textarea
                value={form.user_prompt}
                onChange={e => setForm(f => ({ ...f, user_prompt: e.target.value }))}
                rows={16}
                className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
              />
            </div>
          </div>

          {/* Settings collapsible */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowSettings(s => !s)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-colors text-xs"
            >
              <span className="flex items-center gap-2 text-gray-300 font-medium">
                <Settings2 className="w-3.5 h-3.5 text-gray-400" />
                Settings
              </span>
              {showSettings ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
            </button>
            {showSettings && (
              <div className="p-4 space-y-4 border-t border-gray-800">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Model</label>
                  <ModelSelect value={form.model} onChange={v => setForm(f => ({ ...f, model: v }))} />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Temperature</label>
                  <input
                    type="number" min={0} max={2} step={0.1}
                    value={form.temperature}
                    onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Compliance section */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowCompliance(s => !s)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-colors text-xs"
            >
              <span className="flex items-center gap-2 text-gray-300 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                Compliance Scoring
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={form.run_compliance}
                    onChange={e => setForm(f => ({ ...f, run_compliance: e.target.checked }))}
                    className="w-3.5 h-3.5 accent-indigo-500"
                  />
                  <span className="text-gray-400">enabled</span>
                </label>
                {showCompliance ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
              </div>
            </button>

            {showCompliance && (
              <div className="p-4 space-y-4 border-t border-gray-800">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Compliance Model</label>
                  <ModelSelect value={form.compliance_model} onChange={v => setForm(f => ({ ...f, compliance_model: v }))} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col">
                    <label className="block text-xs text-gray-400 mb-1">Compliance System Prompt</label>
                    <textarea
                      value={form.compliance_system_prompt}
                      onChange={e => setForm(f => ({ ...f, compliance_system_prompt: e.target.value }))}
                      rows={8}
                      className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
                    />
                  </div>
                  <div className="flex flex-col">
                    <label className="block text-xs text-gray-400 mb-1">Compliance User Prompt</label>
                    <textarea
                      value={form.compliance_user_prompt}
                      onChange={e => setForm(f => ({ ...f, compliance_user_prompt: e.target.value }))}
                      rows={8}
                      className="flex-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          <div className="text-center space-y-3">
            <Bot className="w-12 h-12 mx-auto opacity-20" />
            <p className="text-sm">Select a notes agent or create a new one</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Persona Agents tab ────────────────────────────────────────────────────────

function PersonaAgentsTab() {
  const { mutate } = useSWRConfig();
  const { data: agents, isLoading } = useSWR<PersonaAgent[]>(`${API}/persona-agents`, fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_PERSONA_AGENT });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isNew, setIsNew] = useState(false);

  const selectedAgent = agents?.find(a => a.id === selected);

  function openNew() {
    setSelected(null);
    setIsNew(true);
    setForm({ ...EMPTY_PERSONA_AGENT });
    setSaved(false);
  }

  function openEdit(a: PersonaAgent) {
    setSelected(a.id);
    setIsNew(false);
    setForm({
      name: a.name,
      model: a.model,
      temperature: a.temperature ?? 0.3,
      system_prompt: a.system_prompt ?? "",
      agent_type: a.agent_type ?? "agent_overall",
      is_default: a.is_default ?? false,
    });
    setSaved(false);
  }

  async function save() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const method = isNew ? "POST" : "PATCH";
      const url = isNew ? `${API}/persona-agents` : `${API}/persona-agents/${selected}`;
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      mutate(`${API}/persona-agents`);
      if (isNew) setSelected(data.id ?? null);
      setIsNew(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function setDefault(id: string) {
    await fetch(`${API}/persona-agents/${id}/default`, { method: "PATCH" });
    mutate(`${API}/persona-agents`);
  }

  async function deleteAgent(id: string) {
    if (!confirm("Delete this persona agent?")) return;
    await fetch(`${API}/persona-agents/${id}`, { method: "DELETE" });
    mutate(`${API}/persona-agents`);
    if (selected === id) { setSelected(null); setIsNew(false); }
  }

  const showForm = isNew || selected !== null;

  return (
    <div className="flex h-full gap-0">
      {/* List */}
      <div className="w-56 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <button
            onClick={openNew}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Persona Agent
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
          {(agents ?? []).map(a => (
            <button
              key={a.id}
              onClick={() => openEdit(a)}
              className={cn(
                "w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors",
                selected === a.id
                  ? "bg-purple-600/20 border border-purple-600/30 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              )}
            >
              <div className="flex items-center gap-1.5">
                <Bot className="w-3 h-3 text-purple-400 shrink-0" />
                <span className="font-medium truncate flex-1">{a.name}</span>
                {a.is_default && <span className="text-[9px] bg-purple-900 text-purple-400 px-1.5 py-0.5 rounded">default</span>}
              </div>
              <p className="text-[10px] text-gray-600 mt-0.5 pl-[18px] truncate">{a.model} · {a.agent_type}</p>
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
            <h2 className="text-sm font-semibold text-white">
              {isNew ? "New Persona Agent" : `Edit: ${form.name}`}
            </h2>
            <div className="flex items-center gap-2">
              {selected && (
                <>
                  <button
                    onClick={() => setDefault(selected)}
                    disabled={selectedAgent?.is_default}
                    className="text-xs px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {selectedAgent?.is_default ? "Default ✓" : "Set as default"}
                  </button>
                  <button
                    onClick={() => deleteAgent(selected)}
                    className="text-xs px-2.5 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-800/50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
              <button
                onClick={save}
                disabled={saving || !form.name.trim()}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <Check className="w-3 h-3" /> : null}
                {saved ? "Saved" : "Save"}
              </button>
            </div>
          </div>

          {/* Name + Agent Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Name</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. agent_analyst_v1"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Agent Type</label>
              <select
                value={form.agent_type}
                onChange={e => setForm(f => ({ ...f, agent_type: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
              >
                <option value="agent_overall">agent_overall</option>
                <option value="pair">pair</option>
                <option value="customer">customer</option>
              </select>
            </div>
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">System Prompt</label>
            <textarea
              value={form.system_prompt}
              onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))}
              rows={16}
              placeholder="Enter the system prompt for this persona agent…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono outline-none focus:border-purple-500 resize-y"
            />
          </div>

          {/* Settings collapsible */}
          <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowSettings(s => !s)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-colors text-xs"
            >
              <span className="flex items-center gap-2 text-gray-300 font-medium">
                <Settings2 className="w-3.5 h-3.5 text-gray-400" />
                Settings
              </span>
              {showSettings ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
            </button>
            {showSettings && (
              <div className="p-4 space-y-4 border-t border-gray-800">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Model</label>
                  <ModelSelect value={form.model} onChange={v => setForm(f => ({ ...f, model: v }))} />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Temperature</label>
                  <input
                    type="number" min={0} max={2} step={0.1}
                    value={form.temperature}
                    onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          <div className="text-center space-y-3">
            <Bot className="w-12 h-12 mx-auto opacity-20" />
            <p className="text-sm">Select a persona agent or create a new one</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = "persona" | "notes";

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>("persona");

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex flex-col -m-6">
      {/* Header */}
      <div className="px-6 pt-5 pb-0 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3 mb-4">
          <Bot className="w-5 h-5 text-indigo-400" />
          <h1 className="text-lg font-semibold text-white">Agents</h1>
          <p className="text-sm text-gray-500">Create and manage analysis agents</p>
        </div>
        <div className="flex gap-1">
          {(["persona", "notes"] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
                tab === t
                  ? "bg-gray-950 text-white border-t border-x border-gray-800"
                  : "text-gray-500 hover:text-gray-300"
              )}
            >
              {t === "notes" ? "Notes Agents" : "Persona Agents"}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 bg-gray-950">
        {tab === "persona" && <PersonaAgentsTab />}
        {tab === "notes"   && <NotesAgentsTab />}
      </div>
    </div>
  );
}
