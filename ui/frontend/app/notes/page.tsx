"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import useSWR from "swr";
import {
  Users, Search, Loader2, CheckCircle2, Circle, ChevronDown, ChevronUp,
  Play, Save, Trash2, Check, StickyNote, AlertTriangle, XCircle, Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";
import { DragHandle } from "@/components/shared/DragHandle";
import { useResize } from "@/lib/useResize";

const API = "/api";

const ALL_MODELS = [
  "gpt-5.4", "gpt-4.1", "gpt-4.1-mini",
  "claude-opus-4-6", "claude-sonnet-4-6",
  "gemini-2.5-pro", "gemini-2.5-flash",
  "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
];

const DEFAULT_SYSTEM = `You are a senior call analyst reviewing a single sales call transcript.

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

const DEFAULT_PROMPT = "Analyse this call and produce a concise call note:";

// ── Types ────────────────────────────────────────────────────────────────────

interface Agent    { agent: string; count: number; }
interface Customer { customer: string; account_id: string; crm_url: string; call_count: number; }
interface CRMCall  { call_id: string; date: string; duration: number; record_path: string; }
interface TxCall   {
  call_id: string; pair_slug: string;
  has_llm_smoothed: boolean; has_llm_voted: boolean; has_pipeline_final: boolean;
}

interface NotesAgent {
  name: string;
  model: string;
  temperature: number;
  system_prompt: string;
  user_prompt: string;
  is_default: boolean;
  created_at?: string;
}

type CallStatus = "idle" | "transcribing" | "analyzing" | "done" | "error";
interface CallProgress {
  call_id: string;
  status: CallStatus;
  msg: string;
  note_id?: string;
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then(r => r.json());

function formatDuration(s: number) {
  if (!s) return "";
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
function formatDate(d: string) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }); }
  catch { return d; }
}
function providerFor(model: string) {
  if (model.startsWith("claude-")) return "Anthropic";
  if (model.startsWith("gemini"))  return "Google";
  if (model.startsWith("grok"))    return "xAI";
  return "OpenAI";
}

// ── Temperature selector ─────────────────────────────────────────────────────

const TEMP_OPTIONS = [0, 0.25, 0.5, 0.75] as const;

function TempSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1">
      {TEMP_OPTIONS.map(t => (
        <button key={t} type="button" onClick={() => onChange(t)}
          className={cn("flex-1 py-1.5 rounded text-xs font-mono transition-colors",
            Math.abs(value - t) < 0.001
              ? "bg-indigo-600 text-white font-semibold"
              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
          )}>
          {t.toFixed(2)}
        </button>
      ))}
    </div>
  );
}

// ── Notes Agent panel ─────────────────────────────────────────────────────────
// Single-purpose agent — its own preset storage at /api/notes/agents

function NotesAgentPanel({
  name, onNameChange,
  model, temp, system, prompt,
  onModel, onTemp, onSystem, onPrompt,
}: {
  name: string; onNameChange: (v: string) => void;
  model: string; temp: number; system: string; prompt: string;
  onModel: (v: string) => void; onTemp: (v: number) => void;
  onSystem: (v: string) => void; onPrompt: (v: string) => void;
}) {
  const [agents, setAgents] = useState<NotesAgent[]>([]);
  const [showList, setShowList] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [loadedSnapshot, setLoadedSnapshot] = useState<NotesAgent | null>(null);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const reload = useCallback(async () => {
    const r = await fetch(`${API}/notes/agents`);
    if (r.ok) setAgents(await r.json());
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Auto-rename to (copy) when config changes after loading
  useEffect(() => {
    if (!loadedSnapshot || nameManuallyEdited) return;
    const changed =
      model !== loadedSnapshot.model ||
      system !== loadedSnapshot.system_prompt ||
      prompt !== loadedSnapshot.user_prompt ||
      Math.abs(temp - loadedSnapshot.temperature) > 0.001;
    if (changed) {
      onNameChange(`${loadedSnapshot.name} (copy)`);
      setLoadedFrom(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, temp, system, prompt]);

  const autoSuggest = `${providerFor(model)} Notes Agent`;

  const save = async () => {
    const saveName = (name.trim() || autoSuggest).trim();
    if (!saveName) return;
    await fetch(`${API}/notes/agents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: saveName, model, temperature: temp,
        system_prompt: system, user_prompt: prompt,
        is_default: false,
      }),
    });
    onNameChange(saveName);
    setLoadedFrom(null); setLoadedSnapshot(null); setNameManuallyEdited(false);
    reload();
  };

  const loadAgent = (p: NotesAgent) => {
    onModel(p.model); onTemp(p.temperature);
    onSystem(p.system_prompt); onPrompt(p.user_prompt);
    onNameChange(p.name);
    setLoadedFrom(p.name);
    setLoadedSnapshot(p);
    setNameManuallyEdited(false);
    setShowList(false);
  };

  return (
    <div className="border-2 border-indigo-900/50 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-gray-900 px-4 pt-4 pb-4 space-y-3">
        <div>
          <p className="text-xs font-semibold text-indigo-300 uppercase tracking-widest mb-0.5">Notes Agent</p>
          <p className="text-[11px] text-gray-500">Single-call analysis configuration</p>
        </div>

        {/* Name + save + browse */}
        <div>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => { onNameChange(e.target.value); setNameManuallyEdited(true); setLoadedFrom(null); }}
              placeholder={autoSuggest}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button onClick={save}
              className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors shrink-0">
              <Save className="w-3.5 h-3.5" /> Save
            </button>
            <button onClick={() => setShowList(v => !v)}
              className="flex items-center gap-1 px-2.5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white text-xs rounded-lg transition-colors shrink-0">
              {showList ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              <span>{agents.length}</span>
            </button>
          </div>
          <div className="mt-1 min-h-[16px]">
            {!name && <p className="text-[11px] text-gray-600">Auto-suggested · type to override</p>}
            {loadedFrom && (
              <p className="text-[11px] text-emerald-700">
                Loaded: <span className="text-emerald-600">{loadedFrom}</span> · change any setting to create a copy
              </p>
            )}
          </div>
        </div>

        {/* Saved agents list */}
        {showList && (
          <div className="border border-gray-700 rounded-lg overflow-hidden">
            {agents.length === 0 && <p className="text-xs text-gray-600 px-3 py-2">No saved notes agents yet</p>}
            {agents.map(p => (
              <div key={p.name} className="flex items-center gap-1.5 px-3 py-2 hover:bg-gray-800/60 border-b border-gray-800/50 last:border-0">
                <button onClick={() => loadAgent(p)} className="flex-1 text-left min-w-0 group">
                  <span className="text-xs font-medium text-gray-200 group-hover:text-white">
                    {p.is_default && <span className="text-yellow-400 mr-1">★</span>}{p.name}
                  </span>
                  <span className="text-[10px] text-gray-600 ml-2">
                    {p.model} · {p.temperature.toFixed(2)}
                  </span>
                </button>
                <button
                  onClick={async () => {
                    await fetch(`${API}/notes/agents/${encodeURIComponent(p.name)}/default`, { method: "PATCH" });
                    reload();
                  }}
                  className="text-gray-600 hover:text-yellow-400 p-1 transition-colors" title="Set as default">
                  <Check className="w-3 h-3" />
                </button>
                <button
                  onClick={async () => {
                    await fetch(`${API}/notes/agents/${encodeURIComponent(p.name)}`, { method: "DELETE" });
                    if (loadedFrom === p.name) setLoadedFrom(null);
                    reload();
                  }}
                  className="text-gray-600 hover:text-red-400 p-1 transition-colors" title="Delete">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Config summary pill + expand toggle */}
        <button onClick={() => setConfigOpen(o => !o)}
          className="w-full flex items-center gap-2 text-[11px] text-gray-600 hover:text-gray-400 transition-colors pt-0.5">
          <span className="text-indigo-400/70 font-medium">{providerFor(model)}</span>
          <span>·</span>
          <span>{model} · {temp.toFixed(2)}</span>
          <span className="ml-auto">{configOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}</span>
        </button>
      </div>

      {/* Expandable config */}
      {configOpen && (
        <div className="border-t border-indigo-900/40 bg-gray-950/40 p-4 space-y-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Model</label>
            <select value={model} onChange={e => onModel(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500">
              {ALL_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">Temperature</label>
            <TempSelector value={temp} onChange={onTemp} />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">System Prompt</label>
            <textarea value={system} onChange={e => onSystem(e.target.value)} rows={8}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 block">User Prompt</label>
            <textarea value={prompt} onChange={e => onPrompt(e.target.value)} rows={2}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 font-mono resize-y focus:outline-none focus:ring-1 focus:ring-indigo-500" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Progress row ──────────────────────────────────────────────────────────────

function ProgressRow({ p }: { p: CallProgress }) {
  const icon =
    p.status === "done"        ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> :
    p.status === "error"       ? <XCircle className="w-4 h-4 text-red-400 shrink-0" /> :
    p.status !== "idle"        ? <Loader2 className="w-4 h-4 animate-spin text-indigo-400 shrink-0" /> :
                                 <Circle className="w-4 h-4 text-gray-700 shrink-0" />;
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-gray-800/50 last:border-0">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono text-gray-300 truncate">{p.call_id}</p>
        <p className={cn("text-[11px] truncate", p.status === "error" ? "text-red-400" : "text-gray-500")}>
          {p.error ?? p.msg}
        </p>
      </div>
      {p.status === "done" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NotesPage() {
  const [agentW, agentDrag]       = useResize(180, 120, 300);
  const [customerW, customerDrag] = useResize(180, 120, 300);
  const [callsW, callsDrag]       = useResize(260, 160, 380);

  const [agentsCollapsed, setAgentsCollapsed]     = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);
  const [callsCollapsed, setCallsCollapsed]       = useState(false);

  const [selectedAgent, setSelectedAgent]       = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedCalls, setSelectedCalls]       = useState<Set<string>>(new Set());
  const [agentSearch, setAgentSearch]           = useState("");
  const [customerSearch, setCustomerSearch]     = useState("");

  // Notes agent config
  const [agentName, setAgentName] = useState("");
  const [model, setModel]         = useState("gpt-5.4");
  const [temp, setTemp]           = useState(0);
  const [system, setSystem]       = useState(DEFAULT_SYSTEM);
  const [prompt, setPrompt]       = useState(DEFAULT_PROMPT);

  // Run state
  const [running, setRunning]   = useState(false);
  const [progress, setProgress] = useState<CallProgress[]>([]);
  const abortRef                = useRef(false);

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: agents } = useSWR<Agent[]>("/api/crm/nav/agents", fetcher);

  const { data: customers } = useSWR<Customer[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null,
    fetcher,
  );

  const { data: crmCalls } = useSWR<CRMCall[]>(
    selectedCustomer
      ? `/api/crm/calls/${selectedCustomer.account_id}?crm_url=${encodeURIComponent(selectedCustomer.crm_url)}&agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer.customer)}`
      : null,
    (url: string) => fetch(url, { signal: AbortSignal.timeout(60000) }).then(r => r.json()),
  );

  const { data: txCalls, mutate: mutateTx } = useSWR<TxCall[]>(
    selectedAgent && selectedCustomer
      ? `/api/final-transcript/calls?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer.customer)}`
      : null,
    fetcher,
  );

  const txMap = new Map<string, TxCall>();
  txCalls?.forEach(t => txMap.set(t.call_id, t));

  const calls = (crmCalls ?? []).map(c => ({
    ...c,
    tx: txMap.get(c.call_id) ?? null,
    hasTranscript: !!(txMap.get(c.call_id)?.has_llm_smoothed || txMap.get(c.call_id)?.has_llm_voted),
  }));

  const filteredAgents    = (agents ?? []).filter(a => a.agent.toLowerCase().includes(agentSearch.toLowerCase()));
  const filteredCustomers = (customers ?? []).filter(c => c.customer.toLowerCase().includes(customerSearch.toLowerCase()));

  // Load default notes agent on mount
  useEffect(() => {
    fetch(`${API}/notes/agents`)
      .then(r => r.ok ? r.json() : [])
      .then((presets: NotesAgent[]) => {
        const def = presets.find(p => p.is_default) ?? presets[0];
        if (def) {
          setAgentName(def.name);
          setModel(def.model); setTemp(def.temperature);
          setSystem(def.system_prompt); setPrompt(def.user_prompt);
        }
      })
      .catch(() => {});
  }, []);

  // ── Selection helpers ─────────────────────────────────────────────────────
  const toggleCall = (callId: string) =>
    setSelectedCalls(prev => {
      const next = new Set(prev);
      next.has(callId) ? next.delete(callId) : next.add(callId);
      return next;
    });

  const toggleAll = () =>
    setSelectedCalls(prev =>
      prev.size === calls.length ? new Set() : new Set(calls.map(c => c.call_id))
    );

  // ── Run analysis ──────────────────────────────────────────────────────────
  const runAnalysis = async () => {
    if (!selectedAgent || !selectedCustomer || selectedCalls.size === 0) return;
    const ordered = calls.filter(c => selectedCalls.has(c.call_id));

    setRunning(true);
    abortRef.current = false;
    setProgress(ordered.map(c => ({ call_id: c.call_id, status: "idle", msg: "Waiting…" })));

    for (let i = 0; i < ordered.length; i++) {
      if (abortRef.current) break;
      const call = ordered[i];

      const updateRow = (partial: Partial<CallProgress>) =>
        setProgress(prev => prev.map((r, idx) => idx === i ? { ...r, ...partial } : r));

      // Step A: transcribe if needed
      if (!call.hasTranscript) {
        if (!call.record_path) {
          updateRow({ status: "error", error: "No audio file — cannot transcribe" });
          continue;
        }
        updateRow({ status: "transcribing", msg: "Starting transcription…" });
        try {
          const res = await fetch("/api/transcription/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              crm_url:     selectedCustomer.crm_url,
              account_id:  selectedCustomer.account_id,
              agent:       selectedAgent,
              customer:    selectedCustomer.customer,
              call_id:     call.call_id,
              record_path: call.record_path,
            }),
          });
          if (!res.ok) throw new Error(await res.text());
          const job = await res.json();
          const jobId = job.id ?? job.job_id;
          updateRow({ msg: "Transcribing… (polling for completion)" });

          let done = false;
          for (let attempt = 0; attempt < 300 && !abortRef.current; attempt++) {
            await new Promise(r => setTimeout(r, 3000));
            const statusRes = await fetch(`/api/jobs/${jobId}`).catch(() => null);
            if (!statusRes?.ok) continue;
            const jobData = await statusRes.json();
            const s = jobData.status ?? "";
            updateRow({ msg: `Transcribing… (${s})` });
            if (s === "done" || s === "completed") { done = true; break; }
            if (s === "failed" || s === "error") throw new Error(`Transcription failed: ${jobData.message ?? s}`);
          }
          if (!done && !abortRef.current) throw new Error("Transcription timed out");
          mutateTx();
          updateRow({ msg: "Transcription complete" });
        } catch (e: any) {
          updateRow({ status: "error", error: e.message ?? "Transcription failed" });
          continue;
        }
      }

      if (abortRef.current) break;

      // Step B: run notes analysis
      updateRow({ status: "analyzing", msg: "Starting notes agent…" });
      try {
        await new Promise<void>((resolve, reject) => {
          fetch(`${API}/notes/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent:          selectedAgent,
              customer:       selectedCustomer.customer,
              call_id:        call.call_id,
              notes_agent_id: agentName.trim() || undefined,
              model,
              temperature:    temp,
              system_prompt:  system,
              user_prompt:    prompt,
            }),
          }).then(async res => {
            if (!res.ok) { reject(new Error(await res.text())); return; }
            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const parts = buf.split("\n\n");
              buf = parts.pop() ?? "";
              for (const part of parts) {
                const dataLine = part.split("\n").find(l => l.startsWith("data:"));
                if (!dataLine) continue;
                const eventLine = part.split("\n").find(l => l.startsWith("event:"));
                const event = eventLine?.replace("event:", "").trim() ?? "message";
                try {
                  const data = JSON.parse(dataLine.replace("data:", "").trim());
                  if (event === "progress") updateRow({ msg: data.msg ?? "" });
                  else if (event === "done") {
                    updateRow({ status: "done", msg: "Done", note_id: data.note_id });
                    resolve();
                  } else if (event === "error") reject(new Error(data.msg ?? "Analysis error"));
                } catch {}
              }
            }
            resolve();
          }).catch(reject);
        });
      } catch (e: any) {
        updateRow({ status: "error", error: e.message ?? "Analysis failed" });
      }
    }

    setRunning(false);
  };

  const selectedNeedingTx = calls.filter(c => selectedCalls.has(c.call_id) && !c.hasTranscript).length;
  const canRun = !!(selectedAgent && selectedCustomer && selectedCalls.size > 0 && !running);

  return (
    <div className="h-[calc(100vh-3rem)] flex gap-0">

      {/* Panel 1 — Agents */}
      <CollapsiblePanel title="Agents" width={agentW} collapsed={agentsCollapsed} onToggle={() => setAgentsCollapsed(c => !c)}>
        <div className="px-2 py-1.5 border-b border-gray-800/60">
          <div className="flex items-center gap-1.5 bg-gray-800 rounded-md px-2 py-1">
            <Search className="w-3 h-3 text-gray-600 shrink-0" />
            <input value={agentSearch} onChange={e => setAgentSearch(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-[11px] text-gray-300 placeholder-gray-600 outline-none min-w-0" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {!agents && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
          {filteredAgents.map(a => (
            <button key={a.agent} onClick={() => {
              if (selectedAgent === a.agent) { setSelectedAgent(""); setSelectedCustomer(null); }
              else { setSelectedAgent(a.agent); setSelectedCustomer(null); setSelectedCalls(new Set()); }
            }}
              className={cn("w-full text-left px-2 py-2 rounded-lg text-xs transition-colors",
                selectedAgent === a.agent
                  ? "bg-teal-500/10 border border-teal-500/20 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              )}>
              <div className="flex items-center gap-1.5">
                <Users className="w-3 h-3 text-teal-400 shrink-0" />
                <span className="font-medium truncate">{a.agent}</span>
              </div>
              <p className="text-gray-600 pl-[18px] text-[10px] mt-0.5">{a.count} customer{a.count !== 1 ? "s" : ""}</p>
            </button>
          ))}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={agentDrag} />

      {/* Panel 2 — Customers */}
      <CollapsiblePanel title="Customers" width={customerW} collapsed={customersCollapsed} onToggle={() => setCustomersCollapsed(c => !c)}>
        {!selectedAgent ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-600">Select an agent</p>
          </div>
        ) : (
          <>
            <div className="px-3 py-2 border-b border-gray-800">
              <p className="text-xs font-semibold text-white truncate">{selectedAgent}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">{customers?.length ?? "…"} customers</p>
            </div>
            <div className="px-2 py-1.5 border-b border-gray-800/60">
              <div className="flex items-center gap-1.5 bg-gray-800 rounded-md px-2 py-1">
                <Search className="w-3 h-3 text-gray-600 shrink-0" />
                <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)}
                  placeholder="Search…"
                  className="flex-1 bg-transparent text-[11px] text-gray-300 placeholder-gray-600 outline-none min-w-0" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {!customers && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
              {filteredCustomers.map(c => (
                <button key={c.customer} onClick={() => {
                  if (selectedCustomer?.customer === c.customer) { setSelectedCustomer(null); setSelectedCalls(new Set()); }
                  else { setSelectedCustomer(c); setSelectedCalls(new Set()); }
                }}
                  className={cn("w-full text-left px-2 py-2 rounded-lg text-xs transition-colors",
                    selectedCustomer?.customer === c.customer
                      ? "bg-teal-500/10 border border-teal-500/20 text-white"
                      : "text-gray-400 hover:bg-gray-800 hover:text-white"
                  )}>
                  <span className="font-medium truncate block">{c.customer}</span>
                  {c.call_count > 0 && <p className="text-[10px] text-gray-600 mt-0.5">{c.call_count} calls</p>}
                </button>
              ))}
            </div>
          </>
        )}
      </CollapsiblePanel>

      <DragHandle onMouseDown={customerDrag} />

      {/* Panel 3 — Calls (multi-select) */}
      <CollapsiblePanel title="Calls" width={callsW} collapsed={callsCollapsed} onToggle={() => setCallsCollapsed(c => !c)}>
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 flex items-center gap-2">
          {calls.length > 0 && (
            <>
              <button onClick={toggleAll} className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors">
                {selectedCalls.size === calls.length ? "Deselect all" : "Select all"}
              </button>
              <span className="text-[10px] text-gray-600">{selectedCalls.size}/{calls.length}</span>
            </>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!selectedCustomer && (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-gray-600">Select a customer</p>
            </div>
          )}
          {selectedCustomer && !crmCalls && (
            <div className="flex flex-col items-center gap-2 p-4 text-xs text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading calls…</span>
            </div>
          )}
          {calls.map(call => {
            const isSelected = selectedCalls.has(call.call_id);
            const progressRow = progress.find(p => p.call_id === call.call_id);
            return (
              <button key={call.call_id} onClick={() => toggleCall(call.call_id)}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors",
                  isSelected && "bg-indigo-900/20 border-l-2 border-l-indigo-500"
                )}>
                <div className="flex items-center gap-2 mb-0.5">
                  <div className={cn("w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                    isSelected ? "bg-indigo-600 border-indigo-500" : "border-gray-600"
                  )}>
                    {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                  </div>
                  <span className="text-xs font-mono font-medium text-gray-200 truncate flex-1">{call.call_id}</span>
                  {call.hasTranscript
                    ? <CheckCircle2 className="w-3 h-3 text-teal-400 shrink-0" />
                    : <Circle className="w-3 h-3 text-gray-700 shrink-0" />}
                </div>
                <div className="pl-6 flex items-center gap-2 text-[10px] text-gray-500">
                  {call.duration > 0 && <span className="text-teal-500/80">{formatDuration(call.duration)}</span>}
                  {call.date && <span>{formatDate(call.date)}</span>}
                  {progressRow && (
                    <span className={cn("ml-auto",
                      progressRow.status === "done" ? "text-emerald-400" :
                      progressRow.status === "error" ? "text-red-400" : "text-indigo-400"
                    )}>
                      {progressRow.status === "done" ? "✓" : progressRow.status === "error" ? "✗" : "…"}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {selectedCustomer && crmCalls?.length === 0 && (
            <p className="text-xs text-gray-600 p-4 text-center">No calls found</p>
          )}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={callsDrag} />

      {/* Right panel — Notes Agent + Run */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <StickyNote className="w-4 h-4 text-indigo-400" />
          <h1 className="text-sm font-semibold text-white">Notes</h1>
          <span className="text-xs text-gray-600">· per-call analysis</span>
        </div>

        {/* Notes Agent panel */}
        <NotesAgentPanel
          name={agentName} onNameChange={setAgentName}
          model={model} temp={temp} system={system} prompt={prompt}
          onModel={setModel} onTemp={setTemp} onSystem={setSystem} onPrompt={setPrompt}
        />

        {/* Run section */}
        <div className="border border-gray-800 rounded-xl p-4 space-y-3">
          {selectedNeedingTx > 0 && (
            <div className="flex items-start gap-2 p-3 bg-amber-900/20 border border-amber-700/30 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                {selectedNeedingTx} call{selectedNeedingTx !== 1 ? "s" : ""} will be transcribed automatically before analysis.
              </p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={running ? () => { abortRef.current = true; } : runAnalysis}
              disabled={!running && !canRun}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors",
                running
                  ? "bg-red-700 hover:bg-red-600 text-white"
                  : canRun
                    ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                    : "bg-gray-800 text-gray-600 cursor-not-allowed"
              )}>
              {running
                ? <><Square className="w-4 h-4" /> Stop</>
                : <><Play className="w-4 h-4" /> Analyze{selectedCalls.size > 0 ? ` ${selectedCalls.size} call${selectedCalls.size !== 1 ? "s" : ""}` : ""}</>
              }
            </button>
            {!selectedAgent && <p className="text-xs text-gray-600">Select an agent</p>}
            {selectedAgent && !selectedCustomer && <p className="text-xs text-gray-600">Select a customer</p>}
            {selectedCustomer && selectedCalls.size === 0 && <p className="text-xs text-gray-600">Select calls to analyze</p>}
          </div>

          {progress.length > 0 && (
            <div className="border border-gray-800 rounded-lg overflow-hidden mt-2">
              <div className="px-3 py-2 bg-gray-900 border-b border-gray-800 flex items-center gap-2">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Progress</span>
                <span className="text-[10px] text-gray-600 ml-auto">
                  {progress.filter(p => p.status === "done").length}/{progress.length} done
                </span>
              </div>
              <div className="p-2">
                {progress.map(p => <ProgressRow key={p.call_id} p={p} />)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
