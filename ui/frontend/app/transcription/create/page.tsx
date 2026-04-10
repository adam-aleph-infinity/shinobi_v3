"use client";
export const dynamic = "force-dynamic";
import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import {
  FileText, Users, Folder, ChevronRight, Loader2, RefreshCw,
  Mic2, CheckSquare, Square, GitMerge, Sparkles, CheckCircle2,
  XCircle, Search, Zap, Settings2,
} from "lucide-react";
import { formatDate, formatDuration, fmtBytes } from "@/lib/utils";
import { TranscriptContent } from "@/components/shared/TranscriptViewer";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";

const API = "/api";

const ALL_ENGINES = [
  { id: "elevenlabs_original",  label: "EL Original",   group: "ElevenLabs" },
  { id: "elevenlabs_enhanced",  label: "EL Enhanced",   group: "ElevenLabs" },
  { id: "elevenlabs_converted", label: "EL Converted",  group: "ElevenLabs" },
  { id: "openai_gpt4o",         label: "OpenAI GPT-4o", group: "OpenAI" },
  { id: "openai_diarize",       label: "OpenAI Diarize",group: "OpenAI" },
  { id: "gemini",               label: "Gemini",        group: "Other" },
  { id: "mlx_whisper",          label: "Whisper",       group: "Other" },
];

const STAGE_LABELS: Record<number, string> = {
  0: "Queued", 1: "Processing", 2: "Transcribing", 4: "Voting", 5: "Finalizing",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Pair {
  slug: string; agent: string; customer: string; crm: string;
  audio_count: number; total_size_bytes: number;
}

interface VariantFile {
  name: string;   // "original" | "enhanced" | "converted" | …
  path: string;
  size_bytes: number;
}
interface CallEntry {
  call_id: string; date: string; duration_s: number | null;
  downloaded: boolean; status: "raw" | "enhanced" | "transcribed" | null;
  size_bytes: number | null; path: string | null;
  variant_files: VariantFile[];
}

interface PairCallsResult {
  calls: CallEntry[]; has_metadata: boolean;
  crm_url: string; account_id: string; agent: string; customer: string;
}

interface TranscriptEntry {
  batch: string; job_id: string;
  source: string; source_label: string;
  label: string; type: string;
  engine: string | null; audio_type: string | null;
  format: string; path: string;
}

interface JobProgress {
  job_id: string; stage: number; pct: number;
  message: string; status: "pending" | "running" | "complete" | "failed";
}

interface ProcessResult {
  ok: boolean; word_count: number; used_llm: boolean;
  output: { voted_words?: string; final_srt?: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SOURCE_ORDER = ["final", "full", "merged", "speaker_0", "speaker_1"];
const SOURCE_LABELS: Record<string, string> = {
  final: "Final", full: "Full Audio", merged: "Merged",
  speaker_0: "Speaker 0", speaker_1: "Speaker 1",
};
const AUDIO_TYPE_COLORS: Record<string, string> = {
  original: "text-gray-500", enhanced: "text-emerald-500", converted: "text-blue-500",
};

function StatusDot({ status }: { status: string | null }) {
  const cfg: Record<string, { dot: string; label: string }> = {
    transcribed: { dot: "bg-yellow-400", label: "Transcribed" },
    enhanced:    { dot: "bg-blue-400",   label: "Enhanced" },
    raw:         { dot: "bg-gray-500",   label: "Downloaded" },
  };
  if (!status) return <span className="text-xs text-gray-600">—</span>;
  const c = cfg[status] || cfg.raw;
  return (
    <span className="flex items-center gap-1.5 text-xs text-gray-400">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
      {c.label}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TranscriptionPage() {
  // Resizable panels
  const [agentW, agentDrag]    = useResize(160, 120, 380);
  const [customerW, customerDrag] = useResize(160, 120, 380);
  const [rightW, rightDrag]    = useResize(520, 280, 700, "left");

  const [agentsCollapsed, setAgentsCollapsed] = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);

  // Nav
  const [selectedAgent, setSelectedAgent]   = useState<string | null>(null);
  const [selectedPair, setSelectedPair]     = useState<Pair | null>(null);
  const [agentSearch, setAgentSearch]       = useState("");
  const [customerSearch, setCustomerSearch] = useState("");

  // Call + transcript selection
  const [selectedCall, setSelectedCall]           = useState<CallEntry | null>(null);
  const [expandedSources, setExpandedSources]     = useState<Set<string>>(new Set(["final"]));
  const [selectedTranscript, setSelectedTranscript] = useState<TranscriptEntry | null>(null);
  const [statusFilter, setStatusFilter]           = useState<"all" | "transcribed" | "enhanced" | "raw">("all");

  // Transcription mode — txSelected = Set of audio file paths
  const [txMode, setTxMode]                         = useState(false);
  const [txSelected, setTxSelected]                 = useState<Set<string>>(new Set()); // audio paths
  const [expandedTxCalls, setExpandedTxCalls]       = useState<Set<string>>(new Set()); // unused, kept for compat
  const [selectedEngines, setSelectedEngines]       = useState<Set<string>>(new Set(ALL_ENGINES.map(e => e.id)));
  const [speakerA, setSpeakerA]                     = useState("");
  const [speakerB, setSpeakerB]                     = useState("");
  const [txRunning, setTxRunning]                   = useState(false);
  const [txResult, setTxResult]                     = useState<{ success: number; failed: number } | null>(null);

  // Vote mode
  const [voteMode, setVoteMode]         = useState(false);
  const [voteSelected, setVoteSelected] = useState<Set<string>>(new Set());
  const [voteProcessing, setVoteProcessing] = useState(false);
  const [voteResult, setVoteResult]     = useState<ProcessResult | null>(null);
  const [voteError, setVoteError]       = useState<string | null>(null);

  // Per-variant job progress
  const [activeJobs, setActiveJobs] = useState<Record<string, JobProgress>>({});
  const eventSourcesRef             = useRef<Record<string, EventSource>>({});
  const pendingCallIdRef            = useRef<string | null>(null);
  // Global log stream (all pipeline stdout, same source as /logs page)
  const [globalLogs, setGlobalLogs] = useState<Array<{ ts: string; text: string; level: string }>>([]);
  const logEndRef                   = useRef<HTMLDivElement>(null);

  const router        = useRouter();
  const searchParams  = useSearchParams();

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: pairs, isLoading: loadingPairs } = useSWR<Pair[]>(
    "/audio-pairs",
    () => fetch(`${API}/audio/pairs`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const { data: callsData, isLoading: loadingCalls, mutate: mutateCalls } = useSWR<PairCallsResult>(
    selectedPair ? `/audio-calls-${selectedPair.slug}` : null,
    () => fetch(`${API}/audio/calls?slug=${encodeURIComponent(selectedPair!.slug)}`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const { data: transcripts, isLoading: loadingTranscripts, mutate: mutateTranscripts } = useSWR<TranscriptEntry[]>(
    selectedCall ? `/audio-transcripts-${selectedCall.call_id}` : null,
    () => fetch(`${API}/audio/transcripts/${selectedCall!.call_id}`).then(r => r.json()),
    {
      revalidateOnFocus: true,
      onSuccess: (data) => {
        const first = data?.find(t => t.type === "final_srt") || data?.[0];
        if (first) setSelectedTranscript(first);
      },
    },
  );

  const { data: transcriptContent, isLoading: loadingContent } = useSWR<{ content: string; format: string }>(
    selectedTranscript ? `/transcript-content-${selectedTranscript.path}` : null,
    () => fetch(`${API}/audio/transcript-content?path=${encodeURIComponent(selectedTranscript!.path)}`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  // ── Job stream management ──────────────────────────────────────────────────

  // Jobs are keyed by audio_path so each variant is tracked independently
  const connectJobStream = (job_id: string, audio_path: string) => {
    if (eventSourcesRef.current[job_id]) return;
    const es = new EventSource(`${API}/jobs/${job_id}/stream`);
    eventSourcesRef.current[job_id] = es;
    es.onmessage = (e) => {
      if (!e.data || e.data === "{}") return;
      try {
        const ev = JSON.parse(e.data);
        if (ev.heartbeat) return;
        const done = ev.done === true;
        setActiveJobs(prev => ({
          ...prev,
          [audio_path]: {
            job_id,
            stage:   ev.stage   ?? prev[audio_path]?.stage   ?? 0,
            pct:     ev.pct     ?? prev[audio_path]?.pct     ?? 0,
            message: ev.message ?? prev[audio_path]?.message ?? "",
            status:  done ? (ev.error ? "failed" : "complete") : "running",
          },
        }));
        if (done) {
          es.close();
          delete eventSourcesRef.current[job_id];
          mutateCalls();
          if (selectedCall) mutateTranscripts();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); delete eventSourcesRef.current[job_id]; };
  };

  // Restore active jobs on pair load (job.audio_path is the key)
  useEffect(() => {
    if (!selectedPair) return;
    fetch(`${API}/jobs?pair_slug=${encodeURIComponent(selectedPair.slug)}`)
      .then(r => r.json())
      .then((jobs: Array<{ id: string; audio_path: string; call_id: string; stage: number; pct: number; message: string; status: string }>) => {
        for (const job of jobs) {
          if (job.status === "running" || job.status === "pending") {
            setActiveJobs(prev => ({
              ...prev,
              [job.audio_path]: { job_id: job.id, stage: job.stage, pct: job.pct, message: job.message, status: job.status as JobProgress["status"] },
            }));
            connectJobStream(job.id, job.audio_path);
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPair?.slug]);

  useEffect(() => {
    return () => { Object.values(eventSourcesRef.current).forEach(es => es.close()); };
  }, []);

  // Restore nav state from URL params on mount
  useEffect(() => {
    const agent    = searchParams.get("agent");
    const customer = searchParams.get("customer");
    const callId   = searchParams.get("call");
    if (!agent) return;
    setSelectedAgent(agent);
    if (customer) {
      const slug = `${agent}/${customer}`;
      setSelectedPair({ slug, agent, customer, crm: "", audio_count: 0, total_size_bytes: 0 });
      setSpeakerA(agent.split(" ")[0]);
      setSpeakerB(customer.split(" ")[0]);
      if (callId) pendingCallIdRef.current = callId;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore selected call once calls data arrives after a page refresh
  useEffect(() => {
    if (!pendingCallIdRef.current || !callsData?.calls) return;
    const call = callsData.calls.find(c => c.call_id === pendingCallIdRef.current);
    pendingCallIdRef.current = null;
    if (call) {
      setSelectedCall(call);
      setSelectedTranscript(null);
      setExpandedSources(new Set(["final"]));
    }
  }, [callsData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global log stream — open when txMode is active, close when leaving
  useEffect(() => {
    if (!txMode) return;
    setGlobalLogs([]);
    // Seed with recent history, then stream live
    fetch(`${API}/logs/recent?n=100`)
      .then(r => r.json())
      .then((lines: Array<{ ts: string; text: string; level: string }>) => setGlobalLogs(lines))
      .catch(() => {});
    const es = new EventSource(`${API}/logs/stream`);
    es.onmessage = (e) => {
      if (!e.data || e.data === "{}") return;
      try {
        const d = JSON.parse(e.data);
        if (d.heartbeat) return;
        setGlobalLogs(prev => [...prev, { ts: d.ts ?? "", text: d.text ?? "", level: d.level ?? "info" }].slice(-1000));
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [txMode]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll log panel to bottom on new output
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [globalLogs]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const agentGroups: Record<string, Pair[]> = {};
  for (const p of pairs || []) {
    const key = p.agent || p.slug;
    (agentGroups[key] ??= []).push(p);
  }
  const agentNames = Object.keys(agentGroups).sort();
  const filteredAgents = agentNames.filter(a => a.toLowerCase().includes(agentSearch.toLowerCase()));
  const agentCustomers = selectedAgent
    ? (agentGroups[selectedAgent] || []).filter(p =>
        p.customer.toLowerCase().includes(customerSearch.toLowerCase()))
    : [];

  const calls = callsData?.calls || [];
  const filteredCalls = calls.filter(c => {
    if (!c.downloaded) return false;
    if (statusFilter === "all") return true;
    return c.status === statusFilter;
  });

  const bySource: Record<string, TranscriptEntry[]> = {};
  for (const t of transcripts || []) {
    (bySource[t.source] ??= []).push(t);
  }

  const groupByAudioType = (entries: TranscriptEntry[]) => {
    const groups: Record<string, TranscriptEntry[]> = {};
    for (const t of entries) {
      const key = t.audio_type || "other";
      (groups[key] ??= []).push(t);
    }
    return groups;
  };

  const transcribedCount = calls.filter(c => c.status === "transcribed").length;
  const downloadedCount  = calls.filter(c => c.downloaded).length;


  // ── Handlers ───────────────────────────────────────────────────────────────

  const selectAgent = (agent: string) => {
    setSelectedAgent(agent); setSelectedPair(null);
    setSelectedCall(null); setSelectedTranscript(null);
    setCustomerSearch(""); setTxMode(false); setTxSelected(new Set());
    router.replace(`/transcription/create?agent=${encodeURIComponent(agent)}`);
  };

  const selectPair = (pair: Pair) => {
    setSelectedPair(pair); setSelectedAgent(pair.agent || pair.slug);
    setSelectedCall(null); setSelectedTranscript(null);
    setVoteMode(false); setVoteSelected(new Set());
    setTxMode(false); setTxSelected(new Set()); setTxResult(null);
    setExpandedTxCalls(new Set());
    setSpeakerA(pair.agent ? pair.agent.split(" ")[0] : "");
    setSpeakerB(pair.customer ? pair.customer.split(" ")[0] : "");
    const qs = new URLSearchParams({ agent: pair.agent, customer: pair.customer });
    router.replace(`/transcription/create?${qs.toString()}`);
  };

  const selectCall = (call: CallEntry) => {
    setSelectedCall(call); setSelectedTranscript(null);
    setExpandedSources(new Set(["final"]));
    setVoteMode(false); setVoteSelected(new Set());
    setVoteResult(null); setVoteError(null);
    if (selectedPair) {
      const qs = new URLSearchParams({ agent: selectedPair.agent, customer: selectedPair.customer, call: call.call_id });
      router.replace(`/transcription/create?${qs.toString()}`);
    }
  };

  const toggleTxMode = () => {
    setTxMode(v => !v);
    setTxSelected(new Set()); setTxResult(null);
  };

  // Toggle a single audio path in the selection
  const toggleTxPath = (path: string) =>
    setTxSelected(prev => { const n = new Set(prev); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  // Toggle all paths across all visible calls
  const allPaths = filteredCalls.flatMap(c =>
    (c.variant_files.length > 0 ? c.variant_files : c.path ? [{ path: c.path }] : []).map(v => v.path)
  );
  const toggleAllTx = () =>
    setTxSelected(txSelected.size === allPaths.length ? new Set() : new Set(allPaths));

  const toggleAllCallVariants = (call_id: string, paths: string[]) => {
    const allSel = paths.every(p => txSelected.has(p));
    if (!allSel) setExpandedTxCalls(prev => { const n = new Set(prev); n.add(call_id); return n; });
    setTxSelected(prev => {
      const n = new Set(prev);
      if (allSel) paths.forEach(p => n.delete(p));
      else paths.forEach(p => n.add(p));
      return n;
    });
  };

  const toggleEngine = (id: string) =>
    setSelectedEngines(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Collect selected (call_id, audio_path) pairs for job submission
  const txSelectionList: Array<{ call_id: string; audio_path: string }> = filteredCalls.flatMap(call => {
    const vfs = call.variant_files.length > 0
      ? call.variant_files
      : call.path ? [{ path: call.path }] : [];
    return vfs
      .filter(v => txSelected.has(v.path))
      .map(v => ({ call_id: call.call_id, audio_path: v.path }));
  });

  const runTranscription = async (stages: number[]) => {
    if (!selectedPair || txSelectionList.length === 0) return;
    setTxRunning(true); setTxResult(null);
    const batchId = txSelectionList.length > 1 ? crypto.randomUUID() : undefined;
    let success = 0, failed = 0;
    await Promise.all(txSelectionList.map(async ({ call_id, audio_path }) => {
      try {
        const res = await fetch(`${API}/jobs`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audio_path,
            pair_slug: selectedPair.slug,
            call_id,
            speaker_a: speakerA || selectedPair.agent,
            speaker_b: speakerB || selectedPair.customer,
            stages,
            engines: Array.from(selectedEngines),
            noise_reduction: 0,
            voice_isolation: false,
            vad_trim: false,
            llm_merge: false,
            batch_id: batchId,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setActiveJobs(prev => ({
            ...prev,
            [audio_path]: { job_id: data.job_id, stage: 0, pct: 0, message: "Queued", status: "pending" },
          }));
          connectJobStream(data.job_id, audio_path);
          success++;
        } else { failed++; }
      } catch { failed++; }
    }));
    setTxRunning(false);
    setTxResult({ success, failed });
    setTxSelected(new Set());
  };

  const toggleVoteMode = () => {
    setVoteMode(v => !v);
    setVoteSelected(new Set()); setVoteResult(null); setVoteError(null);
  };

  const toggleVoteItem = (path: string) =>
    setVoteSelected(prev => { const n = new Set(prev); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  const runVoting = async (mode: "vote" | "smooth") => {
    if (!selectedCall || voteSelected.size === 0) return;
    setVoteProcessing(true); setVoteResult(null); setVoteError(null);
    try {
      const res = await fetch(`${API}/transcription/process`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: selectedCall.call_id,
          transcript_paths: Array.from(voteSelected),
          speakers: selectedPair ? [selectedPair.agent, selectedPair.customer] : undefined,
          mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Processing failed");
      setVoteResult(data as ProcessResult);
      await mutateTranscripts();
    } catch (e: unknown) {
      setVoteError(e instanceof Error ? e.message : "Unknown error");
    } finally { setVoteProcessing(false); }
  };

  const toggleSource = (src: string) =>
    setExpandedSources(prev => {
      const n = new Set(prev); if (n.has(src)) n.delete(src); else n.add(src); return n;
    });

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-[calc(100vh-3rem)] flex">

      {/* ── Agent nav ── */}
      <CollapsiblePanel title="Agents" width={agentW} collapsed={agentsCollapsed} onToggle={() => setAgentsCollapsed(c => !c)}>
        <div className="px-3 py-2.5 border-b border-gray-800">
          <h2 className="text-xs font-semibold text-white flex items-center gap-1.5">
            <Folder className="w-3.5 h-3.5 text-yellow-400" /> Agents
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
          {loadingPairs && <p className="text-xs text-gray-600 p-2">Loading...</p>}
          {filteredAgents.map(agent => {
            const ps = agentGroups[agent];
            return (
              <button key={agent} onClick={() => selectAgent(agent)}
                className={`w-full text-left px-2 py-2 rounded-lg text-xs transition-colors ${
                  selectedAgent === agent
                    ? "bg-yellow-500/10 border border-yellow-500/20 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Users className="w-3 h-3 text-yellow-400 shrink-0" />
                  <span className="font-medium truncate">{agent}</span>
                </div>
                <p className="text-gray-600 pl-[18px] text-[10px]">{ps.length} customer{ps.length !== 1 ? "s" : ""}</p>
              </button>
            );
          })}
          {!loadingPairs && filteredAgents.length === 0 && (
            <p className="text-xs text-gray-600 p-2 text-center">{agentSearch ? "No match" : "No agents"}</p>
          )}
        </div>
        <div className="p-2 border-t border-gray-800">
          <Link href="/audio" className="flex items-center gap-1.5 text-xs text-yellow-500/70 hover:text-yellow-400 px-1">
            <Mic2 className="w-3 h-3" /> Audio Library
          </Link>
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={agentDrag} />

      {/* ── Customer nav ── */}
      <CollapsiblePanel title="Customers" width={customerW} collapsed={customersCollapsed} onToggle={() => setCustomersCollapsed(c => !c)}>
        {selectedAgent ? (
          <>
            <div className="px-3 py-2.5 border-b border-gray-800">
              <h2 className="text-xs font-semibold text-white truncate">{selectedAgent}</h2>
              <p className="text-[10px] text-gray-600 mt-0.5">{agentCustomers.length} customer{agentCustomers.length !== 1 ? "s" : ""}</p>
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
              {agentCustomers.map(pair => (
                <button key={pair.slug} onClick={() => selectPair(pair)}
                  className={`w-full text-left px-2 py-2 rounded-lg text-xs transition-colors ${
                    selectedPair?.slug === pair.slug
                      ? "bg-yellow-500/10 border border-yellow-500/20 text-white"
                      : "text-gray-400 hover:bg-gray-800 hover:text-white"
                  }`}>
                  <span className="font-medium truncate block">{pair.customer || "—"}</span>
                  <p className="text-gray-700 text-[10px] mt-0.5">{pair.audio_count} files</p>
                </button>
              ))}
              {agentCustomers.length === 0 && (
                <p className="text-xs text-gray-600 p-2 text-center">{customerSearch ? "No match" : "No customers"}</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-600 p-2 text-center">Select an agent</p>
          </div>
        )}
      </CollapsiblePanel>
      <DragHandle onMouseDown={customerDrag} />

      {/* ── Center: Call list ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {!selectedPair ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
            <FileText className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">Select a pair to browse transcripts</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <div>
                <h1 className="text-lg font-bold text-white">{selectedPair.agent}</h1>
                <p className="text-xs text-gray-500">
                  {selectedPair.customer}
                  {callsData?.crm_url && ` · ${callsData.crm_url.replace(/https?:\/\//, "")}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-600">{transcribedCount} transcribed · {downloadedCount} downloaded</span>
                <button onClick={() => mutateCalls()} className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button onClick={toggleTxMode}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    txMode
                      ? "bg-indigo-600/20 border border-indigo-500/40 text-indigo-300"
                      : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                  }`}>
                  <Zap className="w-3.5 h-3.5" />
                  {txMode ? "Cancel" : "Transcribe"}
                </button>
              </div>
            </div>

            {/* Transcription mode panel */}
            {txMode && (
              <div className="mb-3 bg-gray-900 border border-indigo-500/20 rounded-xl overflow-hidden">
                {/* Engine picker */}
                <div className="p-3 border-b border-gray-800">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-white flex items-center gap-1.5">
                      <Settings2 className="w-3.5 h-3.5 text-indigo-400" /> Engines
                    </p>
                    <div className="flex gap-1 items-center">
                      {([
                        { label: "EL",     group: "ElevenLabs" },
                        { label: "OpenAI", group: "OpenAI" },
                        { label: "Other",  group: "Other" },
                      ] as const).map(({ label, group }) => {
                        const ids = ALL_ENGINES.filter(e => e.group === group).map(e => e.id);
                        const active = ids.length > 0 && ids.every(id => selectedEngines.has(id)) && selectedEngines.size === ids.length;
                        return (
                          <button key={label}
                            onClick={() => setSelectedEngines(new Set(ids))}
                            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                              active ? "bg-indigo-600/40 text-indigo-300 border border-indigo-500/40" : "text-gray-600 hover:text-gray-400 hover:bg-gray-700/50"
                            }`}>
                            {label}
                          </button>
                        );
                      })}
                      <span className="text-gray-700 mx-0.5">·</span>
                      <button onClick={() => setSelectedEngines(new Set(ALL_ENGINES.map(e => e.id)))}
                        className="text-[10px] text-gray-600 hover:text-gray-400 px-1">All</button>
                      <button onClick={() => setSelectedEngines(new Set())}
                        className="text-[10px] text-gray-600 hover:text-gray-400 px-1">None</button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {ALL_ENGINES.map(eng => (
                      <label key={eng.id} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={selectedEngines.has(eng.id)}
                          onChange={() => toggleEngine(eng.id)} className="w-3 h-3 accent-indigo-500" />
                        <span className="text-[11px] text-gray-400">{eng.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Speakers */}
                <div className="px-3 py-2 flex items-center gap-4 flex-wrap border-b border-gray-800">
                  <div className="flex items-center gap-2">
                    <input value={speakerA} onChange={e => setSpeakerA(e.target.value)}
                      placeholder={selectedPair.agent || "Speaker A"}
                      className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-white focus:border-indigo-500 focus:outline-none" />
                    <span className="text-gray-600 text-[10px]">vs</span>
                    <input value={speakerB} onChange={e => setSpeakerB(e.target.value)}
                      placeholder={selectedPair.customer || "Speaker B"}
                      className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-white focus:border-indigo-500 focus:outline-none" />
                  </div>
                </div>

                {/* Selection summary + run */}
                <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
                  <button onClick={toggleAllTx}
                    className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                    {txSelected.size === allPaths.length && allPaths.length > 0
                      ? <CheckSquare className="w-3 h-3" />
                      : <Square className="w-3 h-3" />}
                    {txSelected.size > 0 ? `${txSelected.size} selected` : "Select all"}
                  </button>
                  {(["original", "enhanced", "converted"] as const).map(vname => {
                    const vPaths = filteredCalls.flatMap(c => {
                      const vfs = c.variant_files.length > 0 ? c.variant_files : c.path ? [{ name: "original" as const, path: c.path }] : [];
                      return vfs.filter(v => v.name === vname).map(v => v.path);
                    });
                    if (vPaths.length === 0) return null;
                    const allSel = vPaths.length > 0 && vPaths.every(p => txSelected.has(p));
                    return (
                      <button key={vname}
                        onClick={() => setTxSelected(prev => {
                          const n = new Set(prev);
                          if (allSel) vPaths.forEach(p => n.delete(p));
                          else vPaths.forEach(p => n.add(p));
                          return n;
                        })}
                        className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                          allSel ? "bg-gray-600/40 text-gray-300 border border-gray-600/50" : "text-gray-600 hover:text-gray-400 hover:bg-gray-700/50"
                        }`}>
                        {vname} ({vPaths.length})
                      </button>
                    );
                  })}
                  {txResult && (
                    <span className="text-[10px] text-emerald-400">
                      ✓ {txResult.success} job{txResult.success !== 1 ? "s" : ""} queued
                      {txResult.failed > 0 && ` · ${txResult.failed} failed`}
                    </span>
                  )}
                  <div className="ml-auto">
                    <button
                      disabled={txRunning || txSelectionList.length === 0 || selectedEngines.size === 0}
                      onClick={() => runTranscription([2])}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-medium rounded-lg transition-colors">
                      {txRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                      Transcribe ({txSelectionList.length})
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Filter tabs */}
            <div className="flex items-center gap-1 mb-3">
              {([
                { key: "all",         label: "All",         count: downloadedCount },
                { key: "transcribed", label: "Transcribed", count: transcribedCount },
                { key: "enhanced",    label: "Enhanced",    count: calls.filter(c => c.status === "enhanced").length },
                { key: "raw",         label: "Raw",         count: calls.filter(c => c.status === "raw").length },
              ] as const).map(({ key, label, count }) => (
                <button key={key} onClick={() => setStatusFilter(key)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    statusFilter === key ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}>
                  {label} ({count})
                </button>
              ))}
            </div>

            {/* Call table */}
            <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
              <div className="grid text-xs text-gray-500 font-medium border-b border-gray-800 px-4 py-2"
                style={{ gridTemplateColumns: txMode ? "20px 1fr 110px 70px 110px 55px" : "1fr 110px 70px 110px 55px" }}>
                {txMode && <span />}
                <span>Call ID</span>
                <span>Date</span>
                <span className="text-right">Duration</span>
                <span>Status</span>
                <span className="text-right">Size</span>
              </div>

              <div className="flex-1 overflow-y-auto">
                {loadingCalls && <p className="text-center py-10 text-gray-600 text-sm">Loading...</p>}
                {filteredCalls.map(call => {
                  const vfs = call.variant_files.length > 0
                    ? call.variant_files
                    : call.path ? [{ name: "original", path: call.path, size_bytes: call.size_bytes ?? 0 }] : [];
                  const callHasActiveJob = vfs.some(v => {
                    const j = activeJobs[v.path];
                    return j && (j.status === "pending" || j.status === "running");
                  });
                  const allSel = vfs.length > 0 && vfs.every(v => txSelected.has(v.path));
                  const someSel = vfs.some(v => txSelected.has(v.path));
                  const VPILL: Record<string, string> = {
                    original:  "border-gray-600/60 text-gray-400 hover:border-gray-500",
                    enhanced:  "border-emerald-500/40 text-emerald-400 hover:border-emerald-400",
                    converted: "border-blue-500/40 text-blue-400 hover:border-blue-400",
                  };
                  const VPILL_SEL: Record<string, string> = {
                    original:  "bg-gray-600/30 border-gray-500 text-gray-200",
                    enhanced:  "bg-emerald-500/20 border-emerald-400 text-emerald-300",
                    converted: "bg-blue-500/20 border-blue-400 text-blue-300",
                  };
                  return (
                    <div key={call.call_id} className="border-b border-gray-800/30 last:border-0">
                      {/* Call header row */}
                      <div
                        onClick={() => txMode
                          ? toggleAllCallVariants(call.call_id, vfs.map(v => v.path))
                          : selectCall(call)}
                        className={`grid px-4 items-center text-sm cursor-pointer transition-colors border-l-2 ${
                          txMode ? "py-2" : "py-2.5"
                        } ${
                          !txMode && selectedCall?.call_id === call.call_id
                            ? "bg-yellow-500/5 border-yellow-500/60"
                            : "hover:bg-gray-800/40 border-transparent"
                        }`}
                        style={{ gridTemplateColumns: txMode ? "20px 1fr 110px 70px 110px 55px" : "1fr 110px 70px 110px 55px" }}>
                        {txMode && (
                          <span className="flex items-center">
                            {allSel
                              ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                              : someSel
                                ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400/40" />
                                : <Square className="w-3.5 h-3.5 text-gray-600" />}
                          </span>
                        )}
                        <span className="flex items-center gap-2 min-w-0">
                          <FileText className={`w-3.5 h-3.5 shrink-0 ${
                            callHasActiveJob ? "text-indigo-400 animate-pulse" :
                            call.status === "transcribed" ? "text-yellow-400" :
                            call.status === "enhanced" ? "text-blue-400" : "text-gray-600"
                          }`} />
                          <span className="font-mono text-xs text-gray-300 truncate">{call.call_id}</span>
                        </span>
                        <span className="text-xs text-gray-500">{formatDate(call.date)}</span>
                        <span className="text-xs text-right text-gray-500">
                          {call.duration_s ? formatDuration(call.duration_s) : "—"}
                        </span>
                        <StatusDot status={callHasActiveJob ? null : call.status} />
                        <span className="text-xs text-right text-gray-600">{fmtBytes(call.size_bytes)}</span>
                      </div>

                      {/* Variant pill row — always visible in txMode */}
                      {txMode && vfs.length > 0 && (
                        <div className="flex items-center gap-1.5 px-4 pb-2 pl-9 flex-wrap">
                          {vfs.map(v => {
                            const isSel = txSelected.has(v.path);
                            const job = activeJobs[v.path];
                            const jobActive = job && (job.status === "pending" || job.status === "running");
                            const pillBase = "flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border transition-colors cursor-pointer";
                            const pillCls = isSel
                              ? `${pillBase} ${VPILL_SEL[v.name] ?? VPILL_SEL.original}`
                              : `${pillBase} bg-transparent ${VPILL[v.name] ?? VPILL.original}`;
                            return (
                              <button key={v.path}
                                onClick={(e) => { e.stopPropagation(); toggleTxPath(v.path); }}
                                className={pillCls}>
                                {isSel
                                  ? <CheckSquare className="w-3 h-3" />
                                  : <Square className="w-3 h-3" />}
                                {v.name}
                                {jobActive
                                  ? <Loader2 className="w-2.5 h-2.5 animate-spin ml-0.5" />
                                  : <span className="text-[9px] opacity-50 ml-0.5">{fmtBytes(v.size_bytes)}</span>}
                              </button>
                            );
                          })}
                          {vfs.some(v => activeJobs[v.path]?.status === "failed") && (
                            <span className="text-[10px] text-red-400">✕ error</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!loadingCalls && filteredCalls.length === 0 && (
                  <p className="text-center py-10 text-gray-600 text-sm">
                    {statusFilter === "all" ? "No downloaded calls" : `No ${statusFilter} calls`}
                  </p>
                )}
              </div>

              <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
                {calls.length} total · {downloadedCount} downloaded · {transcribedCount} transcribed
              </div>
            </div>
          </>
        )}
      </div>

      <DragHandle onMouseDown={rightDrag} />

      {/* ── Right: Job log panel (txMode) or Transcript viewer ── */}
      {txMode ? (
        <div className="flex-shrink-0 bg-gray-950 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ width: rightW }}>
          <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
            </div>
            <span className="text-xs text-gray-500 ml-1 flex items-center gap-1.5">
              {Object.values(activeJobs).some(j => j.status === "running" || j.status === "pending") && (
                <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />
              )}
              pipeline output
            </span>
            <span className="ml-auto text-[10px] text-gray-700">
              {Object.values(activeJobs).filter(j => j.status === "running" || j.status === "pending").length > 0 &&
                `${Object.values(activeJobs).filter(j => j.status === "running" || j.status === "pending").length} running · `}
              {Object.values(activeJobs).filter(j => j.status === "complete").length > 0 &&
                `${Object.values(activeJobs).filter(j => j.status === "complete").length} done · `}
              {globalLogs.length} lines
            </span>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] p-3 space-y-0.5">
            {globalLogs.length === 0 && (
              <p className="text-gray-700 text-center pt-8">Waiting for output…</p>
            )}
            {globalLogs.map((l, i) => {
              const cls =
                l.level === "error" ? "text-red-400" :
                l.level === "warn"  ? "text-yellow-400" :
                l.level === "stage" ? "text-indigo-300 font-semibold" :
                "text-gray-500";
              return (
                <p key={i} className={`leading-snug whitespace-pre-wrap break-all ${cls}`}>
                  <span className="text-gray-700 mr-2 select-none">{l.ts}</span>{l.text}
                </p>
              );
            })}
            <div ref={logEndRef} />
          </div>
        </div>
      ) : selectedCall ? (
        <div className="flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ width: rightW }}>
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-yellow-400" />
                <span className="font-mono">{selectedCall.call_id}</span>
              </h2>
              <p className="text-[10px] text-gray-600 mt-0.5">{selectedPair?.agent} · {selectedPair?.customer}</p>
            </div>
            <div className="flex items-center gap-2">
              {loadingTranscripts && <Loader2 className="w-4 h-4 animate-spin text-gray-600" />}
              <button onClick={toggleVoteMode}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  voteMode
                    ? "bg-violet-500/20 border border-violet-500/40 text-violet-300"
                    : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
                }`}>
                <GitMerge className="w-3.5 h-3.5" />
                {voteMode ? "Cancel" : "Vote"}
              </button>
            </div>
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Left tree */}
            <div className="w-56 shrink-0 border-r border-gray-800 flex flex-col">
              <div className="flex-1 overflow-y-auto py-1">
                {!loadingTranscripts && Object.keys(bySource).length === 0 && (
                  <div className="p-3 space-y-1.5">
                    <p className="text-xs text-gray-600">
                      {selectedCall.status === "transcribed"
                        ? "No transcripts found"
                        : "No transcripts — run transcription first"}
                    </p>
                    <button onClick={() => mutateTranscripts()}
                      className="flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-400 transition-colors">
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                  </div>
                )}
                {SOURCE_ORDER.filter(s => bySource[s]).map(src => {
                  const isOpen = expandedSources.has(src);
                  const entries = bySource[src];
                  // Group engine entries by engine name → audio_type map
                  const byEngine: Record<string, Record<string, TranscriptEntry>> = {};
                  for (const t of entries) {
                    if (t.engine) (byEngine[t.engine] ??= {})[t.audio_type ?? "original"] = t;
                  }
                  const PILL_IDLE: Record<string, string> = {
                    original:  "border-gray-600/50 text-gray-500 hover:border-gray-500 hover:text-gray-300",
                    converted: "border-blue-500/40 text-blue-500/70 hover:border-blue-400 hover:text-blue-300",
                    enhanced:  "border-emerald-500/40 text-emerald-500/70 hover:border-emerald-400 hover:text-emerald-300",
                  };
                  const PILL_ACTIVE: Record<string, string> = {
                    original:  "bg-gray-700/60 border-gray-500 text-gray-200",
                    converted: "bg-blue-500/20 border-blue-400 text-blue-300",
                    enhanced:  "bg-emerald-500/20 border-emerald-400 text-emerald-300",
                  };
                  return (
                    <div key={src}>
                      <button onClick={() => toggleSource(src)}
                        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
                        <ChevronRight className={`w-3 h-3 transition-transform shrink-0 ${isOpen ? "rotate-90" : ""}`} />
                        {SOURCE_LABELS[src] || src}
                        <span className="ml-auto text-gray-700 text-[10px]">{entries.length}</span>
                      </button>
                      {isOpen && src === "final" && entries.map(t => (
                        <TranscriptTreeItem key={t.path} t={t}
                          selected={selectedTranscript?.path === t.path}
                          onSelect={() => !voteMode && setSelectedTranscript(t)}
                          voteMode={voteMode}
                          voteChecked={voteSelected.has(t.path)}
                          onVoteToggle={() => toggleVoteItem(t.path)} />
                      ))}
                      {isOpen && src !== "final" && Object.entries(byEngine).map(([engine, variants]) => (
                        <div key={engine} className="px-3 py-2 border-b border-gray-800/30 last:border-0">
                          <p className="text-[10px] text-gray-500 font-medium mb-1.5 capitalize">
                            {engine.replace(/_/g, " ")}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {(["original", "converted", "enhanced"] as const).map(at => {
                              const t = variants[at];
                              if (!t) return null;
                              const isView = selectedTranscript?.path === t.path;
                              const isVoted = voteSelected.has(t.path);
                              const active = voteMode ? isVoted : isView;
                              const pillCls = `flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-colors cursor-pointer ${
                                active ? PILL_ACTIVE[at] ?? PILL_ACTIVE.original
                                       : `bg-transparent ${PILL_IDLE[at] ?? PILL_IDLE.original}`
                              }`;
                              return (
                                <button key={at} className={pillCls}
                                  onClick={() => {
                                    if (voteMode) toggleVoteItem(t.path);
                                    else setSelectedTranscript(t);
                                  }}>
                                  {voteMode && (isVoted
                                    ? <CheckSquare className="w-2.5 h-2.5" />
                                    : <Square className="w-2.5 h-2.5" />)}
                                  {at}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* Vote action panel */}
              {voteMode && (
                <div className="border-t border-gray-800 p-2 space-y-1.5">
                  <p className="text-[10px] text-gray-500">{voteSelected.size} selected</p>
                  {voteResult && (
                    <div className="flex items-start gap-1.5 text-[10px] text-emerald-400">
                      <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>{voteResult.word_count} words · {voteResult.used_llm ? "LLM" : "weighted"} vote</span>
                    </div>
                  )}
                  {voteError && (
                    <div className="flex items-start gap-1.5 text-[10px] text-red-400">
                      <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      <span className="break-words">{voteError}</span>
                    </div>
                  )}
                  <button disabled={voteSelected.size === 0 || voteProcessing} onClick={() => runVoting("vote")}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 disabled:opacity-40 transition-colors">
                    {voteProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />}
                    Vote only
                  </button>
                  <button disabled={voteSelected.size === 0 || voteProcessing} onClick={() => runVoting("smooth")}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 disabled:opacity-40 transition-colors">
                    {voteProcessing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    Vote + Smooth
                  </button>
                </div>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {loadingContent && (
                <div className="flex items-center gap-2 text-gray-600 text-xs">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading...
                </div>
              )}
              {selectedTranscript && !loadingContent && transcriptContent && (
                <TranscriptContent content={transcriptContent.content} format={transcriptContent.format} />
              )}
              {!selectedTranscript && !loadingTranscripts && Object.keys(bySource).length > 0 && (
                <p className="text-xs text-gray-600">Select a transcript from the tree</p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ width: rightW }} className="flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
          <div className="flex-1 flex items-center justify-center text-gray-600">
            <p className="text-sm text-center px-4">Select a call to view transcripts</p>
          </div>
        </div>
      )}
    </div>
  );
}

function TranscriptTreeItem({ t, selected, onSelect, voteMode, voteChecked, onVoteToggle, indent = false }: {
  t: TranscriptEntry; selected: boolean; onSelect: () => void;
  voteMode?: boolean; voteChecked?: boolean; onVoteToggle?: () => void; indent?: boolean;
}) {
  const canVote = t.format === "json";
  if (voteMode) {
    return (
      <button onClick={canVote ? onVoteToggle : undefined} disabled={!canVote}
        className={`w-full flex items-center gap-1.5 py-1.5 text-[11px] transition-colors border-l-2 ${
          voteChecked
            ? "bg-violet-500/10 text-violet-300 border-violet-500"
            : canVote
              ? "text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border-transparent"
              : "text-gray-700 border-transparent cursor-not-allowed"
        } ${indent ? "pl-7" : "pl-4"}`}>
        {voteChecked
          ? <CheckSquare className="w-3 h-3 shrink-0 text-violet-400" />
          : <Square className="w-3 h-3 shrink-0 text-gray-600" />}
        <span className="truncate">{t.label}</span>
      </button>
    );
  }
  return (
    <button onClick={onSelect}
      className={`w-full text-left py-1.5 text-[11px] transition-colors truncate border-l-2 ${
        selected
          ? "bg-yellow-500/10 text-yellow-300 border-yellow-500"
          : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/60 border-transparent"
      } ${indent ? "pl-8" : "pl-5"}`}>
      {t.label}
    </button>
  );
}
