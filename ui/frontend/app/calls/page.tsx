"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Users, Search, Loader2, FileText, CheckCircle2,
  Circle, ChevronRight, Mic2, StickyNote, Trash2, Play,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn, formatDuration, formatDate } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";
import { DragHandle } from "@/components/shared/DragHandle";
import { AgentSidePanel } from "@/components/shared/AgentSidePanel";
import { useResize } from "@/lib/useResize";

const fetcher = (url: string) => fetch(url).then(r => r.json());

// ── Note types ────────────────────────────────────────────────────────────────

interface Note {
  id: string;
  agent: string;
  customer: string;
  call_id: string;
  notes_agent_id?: string;
  content_md: string;
  model: string;
  temperature: number;
  created_at: string;
}

// ── Notes panel ───────────────────────────────────────────────────────────────

function NotesPanel({
  agent, customer, callId, llmAgentName,
}: {
  agent: string; customer: string; callId: string; llmAgentName?: string;
}) {
  const { data: notes, mutate } = useSWR<Note[]>(
    agent && customer && callId
      ? `/api/notes?agent=${encodeURIComponent(agent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(callId)}`
      : null,
    fetcher,
    { refreshInterval: 8000 },
  );
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState("");
  const [createError, setCreateError] = useState("");

  const deleteNote = async (id: string) => {
    await fetch(`/api/notes/${id}`, { method: "DELETE" });
    mutate();
  };

  // Notes filtered by active LLM agent (if one is selected)
  const visibleNotes = llmAgentName
    ? (notes ?? []).filter(n => n.notes_agent_id === llmAgentName)
    : (notes ?? []);

  async function createNote() {
    if (!agent || !customer || !callId || !llmAgentName) return;
    setCreating(true);
    setCreateProgress("Loading agent config…");
    setCreateError("");
    try {
      const presets: any[] = await fetch("/api/notes/agents").then(r => r.json());
      const preset = presets.find((p: any) => p.name === llmAgentName);
      if (!preset) throw new Error(`Agent "${llmAgentName}" not found in Agents`);

      setCreateProgress(`Running ${preset.name}…`);
      const res = await fetch("/api/notes/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent, customer, call_id: callId,
          notes_agent_id: preset.name,
          model: preset.model ?? "gpt-5.4",
          temperature: preset.temperature ?? 0,
          system_prompt: preset.system_prompt,
          user_prompt: preset.user_prompt,
          run_compliance: preset.run_compliance ?? false,
          compliance_model: preset.compliance_model,
          compliance_system_prompt: preset.compliance_system_prompt,
          compliance_user_prompt: preset.compliance_user_prompt,
        }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim());
            if (evt.type === "progress") setCreateProgress(evt.data.msg ?? "");
            if (evt.type === "done") { setCreateProgress(""); mutate(); }
            if (evt.type === "error") throw new Error(evt.data.msg);
          } catch {}
        }
      }
    } catch (e: any) {
      setCreateError(e.message ?? "Failed to create note");
    } finally {
      setCreating(false);
      setCreateProgress("");
    }
  }

  if (!callId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-2">
        <StickyNote className="w-8 h-8 opacity-20" />
        <p className="text-xs">Select a call to view notes</p>
      </div>
    );
  }

  if (!notes) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-gray-600">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-xs">Loading notes…</span>
      </div>
    );
  }

  if (visibleNotes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-3 px-4">
        <StickyNote className="w-8 h-8 opacity-20" />
        {creating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
            <p className="text-xs text-gray-400 text-center">{createProgress || "Working…"}</p>
          </>
        ) : llmAgentName ? (
          <>
            <p className="text-xs text-center">
              No notes from <span className="text-indigo-300 font-medium">{llmAgentName}</span>
            </p>
            <button
              onClick={createNote}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors"
            >
              <Play className="w-3 h-3" />
              Create notes
            </button>
            {createError && <p className="text-xs text-red-400 text-center">{createError}</p>}
          </>
        ) : (
          <p className="text-xs text-center text-gray-600">
            No notes for this call yet.<br />
            Select an agent in the context bar or use the Notes page.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      {/* Create another button when llmAgent is active */}
      {llmAgentName && !creating && (
        <button
          onClick={createNote}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-indigo-400 hover:text-indigo-300 border border-dashed border-indigo-800/50 rounded-lg transition-colors"
        >
          <Play className="w-3 h-3" />
          Re-run {llmAgentName}
        </button>
      )}
      {creating && (
        <div className="flex items-center gap-2 px-3 py-2 bg-indigo-900/20 border border-indigo-800/30 rounded-lg">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 shrink-0" />
          <span className="text-xs text-gray-400">{createProgress || "Working…"}</span>
        </div>
      )}
      {visibleNotes.map(note => (
        <div key={note.id} className="border border-gray-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 pt-2 pb-0">
            <span className="text-[9px] text-gray-600">
              {note.notes_agent_id && <span className="text-indigo-500 mr-1">{note.notes_agent_id}</span>}
              {new Date(note.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <button onClick={() => deleteNote(note.id)}
              className="text-gray-700 hover:text-red-400 p-1 transition-colors shrink-0">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
          <div className="px-3 pb-3 bg-gray-950/40">
            <div className="prose prose-invert prose-sm max-w-none text-xs">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ children }) => <h2 className="text-xs font-semibold text-indigo-300 mt-3 mb-1 border-b border-gray-800 pb-0.5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-xs font-semibold text-gray-300 mt-2 mb-0.5">{children}</h3>,
                  p:  ({ children }) => <p className="text-gray-400 mb-1 leading-relaxed text-[11px]">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc list-inside text-gray-400 mb-1 space-y-0 pl-2 text-[11px]">{children}</ul>,
                  li: ({ children }) => <li className="text-gray-400">{children}</li>,
                  strong: ({ children }) => <strong className="text-white font-medium">{children}</strong>,
                }}
              >
                {note.content_md}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface Agent    { agent: string; count: number; }
interface Customer { customer: string; account_id: string; crm_url: string; call_count: number; }
interface CRMCall  { call_id: string; date: string; duration: number; record_path: string; }
interface TxCall   {
  call_id: string; pair_slug: string;
  has_llm_smoothed: boolean; has_llm_voted: boolean; has_pipeline_final: boolean;
  smoothed_path: string | null; voted_path: string | null;
  duration_s: number | null; started_at: string | null;
}

function _css(k: string) { try { return sessionStorage.getItem(`calls_${k}`) ?? ""; } catch { return ""; } }
function _cssSet(k: string, v: string) { try { sessionStorage.setItem(`calls_${k}`, v); } catch {} }

export default function CallsPage() {
  const ctx = useAppCtx();

  const [agentW, agentDrag]       = useResize(180, 120, 360);
  const [customerW, customerDrag] = useResize(180, 120, 360);
  const [callsW, callsDrag]       = useResize(280, 180, 440);

  const [agentsCollapsed, setAgentsCollapsed]     = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);
  const [callsCollapsed, setCallsCollapsed]       = useState(false);

  // Start from safe defaults to match SSR; restored from sessionStorage post-mount
  const [selectedAgent, _setSelectedAgent]       = useState("");
  const [selectedCustomer, _setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedCallId, _setSelectedCallId]     = useState("");
  const [agentSearch, _setAgentSearch]           = useState("");
  const [customerSearch, _setCustomerSearch]     = useState("");
  const [checkedCallIds, setCheckedCallIds]       = useState<Set<string>>(new Set());
  const [batchTranscribing, setBatchTranscribing] = useState(false);
  const [batchError, setBatchError]               = useState("");

  const setSelectedAgent = (v: string) => {
    _setSelectedAgent(v); _cssSet("selectedAgent", v);
    ctx.setSalesAgent(v);
  };
  const setSelectedCustomer = (v: Customer | null) => {
    _setSelectedCustomer(v); _cssSet("selectedCustomer", v ? JSON.stringify(v) : "");
    if (v) ctx.setCustomer(v.customer);
    setCheckedCallIds(new Set());
  };
  const setSelectedCallId = (v: string) => {
    _setSelectedCallId(v); _cssSet("selectedCallId", v);
    ctx.setCallId(v);
  };
  const setAgentSearch     = (v: string) => { _setAgentSearch(v);     _cssSet("agentSearch",     v); };
  const setCustomerSearch  = (v: string) => { _setCustomerSearch(v);  _cssSet("customerSearch",  v); };

  const [transcript, setTranscript]             = useState("");
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcribing, setTranscribing]         = useState(false);
  const [transcribeError, setTranscribeError]   = useState("");
  const [notesW, notesDrag]                     = useResize(320, 200, 560, "left");

  // Restore persisted state after mount — prefer context values if local storage is empty
  useEffect(() => {
    const localAgent = _css("selectedAgent") || ctx.salesAgent;
    const localCustomerRaw = _css("selectedCustomer");
    const localCall = _css("selectedCallId") || ctx.callId;

    _setSelectedAgent(localAgent);
    let restoredCustomer = "";
    try {
      const v = localCustomerRaw;
      if (v) {
        const parsed = JSON.parse(v);
        _setSelectedCustomer(parsed);
        restoredCustomer = parsed.customer ?? "";
      }
    } catch {}
    _setSelectedCallId(localCall);
    _setAgentSearch(_css("agentSearch"));
    _setCustomerSearch(_css("customerSearch"));

    // Sync restored selections into the shared context so AgentSidePanel sees them.
    // Order matters: setSalesAgent clears customer/call, so set agent first.
    if (localAgent) ctx.setSalesAgent(localAgent);
    if (restoredCustomer) ctx.setCustomer(restoredCustomer);
    if (localCall) ctx.setCallId(localCall);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const { data: agents } = useSWR<Agent[]>("/api/crm/nav/agents", fetcher);

  const { data: customers } = useSWR<Customer[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null,
    fetcher
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
    fetcher
  );

  // Fetch all notes for this agent/customer pair to know which calls have notes
  const { data: pairNotes } = useSWR<{ call_id: string }[]>(
    selectedAgent && selectedCustomer
      ? `/api/notes?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer.customer)}`
      : null,
    fetcher,
    { refreshInterval: 15000 }
  );
  const notesCallIds = new Set((pairNotes ?? []).map(n => n.call_id));

  // Build transcription status map: call_id → TxCall
  const txMap = new Map<string, TxCall>();
  txCalls?.forEach(t => txMap.set(t.call_id, t));

  // Merge CRM calls with transcription status
  const calls = crmCalls?.map(c => ({
    ...c,
    tx: txMap.get(c.call_id) ?? null,
  })) ?? [];

  const selectedCallData = calls.find(c => c.call_id === selectedCallId) ?? null;
  const selectedTx = selectedCallData?.tx ?? null;

  // ── Load transcript ───────────────────────────────────────────────────────
  useEffect(() => {
    setTranscript("");
    setTranscribeError("");
    if (!selectedTx) return;
    const path = selectedTx.smoothed_path || selectedTx.voted_path;
    if (!path) return;
    setTranscriptLoading(true);
    fetch(`/api/final-transcript/content?path=${encodeURIComponent(path)}`)
      .then(r => r.text())
      .then(setTranscript)
      .catch(() => setTranscript("Error loading transcript."))
      .finally(() => setTranscriptLoading(false));
  }, [selectedCallId, selectedTx?.smoothed_path, selectedTx?.voted_path]);

  // ── Transcribe action ─────────────────────────────────────────────────────
  async function handleTranscribe() {
    if (!selectedCallData || !selectedCustomer) return;
    setTranscribing(true);
    setTranscribeError("");
    try {
      const res = await fetch("/api/transcription/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_url:     selectedCustomer.crm_url,
          account_id:  selectedCustomer.account_id,
          agent:       selectedAgent,
          customer:    selectedCustomer.customer,
          call_id:     selectedCallData.call_id,
          record_path: selectedCallData.record_path,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: any) {
      setTranscribeError(e.message ?? "Failed to start transcription");
    } finally {
      setTranscribing(false);
      mutateTx();
    }
  }

  // ── Batch transcribe ──────────────────────────────────────────────────────
  function toggleCheck(callId: string) {
    setCheckedCallIds(prev => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }

  function selectUntranscribed() {
    const ids = calls
      .filter(c => !c.tx?.has_llm_smoothed && !c.tx?.has_llm_voted && !c.tx?.has_pipeline_final && c.record_path)
      .map(c => c.call_id);
    setCheckedCallIds(new Set(ids));
  }

  async function handleBatchTranscribe() {
    if (!selectedCustomer || checkedCallIds.size === 0) return;
    setBatchTranscribing(true);
    setBatchError("");
    try {
      await Promise.all([...checkedCallIds].map(async (callId) => {
        const callData = calls.find(c => c.call_id === callId);
        if (!callData?.record_path) return;
        await fetch("/api/transcription/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            crm_url:     selectedCustomer.crm_url,
            account_id:  selectedCustomer.account_id,
            agent:       selectedAgent,
            customer:    selectedCustomer.customer,
            call_id:     callId,
            record_path: callData.record_path,
          }),
        });
      }));
      setCheckedCallIds(new Set());
      mutateTx();
    } catch (e: any) {
      setBatchError(e.message ?? "Failed to queue some transcriptions");
    } finally {
      setBatchTranscribing(false);
    }
  }

  // ── Filtered lists ────────────────────────────────────────────────────────
  const filteredAgents    = (agents ?? []).filter(a => a.agent.toLowerCase().includes(agentSearch.toLowerCase()));
  const filteredCustomers = (customers ?? []).filter(c => c.customer.toLowerCase().includes(customerSearch.toLowerCase()));

  return (
    <div className="h-[calc(100vh-5.25rem)] flex">

      {/* Panel 1 — Agents */}
      <CollapsiblePanel title="Agents" width={agentW} collapsed={agentsCollapsed} onToggle={() => setAgentsCollapsed(c => !c)}>
        <div className="px-2 py-1.5 border-b border-gray-800/60 shrink-0">
          <div className="flex items-center gap-1.5 bg-gray-800 rounded-md px-2 py-1">
            <Search className="w-3 h-3 text-gray-600 shrink-0" />
            <input value={agentSearch} onChange={e => setAgentSearch(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-[11px] text-gray-300 placeholder-gray-600 outline-none min-w-0" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {!agents && <div className="flex justify-center p-4"><Loader2 className="w-4 h-4 animate-spin text-gray-600" /></div>}
          {filteredAgents.map(a => {
            const isSelected = selectedAgent === a.agent;
            return (
              <div
                key={a.agent}
                onClick={() => {
                  if (isSelected) { setSelectedAgent(""); setSelectedCustomer(null); }
                  else { setSelectedAgent(a.agent); setSelectedCustomer(null); setSelectedCallId(""); }
                }}
                className={cn(
                  "rounded-lg border p-2.5 cursor-pointer transition-colors",
                  isSelected
                    ? "border-teal-500/60 bg-teal-900/20"
                    : "border-gray-700 bg-gray-800/30 hover:border-gray-600"
                )}
              >
                <div className="flex items-start gap-2">
                  <div className={cn(
                    "mt-0.5 w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center",
                    isSelected ? "border-teal-500 bg-teal-600" : "border-gray-600"
                  )}>
                    {isSelected && (
                      <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-xs font-medium truncate leading-tight", isSelected ? "text-white" : "text-gray-300")}>
                      {a.agent}
                    </p>
                    <p className="text-[10px] text-gray-600 mt-0.5">
                      {a.count} customer{a.count !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
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
                  if (selectedCustomer?.customer === c.customer) { setSelectedCustomer(null); setSelectedCallId(""); }
                  else { setSelectedCustomer(c); setSelectedCallId(""); }
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

      {/* Panel 3 — Calls */}
      <CollapsiblePanel title="Calls" width={callsW} collapsed={callsCollapsed} onToggle={() => setCallsCollapsed(c => !c)}>
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1.5">
          {calls.length > 0 && (
            <p className="text-[10px] text-gray-500">
              {calls.length} calls · {calls.filter(c => c.tx?.has_llm_smoothed || c.tx?.has_llm_voted).length} transcribed
            </p>
          )}
          {calls.some(c => !c.tx?.has_llm_smoothed && !c.tx?.has_llm_voted && !c.tx?.has_pipeline_final && c.record_path) && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={selectUntranscribed}
                className="text-[10px] text-gray-500 hover:text-gray-300 underline transition-colors"
              >
                Select untranscribed
              </button>
              {checkedCallIds.size > 0 && (
                <>
                  <span className="text-[10px] text-gray-700">·</span>
                  <button
                    onClick={handleBatchTranscribe}
                    disabled={batchTranscribing}
                    className="flex items-center gap-1 px-2 py-0.5 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-[10px] rounded transition-colors"
                  >
                    {batchTranscribing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mic2 className="w-3 h-3" />}
                    {batchTranscribing ? "Queuing…" : `Transcribe ${checkedCallIds.size}`}
                  </button>
                  <button
                    onClick={() => setCheckedCallIds(new Set())}
                    className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          {batchError && <p className="text-[10px] text-red-400">{batchError}</p>}
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
              <span className="text-gray-700 text-[10px]">First load fetches from CRM</span>
            </div>
          )}
          {calls.map(call => {
            const hasTranscript = call.tx?.has_llm_smoothed || call.tx?.has_llm_voted || call.tx?.has_pipeline_final;
            const hasNotes = notesCallIds.has(call.call_id);
            const isSelected = selectedCallId === call.call_id;
            const isChecked = checkedCallIds.has(call.call_id);
            return (
              <div key={call.call_id} className={cn(
                "flex items-stretch border-b border-gray-800/50",
                isSelected && "bg-teal-500/5 border-l-2 border-l-teal-500"
              )}>
                {/* Checkbox column */}
                <div
                  onClick={() => toggleCheck(call.call_id)}
                  className="flex items-center px-2 cursor-pointer hover:bg-gray-700/20 transition-colors shrink-0"
                >
                  <div className={cn(
                    "w-3.5 h-3.5 rounded border flex items-center justify-center",
                    isChecked ? "border-teal-500 bg-teal-600" : "border-gray-700"
                  )}>
                    {isChecked && (
                      <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                </div>
                {/* Row content */}
                <button
                  onClick={() => setSelectedCallId(selectedCallId === call.call_id ? "" : call.call_id)}
                  className="flex-1 min-w-0 text-left px-2 py-2.5 hover:bg-gray-800/40 transition-colors"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <ChevronRight className={cn("w-3 h-3 shrink-0", isSelected ? "text-teal-400" : "text-gray-700")} />
                    <span className="text-xs font-mono font-medium text-gray-200 truncate">{call.call_id}</span>
                    <span className="ml-auto flex items-center gap-1 shrink-0">
                      {hasNotes && <StickyNote className="w-3 h-3 text-indigo-400" />}
                      {hasTranscript
                        ? <CheckCircle2 className="w-3 h-3 text-teal-400" />
                        : <Circle className="w-3 h-3 text-gray-700" />}
                    </span>
                  </div>
                  <div className="pl-[18px] flex items-center gap-2 text-[10px] text-gray-500">
                    {call.duration > 0 && <span className="text-teal-500/80">{formatDuration(call.duration)}</span>}
                    {call.date && <span>{formatDate(call.date)}</span>}
                  </div>
                </button>
              </div>
            );
          })}
          {selectedCustomer && crmCalls?.length === 0 && (
            <p className="text-xs text-gray-600 p-4 text-center">No calls found</p>
          )}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={callsDrag} />

      {/* Panel 4 — Transcript viewer + optional Notes panel */}
      <div className="flex-1 min-w-0 flex">
        {/* Transcript */}
        <div className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
            <FileText className="w-3.5 h-3.5 text-teal-400" />
            <span className="text-xs font-semibold text-white flex-1">
              {selectedCallId ? selectedCallId : "Transcript"}
            </span>
            {selectedCallData && (
              <div className="flex items-center gap-2 text-[10px] text-gray-500">
                {selectedCallData.duration > 0 && <span className="text-teal-400">{formatDuration(selectedCallData.duration)}</span>}
                {selectedCallData.date && <span>{formatDate(selectedCallData.date)}</span>}
              </div>
            )}
          </div>

          {!selectedCallId ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-600 gap-2">
              <FileText className="w-10 h-10 opacity-20" />
              <p className="text-sm">Select a call</p>
            </div>
          ) : transcriptLoading ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading transcript…
            </div>
          ) : transcript ? (
            <div className="flex-1 min-h-0 p-4 overflow-auto">
              <div className="h-full bg-gray-950 border border-gray-800 rounded-lg p-3 overflow-auto">
                <TranscriptViewer content={transcript} format="txt" className="h-full" />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-600">
              <Circle className="w-10 h-10 opacity-20" />
              <p className="text-sm">No transcript yet</p>
              {selectedCallData?.record_path && (
                <button
                  onClick={handleTranscribe}
                  disabled={transcribing}
                  className="flex items-center gap-2 px-4 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {transcribing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic2 className="w-4 h-4" />}
                  {transcribing ? "Starting…" : "Transcribe"}
                </button>
              )}
              {transcribeError && <p className="text-xs text-red-400 max-w-xs text-center">{transcribeError}</p>}
            </div>
          )}
        </div>

        {/* Agent side panel — always visible */}
        <>
          <DragHandle onMouseDown={notesDrag} />
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col shrink-0" style={{ width: notesW }}>
            <AgentSidePanel />
          </div>
        </>
      </div>
    </div>
  );
}
