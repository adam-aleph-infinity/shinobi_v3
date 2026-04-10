"use client";
export const dynamic = "force-dynamic";
import { useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import Link from "next/link";
import {
  Mic2, Folder, FileAudio, CheckSquare, Square, Loader2,
  X, Download, Users, Trash2, RefreshCw, Play, FileText, Search,
  Zap, RotateCcw, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown, SlidersHorizontal,
} from "lucide-react";
import { formatDate, formatDuration, fmtBytes } from "@/lib/utils";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";

const API = "/api";
const LOG_API = "/api"; // direct — Next.js proxy buffers SSE

const STAGE_LABELS: Record<number, string> = {
  0: "Queued", 1: "Processing", 2: "Transcribing", 4: "Voting", 5: "Finalizing",
};

interface JobProgress {
  job_id: string; stage: number; pct: number;
  message: string; status: "pending" | "running" | "complete" | "failed";
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Pair {
  slug: string; agent: string; customer: string; crm: string;
  audio_count: number; total_size_bytes: number;
  account_id?: string;
}
interface VariantFile {
  name: string;   // "original" | "enhanced" | "converted" | …
  path: string;
  size_bytes: number;
}
interface CallEntry {
  call_id: string; date: string; duration_s: number | null;
  downloaded: boolean; path: string | null; size_bytes: number | null;
  status: "raw" | "enhanced" | "transcribed" | null;
  record_path: string;
  variant_files: VariantFile[];
}
interface PairCallsResult {
  calls: CallEntry[]; has_metadata: boolean;
  crm_url: string; account_id: string; agent: string; customer: string;
}
interface AudioVersion {
  label: string; path: string; type: "original" | "converted" | "enhanced";
}

type DlFilter = "all" | "downloaded" | "not_downloaded";
type StatusFilter = "all" | "transcribed" | "not_transcribed";
type SortField = "call_id" | "date" | "duration";
type SortDir = "asc" | "desc";

// ── Small components ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      className={`relative w-8 h-4 rounded-full transition-colors flex-shrink-0 ${checked ? "bg-indigo-600" : "bg-gray-700"}`}>
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function DurationBar({ duration_s, maxDuration }: { duration_s: number | null; maxDuration: number }) {
  if (!duration_s) return <span className="text-xs text-gray-700">—</span>;
  const pct = maxDuration > 0 ? (duration_s / maxDuration) * 100 : 0;
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-xs text-gray-400">{formatDuration(duration_s)}</span>
      <div className="h-[3px] bg-gray-800 rounded-full overflow-hidden">
        <div className="h-full bg-indigo-500/50 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const VARIANT_STYLE: Record<string, { pill: string; icon: string }> = {
  original: { pill: "bg-gray-700/60 text-gray-400",      icon: "text-gray-500" },
  enhanced: { pill: "bg-emerald-500/15 text-emerald-400", icon: "text-emerald-400" },
  converted:{ pill: "bg-blue-500/15 text-blue-400",       icon: "text-blue-400" },
};

// ── Inline log stream ─────────────────────────────────────────────────────────

const LOG_LEVEL_COLOR: Record<string, string> = {
  error: "text-red-400", warn: "text-yellow-400",
  stage: "text-indigo-300", llm: "text-teal-300", info: "text-gray-500",
};

function LogStream() {
  const [lines, setLines] = useState<{ ts: string; text: string; level: string }[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    const es = new EventSource(`${LOG_API}/logs/stream`);
    es.onmessage = (e) => {
      if (!e.data || e.data === "{}") return;
      try {
        const data = JSON.parse(e.data);
        if (data.heartbeat) return;
        setLines(prev => {
          const next = [...prev, { ts: data.ts || "", text: data.text || "", level: data.level || "info" }];
          return next.length > 800 ? next.slice(-800) : next;
        });
        if (!pausedRef.current) {
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
        }
      } catch { /* ignore */ }
    };
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior }), 200);
    return () => es.close();
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-800 shrink-0 bg-gray-950">
        <span className="text-[10px] text-gray-600 flex-1">live · all jobs</span>
        <button onClick={() => setPaused(p => !p)}
          className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${paused ? "bg-indigo-700 text-white" : "bg-gray-800 text-gray-500"}`}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={() => setLines([])}
          className="text-[10px] px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-600 rounded transition-colors">
          Clear
        </button>
        <Link href="/logs" className="text-[10px] text-indigo-500 hover:text-indigo-400 px-1">↗ Full</Link>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-[10px] p-2 space-y-0.5 bg-gray-950">
        {lines.length === 0 && (
          <p className="text-gray-700 text-center pt-8">No log output yet</p>
        )}
        {lines.map((l, i) => (
          <div key={i} className="flex gap-1.5 leading-4 items-start">
            <span className="text-gray-700 shrink-0 w-14">{l.ts}</span>
            <span className={`min-w-0 whitespace-pre-wrap break-words ${LOG_LEVEL_COLOR[l.level] ?? "text-gray-400"}`}>{l.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AudioLibraryPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Resizable panels
  const [agentW, agentDrag]     = useResize(160, 120, 380);
  const [customerW, customerDrag] = useResize(160, 120, 380);
  const [rightW, rightDrag]     = useResize(320, 200, 560, "left");

  // Nav state
  const [selectedAgent, setSelectedAgent]   = useState<string | null>(null);
  const [selectedPair, setSelectedPair]     = useState<Pair | null>(null);
  const [agentSearch, setAgentSearch]       = useState("");
  const [customerSearch, setCustomerSearch] = useState("");

  // Library panel filters + sort
  const [dlFilter, setDlFilter]           = useState<DlFilter>("all");
  const [statusFilter, setStatusFilter]   = useState<StatusFilter>("all");
  const [minDurationS, setMinDurationS]   = useState(0);  // seconds
  const [sortField, setSortField]         = useState<SortField>("date");
  const [sortDir, setSortDir]             = useState<SortDir>("desc");

  const [agentsCollapsed, setAgentsCollapsed] = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);
  const [localFilesCollapsed, setLocalFilesCollapsed] = useState(false);

  // Local panel
  const [localTab, setLocalTab]           = useState<"files" | "settings" | "logs">("files");
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
  const [expandedCalls, setExpandedCalls] = useState<Set<string>>(new Set());

  // Enhancement settings
  const [noiseReduction, setNoiseReduction] = useState(80);
  const [voiceIsolation, setVoiceIsolation] = useState(false);
  const [vadTrim, setVadTrim]               = useState(false);
  const [speakerA, setSpeakerA]             = useState("");
  const [speakerB, setSpeakerB]             = useState("");

  // S3 / CRM
  const [fetchingCalls, setFetchingCalls]     = useState(false);
  const [fetchCallsError, setFetchCallsError] = useState<string | null>(null);
  const [syncingS3, setSyncingS3]             = useState(false);
  const [s3Files, setS3Files]                 = useState<{ call_id: string; size_bytes: number; date: string }[] | null>(null);
  const [downloading, setDownloading]         = useState<Set<string>>(new Set());
  const [removing, setRemoving]               = useState<Set<string>>(new Set());
  const [librarySelected, setLibrarySelected] = useState<Set<string>>(new Set());
  const [transcribeSelected, setTranscribeSelected] = useState<Set<string>>(new Set());

  // Clear selection when filters change so stale picks don't survive filter changes
  useEffect(() => { setLibrarySelected(new Set()); setTranscribeSelected(new Set()); }, [minDurationS, statusFilter, dlFilter]);

  // Per-call job progress
  const [activeJobs, setActiveJobs]   = useState<Record<string, JobProgress>>({});
  const eventSourcesRef               = useRef<Record<string, EventSource>>({});

  // Audio player
  const [playingCall, setPlayingCall]     = useState<CallEntry | null>(null);
  const [activeVersion, setActiveVersion] = useState<AudioVersion | null>(null);
  const audioRef                          = useRef<HTMLAudioElement>(null);

  // ── Data fetching ──────────────────────────────────────────────────────────

  // CRM nav — all agents/customers from DB
  const { data: crmAgents, isLoading: loadingAgents } = useSWR<{ agent: string; count: number }[]>(
    "/crm-nav-agents",
    () => fetch(`${API}/crm/nav/agents`).then(r => r.json()),
    { revalidateOnFocus: false },
  );
  const { data: crmCustomers } = useSWR<{ customer: string; account_id: string; crm_url: string; call_count: number }[]>(
    selectedAgent ? `/crm-nav-customers-${selectedAgent}` : null,
    () => fetch(`${API}/crm/nav/customers?agent=${encodeURIComponent(selectedAgent!)}`).then(r => r.json()),
    { revalidateOnFocus: false },
  );
  // Local pairs — only for downloaded file counts
  const { data: localPairs } = useSWR<Pair[]>(
    "/audio-pairs",
    () => fetch(`${API}/audio/pairs`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const { data: callsData, isLoading: loadingCalls, mutate: mutateCalls } = useSWR<PairCallsResult>(
    selectedPair ? `/audio-calls-${selectedPair.slug}` : null,
    () => fetch(`${API}/audio/calls?slug=${encodeURIComponent(selectedPair!.slug)}`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const { data: versions } = useSWR<AudioVersion[]>(
    playingCall && selectedPair ? `/audio-versions-${playingCall.call_id}` : null,
    () => fetch(`${API}/audio/versions/${playingCall!.call_id}?slug=${encodeURIComponent(selectedPair!.slug)}`).then(r => r.json()),
    { revalidateOnFocus: false, onSuccess: (d) => { if (d?.length) setActiveVersion(d[0]); } },
  );

  // ── Job stream management ──────────────────────────────────────────────────

  const connectJobStream = (job_id: string, call_id: string) => {
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
          [call_id]: {
            job_id,
            stage:   ev.stage   ?? prev[call_id]?.stage   ?? 0,
            pct:     ev.pct     ?? prev[call_id]?.pct     ?? 0,
            message: ev.message ?? prev[call_id]?.message ?? "",
            status:  done ? (ev.error ? "failed" : "complete") : "running",
          },
        }));
        if (done) {
          es.close();
          delete eventSourcesRef.current[job_id];
          mutateCalls();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { es.close(); delete eventSourcesRef.current[job_id]; };
  };

  // Restore active jobs when pair loads
  useEffect(() => {
    if (!selectedPair) return;
    fetch(`${API}/jobs?pair_slug=${encodeURIComponent(selectedPair.slug)}`)
      .then(r => r.json())
      .then((jobs: Array<{ id: string; call_id: string; stage: number; pct: number; message: string; status: string }>) => {
        for (const job of jobs) {
          if (job.status === "running" || job.status === "pending") {
            setActiveJobs(prev => ({
              ...prev,
              [job.call_id]: { job_id: job.id, stage: job.stage, pct: job.pct, message: job.message, status: job.status as JobProgress["status"] },
            }));
            connectJobStream(job.id, job.call_id);
          }
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPair?.slug]);

  useEffect(() => {
    return () => { Object.values(eventSourcesRef.current).forEach(es => es.close()); };
  }, []);

  // URL params auto-select (restores state on refresh)
  useEffect(() => {
    const agent = searchParams.get("agent");
    const customer = searchParams.get("customer");
    const crm = searchParams.get("crm") || "";
    const account = searchParams.get("account") || "";
    if (!agent) return;
    setSelectedAgent(agent);
    if (customer) {
      setSelectedPair({ slug: `${agent}/${customer}`, agent, customer, crm, account_id: account, audio_count: 0, total_size_bytes: 0 });
      setSpeakerA(agent.split(" ")[0]);
      setSpeakerB(customer.split(" ")[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fetch from CRM when pair loads with no calls
  useEffect(() => {
    if (!callsData || (callsData.calls?.length ?? 0) > 0 || fetchingCalls) return;
    const crm = callsData.crm_url || selectedPair?.crm || searchParams.get("crm") || "";
    const account = callsData.account_id || selectedPair?.account_id || searchParams.get("account") || "";
    if (!crm || !account) return;
    handleFetchFromCRM();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callsData?.calls?.length, callsData?.crm_url, callsData?.account_id, selectedPair?.account_id]);

  // ── Derived ────────────────────────────────────────────────────────────────

  // Build lookup: slug → local Pair (for downloaded file counts)
  const localPairMap = new Map<string, Pair>();
  for (const p of localPairs || []) localPairMap.set(p.slug, p);

  // Agent list from CRM DB
  const agentList = crmAgents || [];
  const filteredAgents = agentList.filter(a => a.agent.toLowerCase().includes(agentSearch.toLowerCase()));

  // Customer list from CRM DB (loaded when agent selected)
  const customerList = crmCustomers || [];
  const filteredCustomers = customerList.filter(c => c.customer.toLowerCase().includes(customerSearch.toLowerCase()));

  const s3SizeMap = new Map((s3Files || []).map(f => [f.call_id, f.size_bytes]));
  const localCallIds = new Set((callsData?.calls || []).map(c => c.call_id));
  const s3OnlyCalls: CallEntry[] = (s3Files || [])
    .filter(f => !localCallIds.has(f.call_id))
    .map(f => ({ call_id: f.call_id, date: f.date, duration_s: null,
                 downloaded: false, path: null, size_bytes: f.size_bytes,
                 status: null, record_path: "", variant_files: [] }));
  // Enrich callsData entries with S3 size when not already present (un-downloaded calls have no local size)
  const allCalls: CallEntry[] = [
    ...(callsData?.calls || []).map(c => ({
      ...c,
      size_bytes: c.size_bytes ?? s3SizeMap.get(c.call_id) ?? null,
    })),
    ...s3OnlyCalls,
  ];

  const downloadedCalls = allCalls.filter(c => c.downloaded);

  const maxDurationAll = Math.max(...allCalls.map(c => c.duration_s ?? 0), 1);

  const filteredCalls = allCalls
    .filter(c => {
      if (dlFilter === "downloaded" && !c.downloaded) return false;
      if (dlFilter === "not_downloaded" && c.downloaded) return false;
      if (statusFilter === "transcribed" && c.status !== "transcribed") return false;
      if (statusFilter === "not_transcribed" && c.status === "transcribed") return false;
      if (minDurationS > 0 && (c.duration_s ?? 0) < minDurationS) return false;
      return true;
    })
    .sort((a, b) => {
      let diff = 0;
      if (sortField === "call_id") diff = String(a.call_id).localeCompare(String(b.call_id));
      else if (sortField === "date") diff = (a.date || "").localeCompare(b.date || "");
      else if (sortField === "duration") diff = (a.duration_s ?? 0) - (b.duration_s ?? 0);
      return sortDir === "asc" ? diff : -diff;
    });

  const maxDuration = Math.max(...filteredCalls.map(c => c.duration_s ?? 0), 1);

  const counts = {
    all: allCalls.length,
    downloaded: allCalls.filter(c => c.downloaded).length,
    not_downloaded: allCalls.filter(c => !c.downloaded).length,
  };

  const localSelectedList = downloadedCalls.filter(c => localSelected.has(c.call_id));

  const downloadableCalls = filteredCalls.filter(c => !c.downloaded);
  const allLibrarySelected = downloadableCalls.length > 0 && downloadableCalls.every(c => librarySelected.has(c.call_id));
  const selectedForDownload = filteredCalls.filter(c => !c.downloaded && librarySelected.has(c.call_id));
  const transcribableCalls = filteredCalls.filter(c => c.downloaded && c.status !== "transcribed");
  const allTranscribeSelected = transcribableCalls.length > 0 && transcribableCalls.every(c => transcribeSelected.has(c.call_id));
  const selectedForTranscribe = transcribableCalls.filter(c => transcribeSelected.has(c.call_id));

  // ── Helpers ────────────────────────────────────────────────────────────────

  const getCrmAndAccount = () => ({
    crm:     callsData?.crm_url    || selectedPair?.crm              || searchParams.get("crm")     || "",
    account: callsData?.account_id || selectedPair?.account_id       || searchParams.get("account") || "",
  });

  const toggleLocal = (callId: string) =>
    setLocalSelected(prev => { const n = new Set(prev); if (n.has(callId)) n.delete(callId); else n.add(callId); return n; });

  const toggleAllLocal = () =>
    setLocalSelected(localSelected.size === downloadedCalls.length
      ? new Set()
      : new Set(downloadedCalls.map(c => c.call_id)));

  const toggleLibraryCall = (callId: string) =>
    setLibrarySelected(prev => { const n = new Set(prev); if (n.has(callId)) n.delete(callId); else n.add(callId); return n; });

  const toggleAllLibraryCalls = () =>
    setLibrarySelected(allLibrarySelected ? new Set() : new Set(downloadableCalls.map(c => c.call_id)));

  const toggleTranscribeCall = (callId: string) =>
    setTranscribeSelected(prev => { const n = new Set(prev); if (n.has(callId)) n.delete(callId); else n.add(callId); return n; });
  const toggleAllTranscribeCalls = () =>
    setTranscribeSelected(allTranscribeSelected ? new Set() : new Set(transcribableCalls.map(c => c.call_id)));

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleFetchFromCRM = async () => {
    if (!selectedPair) return;
    const { crm, account } = getCrmAndAccount();
    if (!crm || !account) return;
    setFetchingCalls(true); setFetchCallsError(null);
    try {
      const res = await fetch(
        `${API}/crm/calls/${account}/refresh?crm_url=${encodeURIComponent(crm)}&agent=${encodeURIComponent(selectedPair.agent)}&customer=${encodeURIComponent(selectedPair.customer)}`,
        { method: "POST" },
      );
      const data = await res.json();
      if (data.error) { setFetchCallsError(data.error); return; }
      if (data.count > 0) await mutateCalls();
      const qs = new URLSearchParams({ crm_url: crm, account_id: account, agent: selectedPair.agent, customer: selectedPair.customer });
      const s3res = await fetch(`${API}/audio/s3-files?${qs}`);
      if (s3res.ok) setS3Files(await s3res.json());
    } catch (e: unknown) {
      setFetchCallsError(e instanceof Error ? e.message : String(e));
    } finally { setFetchingCalls(false); }
  };

  const handleDownload = async (callIds: string[]) => {
    if (!selectedPair) return;
    const { crm, account } = getCrmAndAccount();
    if (!crm || !account) return;
    if (callIds.length === 1) setDownloading(prev => new Set(prev).add(callIds[0]));
    setSyncingS3(callIds.length > 1);
    setFetchCallsError(null);
    await fetch(`${API}/crm/download`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crm_url: crm, agent: selectedPair.agent,
                              customer: selectedPair.customer, account_id: account,
                              call_ids: callIds }),
    });
    const prevCount = callsData?.calls.filter(c => c.downloaded).length ?? 0;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const updated = await mutateCalls();
      if ((updated?.calls.filter(c => c.downloaded).length ?? 0) > prevCount) break;
    }
    setSyncingS3(false);
    setDownloading(prev => { const s = new Set(prev); callIds.forEach(id => s.delete(id)); return s; });
  };

  const handleRemove = async (callIds: string[]) => {
    if (!selectedPair) return;
    callIds.forEach(id => setRemoving(prev => new Set(prev).add(id)));
    await Promise.all(callIds.map(id =>
      fetch(`${API}/audio/file/${id}?slug=${encodeURIComponent(selectedPair.slug)}`, { method: "DELETE" })
    ));
    setRemoving(prev => { const s = new Set(prev); callIds.forEach(id => s.delete(id)); return s; });
    setLocalSelected(new Set());
    mutateCalls();
  };

  const handleRemoveVariant = async (path: string) => {
    await fetch(`${API}/audio/variant?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    mutateCalls();
  };

  const runAudioJob = async (callIds: string[], variant: "enhanced" | "converted") => {
    if (!selectedPair) return;
    await Promise.all(callIds.map(async (cid) => {
      const call = downloadedCalls.find(c => c.call_id === cid);
      if (!call?.path) return;
      try {
        const res = await fetch(`${API}/jobs`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audio_path: call.path,
            pair_slug: selectedPair.slug,
            call_id: cid,
            speaker_a: speakerA || selectedPair.agent,
            speaker_b: speakerB || selectedPair.customer,
            stages: [1],
            engines: [],
            noise_reduction: variant === "enhanced" ? noiseReduction / 100 : 0.80,
            voice_isolation: variant === "enhanced" ? voiceIsolation : false,
            vad_trim: variant === "enhanced" ? vadTrim : false,
            llm_merge: false,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          setActiveJobs(prev => ({
            ...prev,
            [cid]: { job_id: data.job_id, stage: 0, pct: 0, message: "Queued", status: "pending" },
          }));
          connectJobStream(data.job_id, cid);
        }
      } catch { /* ignore */ }
    }));
    setLocalSelected(new Set());
  };

  const runTranscribeJob = async (callIds: string[]) => {
    if (!selectedPair) return;
    const batchId = callIds.length > 1 ? crypto.randomUUID() : undefined;
    if (callIds.length > 1) setLocalTab("logs"); // auto-switch to log view for batches
    await Promise.all(callIds.map(async (cid) => {
      const call = downloadedCalls.find(c => c.call_id === cid);
      if (!call?.path) return;
      try {
        const res = await fetch(`${API}/jobs`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audio_path: call.path,
            pair_slug: selectedPair.slug,
            call_id: cid,
            speaker_a: speakerA || selectedPair.agent,
            speaker_b: speakerB || selectedPair.customer,
            stages: [2, 4, 5],
            engines: ["elevenlabs_original"],
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
            [cid]: { job_id: data.job_id, stage: 0, pct: 0, message: "Queued", status: "pending" },
          }));
          connectJobStream(data.job_id, cid);
        }
      } catch { /* ignore */ }
    }));
    setTranscribeSelected(new Set());
  };

  const selectPair = (pair: Pair) => {
    setSelectedPair(pair); setLocalSelected(new Set()); setLibrarySelected(new Set()); setTranscribeSelected(new Set());
    setFetchCallsError(null); setS3Files(null);
    setSpeakerA(pair.agent ? pair.agent.split(" ")[0] : "");
    setSpeakerB(pair.customer ? pair.customer.split(" ")[0] : "");
    setSelectedAgent(pair.agent || pair.slug);
    const qs = new URLSearchParams({ agent: pair.agent, customer: pair.customer });
    if (pair.crm) qs.set("crm", pair.crm);
    if (pair.account_id) qs.set("account", pair.account_id);
    router.replace(`/audio?${qs.toString()}`);
  };

  const selectAgent = (agent: string) => {
    setSelectedAgent(agent);
    setSelectedPair(null); setLocalSelected(new Set()); setLibrarySelected(new Set()); setTranscribeSelected(new Set());
    setFetchCallsError(null); setS3Files(null);
    setActiveJobs({}); setCustomerSearch("");
    router.replace(`/audio?agent=${encodeURIComponent(agent)}`);
  };

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 text-gray-700 inline ml-1" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 text-indigo-400 inline ml-1" />
      : <ArrowDown className="w-3 h-3 text-indigo-400 inline ml-1" />;
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={`flex ${playingCall ? "h-[calc(100vh-3rem-72px)]" : "h-[calc(100vh-3rem)]"}`}>

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
          {loadingAgents && <p className="text-xs text-gray-600 p-2">Loading...</p>}
          {filteredAgents.map(({ agent, count }) => {
            const totalDl = (localPairs || []).filter(p => p.agent === agent).reduce((s, p) => s + p.audio_count, 0);
            return (
              <button key={agent} onClick={() => selectAgent(agent)}
                className={`w-full text-left px-2 py-2 rounded-lg text-xs transition-colors ${
                  selectedAgent === agent
                    ? "bg-indigo-600/20 border border-indigo-500/30 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Users className="w-3 h-3 text-indigo-400 shrink-0" />
                  <span className="font-medium truncate">{agent}</span>
                </div>
                <p className="text-gray-600 pl-[18px] text-[10px]">
                  {count} customer{count !== 1 ? "s" : ""}
                  {totalDl > 0 && ` · ${totalDl} downloaded`}
                </p>
              </button>
            );
          })}
          {!loadingAgents && filteredAgents.length === 0 && (
            <p className="text-xs text-gray-600 p-2 text-center">{agentSearch ? "No match" : "No agents"}</p>
          )}
        </div>
        <div className="p-2 border-t border-gray-800">
          <Link href="/crm" className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 px-1">
            <Users className="w-3 h-3" /> Browse CRM
          </Link>
        </div>
      </CollapsiblePanel>
      <DragHandle onMouseDown={agentDrag} />

      {/* ── Customer nav ── */}
      <CollapsiblePanel title="Customers" width={customerW} collapsed={customersCollapsed} onToggle={() => setCustomersCollapsed(c => !c)}>
        {!selectedAgent ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-600">Select an agent</p>
          </div>
        ) : (
          <>
            <div className="px-3 py-2.5 border-b border-gray-800">
              <h2 className="text-xs font-semibold text-white truncate">{selectedAgent}</h2>
              <p className="text-[10px] text-gray-600 mt-0.5">{customerList.length} customer{customerList.length !== 1 ? "s" : ""}</p>
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
              {filteredCustomers.map(c => {
                const slug = `${selectedAgent}/${c.customer}`;
                const local = localPairMap.get(slug);
                return (
                  <button key={slug} onClick={() => selectPair({
                    slug, agent: selectedAgent!, customer: c.customer,
                    crm: c.crm_url, account_id: c.account_id,
                    audio_count: local?.audio_count ?? 0,
                    total_size_bytes: local?.total_size_bytes ?? 0,
                  })}
                    className={`w-full text-left px-2 py-2 rounded-lg text-xs transition-colors ${
                      selectedPair?.slug === slug
                        ? "bg-indigo-600/20 border border-indigo-500/30 text-white"
                        : "text-gray-400 hover:bg-gray-800 hover:text-white"
                    }`}>
                    <span className="font-medium truncate block">{c.customer || "—"}</span>
                    <p className="text-gray-700 text-[10px] mt-0.5">
                      {c.call_count ?? 0} call{(c.call_count ?? 0) !== 1 ? "s" : ""}{local?.audio_count ? ` · ${local.audio_count} downloaded` : ""}
                    </p>
                  </button>
                );
              })}
              {filteredCustomers.length === 0 && (
                <p className="text-xs text-gray-600 p-2 text-center">{customerSearch ? "No match" : "No customers"}</p>
              )}
            </div>
          </>
        )}
      </CollapsiblePanel>
      <DragHandle onMouseDown={customerDrag} />

      {/* ── Library panel (all calls + download) ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {!selectedPair ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
            <Mic2 className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">Select a pair to see their calls</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <div>
                <h1 className="text-lg font-bold text-white">{selectedPair.agent}</h1>
                <p className="text-xs text-gray-500">
                  {selectedPair.customer && `${selectedPair.customer} · `}
                  {callsData?.crm_url?.replace(/https?:\/\//, "") || selectedPair.crm?.replace(/https?:\/\//, "")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => mutateCalls()} className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg transition-colors">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                {(callsData?.crm_url || selectedPair?.crm || searchParams.get("crm")) &&
                 (callsData?.account_id || selectedPair?.account_id || searchParams.get("account")) && (
                  <button onClick={handleFetchFromCRM} disabled={fetchingCalls || syncingS3}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 text-white text-xs rounded-lg transition-colors">
                    {fetchingCalls ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    {fetchingCalls ? "Fetching..." : s3Files ? `${s3Files.length} calls · Refresh` : "Fetch from CRM"}
                  </button>
                )}
              </div>
            </div>

            {/* Error banner */}
            {fetchCallsError && (
              <div className="flex items-center justify-between mb-3 px-3 py-2 bg-red-900/20 border border-red-800/40 rounded-lg text-xs text-red-400">
                <span>CRM: {fetchCallsError.slice(0, 120)}</span>
                <button onClick={() => setFetchCallsError(null)} className="ml-2 text-red-600 hover:text-red-400">✕</button>
              </div>
            )}

            {/* Bulk download bar */}
            {selectedForDownload.length > 0 && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-indigo-900/20 border border-indigo-700/30 rounded-lg">
                <span className="text-xs text-gray-400">{selectedForDownload.length} call{selectedForDownload.length !== 1 ? "s" : ""} selected</span>
                {(() => {
                  const totalBytes = selectedForDownload.reduce((s, c) => s + (c.size_bytes ?? 0), 0);
                  const totalSecs  = selectedForDownload.reduce((s, c) => s + (c.duration_s ?? 0), 0);
                  return (
                    <span className="text-xs text-gray-500">
                      {totalBytes > 0 ? fmtBytes(totalBytes) : "size unknown"}
                      {totalSecs > 0 && <span className="text-gray-600"> · {formatDuration(totalSecs)}</span>}
                    </span>
                  );
                })()}
                {minDurationS > 0 && <span className="text-[10px] text-indigo-400">≥ {formatDuration(minDurationS)} only</span>}
                <button
                  onClick={() => { handleDownload(selectedForDownload.map(c => c.call_id)); setLibrarySelected(new Set()); }}
                  disabled={syncingS3}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs rounded-md transition-colors">
                  <Download className="w-3 h-3" /> Download {selectedForDownload.length}
                </button>
                <button onClick={() => setLibrarySelected(new Set())} className="ml-auto p-1 text-gray-600 hover:text-gray-400">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* Bulk transcribe bar */}
            {selectedForTranscribe.length > 0 && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-amber-900/20 border border-amber-700/30 rounded-lg">
                <button onClick={toggleAllTranscribeCalls}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 shrink-0">
                  {allTranscribeSelected
                    ? <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                    : <Square className="w-3.5 h-3.5 text-gray-600" />}
                  {selectedForTranscribe.length} / {transcribableCalls.length}
                </button>
                <button
                  onClick={() => runTranscribeJob(selectedForTranscribe.map(c => c.call_id))}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-xs rounded-md transition-colors">
                  <Mic2 className="w-3 h-3" /> Transcribe {selectedForTranscribe.length}
                </button>
                <span className="text-[10px] text-amber-600/70">ElevenLabs only</span>
                <button onClick={() => setTranscribeSelected(new Set())} className="ml-auto p-1 text-gray-600 hover:text-gray-400">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* ── Filter + Sort toolbar ── */}
            <div className="flex flex-col gap-2 mb-3">
              {/* Row 1: Download status + Status filter */}
              <div className="flex items-center gap-1 flex-wrap">
                <SlidersHorizontal className="w-3 h-3 text-gray-600 shrink-0" />
                {([
                  { key: "all" as DlFilter, label: "All", count: counts.all },
                  { key: "downloaded" as DlFilter, label: "Downloaded", count: counts.downloaded },
                  { key: "not_downloaded" as DlFilter, label: "Not DL", count: counts.not_downloaded },
                ]).map(({ key, label, count }) => (
                  <button key={key} onClick={() => setDlFilter(key)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      dlFilter === key ? "bg-gray-700 text-white" : "text-gray-600 hover:text-gray-300"
                    }`}>
                    {label} <span className="text-gray-500 ml-0.5">{count}</span>
                  </button>
                ))}
                <span className="text-gray-700 mx-0.5">|</span>
                {([
                  { key: "all" as StatusFilter, label: "Any status" },
                  { key: "transcribed" as StatusFilter, label: "Transcribed" },
                  { key: "not_transcribed" as StatusFilter, label: "Not transcribed" },
                ]).map(({ key, label }) => (
                  <button key={key} onClick={() => setStatusFilter(key)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      statusFilter === key
                        ? key === "transcribed" ? "bg-emerald-900/50 text-emerald-300"
                        : key === "not_transcribed" ? "bg-amber-900/50 text-amber-300"
                        : "bg-gray-700 text-white"
                        : "text-gray-600 hover:text-gray-300"
                    }`}>
                    {label}
                  </button>
                ))}
                <span className="ml-auto text-[11px] text-gray-600">
                  {filteredCalls.length} / {allCalls.length}
                </span>
              </div>

              {/* Row 2: Duration slider */}
              <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                <span className="text-[10px] text-gray-500 shrink-0 font-medium">Min duration</span>
                <input
                  type="range"
                  min={0}
                  max={maxDurationAll}
                  step={30}
                  value={minDurationS}
                  onChange={e => setMinDurationS(Number(e.target.value))}
                  className="flex-1 accent-indigo-500 h-1"
                />
                <span className="text-xs font-mono text-indigo-300 shrink-0 w-16 text-right">
                  {minDurationS === 0 ? "any" : `≥ ${formatDuration(minDurationS)}`}
                </span>
                {minDurationS > 0 && (
                  <button onClick={() => setMinDurationS(0)}
                    className="text-gray-600 hover:text-gray-400 shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Calls table */}
            <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
              <div className="grid text-xs text-gray-500 font-medium border-b border-gray-800 px-4 py-2 items-center"
                style={{ gridTemplateColumns: "20px 1fr 100px 110px 80px 64px" }}>
                {downloadableCalls.length > 0 ? (
                  <button onClick={toggleAllLibraryCalls} className="flex items-center" title="Select all for download">
                    {allLibrarySelected
                      ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                      : <Square className="w-3.5 h-3.5 text-gray-700" />}
                  </button>
                ) : transcribableCalls.length > 0 ? (
                  <button onClick={toggleAllTranscribeCalls} className="flex items-center" title="Select all for transcription">
                    {allTranscribeSelected
                      ? <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                      : <Square className="w-3.5 h-3.5 text-gray-700" />}
                  </button>
                ) : (
                  <Square className="w-3.5 h-3.5 text-gray-800" />
                )}
                <button onClick={() => toggleSort("call_id")}
                  className="flex items-center gap-0.5 hover:text-gray-300 transition-colors text-left">
                  Call ID <SortIcon field="call_id" />
                </button>
                <button onClick={() => toggleSort("date")}
                  className="flex items-center gap-0.5 hover:text-gray-300 transition-colors text-left">
                  Date <SortIcon field="date" />
                </button>
                <button onClick={() => toggleSort("duration")}
                  className="flex items-center gap-0.5 hover:text-gray-300 transition-colors text-left">
                  Duration <SortIcon field="duration" />
                </button>
                <span className="text-right">Size</span>
                <span></span>
              </div>

              <div className="flex-1 overflow-y-auto">
                {loadingCalls && <p className="text-center py-10 text-gray-600 text-sm">Loading...</p>}
                {fetchingCalls && filteredCalls.length > 0 && (
                  <div className="flex items-center gap-2 px-4 py-1.5 bg-indigo-950/40 border-b border-indigo-800/20 text-xs text-indigo-400">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                    Fetching calls from CRM…
                  </div>
                )}
                {filteredCalls.map(call => {
                  const isDling = downloading.has(call.call_id);
                  const isLibSel = librarySelected.has(call.call_id);
                  return (
                    <div key={call.call_id}
                      className={`group grid px-4 py-2 items-center text-sm border-l-2 hover:bg-gray-800/30 transition-colors ${isLibSel ? "bg-indigo-900/10 border-indigo-700/30" : "border-transparent hover:border-gray-700"}`}
                      style={{ gridTemplateColumns: "20px 1fr 100px 110px 80px 64px" }}>
                      <span className="flex items-center">
                        {!call.downloaded ? (
                          <button onClick={e => { e.stopPropagation(); toggleLibraryCall(call.call_id); }}>
                            {isLibSel
                              ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                              : <Square className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400" />}
                          </button>
                        ) : call.status !== "transcribed" ? (
                          <button onClick={e => { e.stopPropagation(); toggleTranscribeCall(call.call_id); }}>
                            {transcribeSelected.has(call.call_id)
                              ? <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                              : <Square className="w-3.5 h-3.5 text-gray-700 group-hover:text-gray-500" />}
                          </button>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2 min-w-0">
                        <FileAudio className={`w-3.5 h-3.5 shrink-0 ${
                          call.downloaded ? "text-emerald-400" : "text-gray-600"
                        }`} />
                        <span className="font-mono text-xs text-gray-300 truncate">{call.call_id}</span>
                        {isDling && <span className="text-[10px] text-indigo-400 animate-pulse shrink-0">↓</span>}
                      </span>
                      <span className="text-xs text-gray-500">{formatDate(call.date)}</span>
                      <DurationBar duration_s={call.duration_s} maxDuration={maxDuration} />
                      <span className="text-xs text-right text-gray-600">{fmtBytes(call.size_bytes)}</span>
                      <span className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={e => e.stopPropagation()}>
                        {isDling ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />
                        ) : !call.downloaded ? (
                          <button onClick={() => handleDownload([call.call_id])} disabled={syncingS3}
                            className="p-1 rounded text-gray-500 hover:text-indigo-400 disabled:opacity-40 transition-colors"
                            title="Download">
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <span className="w-2 h-2 rounded-full bg-emerald-500/60" title="Downloaded" />
                        )}
                      </span>
                    </div>
                  );
                })}
                {!loadingCalls && filteredCalls.length === 0 && fetchingCalls && (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
                    <p className="text-sm text-gray-300">Fetching calls from CRM…</p>
                    <p className="text-xs text-gray-600">This may take a moment</p>
                  </div>
                )}
                {!loadingCalls && filteredCalls.length === 0 && !fetchingCalls && (
                  <p className="text-center py-10 text-gray-600 text-sm">No calls found</p>
                )}
              </div>

              <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex items-center justify-between">
                <span>
                  {filteredCalls.length} shown · {allCalls.length} total · {counts.downloaded} downloaded
                  {minDurationS > 0 && <span className="text-indigo-400/70 ml-2">≥ {formatDuration(minDurationS)}</span>}
                </span>
                {!callsData?.has_metadata && s3Files && (
                  <span className="text-yellow-600/60">S3 listing only</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Local Files panel (downloaded) ── */}
      <DragHandle onMouseDown={rightDrag} />
      <CollapsiblePanel title="Local Files" width={rightW} collapsed={localFilesCollapsed} onToggle={() => setLocalFilesCollapsed(c => !c)}>
        {!selectedPair ? (
          <div className="flex-1 flex items-center justify-center text-gray-600">
            <p className="text-sm text-center px-4">Select a pair to view local files</p>
          </div>
        ) : (
          <>
          {/* Panel tabs */}
          <div className="flex border-b border-gray-800">
            {(["files", "settings", "logs"] as const).map(tab => {
              const runningCount = Object.values(activeJobs).filter(j => j.status === "running" || j.status === "pending").length;
              const label = tab === "files"    ? `Files (${downloadedCalls.length})`
                          : tab === "settings" ? "Settings"
                          : "Logs";
              return (
                <button key={tab} onClick={() => setLocalTab(tab)}
                  className={`flex-1 py-2.5 text-xs font-medium transition-colors relative ${
                    localTab === tab ? "text-white border-b-2 border-indigo-500" : "text-gray-500 hover:text-gray-300"
                  }`}>
                  {label}
                  {tab === "logs" && runningCount > 0 && (
                    <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Files tab */}
          {localTab === "files" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Batch bar */}
              {localSelected.size > 0 && (
                <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-gray-500">{localSelected.size} calls selected</span>
                  <button onClick={() => runAudioJob(Array.from(localSelected), "enhanced")}
                    className="flex items-center gap-1 px-2 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-[11px] rounded-md transition-colors">
                    <Zap className="w-3 h-3" /> Enhance
                  </button>
                  <button onClick={() => runAudioJob(Array.from(localSelected), "converted")}
                    className="flex items-center gap-1 px-2 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-[11px] rounded-md transition-colors">
                    <RotateCcw className="w-3 h-3" /> Convert
                  </button>
                  <button onClick={() => handleRemove(Array.from(localSelected))}
                    className="p-1 text-red-500/70 hover:text-red-400 transition-colors ml-auto" title="Remove calls">
                    <Trash2 className="w-3 h-3" />
                  </button>
                  <button onClick={() => setLocalSelected(new Set())} className="text-gray-600 hover:text-gray-400 text-[10px]">✕</button>
                </div>
              )}

              {/* Select all */}
              {downloadedCalls.length > 0 && localSelected.size === 0 && (
                <div className="px-3 py-1.5 border-b border-gray-800/50 flex items-center justify-between shrink-0">
                  <button onClick={toggleAllLocal}
                    className="flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors">
                    <Square className="w-3 h-3" /> Select all
                  </button>
                  <span className="text-[10px] text-gray-700">{downloadedCalls.length} calls</span>
                </div>
              )}

              <div className="flex-1 overflow-y-auto">
                {downloadedCalls.length === 0 && (
                  <p className="text-center py-10 text-gray-600 text-sm">No downloaded files</p>
                )}

                {downloadedCalls.map(call => {
                  const job = activeJobs[call.call_id];
                  const jobActive = job && (job.status === "pending" || job.status === "running");
                  const isSel     = localSelected.has(call.call_id);
                  const isRmv     = removing.has(call.call_id);
                  const isExpanded = expandedCalls.has(call.call_id);
                  const vfiles    = call.variant_files.length > 0
                    ? call.variant_files
                    : call.path ? [{ name: "original", path: call.path, size_bytes: call.size_bytes ?? 0 }] : [];

                  return (
                    <div key={call.call_id} className={`border-b border-gray-800/40 ${isRmv ? "opacity-40" : ""}`}>
                      {/* ── Call group header ── */}
                      <div className={`flex items-center gap-1.5 px-2 py-2 transition-colors ${
                        isSel ? "bg-indigo-600/8" : ""
                      }`}>
                        {/* Checkbox */}
                        <button onClick={() => toggleLocal(call.call_id)} className="shrink-0">
                          {isSel
                            ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                            : <Square className="w-3.5 h-3.5 text-gray-600" />}
                        </button>

                        {/* Expand toggle */}
                        <button
                          onClick={() => setExpandedCalls(prev => {
                            const n = new Set(prev);
                            if (n.has(call.call_id)) n.delete(call.call_id); else n.add(call.call_id);
                            return n;
                          })}
                          className="flex items-center gap-1 flex-1 min-w-0 text-left">
                          <ChevronRight className={`w-3 h-3 shrink-0 text-gray-600 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                          <FileAudio className={`w-3 h-3 shrink-0 ${jobActive ? "text-indigo-400 animate-pulse" : "text-emerald-400"}`} />
                          <span className="font-mono text-[11px] text-gray-300 truncate ml-0.5">{call.call_id}</span>
                          <span className="text-[10px] text-gray-700 shrink-0 ml-1">{vfiles.length}</span>
                        </button>

                        {/* Enhance / Convert buttons — operate on original */}
                        <button onClick={() => runAudioJob([call.call_id], "enhanced")} disabled={!!jobActive}
                          className="shrink-0 p-1 rounded text-gray-600 hover:text-emerald-400 disabled:opacity-30 transition-colors" title="Enhance">
                          <Zap className="w-3 h-3" />
                        </button>
                        <button onClick={() => runAudioJob([call.call_id], "converted")} disabled={!!jobActive}
                          className="shrink-0 p-1 rounded text-gray-600 hover:text-blue-400 disabled:opacity-30 transition-colors" title="Convert">
                          <RotateCcw className="w-3 h-3" />
                        </button>
                        <button onClick={() => handleRemove([call.call_id])} disabled={isRmv}
                          className="shrink-0 p-1 rounded text-gray-700 hover:text-red-400 disabled:opacity-30 transition-colors" title="Remove call">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>

                      {/* Job progress under header */}
                      {jobActive && (
                        <div className="px-8 pb-1.5">
                          <div className="h-[2px] bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                              style={{ width: `${job.pct}%` }} />
                          </div>
                          <p className="text-[10px] text-indigo-400/80 mt-0.5">
                            {STAGE_LABELS[job.stage] ?? "Running"} · {job.pct}%
                          </p>
                        </div>
                      )}
                      {job?.status === "failed" && (
                        <p className="px-8 pb-1.5 text-[10px] text-red-400 truncate">✕ {job.message.slice(0, 50)}</p>
                      )}

                      {/* ── Variant rows (expanded) ── */}
                      {isExpanded && vfiles.map(v => {
                        const vs = VARIANT_STYLE[v.name] ?? VARIANT_STYLE.original;
                        const isPlaying = playingCall?.call_id === call.call_id
                          && activeVersion?.path === v.path;
                        return (
                          <div key={v.path}
                            className="flex items-center gap-2 pl-8 pr-2 py-1.5 bg-gray-900/40 border-t border-gray-800/30 hover:bg-gray-800/30 transition-colors">
                            {/* Variant badge */}
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${vs.pill}`}>
                              {v.name}
                            </span>
                            <span className="text-[10px] text-gray-600 shrink-0">{fmtBytes(v.size_bytes)}</span>
                            <span className="flex-1" />
                            {/* Play */}
                            <button
                              onClick={() => {
                                if (isPlaying) {
                                  setPlayingCall(null); setActiveVersion(null);
                                } else {
                                  setPlayingCall(call);
                                  setActiveVersion({ type: v.name as AudioVersion["type"], path: v.path, label: v.name.charAt(0).toUpperCase() + v.name.slice(1) });
                                }
                              }}
                              className={`p-1 rounded transition-colors ${isPlaying ? "text-emerald-400" : "text-gray-600 hover:text-gray-300"}`}
                              title="Play">
                              <Play className="w-3 h-3" />
                            </button>
                            {/* Transcripts link (only for original if transcribed) */}
                            {v.name === "original" && call.status === "transcribed" && (
                              <Link href="/transcription" className="p-1 rounded text-gray-600 hover:text-yellow-400 transition-colors" title="View transcripts">
                                <FileText className="w-3 h-3" />
                              </Link>
                            )}
                            {/* Delete variant (not original) */}
                            {v.name !== "original" && (
                              <button onClick={() => handleRemoveVariant(v.path)}
                                className="p-1 rounded text-gray-700 hover:text-red-400 transition-colors" title="Delete this variant">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Logs tab */}
          {localTab === "logs" && <LogStream />}

          {/* Settings tab */}
          {localTab === "settings" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-3">Enhancement Settings</p>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between mb-1.5">
                      <span className="text-xs text-gray-400">Noise Reduction</span>
                      <span className="text-xs text-gray-400 font-mono">{noiseReduction}%</span>
                    </div>
                    <input type="range" min="0" max="100" value={noiseReduction}
                      onChange={e => setNoiseReduction(parseInt(e.target.value))}
                      className="w-full accent-indigo-500 h-1" />
                    <p className="text-[10px] text-gray-600 mt-1">Converted uses fixed 80%</p>
                  </div>

                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs text-gray-400">Voice Isolation</span>
                      <p className="text-[10px] text-gray-600">Separate voices from background</p>
                    </div>
                    <Toggle checked={voiceIsolation} onChange={setVoiceIsolation} />
                  </label>

                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs text-gray-400">VAD Trim</span>
                      <p className="text-[10px] text-gray-600">Remove silence at start/end</p>
                    </div>
                    <Toggle checked={vadTrim} onChange={setVadTrim} />
                  </label>
                </div>
              </div>

              <div className="border-t border-gray-800" />

              <div>
                <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold mb-3">Speakers</p>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] text-gray-600 block mb-1">Agent (Speaker A)</label>
                    <input value={speakerA} onChange={e => setSpeakerA(e.target.value)}
                      placeholder={selectedPair?.agent || "Agent name"}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none" />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-600 block mb-1">Customer (Speaker B)</label>
                    <input value={speakerB} onChange={e => setSpeakerB(e.target.value)}
                      placeholder={selectedPair?.customer || "Customer name"}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none" />
                  </div>
                </div>
              </div>

              <div className="border-t border-gray-800" />

              <div className="space-y-1.5">
                <p className="text-[10px] text-gray-600">
                  <span className="text-emerald-400 font-medium">Enhance</span> — applies above settings
                </p>
                <p className="text-[10px] text-gray-600">
                  <span className="text-blue-400 font-medium">Convert</span> — fixed 80% NR, no isolation
                </p>
              </div>
            </div>
          )}
          </>
        )}
      </CollapsiblePanel>

      {/* ── Audio Player ── */}
      {playingCall && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-gray-950 border-t border-gray-800 px-4 py-3">
          <div className="flex items-center gap-4">
            <div className="w-48 shrink-0">
              <p className="text-xs font-mono text-white truncate">{playingCall.call_id}</p>
              <p className="text-[10px] text-gray-500 truncate">{selectedPair?.agent} · {selectedPair?.customer}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(versions || []).map(v => (
                <button key={v.type} onClick={() => setActiveVersion(v)}
                  className={`px-2.5 py-1 text-[10px] font-medium rounded transition-colors ${
                    activeVersion?.type === v.type
                      ? v.type === "original" ? "bg-gray-600 text-white"
                        : v.type === "converted" ? "bg-blue-600 text-white"
                        : "bg-emerald-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:text-white"
                  }`}>{v.label}</button>
              ))}
            </div>
            <audio ref={audioRef} key={activeVersion?.path}
              src={activeVersion ? `${API}/audio/serve?path=${encodeURIComponent(activeVersion.path)}` : undefined}
              controls autoPlay className="flex-1 h-8" />
            <button onClick={() => { setPlayingCall(null); setActiveVersion(null); }}
              className="shrink-0 p-1 text-gray-600 hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
