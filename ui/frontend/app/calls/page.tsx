"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import {
  Users, Search, Loader2, FileText, CheckCircle2,
  Circle, ChevronRight, Mic2,
} from "lucide-react";
import { cn, formatDuration, formatDate } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";
import { DragHandle } from "@/components/shared/DragHandle";
import { useResize } from "@/lib/useResize";

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface Agent    { agent: string; count: number; }
interface Customer { customer: string; account_id: string; crm_url: string; call_count: number; }
interface CRMCall  { call_id: string; date: string; duration: number; record_path: string; }
interface TxCall   {
  call_id: string; pair_slug: string;
  has_llm_smoothed: boolean; has_llm_voted: boolean; has_pipeline_final: boolean;
  smoothed_path: string | null; voted_path: string | null;
  duration_s: number | null; started_at: string | null;
}

export default function CallsPage() {
  const [agentW, agentDrag]       = useResize(180, 120, 360);
  const [customerW, customerDrag] = useResize(180, 120, 360);
  const [callsW, callsDrag]       = useResize(280, 180, 440);

  const [agentsCollapsed, setAgentsCollapsed]     = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);
  const [callsCollapsed, setCallsCollapsed]       = useState(false);

  const [selectedAgent, setSelectedAgent]       = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedCallId, setSelectedCallId]     = useState("");
  const [agentSearch, setAgentSearch]           = useState("");
  const [customerSearch, setCustomerSearch]     = useState("");

  const [transcript, setTranscript]             = useState("");
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcribing, setTranscribing]         = useState(false);
  const [transcribeError, setTranscribeError]   = useState("");

  // ── Data fetching ─────────────────────────────────────────────────────────
  const { data: agents } = useSWR<Agent[]>("/api/crm/nav/agents", fetcher);

  const { data: customers } = useSWR<Customer[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null,
    fetcher
  );

  const { data: crmCalls } = useSWR<CRMCall[]>(
    selectedCustomer
      ? `/api/crm/calls/${selectedCustomer.account_id}?crm_url=${encodeURIComponent(selectedCustomer.crm_url)}&agent=${encodeURIComponent(selectedAgent)}`
      : null,
    fetcher
  );

  const { data: txCalls, mutate: mutateTx } = useSWR<TxCall[]>(
    selectedAgent && selectedCustomer
      ? `/api/final-transcript/calls?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer.customer)}`
      : null,
    fetcher
  );

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

  // ── Filtered lists ────────────────────────────────────────────────────────
  const filteredAgents    = (agents ?? []).filter(a => a.agent.toLowerCase().includes(agentSearch.toLowerCase()));
  const filteredCustomers = (customers ?? []).filter(c => c.customer.toLowerCase().includes(customerSearch.toLowerCase()));

  return (
    <div className="h-[calc(100vh-3rem)] flex">

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
              else { setSelectedAgent(a.agent); setSelectedCustomer(null); setSelectedCallId(""); }
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
        <div className="px-3 py-2 border-b border-gray-800 shrink-0">
          {calls.length > 0 && (
            <p className="text-[10px] text-gray-500">
              {calls.length} calls · {calls.filter(c => c.tx?.has_llm_smoothed || c.tx?.has_llm_voted).length} transcribed
            </p>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!selectedCustomer && (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-gray-600">Select a customer</p>
            </div>
          )}
          {selectedCustomer && !crmCalls && (
            <div className="flex items-center gap-2 p-4 text-xs text-gray-500">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading calls…
            </div>
          )}
          {calls.map(call => {
            const hasTranscript = call.tx?.has_llm_smoothed || call.tx?.has_llm_voted || call.tx?.has_pipeline_final;
            const isSelected = selectedCallId === call.call_id;
            return (
              <button key={call.call_id} onClick={() => setSelectedCallId(p => p === call.call_id ? "" : call.call_id)}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors",
                  isSelected && "bg-teal-500/5 border-l-2 border-l-teal-500"
                )}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <ChevronRight className={cn("w-3 h-3 shrink-0", isSelected ? "text-teal-400" : "text-gray-700")} />
                  <span className="text-xs font-mono font-medium text-gray-200 truncate">{call.call_id}</span>
                  <span className="ml-auto shrink-0">
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
            );
          })}
          {selectedCustomer && crmCalls?.length === 0 && (
            <p className="text-xs text-gray-600 p-4 text-center">No calls found</p>
          )}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={callsDrag} />

      {/* Panel 4 — Transcript viewer */}
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
    </div>
  );
}
