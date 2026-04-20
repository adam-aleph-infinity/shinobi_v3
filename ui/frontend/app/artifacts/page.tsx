"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  User, BadgeCheck, StickyNote, ShieldCheck, Layers, FileText, GitBranch,
  Loader2, Copy, Archive, Search, CalendarDays, ChevronRight, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { useAppCtx } from "@/lib/app-context";

const fetcher = (url: string) =>
  fetch(url).then(r => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

// Returns null on 404 instead of throwing (for optional artifacts)
const fetcherOptional = (url: string) =>
  fetch(url).then(r => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });

// ── Types ─────────────────────────────────────────────────────────────────────

interface Persona {
  id: string; type: string; agent: string; customer?: string; label?: string;
  content_md: string; score_json?: unknown; model: string; created_at: string; version: number;
}
interface Note {
  id: string; agent: string; customer: string; call_id: string;
  content_md: string; score_json?: unknown; model: string; created_at: string;
}
interface PipelineRun {
  id: string; pipeline_name: string; sales_agent: string; customer: string;
  started_at: string; finished_at: string | null; status: string;
  steps_json: string; canvas_json: string;
}
interface RunStep {
  agent_id: string; agent_name: string; status: string;
  content: string; model?: string;
}

type ArtifactKind =
  | "merged_transcript"
  | "persona"
  | "persona_score"
  | "notes_rollup"
  | "note"
  | "compliance_note"
  | "pipeline_persona"
  | "pipeline_score"
  | "pipeline_notes"
  | "pipeline_compliance"
  | "pipeline_output";

type ArtifactItem =
  | { kind: "merged_transcript"; id: "merged_transcript"; date: string; chars: number; label: string; data: { content: string } }
  | { kind: "persona";           id: string; date: string; chars: number; label: string; data: Persona }
  | { kind: "persona_score";     id: string; date: string; chars: number; label: string; data: Persona }
  | { kind: "notes_rollup";      id: "rollup"; date: string; chars: number; label: string; data: Record<string, unknown> }
  | { kind: "note";              id: string; date: string; chars: number; label: string; data: Note }
  | { kind: "compliance_note";   id: string; date: string; chars: number; label: string; data: Note }
  | { kind: "pipeline_persona";    id: string; date: string; chars: number; label: string; data: { content: string; agent_name: string; pipeline_name: string; model: string; run_id: string } }
  | { kind: "pipeline_score";      id: string; date: string; chars: number; label: string; data: { content: string; agent_name: string; pipeline_name: string; model: string; run_id: string } }
  | { kind: "pipeline_notes";      id: string; date: string; chars: number; label: string; data: { content: string; agent_name: string; pipeline_name: string; model: string; run_id: string } }
  | { kind: "pipeline_compliance"; id: string; date: string; chars: number; label: string; data: { content: string; agent_name: string; pipeline_name: string; model: string; run_id: string } }
  | { kind: "pipeline_output";     id: string; date: string; chars: number; label: string; data: { content: string; agent_name: string; pipeline_name: string; model: string; run_id: string } };

// ── Artifact type config ──────────────────────────────────────────────────────

const ARTIFACT_TYPE_META: Record<ArtifactKind, {
  label: string; icon: React.ComponentType<{ className?: string }>;
  bg: string; text: string; border: string; dot: string;
}> = {
  merged_transcript: { label: "Merged Transcript",  icon: FileText,   bg: "bg-cyan-900/40",    text: "text-cyan-300",    border: "border-cyan-700/40",    dot: "bg-cyan-500"    },
  persona:           { label: "Personas",            icon: User,       bg: "bg-violet-900/50",  text: "text-violet-300",  border: "border-violet-700/40",  dot: "bg-violet-500"  },
  persona_score:     { label: "Persona Scores",      icon: BadgeCheck, bg: "bg-violet-900/30",  text: "text-violet-400",  border: "border-violet-700/30",  dot: "bg-violet-400"  },
  notes_rollup:      { label: "Merged Notes",        icon: Layers,     bg: "bg-amber-900/40",   text: "text-amber-300",   border: "border-amber-700/40",   dot: "bg-amber-500"   },
  note:              { label: "Call Notes",          icon: StickyNote, bg: "bg-teal-900/40",    text: "text-teal-300",    border: "border-teal-700/40",    dot: "bg-teal-500"    },
  compliance_note:    { label: "Compliance Notes",    icon: ShieldCheck, bg: "bg-emerald-900/40", text: "text-emerald-300", border: "border-emerald-700/40", dot: "bg-emerald-500" },
  pipeline_persona:   { label: "Persona (Pipeline)",  icon: User,        bg: "bg-violet-900/50",  text: "text-violet-300",  border: "border-violet-700/40",  dot: "bg-violet-500"  },
  pipeline_score:     { label: "Score (Pipeline)",    icon: BadgeCheck,  bg: "bg-violet-900/30",  text: "text-violet-400",  border: "border-violet-700/30",  dot: "bg-violet-400"  },
  pipeline_notes:     { label: "Notes (Pipeline)",    icon: StickyNote,  bg: "bg-amber-900/40",   text: "text-amber-300",   border: "border-amber-700/40",   dot: "bg-amber-500"   },
  pipeline_compliance:{ label: "Compliance (Pipeline)",icon: ShieldCheck,bg: "bg-emerald-900/30", text: "text-emerald-400", border: "border-emerald-700/30", dot: "bg-emerald-400" },
  pipeline_output:    { label: "Pipeline Outputs",    icon: GitBranch,   bg: "bg-indigo-900/40",  text: "text-indigo-300",  border: "border-indigo-700/40",  dot: "bg-indigo-500"  },
};

// ── Pipeline canvas helpers ───────────────────────────────────────────────────

/** Parse canvas_json and return a map of agent_id → artifact subType */
function getAgentArtifactMap(canvasJson: string): Record<string, string> {
  try {
    const canvas = JSON.parse(canvasJson) as {
      nodes: Array<{ id: string; type: string; data: { agentId?: string; subType?: string } }>;
      edges: Array<{ source: string; target: string }>;
    };
    const map: Record<string, string> = {};
    for (const node of canvas.nodes) {
      if (node.type !== "processing") continue;
      const agentId = node.data.agentId;
      if (!agentId) continue;
      const outEdge = canvas.edges.find(e => e.source === node.id);
      if (!outEdge) continue;
      const outNode = canvas.nodes.find(n => n.id === outEdge.target);
      if (!outNode || outNode.type !== "output") continue;
      map[agentId] = outNode.data.subType ?? "general";
    }
    return map;
  } catch { return {}; }
}

function subTypeToKind(subType: string): ArtifactKind {
  if (subType === "persona")          return "pipeline_persona";
  if (subType === "persona_score")    return "pipeline_score";
  if (subType === "notes")            return "pipeline_notes";
  if (subType === "notes_compliance") return "pipeline_compliance";
  return "pipeline_output";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors shrink-0">
      <Copy className="w-3 h-3" /> {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DeleteBtn({ onDelete }: { onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting,   setDeleting]   = useState(false);
  if (confirming) return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button onClick={() => setConfirming(false)}
        className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors">Cancel</button>
      <button onClick={async () => {
        setDeleting(true);
        await onDelete();
        setDeleting(false);
        setConfirming(false);
      }} className="text-[9px] text-red-400 hover:text-red-300 font-semibold transition-colors">
        {deleting ? "…" : "Confirm"}
      </button>
    </div>
  );
  return (
    <button onClick={() => setConfirming(true)}
      className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-red-400 transition-colors shrink-0"
      title="Delete artifact">
      <Trash2 className="w-3 h-3" />
    </button>
  );
}

// ── Shared renderers ──────────────────────────────────────────────────────────

/** Render a JSON value as a key-value table; fallback to raw string. */
function JsonKVTable({ value, accentColor = "text-gray-500" }: { value: unknown; accentColor?: string }) {
  const parsed = (() => {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") return value;
    try { return JSON.parse(value as string); } catch { return null; }
  })();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return (
      <div className="space-y-2">
        {Object.entries(parsed as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="flex gap-3 text-xs border-b border-gray-800/60 pb-2 last:border-0">
            <span className={cn("w-48 shrink-0 font-medium", accentColor)}>{k}</span>
            <span className="text-gray-300 break-words">
              {typeof v === "object" ? JSON.stringify(v) : String(v)}
            </span>
          </div>
        ))}
      </div>
    );
  }
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-words">{raw}</pre>;
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

// ── Content viewer ────────────────────────────────────────────────────────────

function ContentViewer({ item, onDelete }: { item: ArtifactItem; onDelete?: () => Promise<void> }) {
  if (item.kind === "merged_transcript") {
    const text = item.data.content;
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Merged Transcript</p>
            <p className="text-[10px] text-gray-500">{item.chars.toLocaleString()} chars</p>
          </div>
          <CopyBtn text={text} />
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <pre className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed">{text}</pre>
        </div>
      </div>
    );
  }

  if (item.kind === "persona") {
    const md = item.data.content_md ?? "";
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.label}</p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars · type: {item.data.type}</p>
          </div>
          <CopyBtn text={md} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <MarkdownBody content={md} />
        </div>
      </div>
    );
  }

  if (item.kind === "persona_score" && item.data.score_json != null) {
    const raw = prettyJson(item.data.score_json);
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.label}</p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <CopyBtn text={raw} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <JsonKVTable value={item.data.score_json} accentColor="text-gray-500" />
        </div>
      </div>
    );
  }

  if (item.kind === "notes_rollup") {
    const d = item.data;
    const raw = JSON.stringify(d, null, 2);
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
          <CopyBtn text={raw} />
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
    const md = item.data.content_md ?? "";
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">Call Note · {item.data.call_id.slice(-12)}</p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <CopyBtn text={md} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {md ? <MarkdownBody content={md} /> : <p className="text-xs text-gray-600 italic">No content</p>}
        </div>
      </div>
    );
  }

  if (item.kind === "compliance_note") {
    const md  = item.data.content_md ?? "";
    const raw = prettyJson(item.data.score_json);
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">Compliance Note · {item.data.call_id.slice(-12)}</p>
            <p className="text-[10px] text-gray-500">{item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <CopyBtn text={md + (raw ? "\n\n" + raw : "")} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div>
            <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wide mb-2">Compliance Score</p>
            <JsonKVTable value={item.data.score_json} accentColor="text-emerald-700" />
          </div>
          {md && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">Note Content</p>
              <MarkdownBody content={md} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Pipeline artifact kinds ────────────────────────────────────────────────
  if (
    item.kind === "pipeline_persona" ||
    item.kind === "pipeline_notes" ||
    item.kind === "pipeline_output"
  ) {
    // Markdown output
    const m = ARTIFACT_TYPE_META[item.kind];
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <span className={cn("p-1 rounded border shrink-0", m.bg, m.text, m.border)}>
            <m.icon className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.data.agent_name}</p>
            <p className="text-[10px] text-gray-500">
              {item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars · {item.data.pipeline_name}
              {item.data.model ? ` · ${item.data.model}` : ""}
            </p>
          </div>
          <CopyBtn text={item.data.content} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <MarkdownBody content={item.data.content} />
        </div>
      </div>
    );
  }

  if (item.kind === "pipeline_score" || item.kind === "pipeline_compliance") {
    // JSON key-value output — same style as persona_score / compliance_note
    const m = ARTIFACT_TYPE_META[item.kind];
    const accentColor = item.kind === "pipeline_compliance" ? "text-emerald-700" : "text-gray-500";
    const sectionLabel = item.kind === "pipeline_compliance" ? "Compliance Score" : "Score";
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <span className={cn("p-1 rounded border shrink-0", m.bg, m.text, m.border)}>
            <m.icon className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.data.agent_name}</p>
            <p className="text-[10px] text-gray-500">
              {item.date.slice(0, 10)} · {item.chars.toLocaleString()} chars · {item.data.pipeline_name}
              {item.data.model ? ` · ${item.data.model}` : ""}
            </p>
          </div>
          <CopyBtn text={item.data.content} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <p className={cn("text-[10px] font-bold uppercase tracking-wide mb-2", accentColor)}>{sectionLabel}</p>
            <JsonKVTable value={item.data.content} accentColor={accentColor} />
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ── Item row ──────────────────────────────────────────────────────────────────

function ItemRow({ item, selected, onClick }: { item: ArtifactItem; selected: boolean; onClick: () => void }) {
  const m = ARTIFACT_TYPE_META[item.kind];
  const Icon = m.icon;
  return (
    <button onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-l-2",
        selected
          ? "bg-indigo-900/30 border-indigo-500"
          : "border-transparent hover:bg-gray-800/40",
      )}>
      <span className={cn("p-0.5 rounded border shrink-0", m.bg, m.text, m.border)}>
        <Icon className="w-3 h-3" />
      </span>
      <div className="flex-1 min-w-0">
        <p className={cn("text-[11px] font-medium truncate", selected ? "text-white" : "text-gray-300")}>{item.label}</p>
        <p className="text-[9px] text-gray-600 flex items-center gap-1.5">
          <CalendarDays className="w-2.5 h-2.5" />{item.date.slice(0, 10)}
          <span className="text-gray-700">{item.chars.toLocaleString()} chars</span>
        </p>
      </div>
      <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />
    </button>
  );
}

// ── Status dots ───────────────────────────────────────────────────────────────

function StatusDots({ salesAgent, customer }: { salesAgent: string; customer: string }) {
  const qs = new URLSearchParams({ agent: salesAgent, customer });
  const { data: personas } = useSWR<Persona[]>(`/api/personas?${qs}`, fetcher);
  const { data: notes }    = useSWR<Note[]>(`/api/notes?${qs}`, fetcher);
  const { data: rollup, error: rollupErr } = useSWR<Record<string, unknown>>(`/api/notes/rollup?${qs}`, fetcher);
  const mtUrl = `/api/universal-agents/raw-input?source=merged_transcript&sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`;
  const { data: mt } = useSWR<{ content: string; chars: number } | null>(mtUrl, fetcherOptional);
  const has = {
    mt:         mt != null,
    persona:    (personas ?? []).length > 0,
    score:      (personas ?? []).some(p => p.score_json != null),
    rollup:     !!rollup && !rollupErr,
    notes:      (notes ?? []).some(n => n.score_json == null),
    compliance: (notes ?? []).some(n => n.score_json != null),
  };
  if (!has.mt && !has.persona && !has.rollup && !has.notes && !has.compliance) return null;
  return (
    <div className="flex items-center gap-0.5 shrink-0 ml-1">
      {has.mt         && <span className="w-1.5 h-1.5 rounded-full bg-cyan-500"    title="Merged Transcript" />}
      {has.persona    && <span className="w-1.5 h-1.5 rounded-full bg-violet-500"  title="Persona" />}
      {has.score      && <span className="w-1.5 h-1.5 rounded-full bg-violet-400"  title="Score" />}
      {has.rollup     && <span className="w-1.5 h-1.5 rounded-full bg-amber-500"   title="Merged Notes" />}
      {has.notes      && <span className="w-1.5 h-1.5 rounded-full bg-teal-500"    title="Call Notes" />}
      {has.compliance && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Compliance Notes" />}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ArtifactsPage() {
  const [agentW,    agentDrag]    = useResize(160, 120, 280);
  const [customerW, customerDrag] = useResize(160, 120, 280);
  const [typesW,    typesDrag]    = useResize(150, 120, 240);
  const [itemsW,    itemsDrag]    = useResize(220, 160, 360);

  const [selectedAgent,    setSelectedAgent]    = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [selectedKind,     setSelectedKind]     = useState<ArtifactKind | null>(null);
  const [selectedItem,     setSelectedItem]     = useState<ArtifactItem | null>(null);
  const [agentSearch,      setAgentSearch]      = useState("");
  const [customerSearch,   setCustomerSearch]   = useState("");

  // Pre-populate from global context (ContextBar breadcrumb)
  const { salesAgent: ctxAgent, customer: ctxCustomer } = useAppCtx();
  const [ctxApplied, setCtxApplied] = useState(false);
  useEffect(() => {
    if (!ctxApplied && ctxAgent) {
      setSelectedAgent(ctxAgent);
      if (ctxCustomer) setSelectedCustomer(ctxCustomer);
      setCtxApplied(true);
    }
  }, [ctxAgent, ctxCustomer, ctxApplied]);

  const { data: navAgents }    = useSWR<{ agent: string; count: number }[]>("/api/crm/nav/agents", fetcher);
  const { data: navCustomers } = useSWR<{ customer: string; call_count: number }[]>(
    selectedAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(selectedAgent)}` : null, fetcher,
  );

  const pairQs = selectedAgent && selectedCustomer
    ? new URLSearchParams({ agent: selectedAgent, customer: selectedCustomer })
    : null;

  const { data: personas, isLoading: loadP, mutate: mutatePersonas } = useSWR<Persona[]>(
    pairQs ? `/api/personas?${pairQs}` : null, fetcher,
  );
  const { data: notes, isLoading: loadN, mutate: mutateNotes } = useSWR<Note[]>(
    pairQs ? `/api/notes?${pairQs}` : null, fetcher,
  );
  const { data: rollup, isLoading: loadR, error: rollupErr } = useSWR<Record<string, unknown>>(
    pairQs ? `/api/notes/rollup?${pairQs}` : null, fetcher,
  );
  // Merged transcript + pipeline runs load independently — don't block the type panel
  const mtUrl = pairQs
    ? `/api/universal-agents/raw-input?source=merged_transcript&sales_agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer)}`
    : null;
  const { data: mergedTranscript } = useSWR<{ content: string; chars: number } | null>(
    mtUrl, fetcherOptional,
  );
  const runsUrl = pairQs
    ? `/api/history/runs?sales_agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer)}&limit=50`
    : null;
  const { data: historyRuns, isLoading: loadRuns, mutate: mutateRuns } = useSWR<PipelineRun[]>(
    runsUrl, fetcher, { refreshInterval: 8000, dedupingInterval: 500 },
  );

  // All core data must load before Panel 3 renders (avoids "No artifacts" flash)
  const isLoadingPair = loadP || loadN || loadR || (!!runsUrl && loadRuns);

  // Build items per kind
  const itemsByKind: Record<ArtifactKind, ArtifactItem[]> = {
    merged_transcript: [],
    persona: [],
    persona_score: [],
    notes_rollup: [],
    note: [],
    compliance_note: [],
    pipeline_persona: [],
    pipeline_score: [],
    pipeline_notes: [],
    pipeline_compliance: [],
    pipeline_output: [],
  };

  if (mergedTranscript != null) {
    itemsByKind.merged_transcript.push({
      kind: "merged_transcript", id: "merged_transcript",
      date: new Date().toISOString(),
      chars: mergedTranscript.chars,
      label: `Merged Transcript (${mergedTranscript.chars.toLocaleString()} chars)`,
      data: { content: mergedTranscript.content },
    });
  }

  (personas ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)).forEach(p => {
    itemsByKind.persona.push({
      kind: "persona", id: p.id, date: p.created_at,
      chars: p.content_md?.length ?? 0,
      label: p.label ? p.label : `Persona (${p.type}) · v${p.version}`,
      data: p,
    });
    if (p.score_json != null) {
      const scoreStr = prettyJson(p.score_json);
      itemsByKind.persona_score.push({
        kind: "persona_score", id: `${p.id}_score`, date: p.created_at,
        chars: scoreStr.length,
        label: `Score for ${p.label ?? `v${p.version}`}`,
        data: p,
      });
    }
  });

  if (rollup && !rollupErr) {
    const raw = JSON.stringify(rollup);
    const saved = rollup._saved_at as string | undefined;
    itemsByKind.notes_rollup.push({
      kind: "notes_rollup", id: "rollup",
      date: saved ?? new Date().toISOString(),
      chars: raw.length,
      label: `Merged Notes${rollup._note_count ? ` (${rollup._note_count} notes)` : ""}`,
      data: rollup,
    });
  }

  // Split call notes into regular and compliance
  (notes ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)).forEach(n => {
    if (n.score_json != null) {
      itemsByKind.compliance_note.push({
        kind: "compliance_note", id: n.id, date: n.created_at,
        chars: n.content_md?.length ?? 0,
        label: `Compliance Note · ${n.call_id.slice(-12)}`,
        data: n,
      });
    } else {
      itemsByKind.note.push({
        kind: "note", id: n.id, date: n.created_at,
        chars: n.content_md?.length ?? 0,
        label: `Call Note · ${n.call_id.slice(-12)}`,
        data: n,
      });
    }
  });

  // Pipeline step outputs — routed by artifact class from canvas_json
  (historyRuns ?? [])
    .filter(r => r.status === "done")
    .forEach(run => {
      let steps: RunStep[] = [];
      try { steps = JSON.parse(run.steps_json); } catch { return; }
      const agentMap = getAgentArtifactMap(run.canvas_json ?? "");
      steps.forEach((step, idx) => {
        if (step.status !== "done" || !step.content) return;
        const kind = subTypeToKind(agentMap[step.agent_id] ?? "");
        (itemsByKind[kind] as ArtifactItem[]).push({
          kind,
          id: `${run.id}_${idx}`,
          date: run.finished_at ?? run.started_at,
          chars: step.content.length,
          label: `${step.agent_name} · ${run.pipeline_name}`,
          data: {
            content: step.content,
            agent_name: step.agent_name,
            pipeline_name: run.pipeline_name,
            model: step.model ?? "",
            run_id: run.id,
          },
        } as ArtifactItem);
      });
    });

  async function handleDelete(item: ArtifactItem) {
    let url: string | null = null;
    if (item.kind === "persona") {
      url = `/api/personas/${item.id}`;
    } else if (item.kind === "persona_score") {
      url = `/api/personas/${item.data.id}`;
    } else if (item.kind === "note" || item.kind === "compliance_note") {
      url = `/api/notes/${item.id}`;
    } else if (
      item.kind === "pipeline_persona" || item.kind === "pipeline_score" ||
      item.kind === "pipeline_notes"   || item.kind === "pipeline_compliance" ||
      item.kind === "pipeline_output"
    ) {
      url = `/api/history/runs/${item.data.run_id}`;
    }
    if (!url) return;
    await fetch(url, { method: "DELETE" });
    if (item.kind === "persona" || item.kind === "persona_score") {
      await mutatePersonas();
    } else if (item.kind === "note" || item.kind === "compliance_note") {
      await mutateNotes();
    } else if (item.kind.startsWith("pipeline_")) {
      await mutateRuns();
    }
    setSelectedItem(null);
  }

  const typeGroups = (Object.keys(ARTIFACT_TYPE_META) as ArtifactKind[])
    .filter(k => itemsByKind[k].length > 0);

  const visibleItems = selectedKind ? itemsByKind[selectedKind] : [];

  const filteredAgents    = (navAgents ?? []).filter(a => a.agent.toLowerCase().includes(agentSearch.toLowerCase()));
  const filteredCustomers = (navCustomers ?? []).filter(c => c.customer.toLowerCase().includes(customerSearch.toLowerCase()));

  function selectAgent(a: string) {
    setSelectedAgent(a); setSelectedCustomer(""); setSelectedKind(null); setSelectedItem(null);
  }
  function selectCustomer(c: string) {
    setSelectedCustomer(c); setSelectedKind(null); setSelectedItem(null);
  }
  function selectKind(k: ArtifactKind) {
    setSelectedKind(k); setSelectedItem(null);
  }

  return (
    <div className="h-[calc(100vh-5.25rem)] flex overflow-hidden">

      {/* ── Panel 1: Agents ─────────────────────────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: agentW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Sales Agents</p>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600" />
              <input value={agentSearch} onChange={e => setAgentSearch(e.target.value)} placeholder="Search…"
                className="w-full bg-gray-800 border border-gray-700 rounded-md pl-6 pr-2 py-1 text-[10px] text-white outline-none focus:border-indigo-500 placeholder-gray-600" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {filteredAgents.map(a => (
              <button key={a.agent} onClick={() => selectAgent(a.agent)}
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
            {filteredAgents.length === 0 && <p className="text-[10px] text-gray-700 italic px-3 py-4">No agents</p>}
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
              <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} placeholder="Search…"
                disabled={!selectedAgent}
                className="w-full bg-gray-800 border border-gray-700 rounded-md pl-6 pr-2 py-1 text-[10px] text-white outline-none focus:border-indigo-500 placeholder-gray-600 disabled:opacity-40" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!selectedAgent
              ? <p className="text-[10px] text-gray-700 italic px-3 py-4">Select an agent</p>
              : filteredCustomers.map(c => (
                <button key={c.customer} onClick={() => selectCustomer(c.customer)}
                  className={cn(
                    "w-full flex items-center gap-1 px-3 py-2 text-left text-[11px] transition-colors border-l-2",
                    selectedCustomer === c.customer
                      ? "bg-indigo-900/30 border-indigo-500 text-white"
                      : "border-transparent text-gray-400 hover:text-white hover:bg-gray-800/40",
                  )}>
                  <span className="flex-1 truncate">{c.customer}</span>
                  <StatusDots salesAgent={selectedAgent} customer={c.customer} />
                </button>
              ))}
            {selectedAgent && filteredCustomers.length === 0 && <p className="text-[10px] text-gray-700 italic px-3 py-4">No customers</p>}
          </div>
        </div>
        <DragHandle onMouseDown={customerDrag} />
      </div>

      {/* ── Panel 3: Artifact types ──────────────────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: typesW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Artifact Types</p>
            {selectedCustomer && !isLoadingPair && (
              <p className="text-[9px] text-gray-700 mt-0.5">{typeGroups.length} type{typeGroups.length !== 1 ? "s" : ""}</p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!selectedCustomer ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select a customer</p>
            ) : isLoadingPair ? (
              <div className="flex items-center gap-1.5 px-3 py-4 text-[10px] text-gray-600">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            ) : typeGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-gray-700">
                <Archive className="w-5 h-5 opacity-20" />
                <p className="text-[10px]">No artifacts</p>
              </div>
            ) : typeGroups.map(k => {
              const m = ARTIFACT_TYPE_META[k];
              const Icon = m.icon;
              const count = itemsByKind[k].length;
              const isSel = selectedKind === k;
              return (
                <button key={k} onClick={() => selectKind(k)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors border-l-2",
                    isSel ? "bg-indigo-900/30 border-indigo-500" : "border-transparent hover:bg-gray-800/40",
                  )}>
                  <span className={cn("p-0.5 rounded border shrink-0", m.bg, m.text, m.border)}>
                    <Icon className="w-3 h-3" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-[11px] font-medium truncate", isSel ? "text-white" : m.text)}>{m.label}</p>
                    <p className="text-[9px] text-gray-600">{count} item{count !== 1 ? "s" : ""}</p>
                  </div>
                  <ChevronRight className={cn("w-3 h-3 shrink-0 transition-colors", isSel ? "text-indigo-400" : "text-gray-700")} />
                </button>
              );
            })}
          </div>
        </div>
        <DragHandle onMouseDown={typesDrag} />
      </div>

      {/* ── Panel 4: Items within type ───────────────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: itemsW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">
              {selectedKind ? ARTIFACT_TYPE_META[selectedKind].label : "Items"}
            </p>
            {selectedKind && (
              <p className="text-[9px] text-gray-700 mt-0.5">{visibleItems.length} item{visibleItems.length !== 1 ? "s" : ""}</p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!selectedKind ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select an artifact type</p>
            ) : visibleItems.length === 0 ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">No items</p>
            ) : visibleItems.map(item => (
              <ItemRow key={item.id} item={item}
                selected={selectedItem?.id === item.id}
                onClick={() => setSelectedItem(item)} />
            ))}
          </div>
        </div>
        <DragHandle onMouseDown={itemsDrag} />
      </div>

      {/* ── Panel 5: Content viewer ──────────────────────────────── */}
      <div className="flex-1 min-w-0 bg-gray-900 overflow-hidden">
        {selectedItem ? (
          <ContentViewer item={selectedItem} onDelete={() => handleDelete(selectedItem)} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-700">
            <Archive className="w-10 h-10 opacity-10" />
            <p className="text-sm">
              {!selectedAgent    ? "Select a sales agent"
               : !selectedCustomer ? "Select a customer"
               : !selectedKind     ? "Select an artifact type"
               : "Select an item to view it"}
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
