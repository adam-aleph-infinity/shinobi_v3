"use client";

import { useState } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  User, BadgeCheck, StickyNote, ShieldCheck, Layers,
  Loader2, Copy, Archive, Search, CalendarDays, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";

const fetcher = (url: string) =>
  fetch(url).then(r => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

// ── Types ─────────────────────────────────────────────────────────────────────

interface Persona {
  id: string; type: string; agent: string; customer?: string; label?: string;
  content_md: string; score_json?: string; model: string; created_at: string; version: number;
}
interface Note {
  id: string; agent: string; customer: string; call_id: string;
  content_md: string; score_json?: string; model: string; created_at: string;
}

type ArtifactItem =
  | { kind: "persona";       id: string; date: string; chars: number; label: string; data: Persona }
  | { kind: "persona_score"; id: string; date: string; chars: number; label: string; data: Persona }
  | { kind: "notes_rollup";  id: "rollup"; date: string; chars: number; label: string; data: Record<string, unknown> }
  | { kind: "note";          id: string; date: string; chars: number; label: string; data: Note; hasCompliance: boolean };

// ── Artifact type metadata ────────────────────────────────────────────────────

const ARTIFACT_META = {
  persona:       { label: "Persona",          icon: User,        bg: "bg-violet-900/60",  text: "text-violet-300",  border: "border-violet-700/40", dot: "bg-violet-500"  },
  persona_score: { label: "Persona Score",    icon: BadgeCheck,  bg: "bg-violet-900/40",  text: "text-violet-400",  border: "border-violet-700/30", dot: "bg-violet-400"  },
  notes_rollup:  { label: "Merged Notes",     icon: Layers,      bg: "bg-amber-900/40",   text: "text-amber-300",   border: "border-amber-700/40",  dot: "bg-amber-500"   },
  note:          { label: "Call Note",        icon: StickyNote,  bg: "bg-teal-900/40",    text: "text-teal-300",    border: "border-teal-700/40",   dot: "bg-teal-500"    },
  note_compliant:{ label: "Compliance Note",  icon: ShieldCheck, bg: "bg-emerald-900/40", text: "text-emerald-300", border: "border-emerald-700/40",dot: "bg-emerald-500" },
} as const;

// ── Content viewer ────────────────────────────────────────────────────────────

function ContentViewer({ item }: { item: ArtifactItem }) {
  const [copied, setCopied] = useState(false);

  function copyText(t: string) {
    navigator.clipboard.writeText(t);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (item.kind === "persona") {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.label}</p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars · type: {item.data.type}</p>
          </div>
          <button onClick={() => copyText(item.data.content_md)}
            className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors shrink-0">
            <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.data.content_md}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "persona_score" && item.data.score_json) {
    let parsed: unknown;
    try { parsed = JSON.parse(item.data.score_json); } catch { parsed = item.data.score_json; }
    const raw = typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : String(parsed);
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.label}</p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <button onClick={() => copyText(raw)}
            className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors shrink-0">
            <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {typeof parsed === "object" && parsed !== null ? (
            <div className="space-y-2">
              {Object.entries(parsed as Record<string, unknown>).map(([k, v]) => (
                <div key={k} className="flex gap-3 text-xs border-b border-gray-800/60 pb-2 last:border-0">
                  <span className="text-gray-500 w-48 shrink-0 font-medium">{k}</span>
                  <span className="text-gray-300 break-words">{typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-words">{raw}</pre>
          )}
        </div>
      </div>
    );
  }

  if (item.kind === "notes_rollup") {
    const raw = JSON.stringify(item.data, null, 2);
    const d = item.data;
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Merged Notes Rollup</p>
            <p className="text-[10px] text-gray-500">
              {item.chars.toLocaleString()} chars
              {d.overall_risk ? ` · risk: ${d.overall_risk}` : ""}
              {d._note_count ? ` · ${d._note_count} notes` : ""}
            </p>
          </div>
          <button onClick={() => copyText(raw)}
            className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors shrink-0">
            <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!!d.summary && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Summary</p>
              <p className="text-sm text-gray-300">{String(d.summary)}</p>
            </div>
          )}
          {Array.isArray(d.key_patterns) && d.key_patterns.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Key Patterns</p>
              <ul className="space-y-0.5">
                {(d.key_patterns as unknown[]).map((p, i) => (
                  <li key={i} className="text-xs text-gray-400 flex gap-2"><span className="text-gray-700">·</span>{String(p)}</li>
                ))}
              </ul>
            </div>
          )}
          {Array.isArray(d.next_steps) && d.next_steps.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Next Steps</p>
              <ul className="space-y-0.5">
                {(d.next_steps as unknown[]).map((s, i) => (
                  <li key={i} className="text-xs text-gray-400 flex gap-2"><span className="text-gray-700">·</span>{String(s)}</li>
                ))}
              </ul>
            </div>
          )}
          <details className="border border-gray-800 rounded-lg overflow-hidden">
            <summary className="px-3 py-2 text-[10px] text-gray-500 cursor-pointer bg-gray-900/60">Raw JSON</summary>
            <pre className="p-3 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{raw}</pre>
          </details>
        </div>
      </div>
    );
  }

  if (item.kind === "note") {
    const raw = item.data.content_md;
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">
              {item.hasCompliance ? "Compliance Note" : "Call Note"} · {item.data.call_id.slice(-12)}
            </p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <button onClick={() => copyText(raw)}
            className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors shrink-0">
            <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{raw}</ReactMarkdown>
          </div>
          {item.data.score_json && (
            <details className="border border-gray-800 rounded-lg overflow-hidden">
              <summary className="px-3 py-2 text-[10px] text-gray-500 cursor-pointer bg-gray-900/60">Compliance Score</summary>
              <pre className="p-3 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                {(() => { try { return JSON.stringify(JSON.parse(item.data.score_json!), null, 2); } catch { return item.data.score_json; } })()}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ── Nav item row ──────────────────────────────────────────────────────────────

function ArtifactRow({ item, selected, onClick }: { item: ArtifactItem; selected: boolean; onClick: () => void }) {
  const kind = item.kind === "note" && item.hasCompliance ? "note_compliant" : item.kind;
  const m = ARTIFACT_META[kind as keyof typeof ARTIFACT_META] ?? ARTIFACT_META.note;
  const Icon = m.icon;
  return (
    <button onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
        selected
          ? "bg-indigo-900/30 border-l-2 border-indigo-500"
          : "border-l-2 border-transparent hover:bg-gray-800/40",
      )}>
      <span className={cn("p-0.5 rounded border shrink-0", m.bg, m.text, m.border)}>
        <Icon className="w-3 h-3" />
      </span>
      <div className="flex-1 min-w-0">
        <p className={cn("text-[11px] font-medium truncate", selected ? "text-white" : "text-gray-300")}>{item.label}</p>
        <p className="text-[9px] text-gray-600 flex items-center gap-1">
          <CalendarDays className="w-2.5 h-2.5" />{item.date.slice(0, 10)}
          <span className="text-gray-700 ml-1">{item.chars.toLocaleString()} chars</span>
        </p>
      </div>
    </button>
  );
}

// ── Status dots ───────────────────────────────────────────────────────────────

function StatusDots({ salesAgent, customer }: { salesAgent: string; customer: string }) {
  const qs = new URLSearchParams({ agent: salesAgent, customer });
  const { data: personas } = useSWR<Persona[]>(`/api/personas?${qs}`, fetcher);
  const { data: notes }    = useSWR<Note[]>(`/api/notes?${qs}`, fetcher);
  const { data: rollup, error: rollupErr } = useSWR<Record<string, unknown>>(`/api/notes/rollup?${qs}`, fetcher);
  const has = {
    persona: (personas ?? []).length > 0,
    score:   (personas ?? []).some(p => p.score_json),
    rollup:  !!rollup && !rollupErr,
    notes:   (notes ?? []).length > 0,
    compliance: (notes ?? []).some(n => n.score_json),
  };
  if (!has.persona && !has.rollup && !has.notes) return null;
  return (
    <div className="flex items-center gap-0.5 shrink-0 ml-1">
      {has.persona    && <span className="w-1.5 h-1.5 rounded-full bg-violet-500" title="Persona" />}
      {has.score      && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" title="Score" />}
      {has.rollup     && <span className="w-1.5 h-1.5 rounded-full bg-amber-500"  title="Merged Notes" />}
      {has.notes      && <span className="w-1.5 h-1.5 rounded-full bg-teal-500"   title="Call Notes" />}
      {has.compliance && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Compliance" />}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ArtifactsPage() {
  const [agentW,    agentDrag]    = useResize(200, 140, 320);
  const [customerW, customerDrag] = useResize(200, 140, 320);
  const [itemsW,    itemsDrag]    = useResize(240, 180, 400);

  const [selectedAgent, setSelectedAgent]       = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [selectedItem, setSelectedItem]         = useState<ArtifactItem | null>(null);
  const [agentSearch, setAgentSearch]           = useState("");
  const [customerSearch, setCustomerSearch]     = useState("");

  const { data: navAgents }    = useSWR<{ agent: string; count: number }[]>("/api/crm/nav/agents", fetcher);
  const { data: navCustomers } = useSWR<{ customer: string; call_count: number }[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null, fetcher,
  );

  const pairQs = selectedAgent && selectedCustomer
    ? new URLSearchParams({ agent: selectedAgent, customer: selectedCustomer })
    : null;

  const { data: personas, isLoading: loadP } = useSWR<Persona[]>(
    pairQs ? `/api/personas?${pairQs}` : null, fetcher,
  );
  const { data: notes, isLoading: loadN } = useSWR<Note[]>(
    pairQs ? `/api/notes?${pairQs}` : null, fetcher,
  );
  const { data: rollup, isLoading: loadR, error: rollupErr } = useSWR<Record<string, unknown>>(
    pairQs ? `/api/notes/rollup?${pairQs}` : null, fetcher,
  );

  // Build unified artifact item list
  const artifactItems: ArtifactItem[] = [];

  (personas ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)).forEach(p => {
    artifactItems.push({
      kind: "persona", id: p.id, date: p.created_at,
      chars: p.content_md?.length ?? 0,
      label: p.label ? p.label : `Persona (${p.type}) · v${p.version}`,
      data: p,
    });
    if (p.score_json) {
      artifactItems.push({
        kind: "persona_score", id: `${p.id}_score`, date: p.created_at,
        chars: p.score_json.length,
        label: `Score for ${p.label ?? `v${p.version}`}`,
        data: p,
      });
    }
  });

  if (rollup && !rollupErr) {
    const raw = JSON.stringify(rollup);
    const saved = rollup._saved_at as string | undefined;
    artifactItems.push({
      kind: "notes_rollup", id: "rollup",
      date: saved ?? new Date().toISOString(),
      chars: raw.length,
      label: `Merged Notes Rollup${rollup._note_count ? ` (${rollup._note_count} notes)` : ""}`,
      data: rollup,
    });
  }

  (notes ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)).forEach(n => {
    artifactItems.push({
      kind: "note", id: n.id, date: n.created_at,
      chars: n.content_md?.length ?? 0,
      label: `Call Note · ${n.call_id.slice(-12)}`,
      data: n,
      hasCompliance: !!n.score_json,
    });
  });

  const filteredAgents    = (navAgents ?? []).filter(a => a.agent.toLowerCase().includes(agentSearch.toLowerCase()));
  const filteredCustomers = (navCustomers ?? []).filter(c => c.customer.toLowerCase().includes(customerSearch.toLowerCase()));
  const isLoadingItems    = loadP || loadN || loadR;

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex -m-6 overflow-hidden">

      {/* ── Panel 1: Agents ─────────────────────────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: agentW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Sales Agents</p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" />
              <input value={agentSearch} onChange={e => setAgentSearch(e.target.value)}
                placeholder="Search…"
                className="w-full bg-gray-800 border border-gray-700 rounded-md pl-6 pr-2 py-1 text-[10px] text-white outline-none focus:border-indigo-500 placeholder-gray-600" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {filteredAgents.map(a => (
              <button key={a.agent}
                onClick={() => { setSelectedAgent(a.agent); setSelectedCustomer(""); setSelectedItem(null); }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors border-l-2",
                  selectedAgent === a.agent
                    ? "bg-indigo-900/30 border-indigo-500 text-white"
                    : "border-transparent text-gray-400 hover:text-white hover:bg-gray-800/40",
                )}>
                <span className="flex-1 truncate">{a.agent}</span>
                <span className="text-[9px] text-gray-700 shrink-0">{a.count}</span>
              </button>
            ))}
            {filteredAgents.length === 0 && (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">No agents</p>
            )}
          </div>
        </div>
        <DragHandle onMouseDown={agentDrag} />
      </div>

      {/* ── Panel 2: Customers ──────────────────────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: customerW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Customers</p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" />
              <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)}
                placeholder="Search…"
                disabled={!selectedAgent}
                className="w-full bg-gray-800 border border-gray-700 rounded-md pl-6 pr-2 py-1 text-[10px] text-white outline-none focus:border-indigo-500 placeholder-gray-600 disabled:opacity-40" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!selectedAgent ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select an agent</p>
            ) : filteredCustomers.map(c => (
              <button key={c.customer}
                onClick={() => { setSelectedCustomer(c.customer); setSelectedItem(null); }}
                className={cn(
                  "w-full flex items-center gap-1 px-3 py-2 text-left text-[11px] transition-colors border-l-2",
                  selectedCustomer === c.customer
                    ? "bg-indigo-900/30 border-indigo-500 text-white"
                    : "border-transparent text-gray-400 hover:text-white hover:bg-gray-800/40",
                )}>
                <span className="flex-1 truncate">{c.customer}</span>
                <StatusDots salesAgent={selectedAgent} customer={c.customer} />
                <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />
              </button>
            ))}
            {selectedAgent && filteredCustomers.length === 0 && (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">No customers</p>
            )}
          </div>
        </div>
        <DragHandle onMouseDown={customerDrag} />
      </div>

      {/* ── Panel 3: Artifact items ──────────────────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: itemsW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">
              {selectedCustomer ? `${selectedCustomer}` : "Artifacts"}
            </p>
            {selectedCustomer && (
              <p className="text-[9px] text-gray-600 mt-0.5">{artifactItems.length} artifact{artifactItems.length !== 1 ? "s" : ""}</p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!selectedCustomer ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select a customer</p>
            ) : isLoadingItems ? (
              <div className="flex items-center gap-1.5 px-3 py-4 text-[10px] text-gray-600">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            ) : artifactItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-1.5 text-gray-700">
                <Archive className="w-6 h-6 opacity-20" />
                <p className="text-[10px]">No artifacts cached</p>
              </div>
            ) : (() => {
              type Group = { kind: ArtifactItem["kind"]; label: string; items: ArtifactItem[] };
              const groups: Group[] = ([
                { kind: "persona"       as const, label: "Personas",       items: artifactItems.filter(i => i.kind === "persona") },
                { kind: "persona_score" as const, label: "Persona Scores", items: artifactItems.filter(i => i.kind === "persona_score") },
                { kind: "notes_rollup"  as const, label: "Merged Notes",   items: artifactItems.filter(i => i.kind === "notes_rollup") },
                { kind: "note"          as const, label: "Call Notes",     items: artifactItems.filter(i => i.kind === "note") },
              ] as Group[]).filter(g => g.items.length > 0);
              return groups.map(g => {
                const m = ARTIFACT_META[g.kind as keyof typeof ARTIFACT_META] ?? ARTIFACT_META.note;
                const Icon = m.icon;
                return (
                  <div key={g.kind}>
                    <div className={cn("flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-800/60 sticky top-0 z-10", m.bg)}>
                      <Icon className={cn("w-3 h-3 shrink-0", m.text)} />
                      <p className={cn("text-[9px] font-bold uppercase tracking-widest", m.text)}>{g.label}</p>
                      <span className="text-[9px] text-gray-700 ml-auto">{g.items.length}</span>
                    </div>
                    {g.items.map(item => (
                      <ArtifactRow key={item.id} item={item}
                        selected={selectedItem?.id === item.id}
                        onClick={() => setSelectedItem(item)} />
                    ))}
                  </div>
                );
              });
            })()}
          </div>
        </div>
        <DragHandle onMouseDown={itemsDrag} />
      </div>

      {/* ── Panel 4: Content viewer ──────────────────────────────── */}
      <div className="flex-1 min-w-0 bg-gray-900 overflow-hidden">
        {selectedItem ? (
          <ContentViewer item={selectedItem} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-700">
            <Archive className="w-10 h-10 opacity-10" />
            <p className="text-sm">
              {!selectedAgent ? "Select a sales agent to browse artifacts"
               : !selectedCustomer ? "Select a customer to see their artifacts"
               : "Select an artifact to view it"}
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
