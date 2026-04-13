"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { getPersonas, deletePersona } from "@/lib/api";
import { Persona } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { CollapsiblePanel } from "@/components/shared/CollapsiblePanel";
import {
  SectionCard, SectionNav, parsePersonaSections, MD,
} from "@/components/personas/PersonaSections";
import {
  Brain, Users, User, Search, Loader2, Trash2,
  FileText, ChevronRight, X, Sparkles,
  TrendingUp, TrendingDown, Minus, Download, Code, Eye, Pencil, Check,
} from "lucide-react";
import { PersonaSection } from "@/components/personas/SectionBuilder";

// ── Type badge helpers ───────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  agent_overall: "text-violet-400 bg-violet-500/10 border-violet-500/30",
  pair:          "text-indigo-400 bg-indigo-500/10 border-indigo-500/30",
  customer:      "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
};

function TypeIcon({ type }: { type: string }) {
  if (type === "agent_overall") return <Brain className="w-3 h-3 text-violet-400" />;
  if (type === "pair") return <Users className="w-3 h-3 text-indigo-400" />;
  return <User className="w-3 h-3 text-emerald-400" />;
}

// ── Transcript path parser ───────────────────────────────────────────────────

interface ParsedTranscript {
  callId: string;
  agent: string;
  customer: string;
  engine: string;
  subType: string;
  fileName: string;
  raw: string;
}

function parseTranscriptPath(p: string): ParsedTranscript {
  const parts = p.replace(/\\/g, "/").split("/");
  const dataIdx = parts.findIndex(s => s === "data");
  const agent = dataIdx >= 0 ? parts[dataIdx + 1] ?? "" : "";
  const customer = dataIdx >= 0 ? parts[dataIdx + 2] ?? "" : "";
  const transIdx = parts.findIndex(s => s === "transcribed");
  const subType = transIdx >= 0 ? parts[transIdx + 1] ?? "" : "";
  const callId = transIdx > 0 ? parts[transIdx - 1] ?? "" : "";
  const engine = transIdx >= 0 ? parts[transIdx + 2] ?? "" : "";
  const fileName = parts[parts.length - 1] ?? "";
  return { callId, agent, customer, engine, subType, fileName, raw: p };
}

// ── sessionStorage helpers ────────────────────────────────────────────────────

function _pss(k: string) { try { return sessionStorage.getItem(`personas_${k}`) ?? ""; } catch { return ""; } }
function _pssSet(k: string, v: string) { try { sessionStorage.setItem(`personas_${k}`, v); } catch {} }

// ── System Notes panel ───────────────────────────────────────────────────────

function SystemNotesPanel({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false);

  // Split raw markdown into per-call blocks on "System Note – Call N" headings
  const blocks = (() => {
    const lines = notes.split("\n");
    const result: { title: string; body: string }[] = [];
    let cur: { title: string; lines: string[] } | null = null;
    for (const line of lines) {
      const m = line.match(/^#+\s+System Note\s*[–-]\s*(.+)$/i)
               ?? line.match(/^---\s*$/) && null;
      if (line.match(/^#+\s+System Note\s*[–-]\s*/i)) {
        if (cur) result.push({ title: cur.title, body: cur.lines.join("\n").trim() });
        const title = line.replace(/^#+\s+System Note\s*[–-]\s*/i, "").trim();
        cur = { title, lines: [] };
      } else if (line.match(/^#{1,3}\s+(GLOBAL COMPLIANCE SUMMARY)/i)) {
        if (cur) result.push({ title: cur.title, body: cur.lines.join("\n").trim() });
        cur = { title: "Global Compliance Summary", lines: [line] };
      } else {
        cur?.lines.push(line);
      }
    }
    if (cur) result.push({ title: cur.title, body: cur.lines.join("\n").trim() });
    return result.filter(b => b.body.trim());
  })();

  // If parsing found nothing meaningful, show raw text
  if (blocks.length === 0) {
    return (
      <div className="pt-2 border-t border-gray-800">
        <p className="text-[10px] font-semibold text-sky-400 uppercase tracking-wider mb-1">System Notes</p>
        <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap leading-relaxed">{notes}</pre>
      </div>
    );
  }

  return (
    <div className="pt-2 border-t border-gray-800">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center justify-between w-full mb-2 group"
      >
        <p className="text-[10px] font-semibold text-sky-400 uppercase tracking-wider">
          System Notes ({blocks.length} blocks)
        </p>
        <span className="text-[10px] text-gray-600 group-hover:text-gray-400 transition-colors">
          {expanded ? "Collapse" : "Expand"}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2">
          {blocks.map((block, i) => (
            <CallNoteBlock key={i} title={block.title} body={block.body} />
          ))}
        </div>
      )}
    </div>
  );
}

function CallNoteBlock({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);

  // Parse COMPLIANT / VIOLATION lines out of body
  const complianceLines = body.split("\n").filter(l =>
    l.includes("[COMPLIANT]") || l.includes("[VIOLATION]")
  );
  const hasViolation = complianceLines.some(l => l.includes("[VIOLATION]"));
  const allCompliant = complianceLines.length > 0 && !hasViolation;

  const borderColor = allCompliant
    ? "border-emerald-800/50"
    : hasViolation
    ? "border-red-900/50"
    : "border-gray-800";

  return (
    <div className={`border rounded-lg overflow-hidden ${borderColor}`}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-gray-800/30 hover:bg-gray-800/50 transition-colors text-left"
      >
        <span className="text-[10px] font-medium text-gray-300">{title}</span>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {complianceLines.length > 0 && (
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${allCompliant ? "bg-emerald-900/40 text-emerald-400" : "bg-red-900/40 text-red-400"}`}>
              {complianceLines.filter(l => l.includes("[VIOLATION]")).length}V / {complianceLines.filter(l => l.includes("[COMPLIANT]")).length}C
            </span>
          )}
          <span className="text-[10px] text-gray-600">{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && (
        <div className="px-3 py-2 space-y-1">
          {body.split("\n").map((line, i) => {
            if (line.includes("[COMPLIANT]")) {
              return <p key={i} className="text-[10px] text-emerald-400 leading-relaxed">{line.trim()}</p>;
            }
            if (line.includes("[VIOLATION]")) {
              return <p key={i} className="text-[10px] text-red-400 leading-relaxed">{line.trim()}</p>;
            }
            if (line.match(/^#{1,4}\s/)) {
              return <p key={i} className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mt-2">{line.replace(/^#+\s+/, "")}</p>;
            }
            if (line.trim().startsWith("- ")) {
              return <p key={i} className="text-[10px] text-gray-500 pl-2 leading-relaxed">• {line.trim().slice(2)}</p>;
            }
            if (line.trim() === "---" || line.trim() === "") return null;
            return <p key={i} className="text-[10px] text-gray-500 leading-relaxed">{line}</p>;
          })}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PersonasPage() {
  const router = useRouter();
  const [presetW, presetDrag]     = useResize(148, 100, 220);
  const [agentW, agentDrag]       = useResize(160, 120, 280);
  const [customerW, customerDrag] = useResize(160, 120, 280);
  const [listW, listDrag]         = useResize(240, 180, 380);

  const [presetCollapsed, setPresetCollapsed]       = useState(false);
  const [agentsCollapsed, setAgentsCollapsed]       = useState(false);
  const [customersCollapsed, setCustomersCollapsed] = useState(false);
  const [listCollapsed, setListCollapsed]           = useState(false);

  // Preset filter (persisted)
  const [filterPreset, _setFilterPreset] = useState<string | null>(null);
  const setFilterPreset = (v: string | null) => { _setFilterPreset(v); _pssSet("filterPreset", v ?? ""); };

  // Nav state (persisted) — start from safe defaults to match SSR; restored post-mount
  const [selectedAgent, _setSelectedAgent]       = useState<string | null>(null);
  const [selectedCustomer, _setSelectedCustomer] = useState<string | null>(null);
  const [agentSearch, _setAgentSearch]           = useState("");
  const [customerSearch, _setCustomerSearch]     = useState("");
  const [typeFilter, _setTypeFilter]             = useState<"" | "agent_overall" | "pair" | "customer">("");

  const setSelectedAgent   = (v: string | null) => { _setSelectedAgent(v);   _pssSet("selectedAgent",   v ?? ""); };
  const setSelectedCustomer = (v: string | null) => { _setSelectedCustomer(v); _pssSet("selectedCustomer", v ?? ""); };
  const setAgentSearch     = (v: string)         => { _setAgentSearch(v);     _pssSet("agentSearch",     v); };
  const setCustomerSearch  = (v: string)         => { _setCustomerSearch(v);  _pssSet("customerSearch",  v); };
  const setTypeFilter      = (v: "" | "agent_overall" | "pair" | "customer") => { _setTypeFilter(v); _pssSet("typeFilter", v); };

  // Selection / tabs (persisted) — start from safe defaults; restored post-mount
  const [selectedId, _setSelectedId] = useState<string | null>(null);
  const [activeTab, _setActiveTab]   = useState<"content" | "transcripts" | "prompts" | "score">("content");
  const setSelectedId = (v: string | null) => { _setSelectedId(v); _pssSet("selectedId", v ?? ""); };
  const setActiveTab  = (v: "content" | "transcripts" | "prompts" | "score") => { _setActiveTab(v); _pssSet("activeTab", v); };

  // Restore persisted state after mount (avoid SSR/hydration mismatch)
  useEffect(() => {
    _setFilterPreset(_pss("filterPreset") || null);
    _setSelectedAgent(_pss("selectedAgent") || null);
    _setSelectedCustomer(_pss("selectedCustomer") || null);
    _setAgentSearch(_pss("agentSearch"));
    _setCustomerSearch(_pss("customerSearch"));
    _setTypeFilter((_pss("typeFilter") as "" | "agent_overall" | "pair" | "customer") || "");
    _setSelectedId(_pss("selectedId") || null);
    _setActiveTab((_pss("activeTab") as "content" | "transcripts" | "prompts" | "score") || "content");
  }, []);


  // Delete
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]         = useState(false);

  // Rename
  const [renaming, setRenaming]   = useState(false);
  const [renameValue, setRenameValue] = useState("");

  // Content view toggle
  const [contentView, setContentView] = useState<"preview" | "raw">("preview");

  // Transcript inline viewer
  const [selectedTranscriptIdx, setSelectedTranscriptIdx] = useState<number | "merged" | null>(null);
  const [transcriptContent, setTranscriptContent] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  // Score toggles
  const [showRawScore, setShowRawScore] = useState(false);
  const [showNormJson, setShowNormJson] = useState(false);

  const [revalidateKey, setRevalidateKey] = useState(0);

  // ── Data ──────────────────────────────────────────────────────────────────

  const { data: personas } = useSWR<Persona[]>(
    `/all-personas-${revalidateKey}`,
    () => getPersonas() as Promise<Persona[]>,
  );

  const { data: _personaAgentsRaw } = useSWR<{id: string; name: string; persona_type?: string; is_default?: boolean; sections?: unknown[]}[]>(
    "/all-persona-agents",
    () => fetch("/api/persona-agents").then(r => r.json()),
    { revalidateOnFocus: false },
  );
  // Guard against non-array responses (e.g. 404 error objects)
  const personaAgents = Array.isArray(_personaAgentsRaw) ? _personaAgentsRaw : undefined;

  const { data: persona } = useSWR<Persona>(
    selectedId ? `/personas/${selectedId}-${revalidateKey}` : null,
    () => fetch("/api/personas/" + selectedId).then(r => r.json()),
  );

  const { data: scriptData } = useSWR<{ script: string; size_chars: number }>(
    selectedId && persona?.script_path ? `/personas/${selectedId}/script` : null,
    (key: string) => fetch("/api" + key).then(r => r.ok ? r.json() : null),
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!persona) return;
    setConfirmDelete(false);
    setRenaming(false);
    setShowRawScore(false);
    setShowNormJson(false);
    setSelectedTranscriptIdx(null);
    setTranscriptContent(null);
    setContentView("preview");
  }, [persona?.id]);


  // ── Derived nav data ──────────────────────────────────────────────────────

  // Personas filtered by selected preset (all if none selected)
  const presetPersonas = useMemo(() => {
    const all = personas ?? [];
    if (!filterPreset) return all;
    return all.filter(p => p.persona_agent_id === filterPreset);
  }, [personas, filterPreset]);

  const agents = useMemo(() => {
    const names = new Set(presetPersonas.map(p => p.agent));
    return Array.from(names).sort().filter(a =>
      !agentSearch || a.toLowerCase().includes(agentSearch.toLowerCase())
    );
  }, [presetPersonas, agentSearch]);

  const agentPersonas = useMemo(() =>
    selectedAgent ? presetPersonas.filter(p => p.agent === selectedAgent) : [],
    [presetPersonas, selectedAgent]
  );

  const customers = useMemo(() => {
    const names = new Set(agentPersonas.filter(p => p.customer).map(p => p.customer!));
    return Array.from(names).sort().filter(c =>
      !customerSearch || c.toLowerCase().includes(customerSearch.toLowerCase())
    );
  }, [agentPersonas, customerSearch]);

  const filteredPersonas = useMemo(() => {
    let list = agentPersonas;
    if (selectedCustomer) list = list.filter(p => p.customer === selectedCustomer);
    if (typeFilter) list = list.filter(p => p.type === typeFilter);
    return list;
  }, [agentPersonas, selectedCustomer, typeFilter]);

  // When no agent is selected, show all recent personas (sorted by date)
  const recentPersonas = useMemo(() => {
    if (selectedAgent) return [];
    return [...presetPersonas]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [presetPersonas, selectedAgent]);

  const transcripts: ParsedTranscript[] = (() => {
    if (!persona?.transcript_paths) return [];
    try { return (JSON.parse(persona.transcript_paths) as string[]).map(parseTranscriptPath); }
    catch { return []; }
  })();

  const sections = persona ? parsePersonaSections(persona.content_md) : [];

  // Scores per section from stored score_json
  const sectionScores: Record<string, number> = (() => {
    try {
      const data = JSON.parse((persona as any)?.score_json || "{}");
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!k.startsWith("_") && typeof (v as any)?.score === "number") out[k] = (v as any).score;
      }
      return out;
    } catch { return {}; }
  })();

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleRename() {
    if (!selectedId || !renameValue.trim()) return;
    await fetch(`/api/personas/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: renameValue.trim() }),
    });
    setRenaming(false);
    setRevalidateKey(k => k + 1);
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    try {
      await deletePersona(selectedId);
      setSelectedId(null);
      setRevalidateKey(k => k + 1);
    } finally { setDeleting(false); setConfirmDelete(false); }
  }

  const selectPreset = (name: string | null) => {
    setFilterPreset(name);
    setSelectedAgent(null); setSelectedCustomer(null);
    setSelectedId(null); setAgentSearch(""); setCustomerSearch("");
  };

  const selectAgent = (name: string) => {
    setSelectedAgent(name); setSelectedCustomer(null);
    setSelectedId(null); setCustomerSearch("");
  };

  const selectCustomer = (name: string | null) => {
    setSelectedCustomer(name); setSelectedId(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-[calc(100vh-3rem)] flex overflow-hidden">

      {/* ── Preset panel ── */}
      <CollapsiblePanel title="Agents" width={presetW} collapsed={presetCollapsed} onToggle={() => setPresetCollapsed(c => !c)}>
        <div className="px-3 pt-3 pb-2 border-b border-gray-800 shrink-0">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Persona Agents</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {!personaAgents && <p className="text-xs text-gray-700 p-2 text-center">Loading…</p>}
          {/* "All" option */}
          <button onClick={() => selectPreset(null)}
            className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors ${
              filterPreset === null
                ? "bg-indigo-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}>
            <div className="font-medium">All</div>
            <div className="text-[10px] opacity-60 mt-0.5">{(personas ?? []).length} total</div>
          </button>
          {(personaAgents ?? []).map(pa => {
            const count = (personas ?? []).filter(p => p.persona_agent_id === pa.name).length;
            const typeColor = pa.persona_type === "agent_overall" ? "text-violet-400" : pa.persona_type === "pair" ? "text-indigo-400" : "text-emerald-400";
            return (
              <button key={pa.id} onClick={() => selectPreset(pa.name)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors ${
                  filterPreset === pa.name
                    ? "bg-indigo-600 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}>
                <div className="font-medium truncate">
                  {pa.is_default && <span className="text-yellow-400 mr-1">★</span>}
                  {pa.name}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[9px] font-medium ${filterPreset === pa.name ? "text-white/70" : typeColor}`}>
                    {pa.persona_type === "agent_overall" ? "Agent" : pa.persona_type === "pair" ? "Pair" : "Customer"}
                  </span>
                  <span className={`text-[9px] ${filterPreset === pa.name ? "text-white/50" : "text-gray-600"}`}>·</span>
                  <span className={`text-[9px] ${filterPreset === pa.name ? "text-white/70" : "text-gray-600"}`}>
                    {count} persona{count !== 1 ? "s" : ""}
                  </span>
                  {pa.sections && pa.sections.length > 0 && (
                    <>
                      <span className={`text-[9px] ${filterPreset === pa.name ? "text-white/50" : "text-gray-600"}`}>·</span>
                      <span className={`text-[9px] ${filterPreset === pa.name ? "text-white/70" : "text-gray-600"}`}>{pa.sections.length}§</span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
          {personaAgents?.length === 0 && (
            <p className="text-xs text-gray-600 p-2 text-center">No agents yet</p>
          )}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={presetDrag} />

      {/* ── Agents panel ── */}
      <CollapsiblePanel title="Agents" width={agentW} collapsed={agentsCollapsed} onToggle={() => setAgentsCollapsed(c => !c)}>
        <div className="px-3 pt-3 pb-2 border-b border-gray-800 shrink-0">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Agents</p>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" />
            <input
              className="w-full pl-6 pr-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-600 focus:outline-none"
              placeholder="Search…"
              value={agentSearch}
              onChange={e => setAgentSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {!personas && <p className="text-xs text-gray-700 p-2 text-center">Loading…</p>}
          {agents.map(name => {
            const count = (personas ?? []).filter(p => p.agent === name).length;
            return (
              <button key={name} onClick={() => selectAgent(name)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors ${
                  selectedAgent === name
                    ? "bg-indigo-600 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}>
                <div className="font-medium truncate">{name}</div>
                <div className="text-[10px] opacity-60 mt-0.5">{count} persona{count !== 1 ? "s" : ""}</div>
              </button>
            );
          })}
          {personas && agents.length === 0 && (
            <p className="text-xs text-gray-600 p-2 text-center">No agents</p>
          )}
        </div>
      </CollapsiblePanel>

      <DragHandle onMouseDown={agentDrag} />

      {/* ── Customers panel ── */}
      <CollapsiblePanel title="Customers" width={customerW} collapsed={customersCollapsed} onToggle={() => setCustomersCollapsed(c => !c)}>
        {!selectedAgent ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-gray-600">Select an agent</p>
          </div>
        ) : (
          <>
            <div className="px-3 pt-3 pb-2 border-b border-gray-800 shrink-0">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Customers</p>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" />
                <input
                  className="w-full pl-6 pr-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-white placeholder-gray-600 focus:outline-none"
                  placeholder="Search…"
                  value={customerSearch}
                  onChange={e => setCustomerSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {/* All option */}
              <button onClick={() => selectCustomer(null)}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors ${
                  selectedCustomer === null
                    ? "bg-indigo-600 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}>
                <div className="font-medium">All</div>
                <div className="text-[10px] opacity-60 mt-0.5">{agentPersonas.length} persona{agentPersonas.length !== 1 ? "s" : ""}</div>
              </button>
              {customers.map(name => {
                const count = agentPersonas.filter(p => p.customer === name).length;
                return (
                  <button key={name} onClick={() => selectCustomer(name)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors ${
                      selectedCustomer === name
                        ? "bg-indigo-600 text-white"
                        : "text-gray-400 hover:text-white hover:bg-gray-800"
                    }`}>
                    <div className="font-medium truncate">{name}</div>
                    <div className="text-[10px] opacity-60 mt-0.5">{count} persona{count !== 1 ? "s" : ""}</div>
                  </button>
                );
              })}
              {customers.length === 0 && (
                <p className="text-xs text-gray-600 p-2 text-center">No customer personas</p>
              )}
            </div>
          </>
        )}
      </CollapsiblePanel>

      <DragHandle onMouseDown={customerDrag} />

      {/* ── Personas list panel ── */}
      <CollapsiblePanel title="Personas" width={listW} collapsed={listCollapsed} onToggle={() => setListCollapsed(c => !c)}>
        <>
          <div className="px-3 pt-3 pb-2 border-b border-gray-800 shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                {selectedAgent ? "Personas" : "Recent"}
              </p>
              {(selectedAgent ? filteredPersonas : recentPersonas).length > 0 && (
                <span className="text-[10px] text-gray-700 bg-gray-800 px-1.5 py-0.5 rounded-full ml-auto">
                  {(selectedAgent ? filteredPersonas : recentPersonas).length}
                </span>
              )}
            </div>
            {selectedAgent && (
              <div className="flex gap-1 flex-wrap">
                {(["", "agent_overall", "pair", "customer"] as const).map(t => (
                  <button key={t} onClick={() => setTypeFilter(t)}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                      typeFilter === t
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-800 text-gray-500 hover:text-gray-300"
                    }`}>
                    {t === "" ? "All" : t === "agent_overall" ? "Agent" : t === "pair" ? "Pair" : "Customer"}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {(selectedAgent ? filteredPersonas : recentPersonas).length === 0 && (
              <div className="text-center py-8 text-gray-600 text-xs">No personas</div>
            )}
            {(selectedAgent ? filteredPersonas : recentPersonas).map(p => {
                const isActive = p.id === selectedId;
                return (
                  <button key={p.id}
                    onClick={() => { setSelectedId(p.id); setActiveTab("content"); }}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors border-l-2 ${
                      isActive
                        ? "bg-indigo-600/15 border-indigo-500/30 text-white"
                        : "border-transparent text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
                    }`}>
                    <div className="mt-0.5 shrink-0"><TypeIcon type={p.type} /></div>
                    <div className="flex-1 min-w-0">
                      {/* Prominent name */}
                      <p className={`text-xs font-semibold truncate leading-snug ${isActive ? "text-white" : "text-gray-200"}`}>
                        {p.label || p.agent}
                      </p>
                      {/* Agent + customer */}
                      <p className="text-[10px] text-gray-500 truncate mt-0.5">
                        {p.agent}{p.customer ? ` · ${p.customer}` : ""}
                      </p>
                      {/* Preset tag */}
                      {p.persona_agent_id && (
                        <p className="text-[9px] text-violet-400/70 truncate mt-0.5 font-medium">{p.persona_agent_id}</p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-semibold ${TYPE_COLOR[p.type] ?? TYPE_COLOR.agent_overall}`}>
                          {p.type === "agent_overall" ? "Agent" : p.type === "pair" ? "Pair" : "Cust"}
                        </span>
                        {p.version > 1 && (
                          <span className="text-[9px] text-gray-700 bg-gray-800 px-1 rounded">v{p.version}</span>
                        )}
                        <span className="text-[9px] text-gray-700 font-mono">{p.model}</span>
                        <span className="text-[10px] text-gray-600 ml-auto">{formatDate(p.created_at)}</span>
                      </div>
                    </div>
                    <ChevronRight className={`w-3 h-3 shrink-0 mt-1 ${isActive ? "text-indigo-400" : "text-gray-700"}`} />
                  </button>
                );
              })}
          </div>
        </>
      </CollapsiblePanel>

      <DragHandle onMouseDown={listDrag} />

      {/* ── Main detail panel ── */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-gray-900 border border-gray-800 rounded-xl">

        {/* ── Action header (always visible) ── */}
        <div className="px-4 py-2.5 border-b border-gray-800 shrink-0 flex items-center gap-2 justify-between">
          <div className="flex items-center gap-1.5">
            <Brain className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-semibold text-white">Personas</span>
          </div>
        </div>

        {!selectedId && (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-700">
            <Sparkles className="w-10 h-10 mb-3 opacity-20" />
            <p className="text-sm">Select a persona to view</p>
          </div>
        )}

        {selectedId && (
          <>
            {/* Header bar */}
            <div className="px-4 py-3 border-b border-gray-800 shrink-0">
              {!persona ? (
                <div className="flex items-center gap-2 text-gray-600 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-bold text-white">{persona.agent}</span>
                    {persona.customer && (
                      <span className="text-sm text-gray-500">/ {persona.customer}</span>
                    )}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-semibold ${TYPE_COLOR[persona.type ?? "pair"] ?? TYPE_COLOR.agent_overall}`}>
                      {(persona.type ?? "pair").replace(/_/g, " ")}
                    </span>
                    {persona.version > 1 && (
                      <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">v{persona.version}</span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {renaming ? (
                        <>
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenaming(false); }}
                            className="px-2 py-1.5 bg-gray-800 border border-indigo-500 rounded-lg text-xs text-white focus:outline-none w-40"
                            placeholder="New label…"
                          />
                          <button onClick={handleRename} className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg transition-colors">
                            <Check className="w-3 h-3" /> Save
                          </button>
                          <button onClick={() => setRenaming(false)} className="px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-lg transition-colors">
                            <X className="w-3 h-3" />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => { setRenaming(true); setRenameValue(persona.label || ""); }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-lg transition-colors">
                          <Pencil className="w-3 h-3" /> Rename
                        </button>
                      )}
                      <button onClick={handleDelete} onBlur={() => setConfirmDelete(false)} disabled={deleting}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50 ${
                          confirmDelete
                            ? "bg-red-600 hover:bg-red-500 text-white"
                            : "bg-gray-800 hover:bg-red-900/60 text-gray-400 hover:text-red-300"
                        }`}>
                        {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        {confirmDelete ? "Confirm" : "Delete"}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="text-[10px] text-gray-600">
                      {persona.model} · {formatDate(persona.created_at)} · {transcripts.length} call{transcripts.length !== 1 ? "s" : ""}
                      {typeof (persona as any).temperature === "number" ? ` · temp ${(persona as any).temperature}` : ""}
                    </span>
                    {/* Preset tag picker */}
                    <select
                      value={persona.persona_agent_id ?? ""}
                      onChange={async e => {
                        const val = e.target.value;
                        await fetch(`/api/personas/${persona.id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ persona_agent_id: val }),
                        });
                        setRevalidateKey(k => k + 1);
                      }}
                      className="text-[10px] bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-violet-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    >
                      <option value="">— no agent —</option>
                      {(personaAgents ?? []).map(pa => (
                        <option key={pa.id} value={pa.name}>{pa.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>

            {/* Tab bar */}
            <div className="flex gap-0 border-b border-gray-800 shrink-0 px-4">
              {([
                { id: "content",     label: "Content" },
                { id: "score",       label: "Score" },
                { id: "transcripts", label: `Transcripts (${transcripts.length})` },
                { id: "prompts",     label: "Settings" },
              ] as const).map(({ id, label }) => (
                <button key={id} onClick={() => setActiveTab(id as typeof activeTab)}
                  className={`px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                    activeTab === id
                      ? "border-indigo-500 text-white"
                      : "border-transparent text-gray-500 hover:text-gray-300"
                  }`}>
                  {label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto">

              {/* ── Content tab ── */}
              {activeTab === "content" && (
                <div className="flex flex-col h-full min-h-0">
                  {/* Raw / Preview toggle */}
                  <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-800 shrink-0">
                    <button onClick={() => setContentView("preview")}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${contentView === "preview" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                    <button onClick={() => setContentView("raw")}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${contentView === "raw" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}>
                      <Code className="w-3 h-3" /> Raw
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    {!persona ? (
                      <div className="flex items-center justify-center py-16 text-gray-700">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                      </div>
                    ) : contentView === "raw" ? (
                      <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">{persona.content_md}</pre>
                    ) : sections.length === 0 ? (
                      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                        <ReactMarkdown components={MD as never}>{persona.content_md}</ReactMarkdown>
                      </div>
                    ) : (
                      <>
                        <SectionNav sections={sections} />
                        <div className="grid grid-cols-2 gap-3">
                          {sections.map((section, i) => (
                            <SectionCard key={i} section={section} fullWidth={section.content.length > 600} score={sectionScores[section.title]} />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* ── Transcripts tab ── */}
              {activeTab === "transcripts" && (
                <div className="flex h-full min-h-0">
                  {/* List */}
                  <div className="w-56 shrink-0 border-r border-gray-800 overflow-y-auto p-2 space-y-1">
                    {persona?.customer && (
                      <button
                        onClick={async () => {
                          setSelectedTranscriptIdx("merged");
                          setTranscriptContent(null);
                          setTranscriptLoading(true);
                          try {
                            const r = await fetch(`/api/full-persona-agent/transcript?agent=${encodeURIComponent(persona.agent)}&customer=${encodeURIComponent(persona.customer ?? "")}&force=false`);
                            setTranscriptContent(r.ok ? (await r.text()) : "Failed to load");
                          } finally { setTranscriptLoading(false); }
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${selectedTranscriptIdx === "merged" ? "bg-indigo-600 text-white" : "text-indigo-300 hover:bg-indigo-950/60 border border-indigo-800/30"}`}>
                        <div className="flex items-center gap-1.5">
                          <FileText className="w-3 h-3 shrink-0" />
                          <span className="font-semibold">Merged Transcript</span>
                        </div>
                        <p className="text-[10px] mt-0.5 opacity-70">Full LLM input</p>
                      </button>
                    )}
                    {transcripts.length === 0 && !persona?.customer && (
                      <p className="text-gray-600 text-xs text-center py-4">No transcripts.</p>
                    )}
                    {transcripts.map((t, i) => (
                      <button key={i}
                        onClick={async () => {
                          setSelectedTranscriptIdx(i);
                          setTranscriptContent(null);
                          setTranscriptLoading(true);
                          try {
                            const r = await fetch(`/api/personas/${persona!.id}/transcript-content?idx=${i}`);
                            const data = await r.json();
                            setTranscriptContent(r.ok ? data.content : data.detail || "Failed to load");
                          } finally { setTranscriptLoading(false); }
                        }}
                        className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${selectedTranscriptIdx === i ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800"}`}>
                        <div className="flex items-center gap-1.5">
                          <FileText className="w-3 h-3 shrink-0 text-gray-600" />
                          <span className="font-mono truncate">{t.callId || t.fileName}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {t.engine && <span className="text-[9px] px-1 rounded bg-gray-700/60">{t.engine}</span>}
                          {t.subType && <span className="text-[9px] opacity-60">{t.subType}</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                  {/* Viewer */}
                  <div className="flex-1 overflow-y-auto p-4">
                    {selectedTranscriptIdx === null ? (
                      <div className="flex items-center justify-center h-full text-gray-700 text-sm">Select a transcript to view</div>
                    ) : transcriptLoading ? (
                      <div className="flex items-center justify-center h-full text-gray-600"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…</div>
                    ) : (
                      <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap leading-relaxed">{transcriptContent}</pre>
                    )}
                  </div>
                </div>
              )}

              {/* ── Score tab ── */}
              {activeTab === "score" && persona && (() => {
                const scoreSections: PersonaSection[] = (() => {
                  try { return JSON.parse((persona as any).sections_json || "[]") ?? []; }
                  catch { return []; }
                })();
                const secMeta = Object.fromEntries(
                  scoreSections.map(s => [(s.name || (s as any).title || ""), s]).filter(([k]) => k)
                );

                const storedScoreData: Record<string, any> = (() => {
                  try { return JSON.parse((persona as any).score_json || "{}"); } catch { return {}; }
                })();
                const hasStoredScore = Object.keys(storedScoreData).filter(k => !k.startsWith("_")).length > 0;
                const rawScorerText = storedScoreData._raw_score_text as string | undefined;
                const strengths = storedScoreData._strengths as string[] | undefined;
                const weaknesses = storedScoreData._weaknesses as string[] | undefined;
                const assessment = storedScoreData._assessment as string | undefined;
                const systemNotes = storedScoreData._system_notes as string | undefined;

                // Flatten scored sections → {SectionName: number, _overall, _summary, _reasoning}
                const flattenScores = (raw: Record<string, any>) => {
                  const out: Record<string, any> = {
                    _overall: raw._overall ?? 0,
                    _summary: raw._summary ?? "",
                    _reasoning: { ...(raw._reasoning ?? {}) },
                  };
                  for (const [k, v] of Object.entries(raw)) {
                    if (k.startsWith("_")) continue;
                    if (typeof v === "number") {
                      out[k] = v;
                    } else if (typeof v === "object" && v !== null && "score" in (v as any)) {
                      out[k] = (v as any).score;
                      if (!(k in out._reasoning)) out._reasoning[k] = (v as any).reasoning ?? "";
                    }
                  }
                  return out;
                };

                const displayScores = hasStoredScore ? flattenScores(storedScoreData) : null;
                const entries: [string, number][] = displayScores
                  ? (Object.entries(displayScores)
                      .filter(([k, v]) => !k.startsWith("_") && typeof v === "number")
                      .map(([k, v]) => [k, v as number] as [string, number])
                      .sort((a, b) => a[1] - b[1]))
                  : [];

                return (
                  <div className="p-4 space-y-4">

                    {!hasStoredScore && (
                      <p className="text-xs text-gray-600 text-center py-8">No score data — run a Full Persona Agent analysis to score this persona.</p>
                    )}

                    {/* ── Raw Scorer Output panel ── */}
                    {rawScorerText && (
                      <div className="border border-gray-800 rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-gray-800/40 border-b border-gray-800">
                          <p className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">Raw Scorer Output</p>
                          <button onClick={() => setShowRawScore(v => !v)}
                            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                            <Code className="w-3 h-3" />
                            {showRawScore ? "Hide" : "Show"}
                          </button>
                        </div>
                        {showRawScore && (
                          <pre className="p-3 text-[10px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed overflow-y-auto max-h-[32rem]">{rawScorerText}</pre>
                        )}
                      </div>
                    )}

                    {/* ── Normalized panel ── */}
                    {displayScores && (
                      <div className="border border-gray-800 rounded-xl overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2 bg-gray-800/40 border-b border-gray-800">
                          <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider">Normalized</p>
                          <button onClick={() => setShowNormJson(v => !v)}
                            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
                            <Code className="w-3 h-3" />
                            {showNormJson ? "Hide" : "Show"} JSON
                          </button>
                        </div>

                        <div className="p-3 space-y-3">
                          {/* Overall */}
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Overall</span>
                              <span className={`text-lg font-black font-mono ${displayScores._overall >= 75 ? "text-emerald-400" : displayScores._overall >= 50 ? "text-amber-400" : "text-red-400"}`}>
                                {Math.round(displayScores._overall)}/100
                              </span>
                            </div>
                            <div className="h-2.5 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${displayScores._overall >= 75 ? "bg-emerald-500" : displayScores._overall >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                                style={{ width: `${Math.min(displayScores._overall, 100)}%` }}
                              />
                            </div>
                            {displayScores._summary && (
                              <p className="text-xs text-gray-500 mt-1.5 italic leading-relaxed">{displayScores._summary as string}</p>
                            )}
                          </div>

                          {/* Section bars */}
                          {entries.map(([name, score]) => {
                            const reasoning = displayScores._reasoning?.[name];
                            const meta = secMeta[name];
                            const DirIcon = meta?.scoring_direction === "lower_better" ? TrendingDown : meta?.scoring_direction === "neutral" ? Minus : TrendingUp;
                            const dirColor = meta?.scoring_direction === "lower_better" ? "text-amber-500/60" : meta?.scoring_direction === "neutral" ? "text-gray-600" : "text-emerald-500/60";
                            return (
                              <div key={name}>
                                <div className="flex items-center gap-2">
                                  <DirIcon className={`w-3 h-3 shrink-0 ${dirColor}`} />
                                  <span className="text-xs text-gray-400 w-40 shrink-0 truncate" title={name}>{name}</span>
                                  {meta?.weight && (
                                    <span className="text-[9px] text-gray-600 bg-gray-800 px-1 rounded shrink-0">w{meta.weight}</span>
                                  )}
                                  <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${score >= 75 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                                      style={{ width: `${Math.min(score, 100)}%`, opacity: 0.85 }}
                                    />
                                  </div>
                                  <span className={`text-xs font-bold font-mono w-7 text-right shrink-0 ${score >= 75 ? "text-emerald-400" : score >= 50 ? "text-amber-400" : "text-red-400"}`}>
                                    {Math.round(score)}
                                  </span>
                                </div>
                                {reasoning && (
                                  <p className="text-[10px] text-gray-600 italic mt-0.5 ml-[3.25rem] leading-relaxed">{reasoning}</p>
                                )}
                              </div>
                            );
                          })}

                          {/* Metadata: Strengths / Weaknesses / Assessment */}
                          {(strengths || weaknesses || assessment) && (
                            <div className="pt-2 border-t border-gray-800 space-y-3">
                              {strengths && strengths.length > 0 && (
                                <div>
                                  <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider mb-1">Strengths</p>
                                  <ul className="space-y-0.5">
                                    {strengths.map((s, i) => (
                                      <li key={i} className="text-xs text-gray-400 flex gap-1.5"><span className="text-emerald-600 shrink-0">•</span>{s}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {weaknesses && weaknesses.length > 0 && (
                                <div>
                                  <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-1">Weaknesses</p>
                                  <ul className="space-y-0.5">
                                    {weaknesses.map((w, i) => (
                                      <li key={i} className="text-xs text-gray-400 flex gap-1.5"><span className="text-red-600 shrink-0">•</span>{w}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {assessment && (
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Overall Assessment</p>
                                  <p className="text-xs text-gray-400 italic leading-relaxed">{assessment}</p>
                                </div>
                              )}
                            </div>
                          )}

                          {/* System Notes (per-call compliance notes) */}
                          {systemNotes && (
                            <SystemNotesPanel notes={systemNotes} />
                          )}
                        </div>

                        {showNormJson && (
                          <pre className="border-t border-gray-800 p-3 text-[10px] text-gray-400 font-mono whitespace-pre-wrap overflow-y-auto max-h-80">{JSON.stringify(storedScoreData, null, 2)}</pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── Settings tab ── */}
              {activeTab === "prompts" && (
                <div className="p-4 space-y-4 overflow-y-auto">
                  {!persona ? (
                    <div className="flex items-center justify-center py-16 text-gray-700">
                      <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                    </div>
                  ) : (() => {
                    const raw = persona.prompt_used || "";
                    const sysPrompt = raw.replace(/\n\nUSER:[\s\S]*$/, "").replace(/^SYSTEM:\n/, "");
                    const userMatch = raw.match(/\n\nUSER:\n([\s\S]*)$/);
                    const userPrompt = userMatch ? userMatch[1] : "";
                    const scoreJson: Record<string, any> = (() => { try { return JSON.parse((persona as any).score_json || "{}"); } catch { return {}; } })();
                    const scorerModel = scoreJson._scorer_model || "—";
                    const scorerSys = scoreJson._scorer_system || "";
                    const scorerUser = scoreJson._scorer_user || "";
                    const normSys = scoreJson._normaliser_system_used || "";
                    const normModelStored = scoreJson._normaliser_model_used || "—";
                    const normTempStored = scoreJson._normaliser_temperature ?? "—";
                    const PromptBlock = ({ label, text }: { label: string; text: string }) => (
                      <div>
                        <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">{label}</p>
                        <pre className="w-full px-3 py-2 bg-gray-950 border border-gray-800 rounded-lg text-[10px] text-gray-300 font-mono whitespace-pre-wrap overflow-auto max-h-48">{text || "—"}</pre>
                      </div>
                    );
                    const MetaRow = ({ label, value }: { label: string; value: string }) => (
                      <div className="flex gap-3">
                        <span className="text-gray-500 shrink-0 w-24">{label}</span>
                        <span className="text-white font-mono text-xs">{value}</span>
                      </div>
                    );
                    return (
                      <>
                        {/* ── Persona Agent ── */}
                        <div className="border border-gray-700 rounded-xl overflow-hidden">
                          <div className="px-3 py-2 bg-gray-800/60 border-b border-gray-700">
                            <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider">Persona Agent</p>
                          </div>
                          <div className="p-3 space-y-3 text-xs">
                            <MetaRow label="Model" value={persona.model} />
                            <MetaRow label="Temperature" value={String(persona.temperature ?? 0.3)} />
                            <MetaRow label="Type" value={persona.type.replace(/_/g, " ")} />
                            <MetaRow label="Transcripts" value={String(transcripts.length)} />
                            <MetaRow label="Created" value={formatDate(persona.created_at)} />
                            {persona.label && <MetaRow label="Label" value={persona.label} />}
                            <PromptBlock label="System Prompt" text={sysPrompt} />
                            {userPrompt && <PromptBlock label="User Prompt" text={userPrompt} />}
                          </div>
                        </div>

                        {/* ── Scorer Agent ── */}
                        <div className="border border-gray-700 rounded-xl overflow-hidden">
                          <div className="px-3 py-2 bg-gray-800/60 border-b border-gray-700">
                            <p className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">Scorer Agent</p>
                          </div>
                          <div className="p-3 space-y-3 text-xs">
                            <MetaRow label="Model" value={scorerModel} />
                            <PromptBlock label="System Prompt" text={scorerSys} />
                            {scorerUser && <PromptBlock label="User Prompt" text={scorerUser} />}
                            {!scorerSys && <p className="text-[10px] text-gray-600">Score this persona first to populate scorer settings.</p>}
                          </div>
                        </div>

                        {/* ── Normalizer Agent ── */}
                        <div className="border border-gray-700 rounded-xl overflow-hidden">
                          <div className="px-3 py-2 bg-gray-800/60 border-b border-gray-700">
                            <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">Normalizer Agent</p>
                          </div>
                          <div className="p-3 space-y-3 text-xs">
                            {normModelStored !== "—" && <MetaRow label="Model" value={normModelStored} />}
                            {normTempStored !== "—" && <MetaRow label="Temperature" value={String(normTempStored)} />}
                            <PromptBlock label="System Prompt" text={normSys} />
                            {!normSys && <p className="text-[10px] text-gray-600">Run a Full Persona Agent analysis to populate normalizer settings.</p>}
                          </div>
                        </div>

                        {/* Script link */}
                        {persona.script_path && (
                          <a href={`/api/personas/${persona.id}/script/download`} download
                            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors">
                            <Download className="w-3.5 h-3.5" /> Download merged script
                          </a>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

            </div>
          </>
        )}
      </div>
    </div>
  );
}
