"use client";

import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import {
  User, BadgeCheck, StickyNote, ShieldCheck, Layers, FileText, GitBranch,
  Loader2, Copy, Archive, CalendarDays, ChevronRight, Trash2,
  CloudUpload, AlertTriangle, Clock, Code2, Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useResize } from "@/lib/useResize";
import { DragHandle } from "@/components/shared/DragHandle";
import { useAppCtx } from "@/lib/app-context";
import { SectionContent } from "@/components/shared/SectionCards";

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
  agent_id: string;
  agent_name: string;
  status?: string;
  state?: string;
  content?: string;
  model?: string;
}
interface UploadedFile {
  id: string; provider: string; provider_file_id: string; provider_file_uri?: string;
  content_hash: string; input_key: string; source: string;
  sales_agent: string; customer: string; call_id?: string;
  chars: number; created_at: string; expires_at?: string;
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
  | "pipeline_output"
  | "provider_file";

interface PipelineBucket {
  id: string;
  label: string;
  items: ArtifactItem[];
  latestTs: number;
}

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
  | { kind: "pipeline_output";     id: string; date: string; chars: number; label: string; data: { content: string; agent_name: string; pipeline_name: string; model: string; run_id: string } }
  | { kind: "provider_file";       id: string; date: string; chars: number; label: string; data: UploadedFile };

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
  provider_file:      { label: "Provider Files",      icon: CloudUpload, bg: "bg-sky-900/40",     text: "text-sky-300",     border: "border-sky-700/40",     dot: "bg-sky-500"     },
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

function isPipelineKind(
  kind: ArtifactKind,
): kind is "pipeline_persona" | "pipeline_score" | "pipeline_notes" | "pipeline_compliance" | "pipeline_output" {
  return (
    kind === "pipeline_persona" ||
    kind === "pipeline_score" ||
    kind === "pipeline_notes" ||
    kind === "pipeline_compliance" ||
    kind === "pipeline_output"
  );
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

function formatVmDateTime(value: string): string {
  if (!value) return "—";
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  try {
    return new Date(s).toISOString().slice(0, 19).replace("T", " ");
  } catch {
    return s;
  }
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

// ── Raw/rendered toggle ───────────────────────────────────────────────────────

function RawToggle({ raw, onToggle }: { raw: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} title={raw ? "Show rendered" : "Show raw"}
      className="flex items-center gap-1 text-[9px] text-gray-600 hover:text-gray-400 transition-colors shrink-0">
      {raw ? <Eye className="w-3 h-3" /> : <Code2 className="w-3 h-3" />}
      {raw ? "Rendered" : "Raw"}
    </button>
  );
}

const RAW_PRE = "text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed";

// ── Content viewer ────────────────────────────────────────────────────────────

function ContentViewer({ item, onDelete }: { item: ArtifactItem; onDelete?: () => Promise<void> }) {
  // useState must be unconditional (rules of hooks)
  const [rawMode, setRawMode] = useState(false);
  const toggle = () => setRawMode(r => !r);

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
          <pre className={RAW_PRE}>{text}</pre>
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
            <p className="text-[10px] text-gray-500">{formatVmDateTime(item.date)} · {item.chars.toLocaleString()} chars · type: {item.data.type}</p>
          </div>
          <RawToggle raw={rawMode} onToggle={toggle} />
          <CopyBtn text={md} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {rawMode ? <pre className={RAW_PRE}>{md}</pre> : <SectionContent content={md} />}
        </div>
      </div>
    );
  }

  if (item.kind === "persona_score" && item.data.score_json != null) {
    const rawText = prettyJson(item.data.score_json);
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{item.label}</p>
            <p className="text-[10px] text-gray-500">{formatVmDateTime(item.date)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <RawToggle raw={rawMode} onToggle={toggle} />
          <CopyBtn text={rawText} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {rawMode
            ? <pre className={RAW_PRE}>{rawText}</pre>
            : <JsonKVTable value={item.data.score_json} accentColor="text-gray-500" />}
        </div>
      </div>
    );
  }

  if (item.kind === "notes_rollup") {
    const d = item.data;
    const rawText = JSON.stringify(d, null, 2);
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
          <RawToggle raw={rawMode} onToggle={toggle} />
          <CopyBtn text={rawText} />
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {rawMode ? <pre className={RAW_PRE}>{rawText}</pre> : (
            <div className="space-y-4">
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
                <pre className="p-3 text-[9px] text-gray-500 font-mono whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{rawText}</pre>
              </details>
            </div>
          )}
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
            <p className="text-[10px] text-gray-500">{formatVmDateTime(item.date)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <RawToggle raw={rawMode} onToggle={toggle} />
          <CopyBtn text={md} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {rawMode
            ? <pre className={RAW_PRE}>{md || "(empty)"}</pre>
            : (md ? <SectionContent content={md} /> : <p className="text-xs text-gray-600 italic">No content</p>)}
        </div>
      </div>
    );
  }

  if (item.kind === "compliance_note") {
    const md      = item.data.content_md ?? "";
    const rawText = prettyJson(item.data.score_json);
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">Compliance Note · {item.data.call_id.slice(-12)}</p>
            <p className="text-[10px] text-gray-500">{formatVmDateTime(item.date)} · {item.chars.toLocaleString()} chars</p>
          </div>
          <RawToggle raw={rawMode} onToggle={toggle} />
          <CopyBtn text={md + (rawText ? "\n\n" + rawText : "")} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {rawMode ? (
            <pre className={RAW_PRE}>{rawText}{md ? "\n\n" + md : ""}</pre>
          ) : (
            <div className="space-y-5">
              <div>
                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wide mb-2">Compliance Score</p>
                <JsonKVTable value={item.data.score_json} accentColor="text-emerald-700" />
              </div>
              {md && (
                <div>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">Note Content</p>
                  <SectionContent content={md} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Pipeline artifact kinds — all share the same layout ──────────────────
  if (
    item.kind === "pipeline_persona" ||
    item.kind === "pipeline_score"   ||
    item.kind === "pipeline_notes"   ||
    item.kind === "pipeline_compliance" ||
    item.kind === "pipeline_output"
  ) {
    const m = ARTIFACT_TYPE_META[item.kind];
    const content = item.data.content;
    const parsedJson = (() => {
      try {
        const p = JSON.parse(content);
        return p && typeof p === "object" && !Array.isArray(p) ? p as Record<string, unknown> : null;
      } catch { return null; }
    })();
    const accentColor = item.kind === "pipeline_compliance" ? "text-emerald-700"
                      : item.kind === "pipeline_score"      ? "text-violet-400"
                      : "text-gray-500";
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <span className={cn("p-1 rounded border shrink-0", m.bg, m.text, m.border)}>
            <m.icon className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className={cn("text-xs font-semibold uppercase tracking-wide", m.text)}>{m.label}</p>
            <p className="text-sm font-semibold text-white truncate">{item.data.agent_name}</p>
            <p className="text-[10px] text-gray-500">
              {formatVmDateTime(item.date)} · {item.chars.toLocaleString()} chars · {item.data.pipeline_name}
              {item.data.model ? ` · ${item.data.model}` : ""}
            </p>
          </div>
          <RawToggle raw={rawMode} onToggle={toggle} />
          <CopyBtn text={content} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {rawMode
            ? <pre className={RAW_PRE}>{content}</pre>
            : parsedJson
              ? <JsonKVTable value={parsedJson} accentColor={accentColor} />
              : <SectionContent content={content} />}
        </div>
      </div>
    );
  }

  if (item.kind === "provider_file") {
    const f = item.data;
    const isExpired  = f.expires_at ? new Date(f.expires_at) < new Date() : false;
    const expiringSoon = !isExpired && f.expires_at
      ? new Date(f.expires_at) < new Date(Date.now() + 4 * 60 * 60 * 1000) : false;

    const providerColor: Record<string, string> = {
      openai:    "text-emerald-400",
      anthropic: "text-orange-400",
      gemini:    "text-sky-400",
      grok:      "text-slate-400",
    };
    const providerBg: Record<string, string> = {
      openai:    "bg-emerald-900/30 border-emerald-700/40",
      anthropic: "bg-orange-900/30 border-orange-700/40",
      gemini:    "bg-sky-900/30 border-sky-700/40",
      grok:      "bg-slate-900/30 border-slate-700/40",
    };
    const pColor = providerColor[f.provider] ?? "text-gray-400";
    const pBg    = providerBg[f.provider]    ?? "bg-gray-800/40 border-gray-700/40";

    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
          <span className="p-1 rounded border shrink-0 bg-sky-900/40 text-sky-300 border-sky-700/40">
            <CloudUpload className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className={cn("text-xs font-bold uppercase tracking-wider", pColor)}>{f.provider}</p>
            <p className="text-sm font-semibold text-white truncate">{f.source.replace(/_/g, " ")}</p>
            <p className="text-[10px] text-gray-500">
              {formatVmDateTime(f.created_at)} · {f.chars.toLocaleString()} chars
              {f.input_key ? ` · key: ${f.input_key}` : ""}
            </p>
          </div>
          <CopyBtn text={f.provider_file_id} />
          {onDelete && <DeleteBtn onDelete={onDelete} />}
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* File ID — primary piece of info */}
          <div>
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">File ID</p>
            <div className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border font-mono text-sm break-all", pBg, pColor)}>
              <span className="flex-1">{f.provider_file_id}</span>
              <button onClick={() => navigator.clipboard.writeText(f.provider_file_id)}
                className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Gemini URI if present */}
          {f.provider_file_uri && (
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1.5">File URI</p>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sky-700/40 bg-sky-900/20 font-mono text-xs text-sky-300 break-all">
                <span className="flex-1">{f.provider_file_uri}</span>
                <button onClick={() => navigator.clipboard.writeText(f.provider_file_uri!)}
                  className="shrink-0 text-gray-500 hover:text-gray-300 transition-colors">
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: "Provider",    value: f.provider },
              { label: "Source",      value: f.source.replace(/_/g, " ") },
              { label: "Input Key",   value: f.input_key || "—" },
              { label: "Size",        value: `${f.chars.toLocaleString()} chars` },
              { label: "Call ID",     value: f.call_id ? f.call_id.slice(-16) : "—" },
              { label: "Content Hash",value: f.content_hash },
              { label: "Uploaded",    value: f.created_at.slice(0, 19).replace("T", " ") },
            ].map(({ label, value }) => (
              <div key={label} className="border border-gray-800/60 rounded-lg px-3 py-2">
                <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest mb-0.5">{label}</p>
                <p className="text-xs text-gray-300 font-mono break-all">{value}</p>
              </div>
            ))}

            {/* Expiry — separate because of status coloring */}
            <div className={cn("border rounded-lg px-3 py-2", isExpired ? "border-red-800/60 bg-red-950/20" : expiringSoon ? "border-amber-800/60 bg-amber-950/20" : "border-gray-800/60")}>
              <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest mb-0.5">Expiry</p>
              {f.expires_at ? (
                <div className="flex items-center gap-1">
                  {isExpired
                    ? <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
                    : expiringSoon
                    ? <Clock className="w-3 h-3 text-amber-400 shrink-0" />
                    : null}
                  <p className={cn("text-xs font-mono", isExpired ? "text-red-400" : expiringSoon ? "text-amber-400" : "text-gray-300")}>
                    {f.expires_at.slice(0, 19).replace("T", " ")}
                    {isExpired ? " (expired)" : expiringSoon ? " (soon)" : ""}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-gray-400">persistent</p>
              )}
            </div>
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
          <CalendarDays className="w-2.5 h-2.5" />{formatVmDateTime(item.date)}
          <span className="text-gray-700">{item.chars.toLocaleString()} chars</span>
        </p>
      </div>
      <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ArtifactsPage() {
  const [pipelineW, pipelineDrag] = useResize(210, 150, 360);
  const [typesW,    typesDrag]    = useResize(150, 120, 240);
  const [itemsW,    itemsDrag]    = useResize(220, 160, 360);

  const { salesAgent: selectedAgent, customer: selectedCustomer } = useAppCtx();
  const hasPair = !!(selectedAgent && selectedCustomer);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const [selectedKind,     setSelectedKind]     = useState<ArtifactKind | null>(null);
  const [selectedItem,     setSelectedItem]     = useState<ArtifactItem | null>(null);

  const pairQs = selectedAgent && selectedCustomer
    ? new URLSearchParams({ agent: selectedAgent, customer: selectedCustomer })
    : null;

  const { data: personas, isLoading: loadP, mutate: mutatePersonas } = useSWR<Persona[]>(
    pairQs ? `/api/personas?${pairQs}` : null, fetcher,
  );
  const { data: notes, isLoading: loadN, mutate: mutateNotes } = useSWR<Note[]>(
    pairQs ? `/api/notes?${pairQs}` : null, fetcher,
  );
  const { data: rollup, isLoading: loadR, error: rollupErr } = useSWR<Record<string, unknown> | null>(
    pairQs ? `/api/notes/rollup?${pairQs}` : null, fetcherOptional,
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
    runsUrl, fetcher,
  );
  const uploadedFilesUrl = pairQs
    ? `/api/universal-agents/uploaded-files?sales_agent=${encodeURIComponent(selectedAgent)}&customer=${encodeURIComponent(selectedCustomer)}`
    : null;
  const { data: uploadedFiles, mutate: mutateUploadedFiles } = useSWR<UploadedFile[]>(
    uploadedFilesUrl, fetcher,
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
    provider_file: [],
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

  // Pipeline step outputs — routed by artifact class from canvas_json.
  // Supports both legacy step.status ("done") and current step.state ("completed").
  (historyRuns ?? []).forEach(run => {
      let steps: RunStep[] = [];
      try { steps = JSON.parse(run.steps_json); } catch { return; }
      const agentMap = getAgentArtifactMap(run.canvas_json ?? "");
      steps.forEach((step, idx) => {
        const stepState = String(step.status ?? step.state ?? "").toLowerCase();
        const isStepDone = stepState === "done" || stepState === "completed";
        const content = step.content ?? "";
        if (!isStepDone || !content) return;
        const kind = subTypeToKind(agentMap[step.agent_id] ?? "");
        (itemsByKind[kind] as ArtifactItem[]).push({
          kind,
          id: `${run.id}_${idx}`,
          date: run.finished_at ?? run.started_at,
          chars: content.length,
          label: `${step.agent_name} · ${run.pipeline_name}`,
          data: {
            content,
            agent_name: step.agent_name,
            pipeline_name: run.pipeline_name,
            model: step.model ?? "",
            run_id: run.id,
          },
        } as ArtifactItem);
      });
    });

  // Provider-uploaded files
  (uploadedFiles ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)).forEach(f => {
    const srcLabel = f.source.replace(/_/g, " ");
    itemsByKind.provider_file.push({
      kind: "provider_file", id: f.id,
      date: f.created_at, chars: f.chars,
      label: `${f.provider} · ${srcLabel}${f.call_id ? ` · ${f.call_id.slice(-8)}` : ""}`,
      data: f,
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
    } else if (item.kind === "provider_file") {
      url = `/api/universal-agents/uploaded-files/${item.id}`;
    }
    if (!url) return;
    await fetch(url, { method: "DELETE" });
    if (item.kind === "persona" || item.kind === "persona_score") {
      await mutatePersonas();
    } else if (item.kind === "note" || item.kind === "compliance_note") {
      await mutateNotes();
    } else if (item.kind.startsWith("pipeline_")) {
      await mutateRuns();
    } else if (item.kind === "provider_file") {
      await mutateUploadedFiles();
    }
    setSelectedItem(null);
  }

  const allItems = useMemo(
    () => (Object.keys(itemsByKind) as ArtifactKind[]).flatMap(k => itemsByKind[k]),
    [itemsByKind],
  );

  const pipelineBuckets = useMemo<PipelineBucket[]>(() => {
    const map = new Map<string, PipelineBucket>();
    for (const item of allItems) {
      let id = "context";
      let label = "Direct Artifacts";
      if (isPipelineKind(item.kind)) {
        const day = formatVmDateTime(item.date).slice(0, 10);
        const pipelineData = item.data as { pipeline_name?: string };
        const pipelineName = pipelineData.pipeline_name || "Pipeline";
        id = `pipeline:${pipelineName}:${day}`;
        label = `${pipelineName} · ${day}`;
      }
      const ts = Number.isFinite(Date.parse(item.date)) ? Date.parse(item.date) : 0;
      const existing = map.get(id);
      if (!existing) {
        map.set(id, { id, label, items: [item], latestTs: ts });
      } else {
        existing.items.push(item);
        existing.latestTs = Math.max(existing.latestTs, ts);
      }
    }
    return [...map.values()].sort((a, b) => {
      if (a.id === "context" && b.id !== "context") return 1;
      if (a.id !== "context" && b.id === "context") return -1;
      return b.latestTs - a.latestTs || a.label.localeCompare(b.label);
    });
  }, [allItems]);

  useEffect(() => {
    if (!hasPair) {
      setSelectedBucketId(null);
      setSelectedKind(null);
      setSelectedItem(null);
      return;
    }
    if (pipelineBuckets.length === 0) {
      setSelectedBucketId(null);
      setSelectedKind(null);
      setSelectedItem(null);
      return;
    }
    if (!selectedBucketId || !pipelineBuckets.some(b => b.id === selectedBucketId)) {
      setSelectedBucketId(pipelineBuckets[0].id);
      setSelectedKind(null);
      setSelectedItem(null);
    }
  }, [hasPair, pipelineBuckets, selectedBucketId]);

  const selectedBucket = selectedBucketId
    ? pipelineBuckets.find(b => b.id === selectedBucketId) ?? null
    : null;

  const typeGroups = useMemo(
    () => (Object.keys(ARTIFACT_TYPE_META) as ArtifactKind[])
      .filter(k => (selectedBucket?.items ?? []).some(i => i.kind === k)),
    [selectedBucket],
  );

  const visibleItems = useMemo(
    () => selectedKind ? (selectedBucket?.items ?? []).filter(i => i.kind === selectedKind) : [],
    [selectedKind, selectedBucket],
  );

  function selectBucket(id: string) {
    setSelectedBucketId(id);
    setSelectedKind(null);
    setSelectedItem(null);
  }

  function selectKind(k: ArtifactKind) {
    setSelectedKind(k);
    setSelectedItem(null);
  }

  return (
    <div className="h-[calc(100vh-5.25rem)] flex overflow-hidden">

      {/* ── Panel 1: Pipelines (grouped by name + date) ───────────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: pipelineW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Pipelines</p>
            {hasPair && (
              <p className="text-[9px] text-gray-700 mt-0.5 truncate">
                {selectedAgent} · {selectedCustomer}
              </p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!hasPair ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select agent + customer in the top bar</p>
            ) : isLoadingPair ? (
              <div className="flex items-center gap-1.5 px-3 py-4 text-[10px] text-gray-600">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            ) : pipelineBuckets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-gray-700">
                <Archive className="w-5 h-5 opacity-20" />
                <p className="text-[10px]">No artifacts</p>
              </div>
            ) : pipelineBuckets.map(bucket => {
              const isSel = selectedBucketId === bucket.id;
              const isDirect = bucket.id === "context";
              return (
                <button
                  key={bucket.id}
                  onClick={() => selectBucket(bucket.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors border-l-2",
                    isSel ? "bg-indigo-900/30 border-indigo-500" : "border-transparent hover:bg-gray-800/40",
                  )}
                >
                  <span className={cn(
                    "p-0.5 rounded border shrink-0",
                    isDirect
                      ? "bg-gray-800/70 text-gray-300 border-gray-700/60"
                      : "bg-teal-900/50 text-teal-300 border-teal-700/40",
                  )}>
                    {isDirect ? <Archive className="w-3 h-3" /> : <GitBranch className="w-3 h-3" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-[11px] font-medium truncate", isSel ? "text-white" : (isDirect ? "text-gray-300" : "text-teal-300"))}>
                      {bucket.label}
                    </p>
                    <p className="text-[9px] text-gray-600">{bucket.items.length} item{bucket.items.length !== 1 ? "s" : ""}</p>
                  </div>
                  <ChevronRight className={cn("w-3 h-3 shrink-0 transition-colors", isSel ? "text-indigo-400" : "text-gray-700")} />
                </button>
              );
            })}
          </div>
        </div>
        <DragHandle onMouseDown={pipelineDrag} />
      </div>

      {/* ── Panel 2: Artifact types within selected pipeline ───────────────── */}
      <div className="flex shrink-0 overflow-hidden" style={{ width: typesW }}>
        <div className="flex-1 flex flex-col border-r border-gray-800 bg-gray-950 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">Artifact Types</p>
            {selectedBucket && !isLoadingPair && (
              <p className="text-[9px] text-gray-700 mt-0.5">{typeGroups.length} type{typeGroups.length !== 1 ? "s" : ""}</p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {!hasPair ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select agent + customer in the top bar</p>
            ) : isLoadingPair ? (
              <div className="flex items-center gap-1.5 px-3 py-4 text-[10px] text-gray-600">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            ) : !selectedBucket ? (
              <p className="text-[10px] text-gray-700 italic px-3 py-4">Select a pipeline group</p>
            ) : typeGroups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 gap-1.5 text-gray-700">
                <Archive className="w-5 h-5 opacity-20" />
                <p className="text-[10px]">No artifacts</p>
              </div>
            ) : typeGroups.map(k => {
              const m = ARTIFACT_TYPE_META[k];
              const Icon = m.icon;
              const count = (selectedBucket?.items ?? []).filter(i => i.kind === k).length;
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
              {!hasPair          ? "Select agent + customer in the top context bar"
               : !selectedBucket ? "Select a pipeline group"
               : !selectedKind   ? "Select an artifact type"
               : "Select an item to view it"}
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
