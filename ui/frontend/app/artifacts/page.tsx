"use client";

import { useState } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  User, BadgeCheck, StickyNote, ShieldCheck, ChevronDown, ChevronRight,
  Loader2, RefreshCw, Copy, Archive, CalendarDays,
} from "lucide-react";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(r => {
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

// ── Artifact type config ──────────────────────────────────────────────────────

const ARTIFACT_TYPES = {
  persona:          { label: "Persona",          icon: User,        color: "bg-violet-900/50", border: "border-violet-700/40", text: "text-violet-300",  badge: "bg-violet-900/50 text-violet-300 border-violet-700/50"  },
  persona_score:    { label: "Persona Score",     icon: BadgeCheck,  color: "bg-violet-900/30", border: "border-violet-700/30", text: "text-violet-400",  badge: "bg-violet-900/40 text-violet-400 border-violet-700/40"  },
  notes_rollup:     { label: "Merged Notes",      icon: StickyNote,  color: "bg-amber-900/40",  border: "border-amber-700/40",  text: "text-amber-300",   badge: "bg-amber-900/50 text-amber-300 border-amber-700/50"    },
  notes_compliance: { label: "Compliance Notes",  icon: ShieldCheck, color: "bg-emerald-900/40",border: "border-emerald-700/40",text: "text-emerald-300", badge: "bg-emerald-900/50 text-emerald-300 border-emerald-700/50" },
  notes_call:       { label: "Call Notes",        icon: StickyNote,  color: "bg-teal-900/40",   border: "border-teal-700/40",   text: "text-teal-300",    badge: "bg-teal-900/50 text-teal-300 border-teal-700/50"       },
} as const;

// ── Collapsible content card ──────────────────────────────────────────────────

function ArtifactCard({
  type, date, chars, children, defaultOpen = false,
}: React.PropsWithChildren<{
  type: keyof typeof ARTIFACT_TYPES;
  date?: string; chars?: number;
  defaultOpen?: boolean;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const m = ARTIFACT_TYPES[type];
  const Icon = m.icon;
  return (
    <div className={cn("rounded-xl border overflow-hidden", m.border)}>
      <button
        onClick={() => setOpen(o => !o)}
        className={cn("w-full flex items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]", m.color)}>
        <span className={cn("p-1 rounded-lg border shrink-0", m.badge)}>
          <Icon className="w-3.5 h-3.5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className={cn("text-[11px] font-semibold", m.text)}>{m.label}</p>
          {(date || chars) && (
            <p className="text-[9px] text-gray-600 mt-0.5 flex items-center gap-2">
              {date && <span className="flex items-center gap-1"><CalendarDays className="w-2.5 h-2.5" />{date.slice(0, 10)}</span>}
              {chars && <span>{chars.toLocaleString()} chars</span>}
            </p>
          )}
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-600 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-gray-800 bg-gray-950 p-4">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Pair artifact panel ───────────────────────────────────────────────────────

function PairPanel({ salesAgent, customer }: { salesAgent: string; customer: string }) {
  const qs = new URLSearchParams({ agent: salesAgent, customer });

  const { data: personas, isLoading: loadPersonas } =
    useSWR<Persona[]>(`/api/personas?${qs}`, fetcher);

  const { data: notes, isLoading: loadNotes } =
    useSWR<Note[]>(`/api/notes?${qs}`, fetcher);

  const { data: rollup, isLoading: loadRollup, error: rollupErr } =
    useSWR<Record<string, unknown>>(`/api/notes/rollup?${qs}`, fetcher);

  const pairPersonas = (personas ?? [])
    .filter(p => p.type === "pair")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const scoredPersonas = (personas ?? [])
    .filter(p => p.score_json)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const complianceNotes = (notes ?? [])
    .filter(n => n.score_json)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const callNotes = (notes ?? [])
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const isLoading = loadPersonas || loadNotes || loadRollup;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-gray-600">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading artifacts…
      </div>
    );
  }

  const hasAny = pairPersonas.length > 0 || scoredPersonas.length > 0 ||
    (rollup && !rollupErr) || complianceNotes.length > 0 || callNotes.length > 0;

  if (!hasAny) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-700">
        <Archive className="w-8 h-8 opacity-20" />
        <p className="text-sm">No artifacts cached for this context</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">

      {/* Persona */}
      {pairPersonas.length > 0 && (
        <ArtifactCard type="persona" date={pairPersonas[0].created_at} chars={pairPersonas[0].content_md?.length} defaultOpen>
          <div className="prose prose-invert prose-sm max-w-none text-[12px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{pairPersonas[0].content_md}</ReactMarkdown>
          </div>
          <CopyBtn text={pairPersonas[0].content_md} />
          {pairPersonas.length > 1 && (
            <p className="text-[9px] text-gray-700 mt-2">{pairPersonas.length - 1} older version(s) available</p>
          )}
        </ArtifactCard>
      )}

      {/* Persona score */}
      {scoredPersonas.length > 0 && scoredPersonas[0].score_json && (
        <ArtifactCard type="persona_score" date={scoredPersonas[0].created_at}
          chars={scoredPersonas[0].score_json.length}>
          <ScoreContent raw={scoredPersonas[0].score_json} />
          <CopyBtn text={scoredPersonas[0].score_json} />
        </ArtifactCard>
      )}

      {/* Merged notes rollup */}
      {rollup && !rollupErr && (
        <ArtifactCard type="notes_rollup" chars={JSON.stringify(rollup).length}>
          <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
            {JSON.stringify(rollup, null, 2)}
          </pre>
          <CopyBtn text={JSON.stringify(rollup, null, 2)} />
        </ArtifactCard>
      )}

      {/* Compliance notes */}
      {complianceNotes.length > 0 && (
        <ArtifactCard type="notes_compliance" chars={complianceNotes.reduce((s, n) => s + (n.score_json?.length ?? 0), 0)}>
          <div className="space-y-3">
            {complianceNotes.map(n => (
              <div key={n.id}>
                <p className="text-[9px] text-gray-600 font-mono mb-1">call: {n.call_id.slice(-12)} · {n.created_at.slice(0, 10)}</p>
                <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                  {(() => { try { return JSON.stringify(JSON.parse(n.score_json!), null, 2); } catch { return n.score_json; } })()}
                </pre>
              </div>
            ))}
          </div>
        </ArtifactCard>
      )}

      {/* Call notes */}
      {callNotes.length > 0 && (
        <ArtifactCard type="notes_call" chars={callNotes.reduce((s, n) => s + (n.content_md?.length ?? 0), 0)}>
          <div className="space-y-4">
            {callNotes.map(n => (
              <div key={n.id} className="border-b border-gray-800 last:border-0 pb-3 last:pb-0">
                <p className="text-[9px] text-gray-600 font-mono mb-2">
                  call: {n.call_id.slice(-12)} · {n.created_at.slice(0, 10)}
                </p>
                <div className="prose prose-invert prose-sm max-w-none text-[11px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{n.content_md}</ReactMarkdown>
                </div>
                <CopyBtn text={n.content_md} />
              </div>
            ))}
          </div>
        </ArtifactCard>
      )}

    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="flex items-center gap-1 text-[9px] text-gray-700 hover:text-gray-400 transition-colors mt-2">
      <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ScoreContent({ raw }: { raw: string }) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return (
        <div className="space-y-1.5">
          {Object.entries(parsed).map(([k, v]) => (
            <div key={k} className="flex items-start gap-2 text-[10px]">
              <span className="text-gray-500 w-32 shrink-0 truncate">{k}</span>
              <span className="text-gray-300">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
            </div>
          ))}
        </div>
      );
    }
  } catch { /* fall through */ }
  return (
    <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{raw}</pre>
  );
}

// ── Summary badge for nav list ────────────────────────────────────────────────

function ArtifactSummaryDots({ salesAgent, customer }: { salesAgent: string; customer: string }) {
  const qs = new URLSearchParams({ agent: salesAgent, customer });
  const { data: personas } = useSWR<Persona[]>(`/api/personas?${qs}`, fetcher);
  const { data: notes }    = useSWR<Note[]>(`/api/notes?${qs}`, fetcher);
  const { data: rollup, error: rollupErr } = useSWR<unknown>(`/api/notes/rollup?${qs}`, fetcher);

  const hasPair  = (personas ?? []).some(p => p.type === "pair");
  const hasScore = (personas ?? []).some(p => p.score_json);
  const hasRoll  = !!rollup && !rollupErr;
  const hasNotes = (notes ?? []).length > 0;

  if (!hasPair && !hasScore && !hasRoll && !hasNotes) return null;
  return (
    <div className="flex items-center gap-0.5 shrink-0 ml-1">
      {hasPair  && <span className="w-1.5 h-1.5 rounded-full bg-violet-500" title="Persona"  />}
      {hasScore && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" title="Score"    />}
      {hasRoll  && <span className="w-1.5 h-1.5 rounded-full bg-amber-500"  title="Rollup"   />}
      {hasNotes && <span className="w-1.5 h-1.5 rounded-full bg-teal-500"   title="Notes"    />}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ArtifactsPage() {
  const { data: navAgents } = useSWR<{ agent: string; count: number }[]>("/api/crm/nav/agents", fetcher);

  const [selectedAgent, setSelectedAgent]       = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [expandedAgents, setExpandedAgents]     = useState<Record<string, boolean>>({});

  const { data: navCustomers } = useSWR<{ customer: string; call_count: number }[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null, fetcher,
  );

  function toggleAgent(agent: string) {
    setExpandedAgents(p => ({ ...p, [agent]: !p[agent] }));
    if (selectedAgent !== agent) { setSelectedAgent(agent); setSelectedCustomer(""); }
  }

  return (
    <div className="min-h-[calc(100vh-5.25rem)] flex -m-6">

      {/* ── Left: agent / customer tree ─────────────────────────── */}
      <aside className="w-56 shrink-0 border-r border-gray-800 flex flex-col bg-gray-950 overflow-hidden">
        <div className="px-3 py-2.5 border-b border-gray-800 shrink-0">
          <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Artifact Browser</p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {(navAgents ?? []).map(a => {
            const isExpanded = expandedAgents[a.agent];
            const isSel      = selectedAgent === a.agent;
            return (
              <div key={a.agent}>
                <button
                  onClick={() => toggleAgent(a.agent)}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-[11px] transition-colors",
                    isSel ? "bg-indigo-900/30 text-white" : "text-gray-400 hover:text-white hover:bg-gray-800/60",
                  )}>
                  {isExpanded
                    ? <ChevronDown className="w-3 h-3 shrink-0 text-gray-600" />
                    : <ChevronRight className="w-3 h-3 shrink-0 text-gray-600" />}
                  <span className="truncate flex-1">{a.agent}</span>
                  <span className="text-[9px] text-gray-700 shrink-0">{a.count}</span>
                </button>

                {isExpanded && (
                  <div className="ml-4 mt-0.5 space-y-0.5">
                    {navCustomers === undefined && isSel ? (
                      <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-gray-700">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> loading
                      </div>
                    ) : (navCustomers ?? []).map(c => (
                      <button key={c.customer}
                        onClick={() => { setSelectedCustomer(c.customer); setSelectedAgent(a.agent); }}
                        className={cn(
                          "w-full flex items-center px-2 py-1 rounded-md text-left text-[10px] transition-colors",
                          selectedCustomer === c.customer && selectedAgent === a.agent
                            ? "bg-indigo-800/40 text-white"
                            : "text-gray-500 hover:text-white hover:bg-gray-800/40",
                        )}>
                        <span className="truncate flex-1">{c.customer}</span>
                        <ArtifactSummaryDots salesAgent={a.agent} customer={c.customer} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {(navAgents ?? []).length === 0 && (
            <p className="text-[10px] text-gray-700 italic px-2 py-4 text-center">No agents in CRM</p>
          )}
        </div>
      </aside>

      {/* ── Main: artifact viewer ────────────────────────────────── */}
      <main className="flex-1 min-w-0 overflow-y-auto bg-gray-900">
        {selectedAgent && selectedCustomer ? (
          <div className="p-6 max-w-3xl mx-auto">
            {/* Context header */}
            <div className="flex items-center gap-3 mb-6">
              <div>
                <h2 className="text-base font-semibold text-white">{selectedCustomer}</h2>
                <p className="text-xs text-gray-500">{selectedAgent}</p>
              </div>
              <button onClick={() => {
                  // force SWR revalidation by navigating away and back is not needed —
                  // mutate() would be the right call but requires useSWRConfig, keep simple
                  setSelectedCustomer(""); setTimeout(() => setSelectedCustomer(selectedCustomer), 50);
                }}
                className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-600 hover:text-gray-400 transition-colors">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>

            <PairPanel salesAgent={selectedAgent} customer={selectedCustomer} />
          </div>
        ) : selectedAgent ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-700 py-24">
            <Archive className="w-10 h-10 opacity-10" />
            <p className="text-sm">Select a customer to view their artifacts</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-700 py-24">
            <Archive className="w-10 h-10 opacity-10" />
            <p className="text-sm">Select a sales agent to browse artifacts</p>
          </div>
        )}
      </main>

    </div>
  );
}
