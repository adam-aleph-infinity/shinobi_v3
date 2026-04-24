"use client";
import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import {
  Loader2, FileText, CheckCircle2,
  Circle, ChevronRight, Mic2, StickyNote, Trash2, Play,
  EyeOff, Eye, X,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn, formatDuration, formatDate } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";
import { DragHandle } from "@/components/shared/DragHandle";
import { AgentSidePanel } from "@/components/shared/AgentSidePanel";
import { PipelineSidePanel } from "@/components/shared/PipelineSidePanel";
import { SectionContent } from "@/components/shared/SectionCards";
import { useResize } from "@/lib/useResize";
import { CallCitationProvider } from "@/lib/call-citation-context";
import { logClientExecutionEvent } from "@/lib/execution-log";

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
            <SectionContent content={note.content_md} />
          </div>
        </div>
      ))}
    </div>
  );
}

interface Customer { customer: string; account_id: string; crm_url: string; call_count: number; }
interface CRMCall  { call_id: string; date: string; duration: number; record_path: string; crm_url?: string; account_id?: string; }
interface TxCall   {
  call_id: string; pair_slug: string;
  has_llm_smoothed: boolean; has_llm_voted: boolean; has_pipeline_final: boolean;
  smoothed_path: string | null; voted_path: string | null;
  duration_s: number | null; started_at: string | null;
}

export default function CallsPage() {
  const ctx = useAppCtx();
  const [sidePanel, setSidePanel] = useState<"agent" | "pipeline">("agent");

  // On mount: default to pipeline tab if only a pipeline is active (no agent)
  useEffect(() => {
    if (ctx.activePipelineId && !ctx.activeAgentId) setSidePanel("pipeline");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-switch to pipeline tab when a pipeline becomes active
  const prevPipelineId = useRef(ctx.activePipelineId);
  useEffect(() => {
    if (ctx.activePipelineId && ctx.activePipelineId !== prevPipelineId.current) {
      setSidePanel("pipeline");
    }
    prevPipelineId.current = ctx.activePipelineId;
  }, [ctx.activePipelineId]);

  const [callsW, callsDrag]       = useResize(280, 180, 440);
  const [callsCollapsed, setCallsCollapsed]       = useState(false);

  const selectedAgent = ctx.salesAgent;
  const selectedCustomerName = ctx.customer;
  const selectedCallId = ctx.callId;
  const [checkedCallIds, setCheckedCallIds]       = useState<Set<string>>(new Set());

  // Auto-switch to pipeline tab when calls are first checked (if pipeline active)
  const prevCheckedSizeRef = useRef(0);
  useEffect(() => {
    if (checkedCallIds.size > 0 && prevCheckedSizeRef.current === 0 && ctx.activePipelineId) {
      setSidePanel("pipeline");
    }
    prevCheckedSizeRef.current = checkedCallIds.size;
  }, [checkedCallIds, ctx.activePipelineId]);

  const [batchTranscribing, setBatchTranscribing] = useState(false);
  const [batchError, setBatchError]               = useState("");
  const setSelectedCallId = (v: string) => ctx.setCallId(v);

  const [transcript, setTranscript]             = useState("");
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcribing, setTranscribing]         = useState(false);
  const [transcribeError, setTranscribeError]   = useState("");
  const [notesW, notesDrag]                     = useResize(320, 200, 560, "left");
  const [showTranscript, setShowTranscript]     = useState(true);

  // Citation modal state
  const [citationCallId, setCitationCallId]       = useState<string | null>(null);
  const [citationTranscript, setCitationTranscript] = useState("");
  const [citationLoading, setCitationLoading]     = useState(false);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const { data: customers } = useSWR<Customer[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null,
    fetcher
  );
  const norm = (v?: string | null) => String(v || "").trim().toLowerCase();
  const selectedCustomer = (customers ?? []).find(c => norm(c.customer) === norm(selectedCustomerName)) ?? null;

  // Fallback lookup from pair list when nav/customers doesn't include the active customer yet.
  const { data: selectedPairRows } = useSWR<any[]>(
    selectedAgent && selectedCustomerName && !selectedCustomer
      ? `/api/crm/pairs?agent=${encodeURIComponent(selectedAgent)}&agent_exact=true&customer=${encodeURIComponent(selectedCustomerName)}&sort=calls&dir=desc`
      : null,
    fetcher,
  );
  const selectedPairFallback = (() => {
    const rows = (selectedPairRows ?? []) as any[];
    if (!rows.length) return null;
    const exact = rows.filter(r => norm(r?.customer) === norm(selectedCustomerName));
    const pool = exact.length ? exact : rows;
    return [...pool].sort((a, b) => Number(b?.call_count || 0) - Number(a?.call_count || 0))[0] ?? null;
  })();
  const selectedPairMeta = selectedCustomer
    ? {
        crm_url: selectedCustomer.crm_url,
        account_id: selectedCustomer.account_id,
        customer: selectedCustomer.customer,
      }
    : selectedPairFallback
      ? {
          crm_url: selectedPairFallback.crm_url,
          account_id: selectedPairFallback.account_id,
          customer: selectedPairFallback.customer,
        }
      : null;

  // Fast path: local DB — instant, no live CRM needed
  const { data: dbCalls } = useSWR<CRMCall[]>(
    selectedAgent && selectedCustomerName
      ? `/api/crm/calls-by-pair?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomerName)}`
      : null,
    fetcher,
  );

  // Slow path: live CRM / calls.json — only triggered when DB returns empty
  const needsCrmFetch = dbCalls !== undefined && dbCalls.length === 0 && !!selectedPairMeta;
  const { data: crmCalls } = useSWR<CRMCall[]>(
    needsCrmFetch
      ? `/api/crm/calls/${selectedPairMeta!.account_id}?crm_url=${encodeURIComponent(selectedPairMeta!.crm_url)}&agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomerName)}`
      : null,
    (url: string) => fetch(url, { signal: AbortSignal.timeout(60000) }).then(r => r.json()),
  );

  // Merge: DB calls are the primary source; live CRM fills any gaps
  const rawCrmCalls: CRMCall[] = (() => {
    if (dbCalls && dbCalls.length > 0) return dbCalls;
    if (Array.isArray(crmCalls)) return crmCalls;
    return [];
  })();

  const { data: txCalls, mutate: mutateTx } = useSWR<TxCall[]>(
    selectedAgent && selectedCustomerName
      ? `/api/final-transcript/calls?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomerName)}`
      : null,
    fetcher
  );

  // Fetch all notes for this agent/customer pair to know which calls have notes
  const { data: pairNotes } = useSWR<{ call_id: string }[]>(
    selectedAgent && selectedCustomerName
      ? `/api/notes?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomerName)}`
      : null,
    fetcher,
    { refreshInterval: 15000 }
  );
  const notesCallIds = new Set((pairNotes ?? []).map(n => n.call_id));

  // Build transcription status map: call_id → TxCall
  const txMap = new Map<string, TxCall>();
  txCalls?.forEach(t => txMap.set(t.call_id, t));

  // Merge: rawCrmCalls + any tx-only calls not in the CRM list
  const crmCallSet = new Set(rawCrmCalls.map(c => c.call_id));
  const txOnlyCalls = (txCalls ?? []).filter(tx => !crmCallSet.has(tx.call_id));

  const calls = [
    ...rawCrmCalls.map(c => ({ ...c, tx: txMap.get(c.call_id) ?? null })),
    ...txOnlyCalls.map(tx => ({
      call_id:     tx.call_id,
      date:        tx.started_at ?? "",
      duration:    tx.duration_s ?? 0,
      record_path: "",
      tx,
    })),
  ];

  const selectedCallData = calls.find(c => c.call_id === selectedCallId) ?? null;
  const selectedTx = selectedCallData?.tx ?? null;

  // Calls with transcripts in chronological order — matches the "Call N" numbering in merged transcripts
  const transcribedCallsInOrder = calls
    .filter(c => c.tx?.has_llm_smoothed || c.tx?.has_llm_voted || c.tx?.has_pipeline_final)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // Open a call's transcript in the citation modal
  async function openCitation(callN: number) {
    const call = transcribedCallsInOrder[callN - 1];
    if (!call?.tx) return;
    const path = call.tx.smoothed_path || call.tx.voted_path;
    if (!path) return;
    setCitationCallId(call.call_id);
    setCitationTranscript("");
    setCitationLoading(true);
    try {
      const text = await fetch(`/api/final-transcript/content?path=${encodeURIComponent(path)}`).then(r => r.text());
      setCitationTranscript(text);
    } catch {
      setCitationTranscript("Error loading transcript.");
    } finally {
      setCitationLoading(false);
    }
  }

  // Close citation modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setCitationCallId(null); }
    if (citationCallId) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [citationCallId]);

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
    if (!selectedCallData || !selectedPairMeta) return;
    setTranscribing(true);
    setTranscribeError("");
    try {
      const res = await fetch("/api/transcription/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crm_url:     selectedPairMeta.crm_url,
          account_id:  selectedPairMeta.account_id,
          agent:       selectedAgent,
          customer:    selectedPairMeta.customer,
          call_id:     selectedCallData.call_id,
          record_path: selectedCallData.record_path,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e: any) {
      setTranscribeError(e.message ?? "Failed to start transcription");
      void logClientExecutionEvent({
        action: "calls_single_transcription_failed",
        status: "failed",
        level: "error",
        message: "Single-call transcription request failed in UI",
        context: {
          agent: selectedAgent,
          customer: selectedCustomerName,
          call_id: selectedCallData?.call_id || "",
        },
        error: String(e?.message || e || ""),
        finish: true,
      });
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

  function selectAll() {
    setCheckedCallIds(new Set(calls.map(c => c.call_id)));
  }

  function selectUntranscribed() {
    const ids = calls
      .filter(c => !c.tx?.has_llm_smoothed && !c.tx?.has_llm_voted && !c.tx?.has_pipeline_final)
      .map(c => c.call_id);
    setCheckedCallIds(new Set(ids));
  }

  async function handleBatchTranscribe() {
    if (checkedCallIds.size === 0) return;
    // Prefer selected pair metadata; fall back to DB call metadata
    const crmUrl    = selectedPairMeta?.crm_url    ?? dbCalls?.[0]?.crm_url    ?? "";
    const accountId = selectedPairMeta?.account_id ?? dbCalls?.[0]?.account_id ?? "";
    if (!crmUrl || !accountId || !selectedAgent || !selectedCustomerName) {
      setBatchError("Missing CRM info — sync this pair from the CRM browser first");
      return;
    }
    setBatchTranscribing(true);
    setBatchError("");
    try {
      const res = await fetch("/api/transcription/batch-for-pairs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: [{
            crm_url: crmUrl,
            account_id: accountId,
            agent: selectedAgent,
            customer: selectedCustomerName,
            call_ids: [...checkedCallIds],
          }],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCheckedCallIds(new Set());
      mutateTx();
    } catch (e: any) {
      setBatchError(e.message ?? "Failed to queue transcriptions");
      void logClientExecutionEvent({
        action: "calls_batch_transcription_failed",
        status: "failed",
        level: "error",
        message: "Batch transcription request failed in UI",
        context: {
          agent: selectedAgent,
          customer: selectedCustomerName,
          selected_calls: checkedCallIds.size,
        },
        error: String(e?.message || e || ""),
        finish: true,
      });
    } finally {
      setBatchTranscribing(false);
    }
  }

  const hasPairContext = !!(selectedAgent && selectedCustomerName);
  useEffect(() => {
    setCheckedCallIds(new Set());
    setBatchError("");
  }, [selectedAgent, selectedCustomerName]);

  return (
    <div className="h-[calc(100vh-5.25rem)] flex">

      {/* Panel 1 — Calls */}
      <CollapsiblePanel title="Calls" width={callsW} collapsed={callsCollapsed} onToggle={() => setCallsCollapsed(c => !c)}>
        <div className="px-3 py-2 border-b border-gray-800 shrink-0 space-y-1.5">
          {hasPairContext ? (
            <p className="text-[10px] text-gray-600 truncate">{selectedAgent} · {selectedCustomerName}</p>
          ) : (
            <p className="text-[10px] text-gray-600">Select agent + customer in the top context bar</p>
          )}
          {calls.length > 0 && (
            <p className="text-[10px] text-gray-500">
              {calls.length} calls · {calls.filter(c => c.tx?.has_llm_smoothed || c.tx?.has_llm_voted).length} transcribed
            </p>
          )}
          {calls.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={checkedCallIds.size === calls.length ? () => setCheckedCallIds(new Set()) : selectAll}
                className="text-[10px] text-gray-500 hover:text-gray-300 underline transition-colors"
              >
                {checkedCallIds.size === calls.length ? "Deselect all" : "Select all"}
              </button>
              {calls.some(c => !c.tx?.has_llm_smoothed && !c.tx?.has_llm_voted && !c.tx?.has_pipeline_final) && (
                <button
                  onClick={selectUntranscribed}
                  className="text-[10px] text-gray-500 hover:text-gray-300 underline transition-colors"
                >
                  Select untranscribed
                </button>
              )}
              {checkedCallIds.size > 0 && (
                <>
                  <span className="text-[10px] text-gray-700">·</span>
                  <span className="text-[10px] text-gray-600">{checkedCallIds.size} selected</span>
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
          {!hasPairContext && (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-gray-600">Select agent + customer in the top context bar</p>
            </div>
          )}
          {hasPairContext && !selectedPairMeta && !txCalls && (
            <div className="flex flex-col items-center gap-2 p-4 text-xs text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </div>
          )}
          {hasPairContext && !selectedPairMeta && txCalls && txOnlyCalls.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-4 text-xs text-gray-500">
              <span>Customer not found for selected agent.</span>
            </div>
          )}
          {hasPairContext && !dbCalls && txOnlyCalls.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-4 text-xs text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading calls…</span>
            </div>
          )}
          {hasPairContext && needsCrmFetch && !crmCalls && txOnlyCalls.length === 0 && dbCalls?.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-4 text-xs text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Fetching from CRM…</span>
              <span className="text-gray-700 text-[10px]">First load may take up to 60s</span>
            </div>
          )}
          {hasPairContext && calls.map(call => {
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
          {hasPairContext && calls.length === 0 && (crmCalls !== undefined || txCalls !== undefined) && (
            <p className="text-xs text-gray-600 p-4 text-center">No calls found</p>
          )}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={callsDrag} />

      {/* Panel 4 — Transcript viewer + optional Notes panel */}
      <CallCitationProvider onCitation={openCitation}>
        <div className="flex-1 min-w-0 flex">
          {/* Transcript */}
          <div className={cn(
            "bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col",
            showTranscript ? "flex-1 min-w-0" : "shrink-0 w-auto"
          )}>
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
              <FileText className="w-3.5 h-3.5 text-teal-400" />
              <span className="text-xs font-semibold text-white flex-1">
                {selectedCallId ? selectedCallId : "Transcript"}
              </span>
              {selectedCallData && showTranscript && (
                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                  {selectedCallData.duration > 0 && <span className="text-teal-400">{formatDuration(selectedCallData.duration)}</span>}
                  {selectedCallData.date && <span>{formatDate(selectedCallData.date)}</span>}
                </div>
              )}
              {selectedCallId && (
                <button
                  onClick={() => setShowTranscript(s => !s)}
                  className="text-gray-600 hover:text-gray-400 transition-colors shrink-0"
                  title={showTranscript ? "Hide transcript" : "Show transcript"}
                >
                  {showTranscript ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>

            {showTranscript && (
              <>
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
              </>
            )}
          </div>

          {/* Agent / Pipeline side panel */}
          <>
            <DragHandle onMouseDown={notesDrag} />
            <div className={cn(
              "bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col",
              showTranscript ? "shrink-0" : "flex-1"
            )} style={showTranscript ? { width: notesW } : {}}>
              {/* Tab toggle — show when at least one option is active */}
              {(ctx.activeAgentId || ctx.activePipelineId) && (
                <div className="flex border-b border-gray-800 shrink-0">
                  {ctx.activeAgentId && (
                    <button
                      key="agent"
                      onClick={() => setSidePanel("agent")}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
                        sidePanel === "agent"
                          ? "bg-violet-900/30 text-violet-300 border-b-2 border-violet-500"
                          : "text-gray-500 hover:text-white hover:bg-gray-800/60",
                      )}
                    >
                      Agent
                    </button>
                  )}
                  {ctx.activePipelineId && (
                    <button
                      key="pipeline"
                      onClick={() => setSidePanel("pipeline")}
                      className={cn(
                        "flex-1 py-1.5 text-[10px] font-medium uppercase tracking-wide transition-colors",
                        sidePanel === "pipeline"
                          ? "bg-teal-900/30 text-teal-300 border-b-2 border-teal-500"
                          : "text-gray-500 hover:text-white hover:bg-gray-800/60",
                      )}
                    >
                      Pipeline
                    </button>
                  )}
                </div>
              )}
              {/* Panel content — auto-fallback to pipeline if no agent set */}
              {(ctx.activePipelineId && (sidePanel === "pipeline" || !ctx.activeAgentId))
                ? <PipelineSidePanel
                    showTranscript={showTranscript}
                    onToggleTranscript={() => setShowTranscript(s => !s)}
                    selectedCallIds={checkedCallIds.size > 0 ? [...checkedCallIds] : undefined}
                  />
                : <AgentSidePanel />}
            </div>
          </>
        </div>
      </CallCitationProvider>

      {/* Citation modal — pops up when user clicks a "Call N" citation link */}
      {citationCallId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setCitationCallId(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl w-[min(90vw,800px)] h-[min(85vh,700px)] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-teal-400" />
                <span className="text-xs font-semibold text-white">{citationCallId}</span>
                {citationLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-500" />}
              </div>
              <button
                onClick={() => setCitationCallId(null)}
                className="text-gray-600 hover:text-white transition-colors p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-4 overflow-auto">
              {citationLoading ? (
                <div className="flex items-center justify-center h-full gap-2 text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-xs">Loading transcript…</span>
                </div>
              ) : (
                <div className="h-full bg-gray-950 border border-gray-800 rounded-lg p-3 overflow-auto">
                  <TranscriptViewer content={citationTranscript} format="txt" className="h-full" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
