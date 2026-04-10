"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  Folder, Users, Search, ChevronRight, Loader2,
  Mic2, FileCheck, Sparkles, Wand2, FileText,
} from "lucide-react";
import { cn, formatDuration, formatDate } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";

const API = "/api";
const fetcher = (url: string) => fetch(url).then(r => r.json());

interface CallInfo {
  call_id: string;
  pair_slug: string;
  has_pipeline_final: boolean;
  has_llm_voted: boolean;
  has_llm_smoothed: boolean;
  voted_at: string | null;
  smoothed_at: string | null;
  duration_s: number | null;
  started_at: string | null;
  source_count: number;
  voted_path: string | null;
  smoothed_path: string | null;
  pipeline_final_files: { name: string; path: string }[];
}

interface TranscriptSource {
  source: string;
  source_label: string;
  label: string;
  format: string;
  path: string;
}

export default function TranscriptionPage() {
  const [agentW, agentDrag]       = useResize(160, 120, 380);
  const [customerW, customerDrag] = useResize(160, 120, 380);
  const [callsW, callsDrag]       = useResize(256, 180, 420);

  const [agentsCollapsed, setAgentsCollapsed]     = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);
  const [callsCollapsed, setCallsCollapsed]       = useState(false);

  const [selectedAgent, setSelectedAgent]     = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [selectedCallId, setSelectedCallId]   = useState("");
  const [agentSearch, setAgentSearch]         = useState("");
  const [customerSearch, setCustomerSearch]   = useState("");

  const [transcriptContent, setTranscriptContent]   = useState("");
  const [transcriptFormat, setTranscriptFormat]     = useState("");
  const [transcriptSourceType, setTranscriptSourceType] = useState("");
  const [loadingTranscript, setLoadingTranscript]   = useState(false);

  // Fetch pairs (agent/customer list)
  const { data: pairs } = useSWR<{ agent: string; customers: string[] }[]>(
    `${API}/final-transcript/pairs`, fetcher
  );
  const agents = pairs ? pairs.map(p => p.agent) : [];
  const customers = pairs && selectedAgent
    ? (pairs.find(p => p.agent === selectedAgent)?.customers ?? [])
    : [];

  const filteredAgents    = agents.filter(a => a.toLowerCase().includes(agentSearch.toLowerCase()));
  const filteredCustomers = customers.filter(c => c.toLowerCase().includes(customerSearch.toLowerCase()));

  // Fetch calls for selected agent/customer
  const callsKey = selectedAgent
    ? `${API}/final-transcript/calls?agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer)}`
    : null;
  const { data: calls } = useSWR<CallInfo[]>(callsKey, fetcher);

  const selectedCall = calls?.find(c => c.call_id === selectedCallId) ?? null;

  // Load best transcript when call is selected
  useEffect(() => {
    if (!selectedCallId) { setTranscriptContent(""); setTranscriptSourceType(""); return; }
    setLoadingTranscript(true);
    setTranscriptContent("");
    setTranscriptSourceType("");
    fetch(`${API}/audio/transcripts/${selectedCallId}`)
      .then(r => r.json())
      .then(async (sources: TranscriptSource[]) => {
        const priority = ["llm_final", "final", "merged", "full"];
        let best: TranscriptSource | null = null;
        for (const src of priority) {
          best = sources.find(s => s.source === src) ?? null;
          if (best) break;
        }
        if (!best) best = sources[0] ?? null;
        if (!best) { setTranscriptContent("No transcript available."); return; }
        setTranscriptFormat(best.format);
        setTranscriptSourceType(best.source_label || best.source);
        const res = await fetch(`${API}/final-transcript/content?path=${encodeURIComponent(best.path)}`);
        const text = await res.text();
        setTranscriptContent(text);
      })
      .catch(() => setTranscriptContent("Error loading transcript."))
      .finally(() => setLoadingTranscript(false));
  }, [selectedCallId]);

  return (
    <div className="h-[calc(100vh-3rem)] flex">

      {/* Panel 1: Agents */}
      <CollapsiblePanel title="Agents" width={agentW} collapsed={agentsCollapsed} onToggle={() => setAgentsCollapsed(c => !c)}>
        <div className="px-3 py-2.5 border-b border-gray-800">
          <h2 className="text-xs font-semibold text-white flex items-center gap-1.5">
            <Folder className="w-3.5 h-3.5 text-teal-400" /> Agents
          </h2>
        </div>
        <div className="px-2 py-1.5 border-b border-gray-800/60">
          <div className="flex items-center gap-1.5 bg-gray-800 rounded-md px-2 py-1">
            <Search className="w-3 h-3 text-gray-600 shrink-0" />
            <input value={agentSearch} onChange={e => setAgentSearch(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-[11px] text-gray-300 placeholder-gray-600 outline-none min-w-0" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {agents.length === 0 && <p className="text-xs text-gray-600 p-2 text-center">No agents</p>}
          {filteredAgents.map(agent => {
            const customerCount = pairs?.find(p => p.agent === agent)?.customers.length ?? 0;
            return (
              <button key={agent} onClick={() => {
                if (selectedAgent === agent) { setSelectedAgent(""); setSelectedCustomer(""); }
                else { setSelectedAgent(agent); setSelectedCustomer(""); setSelectedCallId(""); }
              }}
                className={`w-full text-left px-2 py-2 rounded-lg text-xs transition-colors ${
                  selectedAgent === agent
                    ? "bg-teal-500/10 border border-teal-500/20 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Users className="w-3 h-3 text-teal-400 shrink-0" />
                  <span className="font-medium truncate">{agent}</span>
                </div>
                <p className="text-gray-600 pl-[18px] text-[10px]">{customerCount} customer{customerCount !== 1 ? "s" : ""}</p>
              </button>
            );
          })}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={agentDrag} />

      {/* Panel 2: Customers */}
      <CollapsiblePanel title="Customers" width={customerW} collapsed={customersCollapsed} onToggle={() => setCustomersCollapsed(c => !c)}>
        {!selectedAgent ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-600">Select an agent</p>
          </div>
        ) : (
          <>
            <div className="px-3 py-2.5 border-b border-gray-800">
              <h2 className="text-xs font-semibold text-white truncate">{selectedAgent}</h2>
              <p className="text-[10px] text-gray-600 mt-0.5">{customers.length} customer{customers.length !== 1 ? "s" : ""}</p>
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
              <button onClick={() => { setSelectedCustomer(""); setSelectedCallId(""); }}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors ${
                  selectedCustomer === "" ? "bg-teal-500/10 border border-teal-500/20 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}>All customers</button>
              {filteredCustomers.map(cust => (
                <button key={cust} onClick={() => {
                  if (selectedCustomer === cust) { setSelectedCustomer(""); setSelectedCallId(""); }
                  else { setSelectedCustomer(cust); setSelectedCallId(""); }
                }}
                  className={`w-full text-left px-2 py-2 rounded-lg text-xs transition-colors ${
                    selectedCustomer === cust ? "bg-teal-500/10 border border-teal-500/20 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
                  }`}>
                  <span className="font-medium truncate block">{cust}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </CollapsiblePanel>

      <DragHandle onMouseDown={customerDrag} />

      {/* Panel 3: Call list */}
      <CollapsiblePanel title="Calls" width={callsW} collapsed={callsCollapsed} onToggle={() => setCallsCollapsed(c => !c)}>
        <div className="px-3 py-2.5 border-b border-gray-800">
          {calls && <span className="text-[10px] text-gray-600">{calls.length} calls</span>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!selectedAgent && (
            <div className="flex items-center justify-center h-full">
              <p className="text-xs text-gray-600">Select an agent</p>
            </div>
          )}
          {selectedAgent && !calls && (
            <div className="flex items-center gap-2 p-4 text-xs text-gray-500">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
            </div>
          )}
          {calls?.map(call => (
            <button key={call.call_id} onClick={() => setSelectedCallId(prev => prev === call.call_id ? "" : call.call_id)}
              className={cn("w-full text-left px-3 py-2.5 border-b border-gray-800/60 hover:bg-gray-800/40 transition-colors",
                selectedCallId === call.call_id && "bg-teal-500/5 border-l-2 border-l-teal-500"
              )}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <ChevronRight className={cn("w-3 h-3 shrink-0", selectedCallId === call.call_id ? "text-teal-400" : "text-gray-700")} />
                <span className="text-xs font-mono font-medium text-gray-200 truncate">{call.call_id}</span>
              </div>
              {(call.duration_s || call.started_at) && (
                <p className="text-[9px] text-gray-500 pl-4 mb-1">
                  {call.duration_s ? formatDuration(call.duration_s) : ""}
                  {call.duration_s && call.started_at ? " · " : ""}
                  {call.started_at ? formatDate(call.started_at) : ""}
                </p>
              )}
              <div className="flex flex-wrap gap-1 pl-4">
                {call.has_pipeline_final && <span className="text-[9px] px-1 py-0.5 bg-blue-900/40 text-blue-400 border border-blue-800/50 rounded">Pipeline</span>}
                {call.has_llm_voted && <span className="text-[9px] px-1 py-0.5 bg-teal-900/40 text-teal-400 border border-teal-800/50 rounded flex items-center gap-0.5"><Sparkles className="w-2 h-2" /> Voted</span>}
                {call.has_llm_smoothed && <span className="text-[9px] px-1 py-0.5 bg-purple-900/40 text-purple-400 border border-purple-800/50 rounded flex items-center gap-0.5"><Wand2 className="w-2 h-2" /> Smoothed</span>}
                {!call.has_pipeline_final && !call.has_llm_voted && !call.has_llm_smoothed && (
                  <span className="text-[9px] text-gray-700">{call.source_count} source{call.source_count !== 1 ? "s" : ""}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={callsDrag} />

      {/* Panel 4: Transcript viewer */}
      <div className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
        {/* Action header */}
        <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
          <FileText className="w-3.5 h-3.5 text-teal-400" />
          <span className="text-xs font-semibold text-white flex-1">Transcription</span>
          <Link href="/transcription/create"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600/80 hover:bg-yellow-500 text-white text-xs font-medium rounded-lg transition-colors">
            <Mic2 className="w-3 h-3" /> Create
          </Link>
          <Link href="/transcription/final"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-700 hover:bg-teal-600 text-white text-xs font-medium rounded-lg transition-colors">
            <FileCheck className="w-3 h-3" /> Finalize
          </Link>
        </div>

        {!selectedCall ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 gap-3">
            <FileText className="w-12 h-12 opacity-20" />
            <p className="text-sm">Select a call to view its transcript</p>
            <div className="flex gap-3 mt-2">
              <Link href="/transcription/create"
                className="flex items-center gap-2 px-4 py-2 bg-yellow-600/80 hover:bg-yellow-500 text-white text-sm font-medium rounded-lg transition-colors">
                <Mic2 className="w-4 h-4" /> Create Transcript
              </Link>
              <Link href="/transcription/final"
                className="flex items-center gap-2 px-4 py-2 bg-teal-700 hover:bg-teal-600 text-white text-sm font-medium rounded-lg transition-colors">
                <FileCheck className="w-4 h-4" /> Finalize
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col p-4">
            {/* Metadata box */}
            <div className="mb-3 shrink-0 bg-gray-800/50 border border-gray-700/60 rounded-lg px-3 py-2.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-xs font-semibold text-white">{selectedAgent.replace(/_/g, " ")}</span>
                    {selectedCustomer && (
                      <>
                        <span className="text-gray-600 text-xs">→</span>
                        <span className="text-xs text-teal-300">{selectedCustomer.replace(/_/g, " ")}</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-[10px] font-mono text-gray-400">{selectedCall.call_id}</span>
                    {selectedCall.started_at && (
                      <span className="text-[10px] text-gray-500">{formatDate(selectedCall.started_at)}</span>
                    )}
                    {selectedCall.duration_s && (
                      <span className="text-[10px] text-teal-400">{formatDuration(selectedCall.duration_s)}</span>
                    )}
                  </div>
                </div>
                {transcriptSourceType && (
                  <span className="text-[9px] px-2 py-0.5 rounded-full border border-gray-600 text-gray-400 bg-gray-700/50 font-medium shrink-0">
                    {transcriptSourceType}
                  </span>
                )}
              </div>
            </div>
            {loadingTranscript ? (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading transcript…
              </div>
            ) : transcriptContent ? (
              <div className="flex-1 min-h-0 bg-gray-950 border border-gray-800 rounded-lg p-3 overflow-auto">
                <TranscriptViewer content={transcriptContent} format={transcriptFormat} className="h-full" />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center flex-1 text-gray-600 gap-2">
                <p className="text-sm">No transcript yet</p>
                <Link href="/transcription/create"
                  className="text-xs text-teal-400 hover:text-teal-300">Run transcription →</Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
