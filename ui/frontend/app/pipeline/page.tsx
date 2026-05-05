"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant,
  useNodesState, useEdgesState, useReactFlow,
  addEdge,
  getBezierPath, EdgeLabelRenderer,
  Handle, Position, MarkerType,
  type Node, type Edge, type Connection, type NodeChange, type NodeTypes,
  type EdgeProps, type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot, User, Star, StickyNote, Shield, Zap, BadgeCheck, ShieldCheck,
  Check, Loader2, TriangleAlert,
  Mic2, Layers, BookOpen, PenLine, FileText, Braces, AlignLeft,
  Plus, Trash2, ChevronRight, X, Download, Workflow, Copy, ClipboardCopy, ClipboardPaste,
  Lock, Play, Square, History, Users, PhoneCall, Send, Undo2, Redo2,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { useUserProfile } from "@/lib/user-profile";
import { formatLocalTime, parseServerDate, utcHmsToLocal } from "@/lib/time";
import { cn } from "@/lib/utils";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";
import { SectionContent } from "@/components/shared/SectionCards";
import ContextTopBar from "@/components/shared/ContextTopBar";

const fetcher = (url: string) => fetch(url).then(r => r.json());
const PIPELINE_OPEN_RUN_STORAGE_KEY = "shinobi.pipeline.open_run";
// v3: invalidate stale cached run-log timestamps persisted before robust ts normalization.
const PIPELINE_RUN_LOGS_STORAGE_KEY = "shinobi.pipeline.run_logs.v4";
const PIPELINE_ACTIVE_RUNS_STORAGE_KEY = "shinobi.pipeline.active_runs.v1";
const MAX_PERSISTED_RUN_LOG_BUCKETS = 40;

// ── Sub-type metadata ─────────────────────────────────────────────────────────

type NodeKind = "input" | "processing" | "output";  // "output" = artifact internally
type ProcessSubType = "agent";
type ArtifactSubType = "persona" | "persona_score" | "notes" | "notes_compliance";
type RuntimeStatus = "pending" | "loading" | "cached" | "done" | "error" | "cancelled";

interface Meta {
  label:  string;
  icon:   React.ReactNode;
  color:  string;
  border: string;
  text:   string;
  desc:   string;
}

// ── Generic input ─────────────────────────────────────────────────────────────
const INPUT_META: Record<string, Meta> = {
  input: { label: "Input", icon: <Zap className="w-4 h-4" />, color: "bg-blue-700", border: "border-blue-600", text: "text-blue-400", desc: "Data source input" },
};

// ── Processing ────────────────────────────────────────────────────────────────
const PROCESS_META: Record<ProcessSubType, Meta> = {
  agent: { label: "Agent", icon: <Bot className="w-4 h-4" />, color: "bg-indigo-700", border: "border-indigo-500", text: "text-indigo-400", desc: "AI agent — select and configure below" },
};

// ── Artifacts ────────────────────────────────────────────────────────────────
const ARTIFACT_REQUIRES: Partial<Record<ArtifactSubType, ArtifactSubType>> = {
  persona_score:    "persona",
  notes_compliance: "notes",
};
const ARTIFACT_META: Record<ArtifactSubType, Meta> = {
  persona:          { label: "Persona",          icon: <User        className="w-4 h-4" />, color: "bg-violet-700",  border: "border-violet-600",  text: "text-violet-400",  desc: "Customer or agent persona profile" },
  persona_score:    { label: "Persona Score",    icon: <BadgeCheck  className="w-4 h-4" />, color: "bg-violet-800",  border: "border-violet-700",  text: "text-violet-300",  desc: "Scored persona — requires Persona in the pipeline" },
  notes:            { label: "Notes",            icon: <StickyNote  className="w-4 h-4" />, color: "bg-amber-700",   border: "border-amber-600",   text: "text-amber-400",   desc: "Structured call notes" },
  notes_compliance: { label: "Compliance Notes", icon: <ShieldCheck className="w-4 h-4" />, color: "bg-emerald-700", border: "border-emerald-600", text: "text-emerald-400", desc: "Compliance notes — requires Notes in the pipeline" },
};

// Module-level registry for user-defined custom artifacts (persists across renders)
const CUSTOM_ARTIFACT_REGISTRY: Record<string, Meta> = {};

const GENERIC_ARTIFACT_META: Meta = {
  label: "Output", icon: <Star className="w-4 h-4" />, color: "bg-yellow-700", border: "border-yellow-600", text: "text-yellow-400", desc: "Pipeline output artifact — click to set type",
};

function getMeta(kind: NodeKind, subType: string): Meta {
  if (kind === "input")      return INPUT_META.input;
  if (kind === "processing") return PROCESS_META.agent;
  return (ARTIFACT_META as Record<string, Meta>)[subType]
    ?? CUSTOM_ARTIFACT_REGISTRY[subType]
    ?? GENERIC_ARTIFACT_META;
}

const RUNTIME_META: Record<RuntimeStatus, { label: string; className: string; dot: string }> = {
  pending: { label: "Pending", className: "text-gray-400 border-gray-700/60 bg-gray-900/70", dot: "bg-gray-500" },
  loading: { label: "Running", className: "text-orange-300 border-orange-700/60 bg-orange-950/50", dot: "bg-orange-400" },
  cached:  { label: "Cached",  className: "text-amber-300 border-amber-700/60 bg-amber-950/50", dot: "bg-amber-400" },
  done:    { label: "Done",    className: "text-emerald-300 border-emerald-700/60 bg-emerald-950/50", dot: "bg-emerald-400" },
  error:   { label: "Error",   className: "text-red-300 border-red-700/60 bg-red-950/50", dot: "bg-red-400" },
  cancelled: { label: "Cancelled", className: "text-slate-200 border-slate-600/70 bg-slate-900/70", dot: "bg-slate-300" },
};

function normalizeStateToken(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isCancelledLike(value: unknown): boolean {
  const s = normalizeStateToken(value);
  if (!s) return false;
  return s.includes("cancel") || s.includes("abort") || s.includes("stop");
}

function isRunningLike(value: unknown): boolean {
  const s = normalizeStateToken(value);
  if (!s) return false;
  return s === "running" || s === "loading" || s === "started" || s.includes("in_progress");
}

function isFailedLike(value: unknown): boolean {
  const s = normalizeStateToken(value);
  if (!s) return false;
  return s === "failed" || s === "error" || s === "fail" || s.includes("exception");
}

function isCompletedLike(value: unknown): boolean {
  const s = normalizeStateToken(value);
  if (!s) return false;
  return s === "completed" || s === "done" || s === "pass" || s === "success" || s === "ok";
}

function isActiveRunLike(value: unknown): boolean {
  const s = normalizeStateToken(value);
  if (!s) return false;
  return s === "running" || s === "queued" || s === "preparing" || s === "retrying";
}

function runtimeStatusFromToken(value: unknown, hasCached = false): RuntimeStatus {
  const s = normalizeStateToken(value);
  if (!s) return "pending";
  if (s === "cached" || s === "cache_hit") return "cached";
  if (isCancelledLike(s)) return "cancelled";
  if (isFailedLike(s)) return "error";
  if (isRunningLike(s)) return "loading";
  if (isCompletedLike(s)) return hasCached ? "cached" : "done";
  if (s === "input_prepared" || s === "prepared") return "pending";
  return "pending";
}

// ── Universal agent types & constants ────────────────────────────────────────

interface AgentInput { key: string; source: string; agent_id?: string; }

interface StepOutputContractOverride {
  artifact_type?: string;
  artifact_class?: string;
  artifact_name?: string;
  output_format?: string;
  output_schema?: string;
  output_taxonomy?: string[];
  output_contract_mode?: "off" | "soft" | "strict";
  output_fit_strategy?: "structured" | "raw";
  output_response_mode?: "wrap" | "transform" | "custom_format";
  output_target_type?: "raw_text" | "markdown" | "json";
  output_template?: string;
  output_placeholder?: string;
  output_previous_placeholder?: string;
}

interface PipelineStepDef {
  agent_id: string;
  input_overrides: Record<string, string>;
  output_contract_override?: StepOutputContractOverride;
}

interface UniversalAgent {
  id: string; name: string; description: string; agent_class: string;
  model: string; temperature: number; system_prompt: string; user_prompt: string;
  inputs: AgentInput[]; output_format: string; tags: string[];
  artifact_type?: string;
  artifact_class?: string;
  artifact_name?: string;
  output_schema?: string;
  output_taxonomy?: string[];
  output_contract_mode?: "off" | "soft" | "strict";
  output_fit_strategy?: "structured" | "raw";
  output_response_mode?: "wrap" | "transform" | "custom_format";
  output_target_type?: "raw_text" | "markdown" | "json";
  output_template?: string;
  output_placeholder?: string;
  output_previous_placeholder?: string;
  is_default: boolean; created_at: string;
}

interface PipelineFolderDef {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sort_order: number;
  owner_email?: string | null;
  pipeline_count: number;
  created_at: string;
  updated_at: string;
}

interface PipelineDef {
  id: string;
  name: string;
  description: string;
  scope?: string;
  folder?: string;
  folder_id?: string;
  workspace_user_email?: string;
  workspace_user_name?: string;
  steps: PipelineStepDef[];
  canvas?: { nodes: any[]; edges: any[]; stages: string[] };
}

interface NavCustomerOption {
  customer: string;
  call_count: number;
}

type CallDatesMap = Record<string, { date: string; has_audio: boolean }>;
interface CRMCallLite {
  call_id: string;
  date?: string;
  duration?: number;
  record_path?: string | null;
}
interface CallOptionMeta {
  date: string;
  has_audio: boolean;
  duration_s: number | null;
}

interface FinalTranscriptCall {
  call_id: string;
  final_path?: string | null;
  smoothed_path?: string | null;
  voted_path?: string | null;
  pipeline_final_files?: Array<{ path?: string; name?: string }>;
}

interface PipelineArtifactState {
  processed: boolean;
  complete: boolean;
  step_count: number;
  total_steps: number;
  artifact_count?: number;
  artifact_total?: number;
  artifact_complete?: boolean;
  artifact_types?: string[];
  last_at?: string | null;
}

interface PipelineArtifactStatus {
  pipeline_id: string;
  sales_agent: string;
  customer: string;
  pair: PipelineArtifactState;
  calls: Record<string, PipelineArtifactState>;
  generated_at: string;
}

interface CachedStepResult {
  agent_id: string;
  result: { id: string; content: string; agent_name: string; created_at: string } | null;
}

interface PipelineRunRecord {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  sales_agent: string;
  customer: string;
  call_id: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  canvas_json?: string;
  steps_json: string;
  log_json?: string;
}

interface PipelineRunStepInputSource {
  key?: string;
  source?: string;
  resolved_call_id?: string;
  merged_scope?: string;
  merged_until_call_id?: string;
}
interface PipelineRunStepCachedLocation {
  type?: string;
  id?: string;
  created_at?: string | null;
}
interface PipelineRunStep {
  agent_id?: string;
  agent_name?: string;
  model?: string;
  status?: string;
  state?: string;
  input_ready?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  execution_time_s?: number | null;
  cache_mode?: string;
  input_sources?: PipelineRunStepInputSource[];
  cached_locations?: PipelineRunStepCachedLocation[];
  input_token_est?: number;
  output_token_est?: number;
  thinking?: string;
  model_info?: Record<string, any>;
  request_raw?: Record<string, any>;
  response_raw?: string;
  content?: string;
  error_msg?: string;
  note_id?: string;
  note_call_id?: string;
}

interface StepCacheDisplay {
  source: "latest_cache" | "selected_run" | "current_run";
  runId?: string;
  createdAt?: string | null;
  agentName?: string;
  model?: string;
  status?: string;
  errorMsg?: string;
  inputTokenEst?: number;
  outputTokenEst?: number;
  thinking?: string;
  modelInfo?: Record<string, any>;
  requestRaw?: Record<string, any>;
  responseRaw?: string;
  content: string;
  noteId?: string;
  noteCallId?: string;
}

interface PipelineLiveStateStep {
  state?: string;
  status?: string;
  input_ready?: boolean;
  cached_locations?: Array<{ type?: string; id?: string }>;
}

interface PipelineLiveState {
  run_id?: string;
  status?: string;
  steps?: PipelineLiveStateStep[];
  node_states?: {
    input?: Record<string, string>;
    processing?: Record<string, string>;
    output?: Record<string, string>;
  };
}

type CanvasLogFilterMode = "all" | "llm" | "pipeline" | "errors";

interface CanvasLogLine {
  ts: string;
  text: string;
  level: "llm" | "pipeline" | "error" | "warn" | "info";
}

type RunContextMode = "new" | "historical";
type ResultViewMode = "rendered" | "raw";
type HistoricalRunExecMode = "force_full" | "failed_only";
type LiveWebhookStatus = "off" | "waiting" | "triggered" | "error";

interface PipelineRunExecOptions {
  executeStepIndices?: number[];
  forceStepIndices?: number[];
  force?: boolean;
  resumePartial?: boolean;
  continueRunId?: string;
  prepareInputOnly?: boolean;
}

interface PipelineOpenRunPayload {
  source?: string;
  locked?: boolean;
  run_id?: string;
  pipeline_id?: string;
  pipeline_name?: string;
  sales_agent?: string;
  customer?: string;
  call_id?: string;
}

interface InputPreviewState {
  loading: boolean;
  content: string;
  error: string;
  requestKey?: string;
  source?: string;
  origin?: string;
  cacheFile?: string;
  resolvedCallId?: string;
  fileRefs?: Record<string, string>;
  fileRefsError?: string;
}

interface RenderedLlmCacheEntry {
  status: "loading" | "ready" | "error";
  markdown: string;
  error: string;
}

interface CanvasDetailViewerState {
  title: string;
  subtitle?: string;
  content: string;
  sourceHint?: string;
}

interface PipelineBundle {
  bundle_version: number;
  bundle_id: string;
  bundle_name: string;
  created_at: string;
  source?: {
    pipeline_id?: string;
    pipeline_name?: string;
  };
  pipeline: PipelineDef;
  agents: UniversalAgent[];
  warnings?: {
    missing_agent_ids?: string[];
  };
  snapshot_file?: string;
}

interface PipelineBundleImportResponse {
  ok: boolean;
  folder: string;
  pipeline: PipelineDef;
  agents_created: number;
  snapshot_file?: string;
}

const MODEL_GROUPS = [
  { provider: "OpenAI",    models: ["gpt-5.4", "gpt-4.1", "gpt-4.1-mini"] },
  { provider: "Anthropic", models: ["claude-opus-4-6", "claude-sonnet-4-6"] },
  { provider: "Google",    models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { provider: "xAI",       models: ["grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"] },
];

interface RuntimeGraph {
  stepToProcNodeIds: string[];
  procToOutputNodeIds: Record<string, string[]>;
  inputToProcNodeIds: Record<string, string[]>;
  stepParents: Record<number, number[]>;
}

const INPUT_SOURCES = [
  { value: "transcript",        label: "Transcript",   shortLabel: "Transcript", icon: Mic2,
    badge: "bg-blue-900/50 text-blue-300 border-blue-700/50", desc: "Single call transcript" },
  { value: "merged_transcript", label: "Merged",       shortLabel: "Merged",     icon: Layers,
    badge: "bg-cyan-900/50 text-cyan-300 border-cyan-700/50", desc: "All calls merged" },
  { value: "notes",             label: "Notes",        shortLabel: "Notes",      icon: StickyNote,
    badge: "bg-green-900/50 text-green-300 border-green-700/50", desc: "Call notes" },
  { value: "merged_notes",      label: "Merged Notes", shortLabel: "All Notes",  icon: BookOpen,
    badge: "bg-teal-900/50 text-teal-300 border-teal-700/50", desc: "All notes aggregated" },
  { value: "agent_output",      label: "Agent Output", shortLabel: "Agent",      icon: Bot,
    badge: "bg-purple-900/50 text-purple-300 border-purple-700/50", desc: "Output of another agent" },
  { value: "manual",            label: "Manual",       shortLabel: "Manual",     icon: PenLine,
    badge: "bg-gray-700/50 text-gray-300 border-gray-600/50", desc: "Provided at run time" },
] as const;

const OUTPUT_FMT: Record<string, {
  label: string; desc: string;
  icon: React.ComponentType<{ className?: string }>;
  bg: string; text: string; border: string;
}> = {
  markdown: { label: "Markdown", desc: "Structured text",   icon: FileText,  bg: "bg-indigo-900/50", text: "text-indigo-300",  border: "border-indigo-700/40" },
  json:     { label: "JSON",     desc: "Machine-readable",  icon: Braces,    bg: "bg-yellow-900/50", text: "text-yellow-300", border: "border-yellow-700/40" },
  text:     { label: "Text",     desc: "Plain unformatted", icon: AlignLeft, bg: "bg-gray-700/50",   text: "text-gray-300",   border: "border-gray-600/40"   },
};

const CLASS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  persona: User, scorer: Star, notes: StickyNote, compliance: Shield, general: Zap,
};
const CLASS_ICON_BG: Record<string, string> = {
  persona: "bg-violet-900/60", scorer: "bg-violet-800/40",
  notes: "bg-teal-900/60", compliance: "bg-teal-800/40", general: "bg-sky-900/60",
};
const CLASS_META: Record<string, { label: string; textColor: string; borderColor: string }> = {
  persona:    { label: "Persona",    textColor: "text-violet-300", borderColor: "border-violet-700/40" },
  scorer:     { label: "Scorer",     textColor: "text-violet-400", borderColor: "border-violet-700/30" },
  notes:      { label: "Notes",      textColor: "text-teal-300",   borderColor: "border-teal-700/40"   },
  compliance: { label: "Compliance", textColor: "text-teal-400",   borderColor: "border-teal-700/30"   },
  general:    { label: "General",    textColor: "text-sky-300",    borderColor: "border-sky-700/40"    },
  "":         { label: "Agent",      textColor: "text-gray-400",   borderColor: "border-gray-700/40"   },
};
const CLASS_REQUIRES_PREV: Record<string, string> = { scorer: "persona", compliance: "notes" };
const AGENT_CLASS_ORDER = ["persona", "notes", "scorer", "compliance", "general"] as const;
type AgentClassKey = (typeof AGENT_CLASS_ORDER)[number];
const OUTPUT_SUBTYPE_TO_AGENT_CLASS: Record<string, AgentClassKey> = {
  persona: "persona",
  persona_score: "scorer",
  notes: "notes",
  notes_compliance: "compliance",
};

function classMeta(cls: string) {
  const s = (cls ?? "").toLowerCase();
  return CLASS_META[s] ?? { label: cls || "Agent", textColor: "text-gray-400", borderColor: "border-gray-700/40" };
}

interface OutputProfile {
  id: string;
  name: string;
  artifact_type: string;
  artifact_class: string;
  artifact_name: string;
  output_format: string;
  output_schema: string;
  output_taxonomy: string[];
  output_contract_mode: "off" | "soft" | "strict";
  output_fit_strategy: "structured" | "raw";
  output_response_mode: "wrap" | "transform" | "custom_format";
  output_target_type: "raw_text" | "markdown" | "json";
  output_template: string;
  output_placeholder: string;
  output_previous_placeholder: string;
}

function normalizeAgentClass(raw: string): AgentClassKey | "" {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  if ((AGENT_CLASS_ORDER as readonly string[]).includes(v)) return v as AgentClassKey;
  if (v === "persona_score") return "scorer";
  if (/scor|score/.test(v)) return "scorer";
  if (/compliance/.test(v)) return "compliance";
  if (/note/.test(v)) return "notes";
  if (/persona/.test(v)) return "persona";
  if (/general|agent/.test(v)) return "general";
  return "";
}

function inferAgentClassFromConnectedOutputs(
  outputNodes: Node[],
  outputProfiles: OutputProfile[],
): AgentClassKey | "" {
  const votes: AgentClassKey[] = [];

  for (const node of outputNodes) {
    const data = (node.data || {}) as PipelineNodeData;
    const subType = String(data.subType || "").toLowerCase();
    const fromSubType = OUTPUT_SUBTYPE_TO_AGENT_CLASS[subType] ?? normalizeAgentClass(subType);
    if (fromSubType) votes.push(fromSubType);

    const profileId = String(data.outputProfileId || "").trim();
    if (!profileId) continue;
    const profile = outputProfiles.find((p) => p.id === profileId);
    if (!profile) continue;

    const fromProfile =
      normalizeAgentClass(profile.artifact_class || "") ||
      normalizeAgentClass(profile.artifact_type || "") ||
      normalizeAgentClass(profile.artifact_name || "");
    if (fromProfile) votes.push(fromProfile);
  }

  if (!votes.length) return "";

  const counts = new Map<AgentClassKey, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) || 0) + 1);

  let best: AgentClassKey = votes[0];
  let bestCount = counts.get(best) || 0;
  for (const cls of AGENT_CLASS_ORDER) {
    const c = counts.get(cls) || 0;
    if (c > bestCount) {
      best = cls;
      bestCount = c;
    }
  }
  return best;
}

// ── Agent sub-components ──────────────────────────────────────────────────────

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500">
      {MODEL_GROUPS.map(g => (
        <optgroup key={g.provider} label={g.provider}>
          {g.models.map(m => <option key={m} value={m}>{m}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function AgentClassIcon({ cls, size = "md" }: { cls: string; size?: "sm" | "md" }) {
  const norm = (cls ?? "").toLowerCase();
  const Icon = CLASS_ICON[norm] ?? Bot;
  const bg   = CLASS_ICON_BG[norm] ?? "bg-gray-800";
  const meta = classMeta(norm);
  const dims     = size === "sm" ? "w-6 h-6" : "w-10 h-10";
  const iconDims = size === "sm" ? "w-3 h-3" : "w-5 h-5";
  return (
    <div className={`rounded-xl flex items-center justify-center shrink-0 ${bg} ${dims}`}>
      <Icon className={`${iconDims} ${meta.textColor}`} />
    </div>
  );
}

function AgentPickerGrid({
  value,
  allAgents,
  usageByAgent,
  onChange,
}: {
  value: string; allAgents: UniversalAgent[];
  usageByAgent: Record<string, { total: number; other: number }>;
  onChange: (agent: UniversalAgent) => void;
}) {
  const [search, setSearch] = useState("");
  const classOrder = ["persona", "notes", "scorer", "compliance", "general", ""];
  const filtered = allAgents.filter(a =>
    (a.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (a.agent_class ?? "").toLowerCase().includes(search.toLowerCase())
  );
  const grouped = filtered.reduce<Record<string, UniversalAgent[]>>((acc, agent) => {
    const key = String(agent.agent_class || "").toLowerCase();
    (acc[key] ||= []).push(agent);
    return acc;
  }, {});
  const orderedGroups = Object.keys(grouped).sort((a, b) => {
    const ai = classOrder.indexOf(a);
    const bi = classOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const renderAgentCard = (a: UniversalAgent) => {
    const meta = classMeta(a.agent_class ?? "");
    const isSel = value === a.id;
    const req = CLASS_REQUIRES_PREV[a.agent_class?.toLowerCase() ?? ""];
    const usage = usageByAgent[a.id] ?? { total: 0, other: 0 };
    return (
      <button
        key={a.id}
        onClick={() => onChange(a)}
        title={a.description}
        className={`flex items-center gap-1.5 p-2 rounded-lg border text-left transition-colors
          ${isSel ? `${meta.borderColor} bg-gray-800` : "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 hover:border-gray-600"}`}
      >
        <AgentClassIcon cls={a.agent_class ?? ""} size="sm" />
        <div className="min-w-0 flex-1">
          <p className={`text-[10px] font-medium truncate ${isSel ? "text-white" : "text-gray-300"}`}>{a.name}</p>
          <p className={`text-[9px] ${meta.textColor}`}>{meta.label}</p>
          {usage.other > 0 && (
            <p className="text-[9px] mt-0.5 text-amber-300">
              {`Also in ${usage.other} other pipeline${usage.other !== 1 ? "s" : ""}`}
            </p>
          )}
        </div>
        {isSel && <Check className="w-3 h-3 text-white shrink-0" />}
        {req && !isSel && (
          <span title={`Should follow a ${req} step`}><TriangleAlert className="w-3 h-3 text-amber-600/60 shrink-0" /></span>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-1.5">
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search agents…"
        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
      <div className="max-h-52 overflow-y-auto space-y-2">
        {filtered.length > 0 && orderedGroups.map((groupKey) => {
          const agents = grouped[groupKey] || [];
          if (!agents.length) return null;
          const meta = classMeta(groupKey);
          return (
            <div key={groupKey} className="space-y-1">
              <div className="flex items-center gap-1.5 px-0.5">
                <span className={cn("text-[9px] uppercase tracking-wider font-semibold", meta.textColor)}>
                  {meta.label}
                </span>
                <span className="text-[9px] text-gray-600">({agents.length})</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {agents.map((a) => renderAgentCard(a))}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-xs text-gray-600 italic text-center py-3">No agents match</p>
        )}
      </div>
    </div>
  );
}

// ── Node data interfaces ──────────────────────────────────────────────────────

interface SleeveData extends Record<string, unknown> {
  step:  number;
  label: string;
  kind:  NodeKind;
}

interface PipelineNodeData extends Record<string, unknown> {
  label:      string;
  subType:    string;
  prompt:     string;
  stageIndex: number;
  runtimeStatus?: RuntimeStatus;
  runtimeStartedAtMs?: number;
  runStepIndex?: number | null;
  runButtonDisabled?: boolean;
  onRunStep?: () => void;
  onMutate?: () => void;
  // agent node — linked backend agent
  agentId:    string;
  agentClass: string;
  agentName:  string;
  // input node — data source type
  inputSource: string;
  // output node — selected reusable output profile id ("" => default)
  outputProfileId?: string;
}

interface ArtifactPromptTemplate {
  agent_id: string;
  agent_name: string;
  artifact_sub_type: string;
  method: string;
  model: string;
  schema_template: string;
  taxonomy: string[];
  fields: Array<{ name: string; type: string; required: boolean; description: string }>;
  updated_at: string;
}

// ── Layout constants & helpers ────────────────────────────────────────────────

const NODE_W         = 200;   // node width
const X_GAP          = 40;    // horizontal gap between slot columns
const SLEEVE_H       = 180;   // vertical height per lane
const SLEEVE_INNER   = 52;    // top padding within lane for node placement
const LANE_VISIBLE_H = 155;   // rendered height of the sleeve strip
const LANE_WIDTH     = 2400;  // width of sleeve background strip
const SLEEVE_START_X = -200;  // left edge — room for the label bar
const Y_INIT         = 20;    // top offset
const MAX_PER_LANE   = 4;     // maximum nodes per lane (4 X slots)

// 4 fixed X slots within every lane
const X_SLOTS = [0, 1, 2, 3].map(i => 20 + i * (NODE_W + X_GAP)); // [20, 260, 500, 740]

// Center of the 4-slot group: (leftmost_slot + rightmost_slot + NODE_W) / 2
const LANE_CENTER_X = (X_SLOTS[0] + X_SLOTS[MAX_PER_LANE - 1] + NODE_W) / 2; // 480

// Centered X positions for 1–4 nodes in a lane (symmetric around LANE_CENTER_X)
const CENTERED_X: readonly (readonly number[])[] = [
  [380],                // 1 node  — center at 480
  [260, 500],           // 2 nodes — symmetric around 480
  [140, 380, 620],      // 3 nodes — evenly spaced around 480
  [20, 260, 500, 740],  // 4 nodes — full X_SLOTS
];

const STAGE_LABELS: Record<NodeKind, string> = {
  input: "Inputs",
  processing: "Processing",
  output: "Artifacts",
};

// Maximum total stages: input + 3 × (processing + output)
const MAX_TOTAL_STAGES = 7;
const LOGS_PANEL_WIDTH = "clamp(340px, 25vw, 560px)";

// All valid X snap targets: union of every position used in CENTERED_X
const ALL_SNAP_X = [...new Set(CENTERED_X.flat())].sort((a, b) => a - b); // [20,140,260,380,500,620,740]

function snapXToSlot(x: number): number {
  return ALL_SNAP_X.reduce((best, s) => Math.abs(s - x) < Math.abs(best - x) ? s : best, ALL_SNAP_X[0]);
}

function laneY(si: number): number {
  return Y_INIT + si * SLEEVE_H;
}

function nodeXY(si: number, slotIdx: number): { x: number; y: number } {
  return { x: X_SLOTS[Math.min(slotIdx, MAX_PER_LANE - 1)], y: laneY(si) + SLEEVE_INNER };
}

// ── Handle CSS (hover states) ─────────────────────────────────────────────────

const HANDLE_CSS = `
  /* Sleeve nodes must never intercept pointer events */
  .react-flow__node-sleeve { pointer-events: none !important; }
  /* Override built-in input/output node sizing (150px) so handles align to our 200px card center */
  .react-flow__node-input,
  .react-flow__node-output {
    width: 200px !important;
    padding: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
    text-align: left !important;
  }
  /* Both handles share the same base size (14 px) so they protrude
     symmetrically from the top and bottom edges of every node card.   */
  /* Source handle — center sits ON the bottom edge (protrudes equally below) */
  .rf-src {
    position:absolute!important;
    left:50%!important; top:auto!important; bottom:0!important;
    transform:translate(-50%,50%)!important;
    width:14px!important;height:14px!important;
    border-radius:50%!important;background:#111827!important;
    border:2px solid #4b5563!important;cursor:crosshair!important;
    overflow:visible!important;
    transition:width .15s,height .15s,background .15s,border-color .15s!important;
  }
  .rf-src::after {
    content:'+';position:absolute;top:50%;left:50%;
    transform:translate(-50%,-50%);color:transparent;
    font-size:10px;font-weight:900;line-height:1;pointer-events:none;
    transition:color .15s!important;
  }
  .rf-src:hover { width:24px!important;height:24px!important;
    background:#064e3b!important;border-color:#10b981!important; }
  .rf-src:hover::after { color:#34d399;font-size:14px; }
  /* Target handle — center sits ON the top edge (protrudes equally above) */
  .rf-tgt {
    position:absolute!important;
    left:50%!important; bottom:auto!important; top:0!important;
    transform:translate(-50%,-50%)!important;
    width:14px!important;height:14px!important;border-radius:50%!important;
    background:#111827!important;border:2px solid #4b5563!important;
    cursor:default!important;transition:all .15s!important;
  }
  .rf-tgt:hover { width:20px!important;height:20px!important;
    background:#1e1b4b!important;border-color:#6366f1!important; }
`;

const NODE_RUNTIME_CSS = `
  .pipeline-node-snake {
    fill: none;
    stroke: #facc15;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 48 220;
    animation: pipeline-node-snake 1.05s linear infinite;
    filter: drop-shadow(0 0 3px rgba(250, 204, 21, 0.75));
  }

  @keyframes pipeline-node-snake {
    to { stroke-dashoffset: -268; }
  }
`;

// ── Sleeve background node ────────────────────────────────────────────────────

function SleeveNode({ data }: { data: Record<string, unknown> }) {
  const d = data as SleeveData;
  return (
    <div style={{ width: LANE_WIDTH, height: LANE_VISIBLE_H, pointerEvents: "none", position: "relative" }}>
      {/* Hairline separator at top of each lane */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: "#1f2937" }} />
      {/* Label text — floats on the background */}
      <span style={{
        position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
        fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
        color: "#374151", userSelect: "none", whiteSpace: "nowrap",
      }}>
        {d.label}
      </span>
    </div>
  );
}

function makeSleeves(stages: NodeKind[]): Node[] {
  return stages.map((kind, i) => ({
    id:         `sleeve_${i}`,
    type:       "sleeve",
    position:   { x: SLEEVE_START_X, y: laneY(i) },
    draggable:  false,
    selectable: false,
    focusable:  false,
    zIndex:     0,
    width:      LANE_WIDTH,
    height:     LANE_VISIBLE_H,
    style:      { background: "transparent", padding: 0, border: "none", boxShadow: "none", pointerEvents: "none" },
    data:       { step: i + 1, label: STAGE_LABELS[kind], kind } satisfies SleeveData,
  }));
}

// ── Auto-connect logic ────────────────────────────────────────────────────────
// input      → processing ✓  (multiple inputs per processing allowed)
// output     → processing ✓  (feedback loops)
// processing → output     ✓  (each processing must have an output)
// processing → processing ✗
// input      → output     ✗
// *          → input      ✗

function findAutoConnect(
  newNode: Node,
  nodes:   Node[],
  edges:   Edge[],
): { source: string; target: string } | null {
  const kind      = newNode.type as NodeKind;
  const realNodes = nodes.filter(n => !String(n.id).startsWith("sleeve_"));

  const newStage = (newNode.data as PipelineNodeData).stageIndex;

  if (kind === "input") {
    // Connect to the nearest unconnected processing below (input is always stage 0)
    const procs = realNodes
      .filter(n => n.type === "processing" && (n.data as PipelineNodeData).stageIndex > newStage)
      .sort((a, b) => (a.data as PipelineNodeData).stageIndex - (b.data as PipelineNodeData).stageIndex);
    const unconnected = procs.filter(n => !edges.some(e => e.target === n.id));
    const target = unconnected[0] ?? procs[0];
    if (target) return { source: newNode.id, target: target.id };
    return null;
  }

  if (kind === "processing") {
    // Connect from the nearest input strictly above (lower stage index)
    const openInputs = realNodes.filter(n =>
      n.type === "input" &&
      (n.data as PipelineNodeData).stageIndex < newStage &&
      !edges.some(e => e.source === n.id)
    );
    if (openInputs.length > 0) return { source: openInputs[0].id, target: newNode.id };
    // Fallback: any input above
    const anyInput = realNodes.filter(n =>
      n.type === "input" && (n.data as PipelineNodeData).stageIndex < newStage
    );
    if (anyInput.length > 0) return { source: anyInput[0].id, target: newNode.id };
    return null;
    // NOTE: never connect output → processing (that would be upward within the same stage pair)
  }

  if (kind === "output") {
    // Connect from the nearest processing strictly above (lower stage index) that has no output yet
    const openProcs = realNodes
      .filter(n =>
        n.type === "processing" &&
        (n.data as PipelineNodeData).stageIndex < newStage &&
        !edges.some(e => e.source === n.id && realNodes.find(x => x.id === e.target)?.type === "output")
      )
      .sort((a, b) => (b.data as PipelineNodeData).stageIndex - (a.data as PipelineNodeData).stageIndex);
    if (openProcs.length > 0) return { source: openProcs[0].id, target: newNode.id };
    return null;
  }

  return null;
}

// ── Custom node components ────────────────────────────────────────────────────

function NodeCard({
  children, meta, selected, kind,
  runtimeStatus = "pending",
  runStepIndex = null,
  runButtonDisabled = false,
  onRunStep,
}: {
  children: React.ReactNode;
  meta:     Meta;
  selected: boolean;
  kind:     NodeKind;
  runtimeStatus?: RuntimeStatus;
  runStepIndex?: number | null;
  runButtonDisabled?: boolean;
  onRunStep?: () => void;
}) {
  const hasStepRun = (!!onRunStep) || (typeof runStepIndex === "number" && runStepIndex >= 0);
  const ringColor =
    kind === "input"      ? "ring-blue-400/50" :
    kind === "processing" ? "ring-indigo-400/50" :
                            "ring-yellow-400/50";
  const runtimeBorder =
    runtimeStatus === "done" ? "border-emerald-500" :
    runtimeStatus === "cached" ? "border-amber-500" :
    runtimeStatus === "error" ? "border-red-500" :
    runtimeStatus === "cancelled" ? "border-slate-400" :
    meta.border;
  const runtimeGlow =
    runtimeStatus === "done" ? "shadow-[0_0_16px_rgba(34,197,94,0.25)]" :
    runtimeStatus === "cached" ? "shadow-[0_0_16px_rgba(245,158,11,0.25)]" :
    runtimeStatus === "error" ? "shadow-[0_0_16px_rgba(239,68,68,0.25)]" :
    runtimeStatus === "cancelled" ? "shadow-[0_0_16px_rgba(148,163,184,0.22)]" :
    "";
  return (
    <div className="relative">
      {runtimeStatus === "loading" && (
        <div className="pointer-events-none absolute -inset-1">
          <svg className="w-full h-full" viewBox="0 0 208 96" preserveAspectRatio="none" aria-hidden="true">
            <rect x="2" y="2" width="204" height="92" rx="14" ry="14" className="pipeline-node-snake" />
          </svg>
        </div>
      )}
      <div className={`w-[200px] rounded-xl border-2 shadow-2xl transition-all duration-150
        ${runtimeBorder} bg-gray-900 ${runtimeGlow}
        ${selected ? `ring-2 ${ringColor} shadow-indigo-900/40` : "opacity-90 hover:opacity-100"}`}>
        {hasStepRun && (
          <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRunStep?.();
              }}
              disabled={runButtonDisabled || !onRunStep}
              className="h-5 min-w-[24px] rounded border border-indigo-700/60 bg-indigo-900/50 px-1 text-[10px] font-bold text-indigo-200 hover:bg-indigo-800/60 disabled:opacity-35 disabled:cursor-not-allowed"
              title={
                typeof runStepIndex === "number"
                  ? `Run this step only (Step ${runStepIndex + 1})`
                  : "Run from this input"
              }
            >
              ▶
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function RuntimeBadge({
  status,
  runningSinceMs,
}: {
  status?: RuntimeStatus;
  runningSinceMs?: number;
}) {
  if (!status || status === "pending") return null;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status !== "loading" || !runningSinceMs) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [status, runningSinceMs]);
  const _tick = tick; // keep reactive without JSX lint warnings
  void _tick;

  const formatElapsed = (startMs: number): string => {
    const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    if (elapsed < 60) return `${elapsed}s`;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}m ${s}s`;
  };

  const meta = RUNTIME_META[status];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide ${meta.className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
      {status === "loading" && runningSinceMs && (
        <span className="tabular-nums text-[8px] font-bold normal-case text-orange-200/90">
          {formatElapsed(runningSinceMs)}
        </span>
      )}
    </span>
  );
}

function EditableNodeLabel({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    const next = (draft || "").trim();
    setEditing(false);
    if (next && next !== value) onCommit(next);
    if (!next) setDraft(value);
  };

  if (editing) {
    return (
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        autoFocus
        className="nodrag w-full bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-sm font-bold text-white outline-none"
      />
    );
  }

  return (
    <span
      className="truncate cursor-text"
      title="Double-click to rename"
      onDoubleClick={e => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}

function InputNode({ id, data, selected }: { id: string; data: PipelineNodeData; selected?: boolean }) {
  const { setNodes } = useReactFlow();
  const m   = getMeta("input", data.subType);
  const src = INPUT_SOURCES.find(s => s.value === (data.inputSource as string)) ?? null;
  const SrcIcon = src?.icon ?? null;
  const runtimeStatus = (data.runtimeStatus as RuntimeStatus | undefined) ?? "pending";
  const runtimeStartedAtMs = Number(data.runtimeStartedAtMs || 0) || undefined;
  const runStepIndex = typeof data.runStepIndex === "number" ? data.runStepIndex : null;
  const runButtonDisabled = !!data.runButtonDisabled;
  return (
    <NodeCard
      meta={m}
      selected={!!selected}
      kind="input"
      runtimeStatus={runtimeStatus}
      runStepIndex={runStepIndex}
      runButtonDisabled={runButtonDisabled}
      onRunStep={data.onRunStep}
    >
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5 rounded-t-xl`}>
        <span className="text-white/90 shrink-0">{SrcIcon ? <SrcIcon className="w-4 h-4" /> : m.icon}</span>
        <EditableNodeLabel
          value={String(data.label || "Input")}
          onCommit={(next) => {
            data.onMutate?.();
            setNodes(ns => ns.map(n =>
              n.id === id
                ? { ...n, data: { ...(n.data as PipelineNodeData), label: next } }
                : n
            ));
          }}
        />
      </div>
      <div className="px-4 py-1.5 bg-gray-900 rounded-b-xl flex items-center justify-between gap-2">
        <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide truncate`}>
          ⬤ {src ? src.label : "Input"}
        </span>
        <RuntimeBadge status={runtimeStatus} runningSinceMs={runtimeStartedAtMs} />
      </div>
      <Handle type="source" position={Position.Bottom} className="rf-src" />
    </NodeCard>
  );
}

function ProcessingNode({ id, data, selected }: { id: string; data: PipelineNodeData; selected?: boolean }) {
  const { setNodes } = useReactFlow();
  const m   = getMeta("processing", data.subType);
  const cls = (data.agentClass as string) ?? "";
  const cm  = classMeta(cls);
  const Icon = CLASS_ICON[cls.toLowerCase()] ?? Bot;
  const hasAgent = !!(data.agentId as string);
  const runtimeStatus = (data.runtimeStatus as RuntimeStatus | undefined) ?? "pending";
  const runtimeStartedAtMs = Number(data.runtimeStartedAtMs || 0) || undefined;
  const runStepIndex = typeof data.runStepIndex === "number" ? data.runStepIndex : null;
  const runButtonDisabled = !!data.runButtonDisabled;
  return (
    <NodeCard
      meta={m}
      selected={!!selected}
      kind="processing"
      runtimeStatus={runtimeStatus}
      runStepIndex={runStepIndex}
      runButtonDisabled={runButtonDisabled}
      onRunStep={data.onRunStep}
    >
      <Handle type="target" position={Position.Top} className="rf-tgt" />
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5 rounded-t-xl`}>
        <span className="text-white/90 shrink-0">
          {hasAgent ? <Icon className="w-4 h-4" /> : m.icon}
        </span>
        <EditableNodeLabel
          value={String(hasAgent ? (data.agentName as string) : data.label || "Agent")}
          onCommit={(next) => {
            data.onMutate?.();
            setNodes(ns => ns.map(n =>
              n.id === id
                ? {
                    ...n,
                    data: {
                      ...(n.data as PipelineNodeData),
                      label: next,
                      ...(hasAgent ? { agentName: next } : {}),
                    },
                  }
                : n
            ));
          }}
        />
      </div>
      <div className="px-4 py-1.5 bg-gray-900 rounded-b-xl flex items-center justify-between gap-2">
        {hasAgent ? (
          <span className={`text-[11px] font-semibold ${cm.textColor} uppercase tracking-wide truncate`}>
            ⬡ Agent · {cm.label}
          </span>
        ) : (
          <span className="text-[11px] text-gray-600 italic truncate">tap to configure</span>
        )}
        <RuntimeBadge status={runtimeStatus} runningSinceMs={runtimeStartedAtMs} />
      </div>
      <Handle type="source" position={Position.Bottom} className="rf-src" />
    </NodeCard>
  );
}

function OutputNode({ id, data, selected }: { id: string; data: PipelineNodeData; selected?: boolean }) {
  const { setNodes } = useReactFlow();
  const m = getMeta("output", data.subType);
  const runtimeStatus = (data.runtimeStatus as RuntimeStatus | undefined) ?? "pending";
  const runtimeStartedAtMs = Number(data.runtimeStartedAtMs || 0) || undefined;
  const runStepIndex = typeof data.runStepIndex === "number" ? data.runStepIndex : null;
  const runButtonDisabled = !!data.runButtonDisabled;
  return (
    <NodeCard
      meta={m}
      selected={!!selected}
      kind="output"
      runtimeStatus={runtimeStatus}
      runStepIndex={runStepIndex}
      runButtonDisabled={runButtonDisabled}
      onRunStep={data.onRunStep}
    >
      <Handle type="target" position={Position.Top} className="rf-tgt" />
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5 rounded-t-xl`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <EditableNodeLabel
          value={String(data.label || "Output")}
          onCommit={(next) => {
            data.onMutate?.();
            setNodes(ns => ns.map(n =>
              n.id === id
                ? { ...n, data: { ...(n.data as PipelineNodeData), label: next } }
                : n
            ));
          }}
        />
      </div>
      <div className="px-4 py-1.5 bg-gray-900 rounded-b-xl flex items-center justify-between gap-2">
        {(ARTIFACT_META as Record<string, Meta>)[data.subType as string] ? (
          <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide truncate`}>
            ◆ {m.label}
          </span>
        ) : (
          <span className="text-[11px] text-gray-600 italic truncate">tap to configure</span>
        )}
        <RuntimeBadge status={runtimeStatus} runningSinceMs={runtimeStartedAtMs} />
      </div>
      <Handle type="source" position={Position.Bottom} className="rf-src" />
    </NodeCard>
  );
}

// ── Custom edge with delete button ────────────────────────────────────────────

function DeletableEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  style, markerEnd, selected,
}: EdgeProps) {
  const { setEdges } = useReactFlow();
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  const showBtn   = selected || hovered;
  const edgeColor = (style?.stroke as string) ?? "#818cf8";
  const edgeW     = showBtn ? 3 : ((style?.strokeWidth as number) ?? 2);
  return (
    <>
      {/* Wide transparent hit area so hover is easy to trigger */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={20}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Visible bezier line */}
      <path d={path} fill="none" stroke={edgeColor} strokeWidth={edgeW}
        markerEnd={markerEnd as string}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {showBtn && (
        <EdgeLabelRenderer>
          <div className="absolute nodrag nopan"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: "all" }}>
            <button
              onClick={e => { e.stopPropagation(); setEdges(es => es.filter(x => x.id !== id)); }}
              className="w-6 h-6 rounded-full bg-red-950 border border-red-600 text-red-300 hover:bg-red-800 hover:border-red-400 flex items-center justify-center text-base font-bold shadow-xl transition-colors"
              title="Remove connection"
            >−</button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// Defined outside the component to prevent type recreation on every render
const EDGE_TYPES: EdgeTypes = {
  default: DeletableEdge as EdgeTypes[string],
};

// Defined outside the component to prevent NodeTypes recreation on every render
const NODE_TYPES: NodeTypes = {
  input:      InputNode      as NodeTypes[string],
  processing: ProcessingNode as NodeTypes[string],
  output:     OutputNode     as NodeTypes[string],
  sleeve:     SleeveNode     as NodeTypes[string],
};

function SwimbarBackdrop({
  stages,
  viewport,
}: {
  stages: NodeKind[];
  viewport: { x: number; y: number; zoom: number };
}) {
  const z = viewport.zoom || 1;
  return (
    <div className="absolute inset-0 pointer-events-none z-0">
      {stages.map((kind, i) => {
        const top = laneY(i) * z + viewport.y;
        const h = LANE_VISIBLE_H * z;
        return (
          <div
            key={`swimbar_${i}`}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top,
              height: h,
              borderTop: "1px solid #1f2937",
              background:
                "linear-gradient(90deg, rgba(55,65,81,0.07) 0%, rgba(17,24,39,0.0) 18%)",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "#374151",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
            >
              {STAGE_LABELS[kind]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PropertiesSection({
  title,
  defaultOpen = true,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className={cn("border border-gray-800 rounded-lg overflow-hidden min-h-0", className)}>
      <summary className="list-none cursor-pointer px-2.5 py-1.5 bg-gray-900/70 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </summary>
      <div className={cn("p-2.5 min-h-0", bodyClassName)}>{children}</div>
    </details>
  );
}

// ── Palette groups ────────────────────────────────────────────────────────────

interface PaletteItem { subType: string; meta: Meta }
interface PaletteSubGroup { label: string; items: PaletteItem[] }
interface PaletteGroup {
  kind:       NodeKind;
  label:      string;
  subGroups?: PaletteSubGroup[];
  items?:     PaletteItem[];
}

const PALETTE_GROUPS: PaletteGroup[] = [
  {
    kind:  "input",
    label: "Data Sources",
    items: [{ subType: "input", meta: INPUT_META.input }],
  },
  {
    kind:  "processing",
    label: "Agents",
    items: (Object.entries(PROCESS_META) as [ProcessSubType, Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
];

// ── Pipeline validation ───────────────────────────────────────────────────────

function validatePipeline(nodes: Node[], edges: Edge[]): string | null {
  if (nodes.length === 0) return "Canvas is empty.";
  if (!nodes.some(n => n.type === "input"))      return "Add at least one Input node.";
  if (!nodes.some(n => n.type === "processing")) return "Add at least one Processing node.";
  if (!nodes.some(n => n.type === "output"))     return "Pipeline must end with an Artifact node.";
  const unassigned = nodes.filter(
    n => n.type === "processing" && !(n.data as PipelineNodeData).agentId,
  );
  if (unassigned.length > 0) {
    return `Assign agents to all Processing nodes before saving (${unassigned.length} missing).`;
  }

  const edgeMap: Record<string, string[]> = {};
  edges.forEach(e => { (edgeMap[e.source] ??= []).push(e.target); });

  for (const proc of nodes.filter(n => n.type === "processing")) {
    const hasOutput = edges.some(
      e => e.source === proc.id && nodes.find(x => x.id === e.target)?.type === "output"
    );
    if (!hasOutput)
      return `Processing "${(proc.data as PipelineNodeData).label}" has no Artifact connected.`;
  }

  for (const inp of nodes.filter(n => n.type === "input")) {
    if (!canReach(inp.id, nodes, edgeMap))
      return `"${(inp.data as PipelineNodeData).label}" has no path to any Artifact.`;
  }
  return null;
}

function canReach(startId: string, nodes: Node[], edgeMap: Record<string, string[]>): boolean {
  const visited = new Set<string>();
  const queue   = [startId];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const n = nodes.find(x => x.id === id);
    if (n?.type === "output") return true;
    (edgeMap[id] ?? []).forEach(nxt => queue.push(nxt));
  }
  return false;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  const diff = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function classifyCanvasLogLine(text: string): CanvasLogLine["level"] {
  const t = String(text || "");
  const up = t.toUpperCase();
  if (up.includes("ERROR") || up.includes("FAILED") || up.includes("EXCEPTION") || up.includes("TRACEBACK")) return "error";
  if (up.includes("WARN")) return "warn";
  if (
    up.includes("[LLM]")
    || up.includes("[VOTE]")
    || up.includes("[SMOOTH]")
    || up.includes("THINKING")
    || up.includes("STREAM")
  ) return "llm";
  if (up.includes("[PIPELINE]") || up.includes("STEP ") || up.includes("PIPELINE")) return "pipeline";
  return "info";
}

function quickHash(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

function normalizeCanvasLogTs(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatLocalTime(value, true);
  }
  const s = String(value || "").trim();
  if (!s) return "—";
  if (/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)) {
    return utcHmsToLocal(s.slice(0, 8));
  }
  const utcTaggedHms = s.match(/^(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:UTC|Z)$/i);
  if (utcTaggedHms?.[1]) {
    return utcHmsToLocal(utcTaggedHms[1]);
  }
  const parsed = parseServerDate(s);
  return parsed ? formatLocalTime(parsed, true) : s;
}

function normalizeCanvasLogLine(line: CanvasLogLine): CanvasLogLine {
  const text = String(line?.text || "");
  return {
    ts: normalizeCanvasLogTs(line?.ts),
    text,
    level: line?.level || classifyCanvasLogLine(text),
  };
}

function parseSavedRunLogLines(rawLogJson: string | null | undefined): CanvasLogLine[] {
  const raw = String(rawLogJson || "").trim();
  if (!raw) return [];

  const normalizeLevel = (value: unknown, text: string): CanvasLogLine["level"] => {
    const v = String(value || "").trim().toLowerCase();
    if (v === "llm" || v === "pipeline" || v === "error" || v === "warn" || v === "info") return v;
    return classifyCanvasLogLine(text);
  };

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => ({
        ts: "—",
        text: line,
        level: classifyCanvasLogLine(line),
      }));
    }
    const out: CanvasLogLine[] = [];
    parsed.forEach((item) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return;
        out.push({ ts: "—", text, level: classifyCanvasLogLine(text) });
        return;
      }
      if (!item || typeof item !== "object") return;
      const obj = item as Record<string, unknown>;
      const text = String(obj.text || obj.msg || obj.message || "").trim();
      if (!text) return;
      out.push({
        ts: normalizeCanvasLogTs(obj.ts || obj.time || obj.timestamp),
        text,
        level: normalizeLevel(obj.level, text),
      });
    });
    return out;
  } catch {
    return raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => ({
      ts: "—",
      text: line,
      level: classifyCanvasLogLine(line),
    }));
  }
}

function inferRunCallIdFromRecord(run: PipelineRunRecord | null | undefined): string {
  if (!run) return "";
  const direct = String(run.call_id || "").trim();
  if (direct) return direct;
  try {
    const parsed = JSON.parse(String(run.steps_json || "[]"));
    if (Array.isArray(parsed)) {
      for (const step of parsed) {
        if (!step || typeof step !== "object") continue;
        const obj = step as Record<string, any>;
        const directCandidates = [
          obj.call_id,
          obj.context_call_id,
          obj.input_scope_call_id,
          obj.merged_until_call_id,
        ];
        for (const candidate of directCandidates) {
          const value = String(candidate || "").trim();
          if (value) return value;
        }
        const inputSources = Array.isArray(obj.input_sources) ? obj.input_sources : [];
        for (const src of inputSources) {
          if (!src || typeof src !== "object") continue;
          const sourceCallId = String((src as Record<string, any>).call_id || "").trim();
          if (sourceCallId) return sourceCallId;
        }
      }
    }
  } catch {
    // ignore
  }
  const lines = parseSavedRunLogLines(String(run.log_json || ""));
  for (const line of lines) {
    const text = String(line.text || "");
    const m1 = text.match(/input\s+scope\s+call\s+context\s*:\s*([A-Za-z0-9_-]{3,})/i);
    if (m1 && m1[1]) return String(m1[1]).trim();
    const m2 = text.match(/\bcall[_\s-]?id\s*[:=]\s*([A-Za-z0-9_-]{3,})\b/i);
    if (m2 && m2[1]) return String(m2[1]).trim();
    const m3 = text.match(/\bcall\s+([A-Za-z0-9_-]{3,})\b/i);
    if (m3 && m3[1]) return String(m3[1]).trim();
  }
  return "";
}

type PersistedRunLogBucket = {
  lines: CanvasLogLine[];
  updated_at: number;
  run_id?: string;
};

type PersistedRunLogStore = {
  by_run_id: Record<string, PersistedRunLogBucket>;
  by_context: Record<string, PersistedRunLogBucket>;
};

function readPersistedRunLogStore(): PersistedRunLogStore {
  if (typeof window === "undefined") return { by_run_id: {}, by_context: {} };
  try {
    const raw = window.localStorage.getItem(PIPELINE_RUN_LOGS_STORAGE_KEY);
    if (!raw) return { by_run_id: {}, by_context: {} };
    const parsed = JSON.parse(raw);
    const byRun = (parsed?.by_run_id && typeof parsed.by_run_id === "object") ? parsed.by_run_id : {};
    const byCtx = (parsed?.by_context && typeof parsed.by_context === "object") ? parsed.by_context : {};
    return {
      by_run_id: byRun as Record<string, PersistedRunLogBucket>,
      by_context: byCtx as Record<string, PersistedRunLogBucket>,
    };
  } catch {
    return { by_run_id: {}, by_context: {} };
  }
}

function trimPersistedBuckets(buckets: Record<string, PersistedRunLogBucket>) {
  const entries = Object.entries(buckets)
    .sort((a, b) => Number((b[1]?.updated_at || 0)) - Number((a[1]?.updated_at || 0)));
  if (entries.length <= MAX_PERSISTED_RUN_LOG_BUCKETS) return buckets;
  const keep = new Set(entries.slice(0, MAX_PERSISTED_RUN_LOG_BUCKETS).map(([k]) => k));
  const next: Record<string, PersistedRunLogBucket> = {};
  for (const [k, v] of entries) {
    if (!keep.has(k)) continue;
    next[k] = v;
  }
  return next;
}

function writePersistedRunLogStore(store: PersistedRunLogStore) {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedRunLogStore = {
      by_run_id: trimPersistedBuckets(store.by_run_id || {}),
      by_context: trimPersistedBuckets(store.by_context || {}),
    };
    window.localStorage.setItem(PIPELINE_RUN_LOGS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage errors
  }
}

function persistRunLogLines(contextKey: string, runId: string, lines: CanvasLogLine[]) {
  if (typeof window === "undefined") return;
  const ctx = String(contextKey || "").trim();
  const rid = String(runId || "").trim();
  const store = readPersistedRunLogStore();
  if (!lines.length) {
    if (ctx) delete store.by_context[ctx];
    if (rid) delete store.by_run_id[rid];
    writePersistedRunLogStore(store);
    return;
  }
  const bucket: PersistedRunLogBucket = {
    lines,
    updated_at: Date.now(),
    run_id: rid || undefined,
  };
  if (ctx) store.by_context[ctx] = bucket;
  if (rid) store.by_run_id[rid] = bucket;
  writePersistedRunLogStore(store);
}

function restoreRunLogLines(contextKey: string, runId: string): CanvasLogLine[] {
  if (typeof window === "undefined") return [];
  const ctx = String(contextKey || "").trim();
  const rid = String(runId || "").trim();
  const store = readPersistedRunLogStore();
  if (rid && store.by_run_id[rid]?.lines?.length) {
    return store.by_run_id[rid].lines;
  }
  if (ctx && store.by_context[ctx]?.lines?.length) {
    return store.by_context[ctx].lines;
  }
  return [];
}

function readActiveRunByContext(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PIPELINE_ACTIVE_RUNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
      const key = String(k || "").trim();
      const value = String(v || "").trim();
      if (key && value) out[key] = value;
    });
    return out;
  } catch {
    return {};
  }
}

function writeActiveRunByContext(next: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PIPELINE_ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

// ── Inner canvas ──────────────────────────────────────────────────────────────

let nodeSeq = 1;
function nextId() { return `pn${nodeSeq++}`; }

function makeEdge(source: string, target: string): Edge {
  return {
    id:        `e_${source}_${target}`,
    source,
    target,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 18, height: 18 },
    style:     { stroke: "#818cf8", strokeWidth: 2 },
  };
}

// Extracted so addNodeToCanvas can be passed down without recreating JSX in the map
function PaletteItem({ kind, subType, meta, onAdd }: {
  kind:    NodeKind;
  subType: string;
  meta:    Meta;
  onAdd:   (kind: NodeKind, subType: string) => void;
}) {
  return (
    <div
      draggable
      onClick={() => onAdd(kind, subType)}
      onDragStart={e => {
        e.dataTransfer.setData("application/nodeKind",    kind);
        e.dataTransfer.setData("application/nodeSubType", subType);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border cursor-pointer select-none transition-all
        hover:scale-[1.02] active:scale-[0.98] ${meta.border} bg-gray-900/60 hover:bg-gray-800`}
    >
      <span className={`p-1 rounded-md ${meta.color} text-white shrink-0`}>{meta.icon}</span>
      <span className={`text-[11px] font-semibold ${meta.text} leading-tight`}>{meta.label}</span>
    </div>
  );
}

function PipelineHistoryModal({
  pipelineId,
  onClose,
  onRestore,
}: {
  pipelineId: string;
  onClose: () => void;
  onRestore: (snap: any) => void;
}) {
  const [snaps, setSnaps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/snapshots`)
      .then(r => r.json())
      .then(d => setSnaps(d.snapshots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pipelineId]);

  const handleRestore = async (snapId: string) => {
    setRestoring(snapId);
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/snapshots/${encodeURIComponent(snapId)}`);
      const snap = await res.json();
      onRestore(snap);
    } catch {
      alert("Failed to load snapshot");
    } finally {
      setRestoring(null);
    }
  };

  const fmtDate = (s: string) => {
    try {
      const d = new Date(s.includes("T") ? s : s.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6"));
      return d.toLocaleString();
    } catch { return s; }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[420px] max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-white">Pipeline History</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading && <p className="text-xs text-gray-500 text-center py-6">Loading…</p>}
          {!loading && snaps.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-6">No saved versions yet. Save the pipeline to create history.</p>
          )}
          {snaps.map(s => (
            <div key={s.snapshot_id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-gray-800/60 hover:bg-gray-800">
              <div className="min-w-0">
                <p className="text-xs font-medium text-white truncate">{s.name}</p>
                <p className="text-[10px] text-gray-400">{fmtDate(s.saved_at)} · {s.step_count} step{s.step_count !== 1 ? "s" : ""}</p>
              </div>
              <button
                onClick={() => handleRestore(s.snapshot_id)}
                disabled={!!restoring}
                className="shrink-0 px-2.5 py-1 rounded bg-indigo-700 hover:bg-indigo-600 text-white text-[10px] font-semibold disabled:opacity-50"
              >
                {restoring === s.snapshot_id ? "…" : "Restore"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PipelineCanvas() {
  const { screenToFlowPosition, setViewport } = useReactFlow();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const { mutate } = useSWRConfig();
  const { profile, permissions } = useUserProfile();
  const {
    salesAgent,
    customer,
    callId,
    activePipelineId,
    setSalesAgent,
    setCustomer,
    setCallId,
    setActivePipeline,
  } = useAppCtx();
  const canCreatePipelines = !!permissions.can_create_pipelines;
  const canEditPipelines = !!permissions.can_edit_pipelines;
  const canRunPipelines = !!permissions.can_run_pipelines;

  // Backend data
  const { data: agentsData }    = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);
  const { data: pipelinesData, error: pipelinesError } = useSWR<PipelineDef[]>("/api/pipelines", fetcher);
  const { data: pipelineFoldersData } = useSWR<PipelineFolderDef[]>("/api/pipelines/folders", fetcher);

  const profileEmailKey = String(profile?.email || "").trim().toLowerCase();
  useEffect(() => {
    if (!profileEmailKey) return;
    void mutate("/api/universal-agents");
    void mutate("/api/pipelines");
    void mutate("/api/pipelines/folders");
  }, [profileEmailKey, mutate]);

  // Poll active runs to highlight pipelines that have live jobs
  const { data: liveRunsData } = useSWR<{ id: string; pipeline_id: string; status: string }[]>(
    "/api/history/runs?sort_by=started_at&sort_dir=desc&limit=100&compact=1",
    fetcher,
    { refreshInterval: 5000, keepPreviousData: true },
  );
  const pipelinesWithActiveRuns = useMemo(() => {
    if (!Array.isArray(liveRunsData)) return new Set<string>();
    const ACTIVE = new Set(["running", "queued", "preparing", "retrying", "loading", "started"]);
    return new Set(
      liveRunsData
        .filter(r => ACTIVE.has(String(r.status || "").toLowerCase()))
        .map(r => String(r.pipeline_id || ""))
        .filter(Boolean),
    );
  }, [liveRunsData]);
  const {
    data: navCustomers,
    isValidating: navCustomersValidating,
    error: navCustomersError,
  } = useSWR<NavCustomerOption[]>(
    salesAgent ? `/api/crm/nav/customers?agent=${encodeURIComponent(salesAgent)}` : null,
    fetcher,
  );
  const { data: callDates } = useSWR<CallDatesMap>(
    salesAgent && customer
      ? `/api/crm/call-dates?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
    { refreshInterval: 8000, revalidateOnFocus: true },
  );
  const { data: transcriptCalls } = useSWR<FinalTranscriptCall[]>(
    salesAgent && customer
      ? `/api/final-transcript/calls?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
  );
  const { data: pairCalls } = useSWR<CRMCallLite[]>(
    salesAgent && customer
      ? `/api/crm/calls-by-pair?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
    { refreshInterval: 8000, revalidateOnFocus: true },
  );
  const allAgents   = agentsData   ?? [];
  const allPipelines = pipelinesData ?? [];

  const outputProfiles = useMemo<OutputProfile[]>(() => {
    const out: OutputProfile[] = [];
    for (const a of allAgents) {
      const artifact_type = String(a.artifact_type || "").trim();
      const artifact_name = String(a.artifact_name || "").trim();
      const output_schema = String(a.output_schema || "").trim();
      if (!artifact_type && !artifact_name && !output_schema) continue;
      out.push({
        id: String(a.id || ""),
        name: artifact_name || String(a.name || "Profile"),
        artifact_type,
        artifact_class: String(a.artifact_class || "").trim(),
        artifact_name,
        output_format: String(a.output_format || "markdown").trim().toLowerCase(),
        output_schema,
        output_taxonomy: Array.isArray(a.output_taxonomy)
          ? a.output_taxonomy.map(x => String(x || "").trim()).filter(Boolean)
          : [],
        output_contract_mode: (["off", "soft", "strict"].includes(String(a.output_contract_mode || "").toLowerCase())
          ? String(a.output_contract_mode).toLowerCase()
          : "soft") as "off" | "soft" | "strict",
        output_fit_strategy: (["structured", "raw"].includes(String(a.output_fit_strategy || "").toLowerCase())
          ? String(a.output_fit_strategy).toLowerCase()
          : "structured") as "structured" | "raw",
        output_response_mode: (["wrap", "transform", "custom_format"].includes(String(a.output_response_mode || "").toLowerCase())
          ? String(a.output_response_mode).toLowerCase()
          : "wrap") as "wrap" | "transform" | "custom_format",
        output_target_type: (["raw_text", "markdown", "json"].includes(String(a.output_target_type || "").toLowerCase())
          ? String(a.output_target_type).toLowerCase()
          : "raw_text") as "raw_text" | "markdown" | "json",
        output_template: String(a.output_template || ""),
        output_placeholder: String(a.output_placeholder || "response"),
        output_previous_placeholder: String(a.output_previous_placeholder || "previous_response"),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [allAgents]);

  function profileMatchesArtifactSubType(profile: OutputProfile, subType: string): boolean {
    const st = String(subType || "").toLowerCase();
    const t = String(profile.artifact_type || "").toLowerCase();
    const c = String(profile.artifact_class || "").toLowerCase();
    const n = String(profile.name || "").toLowerCase();
    if (st === "notes") return /note/.test(t) || /note/.test(c) || /note/.test(n);
    if (st === "notes_compliance") return /compliance|violation/.test(t) || /compliance|violation/.test(c) || /compliance|violation/.test(n);
    if (st === "persona") return /persona/.test(t) || /persona/.test(c) || /persona/.test(n);
    if (st === "persona_score") return /score|persona_score/.test(t) || /score|persona_score/.test(c) || /score|persona_score/.test(n);
    return true;
  }

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const INIT_STAGES: NodeKind[] = ["input", "processing", "output"];
  const [stages, setStages]              = useState<NodeKind[]>(INIT_STAGES);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showBundleImport, setShowBundleImport] = useState(false);
  const [bundleImportText, setBundleImportText] = useState("");
  const [bundleImportFolder, setBundleImportFolder] = useState("");
  const [bundleImporting, setBundleImporting] = useState(false);
  const [showBundleCopyFallback, setShowBundleCopyFallback] = useState(false);
  const [bundleCopyText, setBundleCopyText] = useState("");
  // Pipeline save state
  const [pipelineName, setPipelineName]     = useState("");
  const [pipelineId,   setPipelineId]       = useState<string | null>(null);
  const [pipelineFolder, setPipelineFolder] = useState("");
  const [pipelineSaving, setPipelineSaving] = useState(false);
  const [pipelinesPanelWidth, setPipelinesPanelWidth] = useState(320);
  const [showCreatePipelineFolder, setShowCreatePipelineFolder] = useState(false);
  const [newPipelineFolderDraft, setNewPipelineFolderDraft] = useState("");
  const [newFolderColor, setNewFolderColor] = useState("");
  const [collapsedPipelineOwnerIds, setCollapsedPipelineOwnerIds] = useState<Record<string, boolean>>({});
  const [collapsedPipelineFolderIds, setCollapsedPipelineFolderIds] = useState<Record<string, boolean>>({});
  const [dragOverPipelineFolder, setDragOverPipelineFolder] = useState<string | null>(null);
  // Sidebar search
  const [pipelineSidebarSearch, setPipelineSidebarSearch] = useState("");
  // Folder inline rename
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Folder drag-to-reorder
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  const [dragOverFolderReorderId, setDragOverFolderReorderId] = useState<string | null>(null);
  // Agent config panel state (for selected processing node)
  const [agentDraft, setAgentDraft] = useState<Omit<UniversalAgent, "id"|"created_at"> | null>(null);
  const [agentDeleting, setAgentDeleting] = useState(false);
  // Tracks which "nodeId::agentId" the draft was last successfully loaded for,
  // so allAgents re-fetches and updateNodeData calls don't stomp in-progress edits.
  const agentDraftLoadedFor = useRef<string>("");
  // Per-node pending saves: flushed automatically when the pipeline is saved.
  const pendingAgentSaves = useRef<Map<string, Omit<UniversalAgent, "id"|"created_at">>>(new Map());
  const [canvasViewport, setCanvasViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [manualNoteSendPendingId, setManualNoteSendPendingId] = useState("");
  const [manualNoteSendMessage, setManualNoteSendMessage] = useState("");
  const [manualNoteSendError, setManualNoteSendError] = useState(false);
  const [stepStatuses, setStepStatuses] = useState<RuntimeStatus[]>([]);
  const runAbortRef = useRef<AbortController | null>(null);
  const [expandedHistoryRunIds, setExpandedHistoryRunIds] = useState<Record<string, boolean>>({});
  const [collapsedHistoryDayIds, setCollapsedHistoryDayIds] = useState<Record<string, boolean>>({});
  const [showCallsPanel, setShowCallsPanel] = useState(false);
  const [showCrmPanel, setShowCrmPanel] = useState(false);
  const [showHistoricalRunModeDialog, setShowHistoricalRunModeDialog] = useState(false);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [runLogLines, setRunLogLines] = useState<CanvasLogLine[]>([]);
  const [runLogsSearch, setRunLogsSearch] = useState("");
  const [runLogFilterMode, setRunLogFilterMode] = useState<CanvasLogFilterMode>("all");
  const [runLogsGrouped, setRunLogsGrouped] = useState(false);
  const [liveModeEnabled, setLiveModeEnabled] = useState(false);
  const [liveListenAnyCall, setLiveListenAnyCall] = useState(false);
  const [liveWebhookStatus, setLiveWebhookStatus] = useState<LiveWebhookStatus>("off");
  const [liveCursorMs, setLiveCursorMs] = useState(0);
  const [liveTriggeredAt, setLiveTriggeredAt] = useState("");
  const liveCursorRef = useRef(0);

  // ── Canvas undo/redo ──────────────────────────────────────────────────────
  const canvasHistoryRef = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const canvasRedoRef    = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const [canvasUndoLen, setCanvasUndoLen] = useState(0);
  const [canvasRedoLen, setCanvasRedoLen] = useState(0);
  const [showPipelineHistoryModal, setShowPipelineHistoryModal] = useState(false);
  const liveWaitAbortRef = useRef<AbortController | null>(null);
  const [canvasLocked, setCanvasLocked] = useState(false);
  const [runContextMode, setRunContextMode] = useState<RunContextMode>("new");
  const [selectedCacheRunId, setSelectedCacheRunId] = useState("");
  const [currentRunId, setCurrentRunId] = useState("");
  const [stepInputReady, setStepInputReady] = useState<boolean[]>([]);
  const [liveThinkingByStep, setLiveThinkingByStep] = useState<Record<number, string>>({});
  const [liveStreamByStep, setLiveStreamByStep] = useState<Record<number, string>>({});
  const [resultViewMode, setResultViewMode] = useState<ResultViewMode>("rendered");
  const [renderedLlmCache, setRenderedLlmCache] = useState<Record<string, RenderedLlmCacheEntry>>({});
  const [inputPreviewBySource, setInputPreviewBySource] = useState<Record<string, InputPreviewState>>({});
  const inputPreviewSnapshotRef = useRef<Record<string, InputPreviewState>>({});
  const inputPreviewInFlightRef = useRef<Record<string, Promise<void>>>({});
  const [callTranscriptText, setCallTranscriptText] = useState("");
  const [callTranscriptLoading, setCallTranscriptLoading] = useState(false);
  const [callTranscriptError, setCallTranscriptError] = useState("");
  const [pendingOpenRunPayload, setPendingOpenRunPayload] = useState<PipelineOpenRunPayload | null>(null);
  const [pendingRunCallId, setPendingRunCallId] = useState("");
  const [detailViewer, setDetailViewer] = useState<CanvasDetailViewerState | null>(null);
  const pipelinesPanelResizeRef = useRef<{
    active: boolean;
    startX: number;
    startWidth: number;
  }>({ active: false, startX: 0, startWidth: 320 });

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
      liveWaitAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    setLogsExpanded(true);
    setLogsCollapsed(false);
  }, [running]);

  useEffect(() => {
    if (!selectedNodeId) setDetailViewer(null);
  }, [selectedNodeId]);

  useEffect(() => {
    setManualNoteSendPendingId("");
    setManualNoteSendMessage("");
    setManualNoteSendError(false);
  }, [selectedNodeId, selectedCacheRunId, currentRunId, runContextMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let nextPayload: PipelineOpenRunPayload | null = null;

    const raw = window.localStorage.getItem(PIPELINE_OPEN_RUN_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PipelineOpenRunPayload;
        if (parsed && typeof parsed === "object") {
          nextPayload = parsed;
        }
      } catch {
        // ignore malformed payload
      } finally {
        window.localStorage.removeItem(PIPELINE_OPEN_RUN_STORAGE_KEY);
      }
    }

    // Fallback: allow direct links like /pipeline?run_id=<id> to open run context.
    if (!nextPayload) {
      const qp = new URLSearchParams(window.location.search || "");
      const runId = String(
        qp.get("run_id")
        || qp.get("runId")
        || qp.get("runid")
        || "",
      ).trim();
      if (runId) {
        const parseBool = (value: string | null): boolean | undefined => {
          if (value == null) return undefined;
          const norm = String(value).trim().toLowerCase();
          if (!norm) return undefined;
          if (["1", "true", "yes", "on"].includes(norm)) return true;
          if (["0", "false", "no", "off"].includes(norm)) return false;
          return undefined;
        };
        const locked = parseBool(qp.get("locked"));
        nextPayload = {
          source: "pipeline_query",
          run_id: runId,
          pipeline_id: String(qp.get("pipeline_id") || qp.get("pipelineId") || qp.get("pipelineid") || "").trim(),
          pipeline_name: String(qp.get("pipeline_name") || qp.get("pipelineName") || "").trim(),
          sales_agent: String(qp.get("sales_agent") || qp.get("salesAgent") || "").trim(),
          customer: String(qp.get("customer") || "").trim(),
          call_id: String(qp.get("call_id") || qp.get("callId") || "").trim(),
          ...(locked == null ? {} : { locked }),
        };
      }
    }

    if (nextPayload) {
      setPendingOpenRunPayload(nextPayload);
    }
  }, []);

  const agentUsageByPipeline = useMemo(() => {
    const out: Record<string, { total: number; other: number }> = {};
    for (const p of allPipelines) {
      const seen = new Set<string>();
      for (const s of (p.steps ?? [])) {
        const aid = String(s?.agent_id || "").trim();
        if (!aid || seen.has(aid)) continue;
        seen.add(aid);
        const row = out[aid] ?? { total: 0, other: 0 };
        row.total += 1;
        if (!pipelineId || p.id !== pipelineId) row.other += 1;
        out[aid] = row;
      }
    }
    return out;
  }, [allPipelines, pipelineId]);

  const normalizeFolder = (name?: string | null) => (name ?? "").trim();
  const normalizeOwnerEmail = (value?: string | null) => String(value || "").trim().toLowerCase();

  // Rich folder objects from the DB-backed endpoint, sorted by sort_order
  const pipelineFolders = useMemo((): PipelineFolderDef[] => {
    const base = (pipelineFoldersData ?? []);
    // Identify orphan folder strings from pipelines not yet in DB
    const knownIds = new Set(base.map(f => f.id));
    const knownNames = new Set(base.map(f => f.name.toLowerCase()));
    const orphans: PipelineFolderDef[] = [];
    const seenOrphan = new Set<string>();
    for (const p of allPipelines) {
      const fname = normalizeFolder(p.folder);
      if (!fname) continue;
      const fid = p.folder_id ?? "";
      if ((fid && knownIds.has(fid)) || knownNames.has(fname.toLowerCase())) continue;
      const key = fname.toLowerCase();
      if (seenOrphan.has(key)) continue;
      seenOrphan.add(key);
      orphans.push({
        id: `__orphan__${fname}`, name: fname,
        description: null, color: null,
        sort_order: 9999 + orphans.length, owner_email: null,
        pipeline_count: 0, created_at: "", updated_at: "",
      });
    }
    return [...base, ...orphans];
  }, [allPipelines, pipelineFoldersData]);

  // Keyed by folder_id (UUID) or "__name__<folderName>" for orphans/legacy
  const pipelinesByFolderId = useMemo(() => {
    const grouped: Record<string, PipelineDef[]> = {};
    for (const p of allPipelines) {
      const fid = p.folder_id ?? "";
      const fname = normalizeFolder(p.folder);
      const key = fid || (fname ? `__name__${fname}` : "");
      (grouped[key] ??= []).push(p);
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    return grouped;
  }, [allPipelines]);

  const pipelineOwners = useMemo(() => {
    const meEmail = normalizeOwnerEmail(String(profile?.email || ""));

    // Build a folderId → PipelineFolderDef map for sort order lookup
    const folderById = new Map<string, PipelineFolderDef>();
    for (const f of pipelineFolders) folderById.set(f.id, f);

    // Resolve which folder a pipeline belongs to (returns folderId key)
    const getPipelineFolderKey = (p: PipelineDef): string => {
      if (p.folder_id) return p.folder_id;
      const fname = normalizeFolder(p.folder);
      return fname ? `__name__${fname}` : "";
    };

    const getFolderDef = (key: string): PipelineFolderDef | undefined => {
      if (!key.startsWith("__name__")) return folderById.get(key);
      const name = key.slice(8);
      return pipelineFolders.find(f => f.name.toLowerCase() === name.toLowerCase());
    };

    const buckets = new Map<string, { ownerKey: string; ownerEmail: string; ownerName: string; pipelines: PipelineDef[] }>();
    for (const p of allPipelines) {
      const ownerEmail = normalizeOwnerEmail(p.workspace_user_email);
      const ownerKey = ownerEmail || "__shared__";
      if (!buckets.has(ownerKey)) {
        buckets.set(ownerKey, { ownerKey, ownerEmail, ownerName: String(p.workspace_user_name || "").trim(), pipelines: [] });
      }
      const bucket = buckets.get(ownerKey)!;
      if (!bucket.ownerName) bucket.ownerName = String(p.workspace_user_name || "").trim();
      bucket.pipelines.push(p);
    }

    const searchLower = pipelineSidebarSearch.toLowerCase();

    const out = Array.from(buckets.values()).map((bucket) => {
      const byFolder: Record<string, PipelineDef[]> = {};
      for (const p of bucket.pipelines) {
        const key = getPipelineFolderKey(p);
        (byFolder[key] ??= []).push(p);
      }
      for (const key of Object.keys(byFolder)) {
        byFolder[key].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      }

      const folderEntries = Object.keys(byFolder).sort((a, b) => {
        const defA = getFolderDef(a);
        const defB = getFolderDef(b);
        const orderA = defA?.sort_order ?? 9999;
        const orderB = defB?.sort_order ?? 9999;
        if (orderA !== orderB) return orderA - orderB;
        const nameA = defA?.name || a;
        const nameB = defB?.name || b;
        return nameA.localeCompare(nameB);
      });

      const ownerLabel = bucket.ownerKey === "__shared__"
        ? "Shared"
        : bucket.ownerName || (meEmail && bucket.ownerEmail === meEmail ? "You" : bucket.ownerEmail);

      return {
        ownerKey: bucket.ownerKey,
        ownerEmail: bucket.ownerEmail,
        ownerLabel,
        total: bucket.pipelines.length,
        folders: folderEntries.map((fKey) => {
          const def = getFolderDef(fKey);
          const pipelines = (byFolder[fKey] ?? []).filter(p =>
            !searchLower || p.name.toLowerCase().includes(searchLower)
          );
          return {
            key: fKey,
            folderId: def?.id ?? fKey,
            label: def?.name || (fKey.startsWith("__name__") ? fKey.slice(8) : fKey) || "Unfiled",
            color: def?.color ?? null,
            description: def?.description ?? null,
            pipelineCount: def?.pipeline_count ?? pipelines.length,
            pipelines,
          };
        }).filter(f => !searchLower || f.pipelines.length > 0 || !f.key),
      };
    });

    // Empty global folders from DB not yet used by any pipeline
    const allKnownKeys = new Set<string>();
    for (const owner of out) for (const f of owner.folders) allKnownKeys.add(f.key);
    const emptyFolders = pipelineFolders.filter(f =>
      !allKnownKeys.has(f.id) && !allKnownKeys.has(`__name__${f.name}`) && !allKnownKeys.has(f.name)
    );
    if (emptyFolders.length > 0) {
      let sharedGroup = out.find(o => o.ownerKey === "__shared__");
      if (!sharedGroup) {
        sharedGroup = { ownerKey: "__shared__", ownerEmail: "", ownerLabel: "Shared", total: 0, folders: [] };
        out.push(sharedGroup);
      }
      for (const f of emptyFolders) {
        sharedGroup.folders.push({
          key: f.id, folderId: f.id, label: f.name,
          color: f.color ?? null, description: f.description ?? null,
          pipelineCount: 0, pipelines: [],
        });
      }
      sharedGroup.folders.sort((a, b) => a.label.localeCompare(b.label));
    }

    out.sort((a, b) => {
      const aRank = a.ownerKey === "__shared__" ? 2 : (a.ownerEmail && meEmail && a.ownerEmail === meEmail ? 0 : 1);
      const bRank = b.ownerKey === "__shared__" ? 2 : (b.ownerEmail && meEmail && b.ownerEmail === meEmail ? 0 : 1);
      if (aRank !== bRank) return aRank - bRank;
      return a.ownerLabel.localeCompare(b.ownerLabel);
    });
    return out;
  }, [allPipelines, pipelineFolders, pipelineSidebarSearch, profile?.email]);

  const normalizeCallId = (raw: string | null | undefined) => String(raw || "").trim().toLowerCase();
  const parseDurationSeconds = (raw: unknown): number | null => {
    if (raw == null) return null;
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw);
    const s = String(raw).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.max(0, Number(s));
    if (/^(\d{1,2}:)?\d{1,2}:\d{1,2}$/.test(s)) {
      const parts = s.split(":").map((p) => Number(p));
      if (parts.some((n) => !Number.isFinite(n))) return null;
      if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
      if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
    }
    return null;
  };
  const formatDurationLabel = (seconds: number | null | undefined): string => {
    if (seconds == null || !Number.isFinite(seconds)) return "";
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  const parseDateEpoch = (raw: string | null | undefined): number | null => {
    const s = String(raw || "").trim();
    if (!s) return null;
    const epoch = Date.parse(s);
    return Number.isFinite(epoch) ? epoch : null;
  };
  const formatDateLabel = (raw: string | null | undefined): string => {
    const s = String(raw || "").trim();
    if (!s) return "Unknown date";
    const epoch = Date.parse(s);
    if (!Number.isFinite(epoch)) return s;
    return new Date(epoch).toLocaleString();
  };

  const selectedPipeline = useMemo(
    () => allPipelines.find(p => p.id === pipelineId) ?? null,
    [allPipelines, pipelineId],
  );
  const runScope = String(selectedPipeline?.scope || "per_call").toLowerCase();
  const runNeedsCall = runScope !== "per_pair";
  const runLogContextKey = useMemo(
    () => [
      String(pipelineId || "").trim(),
      String(salesAgent || "").trim(),
      String(customer || "").trim(),
      runNeedsCall ? String(callId || "").trim() : "",
    ].join("|"),
    [pipelineId, salesAgent, customer, runNeedsCall, callId],
  );

  const liveStateUrl = useMemo(() => {
    if (!pipelineId || !salesAgent || !customer) return null;
    const qp = new URLSearchParams({
      sales_agent: salesAgent,
      customer,
    });
    return `/api/pipelines/${encodeURIComponent(pipelineId)}/state?${qp.toString()}`;
  }, [pipelineId, salesAgent, customer]);
  const { data: livePipelineState, mutate: mutateLivePipelineState } = useSWR<PipelineLiveState>(
    liveStateUrl,
    fetcher,
    { refreshInterval: running ? 1500 : 5000 },
  );

  const statusPipelineId = pipelineId || activePipelineId;
  const { data: pipelineArtifactStatus } = useSWR<PipelineArtifactStatus>(
    statusPipelineId && salesAgent && customer
      ? `/api/pipelines/${encodeURIComponent(statusPipelineId)}/artifact-status?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`
      : null,
    fetcher,
  );
  const pipelineCallMapByNorm = useMemo(() => {
    const out: Record<string, PipelineArtifactState> = {};
    const callMap = pipelineArtifactStatus?.calls ?? {};
    Object.entries(callMap).forEach(([k, v]) => {
      const norm = normalizeCallId(k);
      if (!norm || out[norm]) return;
      out[norm] = v;
    });
    return out;
  }, [pipelineArtifactStatus]);

  const callOptions = useMemo(() => {
    const merged = new Map<string, CallOptionMeta>();
    (pairCalls ?? []).forEach((c) => {
      const key = String(c?.call_id || "").trim();
      if (!key) return;
      merged.set(key, {
        date: String(c?.date || ""),
        has_audio: !!String(c?.record_path || "").trim(),
        duration_s: parseDurationSeconds(c?.duration),
      });
    });
    Object.entries(callDates ?? {}).forEach(([cid, meta]) => {
      const key = String(cid || "").trim();
      if (!key) return;
      const prev = merged.get(key);
      merged.set(key, {
        date: String(meta?.date || prev?.date || ""),
        has_audio: !!meta?.has_audio || !!prev?.has_audio,
        duration_s: prev?.duration_s ?? null,
      });
    });
    (transcriptCalls ?? []).forEach((tx) => {
      const key = String(tx?.call_id || "").trim();
      if (!key) return;
      const prev = merged.get(key);
      merged.set(key, {
        date: prev?.date || "",
        has_audio: !!prev?.has_audio,
        duration_s: prev?.duration_s ?? null,
      });
    });
    Object.keys(pipelineArtifactStatus?.calls ?? {}).forEach((cid) => {
      const key = String(cid || "").trim();
      if (!key) return;
      if (merged.has(key)) return;
      merged.set(key, { date: "", has_audio: false, duration_s: null });
    });
    if (callId && !merged.has(callId)) {
      merged.set(callId, { date: "", has_audio: false, duration_s: null });
    }
    const entries = Array.from(merged.entries());
    entries.sort((a, b) => {
      const ta = parseDateEpoch(a[1]?.date);
      const tb = parseDateEpoch(b[1]?.date);
      if (ta != null && tb != null && ta !== tb) return ta - tb; // oldest -> newest
      if (ta != null && tb == null) return -1;
      if (ta == null && tb != null) return 1;
      const ca = String(a[0] || "").trim();
      const cb = String(b[0] || "").trim();
      const na = Number(ca);
      const nb = Number(cb);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return ca.localeCompare(cb);
    });
    return entries;
  }, [pairCalls, callDates, transcriptCalls, pipelineArtifactStatus, callId]);

  const selectedTranscriptCall = useMemo(() => {
    const wanted = normalizeCallId(callId);
    if (!wanted) return null;
    return (transcriptCalls ?? []).find((c) => normalizeCallId(c.call_id) === wanted) ?? null;
  }, [transcriptCalls, callId]);

  const transcriptCallMapByNorm = useMemo(() => {
    const out = new Map<string, FinalTranscriptCall>();
    for (const c of (transcriptCalls ?? [])) {
      const key = normalizeCallId(c.call_id);
      if (!key || out.has(key)) continue;
      out.set(key, c);
    }
    return out;
  }, [transcriptCalls]);

  const crmPanelUrl = useMemo(() => {
    const qp = new URLSearchParams({ embedded: "1", mode: "pick_pair" });
    if (salesAgent) qp.set("agent", salesAgent);
    if (customer) qp.set("customer", customer);
    return `/crm?${qp.toString()}`;
  }, [salesAgent, customer]);

  const applySelectedCallId = useCallback((nextCallIdRaw: string) => {
    const nextCallId = String(nextCallIdRaw || "").trim();
    if (runContextMode === "historical") {
      setRunContextMode("new");
      setSelectedCacheRunId("");
      setCurrentRunId("");
      setCanvasLocked(false);
    }
    setPendingRunCallId("");
    setCallId(nextCallId);
  }, [runContextMode, setCallId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as {
        type?: string;
        agent?: string;
        customer?: string;
        call_id?: string;
      } | null;
      if (!payload || !payload.type) return;
      if (payload.type === "shinobi:select-pair") {
        const nextAgent = String(payload.agent || "").trim();
        const nextCustomer = String(payload.customer || "").trim();
        if (!nextAgent || !nextCustomer) return;
        setCustomer(nextCustomer, nextAgent);
        setShowCrmPanel(false);
        return;
      }
      if (payload.type === "shinobi:select-agent") {
        const nextAgent = String(payload.agent || "").trim();
        if (!nextAgent) return;
        setSalesAgent(nextAgent);
        setShowCrmPanel(false);
        return;
      }
      if (payload.type === "shinobi:select-customer") {
        const nextAgent = String(payload.agent || "").trim();
        const nextCustomer = String(payload.customer || "").trim();
        if (!nextCustomer) return;
        if (nextAgent) setCustomer(nextCustomer, nextAgent);
        else setCustomer(nextCustomer);
        setShowCrmPanel(false);
        return;
      }
      if (payload.type === "shinobi:calls-context") {
        const nextAgent = String(payload.agent || "").trim();
        const nextCustomer = String(payload.customer || "").trim();
        const nextCallId = String(payload.call_id || "").trim();
        if (nextAgent && nextCustomer && (nextAgent !== salesAgent || nextCustomer !== customer)) {
          setCustomer(nextCustomer, nextAgent);
        }
        applySelectedCallId(nextCallId);
        if (nextCallId) setShowCallsPanel(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [customer, salesAgent, setCustomer, setSalesAgent, applySelectedCallId]);

  useEffect(() => {
    if (!customer || !navCustomers) return;
    if (navCustomersValidating || navCustomersError) return;
    if (!navCustomers.some(c => c.customer === customer)) {
      setCustomer("");
    }
  }, [customer, navCustomers, navCustomersValidating, navCustomersError, setCustomer]);

  useEffect(() => {
    const wanted = String(pendingRunCallId || "").trim();
    if (!wanted) return;
    if (callId !== wanted) {
      setCallId(wanted);
      return;
    }
    if (callOptions.some(([cid]) => cid === wanted)) {
      setPendingRunCallId("");
    }
  }, [pendingRunCallId, callId, callOptions, setCallId]);

  useEffect(() => {
    const pendingWanted = String(pendingRunCallId || "").trim();
    if (pendingWanted) return;
    if (!callId) return;
    if (!callOptions.some(([cid]) => cid === callId)) {
      setCallId("");
    }
  }, [callId, callOptions, setCallId, pendingRunCallId]);

  useEffect(() => {
    if (!showCallsPanel) return;
    if (!salesAgent || !customer || !callId) {
      setCallTranscriptText("");
      setCallTranscriptError("");
      setCallTranscriptLoading(false);
      return;
    }

    const preferredPath =
      selectedTranscriptCall?.final_path
      || selectedTranscriptCall?.smoothed_path
      || selectedTranscriptCall?.voted_path
      || selectedTranscriptCall?.pipeline_final_files?.[0]?.path
      || "";

    if (!preferredPath) {
      setCallTranscriptText("");
      setCallTranscriptError("No transcript found for this call.");
      setCallTranscriptLoading(false);
      return;
    }

    let cancelled = false;
    setCallTranscriptLoading(true);
    setCallTranscriptError("");

    fetch(`/api/final-transcript/content?path=${encodeURIComponent(preferredPath)}`)
      .then((r) => r.text())
      .then((txt) => {
        if (cancelled) return;
        setCallTranscriptText(String(txt || ""));
      })
      .catch(() => {
        if (cancelled) return;
        setCallTranscriptText("");
        setCallTranscriptError("Error loading transcript.");
      })
      .finally(() => {
        if (cancelled) return;
        setCallTranscriptLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [showCallsPanel, salesAgent, customer, callId, selectedTranscriptCall]);

  const runsUrl = useMemo(() => {
    const qp = new URLSearchParams({ limit: "300", compact: "1" });
    if (pipelineId) qp.set("pipeline_id", pipelineId);
    if (salesAgent) qp.set("sales_agent", salesAgent);
    if (customer) qp.set("customer", customer);
    if (runNeedsCall && callId) qp.set("call_id", callId);
    return `/api/history/runs?${qp.toString()}`;
  }, [pipelineId, salesAgent, customer, runNeedsCall, callId]);
  const { data: runsData, mutate: mutateRuns } = useSWR<PipelineRunRecord[]>(
    runsUrl,
    fetcher,
    { refreshInterval: running ? 4000 : 15000 },
  );

  const selectedRunByIdUrl = useMemo(() => {
    if (runContextMode !== "historical") return null;
    const rid = String(selectedCacheRunId || currentRunId || "").trim();
    if (!rid) return null;
    const qp = new URLSearchParams({ mirror: "1" });
    return `/api/history/runs/${encodeURIComponent(rid)}?${qp.toString()}`;
  }, [runContextMode, selectedCacheRunId, currentRunId]);

  const { data: selectedRunByIdData } = useSWR<PipelineRunRecord>(
    selectedRunByIdUrl,
    fetcher,
    {
      refreshInterval: (data) => {
        const st = String((data as PipelineRunRecord | undefined)?.status || "").trim().toLowerCase();
        return ["queued", "preparing", "running", "retrying"].includes(st) ? 4000 : 15000;
      },
      revalidateOnFocus: true,
    },
  );

  const historyRuns = useMemo(() => {
    const list = Array.isArray(runsData) ? [...runsData] : [];
    if (selectedRunByIdData?.id) {
      const selectedId = String(selectedRunByIdData.id || "");
      const idx = list.findIndex((r) => String(r.id || "") === selectedId);
      if (idx >= 0) list[idx] = selectedRunByIdData;
      else list.unshift(selectedRunByIdData);
    }
    const selectedRid = String(selectedCacheRunId || "").trim();
    return list.filter((r) => {
      if (runContextMode === "historical" && selectedRid && String(r.id || "").trim() === selectedRid) {
        return true;
      }
      if (salesAgent && r.sales_agent !== salesAgent) return false;
      if (customer && r.customer !== customer) return false;
      if (runNeedsCall && callId) {
        return normalizeCallId(r.call_id) === normalizeCallId(callId);
      }
      return true;
    });
  }, [runsData, selectedRunByIdData, runContextMode, selectedCacheRunId, salesAgent, customer, runNeedsCall, callId]);

  const historyRunDayGroups = useMemo(() => {
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const dayIdFromEpoch = (epoch: number) => {
      const d = new Date(epoch);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };
    const labelFromDayId = (dayId: string) => {
      if (dayId === "unknown") return "Unknown date";
      const d = new Date(`${dayId}T00:00:00`);
      if (Number.isNaN(d.getTime())) return dayId;
      return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    };

    const byDay = new Map<string, PipelineRunRecord[]>();
    for (const run of historyRuns) {
      const epoch = parseDateEpoch(run.started_at || run.finished_at || "");
      const dayId = epoch != null ? dayIdFromEpoch(epoch) : "unknown";
      if (!byDay.has(dayId)) byDay.set(dayId, []);
      byDay.get(dayId)!.push(run);
    }

    const groups = Array.from(byDay.entries()).map(([dayId, runs]) => {
      const sortedRuns = [...runs].sort((a, b) => {
        const ea = parseDateEpoch(a.started_at || a.finished_at || "") ?? 0;
        const eb = parseDateEpoch(b.started_at || b.finished_at || "") ?? 0;
        return eb - ea;
      });
      return {
        dayId,
        label: labelFromDayId(dayId),
        runs: sortedRuns,
      };
    });

    groups.sort((a, b) => {
      if (a.dayId === "unknown") return 1;
      if (b.dayId === "unknown") return -1;
      return a.dayId < b.dayId ? 1 : a.dayId > b.dayId ? -1 : 0;
    });
    return groups;
  }, [historyRuns]);

  const cacheRunOptions = useMemo(
    () =>
      historyRuns.map((run) => {
        const at = run.finished_at || run.started_at;
        const runDateLabel = at ? new Date(at).toLocaleString() : "unknown date";
        return {
          id: run.id,
          label: `${run.id.slice(0, 8)} · ${runDateLabel}`,
        };
      }),
    [historyRuns],
  );

  const parsedRunStepsById = useMemo(() => {
    const out = new Map<string, PipelineRunStep[]>();
    for (const run of historyRuns) {
      try {
        const parsed = JSON.parse(run.steps_json || "[]");
        out.set(run.id, Array.isArray(parsed) ? (parsed as PipelineRunStep[]) : []);
      } catch {
        out.set(run.id, []);
      }
    }
    return out;
  }, [historyRuns]);

  const selectedCacheRun = useMemo(() => {
    if (runContextMode !== "historical") return null;
    const rid = String(selectedCacheRunId || "").trim();
    if (!rid) return null;
    if (selectedRunByIdData && String(selectedRunByIdData.id || "").trim() === rid) return selectedRunByIdData;
    return historyRuns.find((r) => String(r.id || "").trim() === rid) ?? null;
  }, [historyRuns, selectedCacheRunId, runContextMode, selectedRunByIdData]);

  useEffect(() => {
    persistRunLogLines(runLogContextKey, currentRunId, runLogLines);
  }, [runLogContextKey, currentRunId, runLogLines]);

  useEffect(() => {
    if (running) return;
    const activeRunId = String(
      runContextMode === "historical"
        ? (selectedCacheRun?.id || selectedCacheRunId || currentRunId || "")
        : (currentRunId || ""),
    ).trim();
    if (!activeRunId) {
      if (runContextMode === "new") {
        const restored = restoreRunLogLines(runLogContextKey, "");
        setRunLogLines(restored.length ? restored : []);
      }
      return;
    }
    const runRows = Array.isArray(runsData) ? runsData : [];
    const runRow = (
      selectedRunByIdData && String(selectedRunByIdData.id || "").trim() === activeRunId
        ? selectedRunByIdData
        : null
    ) ?? runRows.find((r) => String(r.id || "").trim() === activeRunId)
      ?? historyRuns.find((r) => String(r.id || "").trim() === activeRunId);
    if (runRow) {
      const parsed = parseSavedRunLogLines(runRow.log_json);
      if (parsed.length) {
        setRunLogLines(parsed);
        return;
      }
    }
    const restored = restoreRunLogLines(runLogContextKey, activeRunId);
    if (restored.length) {
      setRunLogLines(restored);
      return;
    }
    if (runContextMode === "new") {
      setRunLogLines([]);
    }
  }, [
    running,
    runContextMode,
    selectedCacheRun?.id,
    selectedCacheRunId,
    currentRunId,
    historyRuns,
    runsData,
    selectedRunByIdData,
    runLogContextKey,
  ]);

  useEffect(() => {
    if (runContextMode !== "historical") return;
    if (!historyRuns.length) return;
    if (selectedCacheRunId) return;
    setSelectedCacheRunId(historyRuns[0].id);
  }, [selectedCacheRunId, historyRuns, runContextMode]);

  useEffect(() => {
    if (runContextMode !== "new") return;
    const ctx = String(runLogContextKey || "").trim();
    if (!ctx) return;
    const rid = String(currentRunId || "").trim();
    const store = readActiveRunByContext();
    if (!rid) return;
    if (store[ctx] === rid) return;
    store[ctx] = rid;
    writeActiveRunByContext(store);
  }, [runContextMode, runLogContextKey, currentRunId]);

  useEffect(() => {
    if (runContextMode !== "new") return;
    if (running) return;
    if (currentRunId) return;
    const ctx = String(runLogContextKey || "").trim();
    if (!ctx) return;
    const store = readActiveRunByContext();
    const restored = String(store[ctx] || "").trim();
    if (!restored) return;
    const row = (historyRuns.find((r) => String(r.id || "").trim() === restored)
      ?? (Array.isArray(runsData) ? runsData : []).find((r) => String(r.id || "").trim() === restored));
    if (!row) return;
    const st = String(row.status || "").toLowerCase().trim();
    const active =
      st === "running"
      || st === "started"
      || st === "preparing"
      || st === "queued"
      || st === "retrying";
    if (!active) return;
    setCurrentRunId(restored);
  }, [runContextMode, running, currentRunId, runLogContextKey, historyRuns, runsData]);

  const formatRunAbsoluteTime = useCallback((iso: string | null | undefined): string => {
    const raw = String(iso || "").trim();
    if (!raw) return "—";
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return raw;
    return new Date(ts).toLocaleString();
  }, []);

  const runTimelineById = useMemo(() => {
    type StepTimelineRow = {
      stepIndex: number;
      stageIndex: number | null;
      elementName: string;
      status: "finished" | "cached" | "running" | "failed" | "cancelled" | "not_run";
      statusLabel: string;
      statusClass: string;
      model: string;
      startTime: string | null;
      endTime: string | null;
      durationSeconds: number | null;
      durationLabel: string;
      inputSources: string[];
      outputs: string[];
      errorMsg: string;
    };
    type RunTimeline = {
      runStartedLabel: string;
      runFinishedLabel: string;
      runDurationLabel: string;
      rows: StepTimelineRow[];
    };

    const parseIsoMs = (iso: string | null | undefined): number | null => {
      const raw = String(iso || "").trim();
      if (!raw) return null;
      const ts = Date.parse(raw);
      return Number.isFinite(ts) ? ts : null;
    };

    const out = new Map<string, RunTimeline>();
    for (const run of historyRuns) {
      const steps = parsedRunStepsById.get(run.id) ?? [];
      const runState = normalizeStateToken(run.status);
      const runFinishedAtMs = parseIsoMs(run.finished_at);
      const runIsActive = isActiveRunLike(runState) && runFinishedAtMs == null;
      const runIsCancelled = isCancelledLike(runState);
      const runIsFailed = isFailedLike(runState);
      const runIsCompleted = isCompletedLike(runState);
      const runIsPreflight =
        runState === "preparing"
        || runState === "queued"
        || runState === "retrying";
      let procNodesOrdered: Array<{ id: string; label: string; stageIndex: number | null }> = [];
      let outputsByProcId: Record<string, string[]> = {};

      try {
        const canvasRaw = JSON.parse(String(run.canvas_json || "{}"));
        const canvasNodes = Array.isArray(canvasRaw?.nodes) ? canvasRaw.nodes : [];
        const canvasEdges = Array.isArray(canvasRaw?.edges) ? canvasRaw.edges : [];
        const processingAll = canvasNodes
          .filter((n: any) => n && n.type === "processing")
          .sort((a: any, b: any) => {
            const sa = Number((a?.data?.stageIndex ?? 0));
            const sb = Number((b?.data?.stageIndex ?? 0));
            if (sa !== sb) return sa - sb;
            const xa = Number((a?.position?.x ?? 0));
            const xb = Number((b?.position?.x ?? 0));
            return xa - xb;
          });
        const processingWithAgent = processingAll.filter((n: any) => String(n?.data?.agentId || "").trim());
        const processing = processingWithAgent.length >= steps.length ? processingWithAgent : processingAll;

        procNodesOrdered = processing.map((n: any) => ({
          id: String(n?.id || ""),
          label: String(n?.data?.label || n?.data?.agentName || "Processing"),
          stageIndex: Number.isFinite(Number(n?.data?.stageIndex)) ? Number(n?.data?.stageIndex) : null,
        }));

        const outputNodeLabelById: Record<string, string> = {};
        canvasNodes
          .filter((n: any) => n && n.type === "output")
          .forEach((n: any) => {
            const id = String(n?.id || "");
            if (!id) return;
            const lbl = String(n?.data?.label || "").trim();
            const sub = String(n?.data?.subType || "").trim();
            outputNodeLabelById[id] = lbl || sub || "Artifact";
          });

        const procSet = new Set(procNodesOrdered.map((p) => p.id));
        outputsByProcId = {};
        canvasEdges.forEach((e: any) => {
          const src = String(e?.source || "");
          const tgt = String(e?.target || "");
          if (!src || !tgt || !procSet.has(src)) return;
          const outLabel = outputNodeLabelById[tgt];
          if (!outLabel) return;
          (outputsByProcId[src] ??= []).push(outLabel);
        });
      } catch {
        procNodesOrdered = [];
        outputsByProcId = {};
      }

      const rows: StepTimelineRow[] = [];
      const total = Math.max(steps.length, procNodesOrdered.length);
      for (let i = 0; i < total; i += 1) {
        const step = (steps[i] || {}) as PipelineRunStep;
        const proc = procNodesOrdered[i];
        const rawState = normalizeStateToken(step.state || step.status);
        const hasCache = Array.isArray(step.cached_locations) && step.cached_locations.length > 0;
        const isFailed = isFailedLike(rawState);
        const isCancelled = isCancelledLike(rawState);
        const isRunning = isRunningLike(rawState);
        const isCompleted = isCompletedLike(rawState);

        let status: StepTimelineRow["status"] = "not_run";
        if (isFailed) status = "failed";
        else if (isCancelled) status = "cancelled";
        else if (isRunning) status = "running";
        else if (hasCache || rawState.includes("cache")) status = "cached";
        else if (isCompleted) status = "finished";
        else status = "not_run";

        // If the overall run was cancelled, stale in-flight step states should
        // no longer be presented as running in history/timeline.
        if (status === "running") {
          if (runIsPreflight) status = "not_run";
          else if (runIsCancelled) status = "cancelled";
          else if (runIsFailed) status = "failed";
          else if (runIsCompleted) status = hasCache ? "cached" : "finished";
          else if (!runIsActive) status = "cancelled";
        }

        const statusMeta = {
          finished: {
            label: "finished",
            className: "text-emerald-300 border-emerald-700/50 bg-emerald-950/40",
          },
          cached: {
            label: "cached",
            className: "text-amber-300 border-amber-700/50 bg-amber-950/40",
          },
          running: {
            label: "running",
            className: "text-orange-300 border-orange-700/50 bg-orange-950/40",
          },
          failed: {
            label: "failed",
            className: "text-red-300 border-red-700/50 bg-red-950/40",
          },
          cancelled: {
            label: "cancelled",
            className: "text-slate-200 border-slate-700/50 bg-slate-900/50",
          },
          not_run: {
            label: "not run",
            className: "text-gray-300 border-gray-700 bg-gray-900",
          },
        }[status];

        const startIso = String(step.start_time || "").trim() || null;
        const endIso = String(step.end_time || "").trim() || null;
        let durationSeconds: number | null = null;
        if (typeof step.execution_time_s === "number" && Number.isFinite(step.execution_time_s)) {
          durationSeconds = Math.max(0, Number(step.execution_time_s));
        } else {
          const startMs = parseIsoMs(startIso);
          const endMs = parseIsoMs(endIso);
          if (startMs != null && endMs != null && endMs >= startMs) {
            durationSeconds = Math.max(0, (endMs - startMs) / 1000);
          }
        }

        const inputs = (Array.isArray(step.input_sources) ? step.input_sources : [])
          .map((src) => String(src?.source || src?.key || "").trim())
          .filter(Boolean);
        const outputs = proc?.id ? (outputsByProcId[proc.id] || []) : [];

        rows.push({
          stepIndex: i,
          stageIndex: proc?.stageIndex ?? null,
          elementName: String(proc?.label || step.agent_name || step.agent_id || `Step ${i + 1}`),
          status,
          statusLabel: statusMeta.label,
          statusClass: statusMeta.className,
          model: String(step.model || ""),
          startTime: startIso,
          endTime: endIso,
          durationSeconds,
          durationLabel: durationSeconds != null ? formatDurationLabel(durationSeconds) : "—",
          inputSources: inputs,
          outputs,
          errorMsg: String(step.error_msg || ""),
        });
      }

      const runStartMs = parseIsoMs(run.started_at);
      const runEndMs = parseIsoMs(run.finished_at);
      const runDurationLabel =
        runStartMs != null && runEndMs != null && runEndMs >= runStartMs
          ? formatDurationLabel((runEndMs - runStartMs) / 1000)
          : "—";

      out.set(run.id, {
        runStartedLabel: formatRunAbsoluteTime(run.started_at),
        runFinishedLabel: formatRunAbsoluteTime(run.finished_at),
        runDurationLabel,
        rows,
      });
    }
    return out;
  }, [historyRuns, parsedRunStepsById, formatDurationLabel, formatRunAbsoluteTime]);

  const selectedCacheRunFailedStepIndices = useMemo(() => {
    if (!selectedCacheRun) return [] as number[];
    const steps = parsedRunStepsById.get(selectedCacheRun.id) ?? [];
    const out: number[] = [];
    steps.forEach((s, idx) => {
      const raw = String(s?.state || s?.status || "").toLowerCase().trim();
      if (["failed", "error", "fail"].includes(raw)) out.push(idx);
    });
    return out;
  }, [selectedCacheRun, parsedRunStepsById]);

  const cacheUrl = useMemo(() => {
    if (runContextMode !== "historical") return null;
    if (!pipelineId || !salesAgent || !customer) return null;
    const runCallId = runNeedsCall ? callId : "";
    if (runNeedsCall && !runCallId) return null;
    return `/api/pipelines/${pipelineId}/results?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(runCallId)}`;
  }, [runContextMode, pipelineId, salesAgent, customer, runNeedsCall, callId]);
  const { mutate: mutateCache } = useSWR<CachedStepResult[]>(cacheUrl, fetcher);

  const getStepCacheDisplay = useCallback(
    (stepIndex: number): StepCacheDisplay | null => {
      if (stepIndex < 0) return null;
      const buildFromRun = (
        runId: string,
        source: StepCacheDisplay["source"],
        createdAt?: string | null,
      ): StepCacheDisplay | null => {
        const runSteps = parsedRunStepsById.get(runId) ?? [];
        const s = runSteps[stepIndex];
        if (!s) return null;
        return {
          source,
          runId,
          createdAt,
          agentName: String(allAgents.find(a => a.id === s.agent_id)?.name || s.agent_name || ""),
          model: String(s.model || ""),
          status: String(s.state || s.status || ""),
          errorMsg: String(s.error_msg || ""),
          inputTokenEst: Number.isFinite(Number(s.input_token_est)) ? Number(s.input_token_est) : 0,
          outputTokenEst: Number.isFinite(Number(s.output_token_est)) ? Number(s.output_token_est) : 0,
          thinking: String(s.thinking || ""),
          modelInfo: (s.model_info && typeof s.model_info === "object")
            ? (s.model_info as Record<string, any>)
            : {},
          requestRaw: (s.request_raw && typeof s.request_raw === "object")
            ? (s.request_raw as Record<string, any>)
            : {},
          responseRaw: String(s.response_raw || ""),
          content: String(s.content || ""),
          noteId: String((s as PipelineRunStep).note_id || ""),
          noteCallId: String((s as PipelineRunStep).note_call_id || ""),
        };
      };

      if (runContextMode === "historical") {
        if (!selectedCacheRun) return null;
        return buildFromRun(
          selectedCacheRun.id,
          "selected_run",
          selectedCacheRun.finished_at || selectedCacheRun.started_at,
        );
      }

      const rid = String(currentRunId || "").trim();
      if (!rid) return null;
      const runMeta = historyRuns.find((r) => String(r.id) === rid);
      return buildFromRun(
        rid,
        "current_run",
        runMeta?.finished_at || runMeta?.started_at || null,
      );
    },
    [runContextMode, selectedCacheRun, parsedRunStepsById, currentRunId, historyRuns],
  );

  // Refs for fresh state in callbacks (avoid stale closures)
  const nodesRef  = useRef<Node[]>([]);
  const edgesRef  = useRef<Edge[]>([]);
  const stagesRef = useRef<NodeKind[]>([...INIT_STAGES]);
  nodesRef.current  = nodes;
  edgesRef.current  = edges;
  stagesRef.current = stages;

  const runtimeGraph = useMemo<RuntimeGraph>(() => {
    const processingOrdered = [...nodes]
      .filter(n => n.type === "processing" && String((n.data as PipelineNodeData).agentId || "").trim())
      .sort((a, b) => {
        const da = a.data as PipelineNodeData;
        const db = b.data as PipelineNodeData;
        return da.stageIndex !== db.stageIndex ? da.stageIndex - db.stageIndex : a.position.x - b.position.x;
      });
    const stepToProcNodeIds = processingOrdered.map(n => n.id);
    const procNodeIdToStepIndex = new Map(stepToProcNodeIds.map((id, idx) => [id, idx]));
    const procToOutputNodeIds: Record<string, string[]> = {};
    const inputToProcNodeIds: Record<string, string[]> = {};
    const outputToProcNodeIds: Record<string, string[]> = {};
    const outputProducerProcId: Record<string, string> = {};
    const stepParentSet: Record<number, Set<number>> = {};
    const getOrCreateStepParentSet = (idx: number): Set<number> => {
      if (!stepParentSet[idx]) stepParentSet[idx] = new Set<number>();
      return stepParentSet[idx];
    };

    for (const e of edges) {
      const src = nodes.find(n => n.id === e.source);
      const tgt = nodes.find(n => n.id === e.target);
      if (!src || !tgt) continue;
      if (src.type === "processing" && tgt.type === "output") {
        (procToOutputNodeIds[src.id] ??= []).push(tgt.id);
      }
      if (src.type === "input" && tgt.type === "processing") {
        (inputToProcNodeIds[src.id] ??= []).push(tgt.id);
      }
      if (src.type === "output" && tgt.type === "processing") {
        (outputToProcNodeIds[src.id] ??= []).push(tgt.id);
      }
      if (src.type === "processing" && tgt.type === "processing") {
        const srcIdx = procNodeIdToStepIndex.get(src.id);
        const tgtIdx = procNodeIdToStepIndex.get(tgt.id);
        if (srcIdx != null && tgtIdx != null && srcIdx !== tgtIdx) {
          getOrCreateStepParentSet(tgtIdx).add(srcIdx);
        }
      }
    }

    // processing -> output producer map
    Object.entries(procToOutputNodeIds).forEach(([procId, outIds]) => {
      outIds.forEach((oid) => {
        if (oid) outputProducerProcId[oid] = procId;
      });
    });

    // output -> processing implies dependency: producer(processing) -> downstream(processing)
    Object.entries(outputToProcNodeIds).forEach(([outputId, targetProcIds]) => {
      const producerProcId = outputProducerProcId[outputId];
      if (!producerProcId) return;
      const producerIdx = procNodeIdToStepIndex.get(producerProcId);
      if (producerIdx == null) return;
      targetProcIds.forEach((targetProcId) => {
        const targetIdx = procNodeIdToStepIndex.get(targetProcId);
        if (targetIdx == null || targetIdx === producerIdx) return;
        getOrCreateStepParentSet(targetIdx).add(producerIdx);
      });
    });

    const stepParents: Record<number, number[]> = {};
    for (let i = 0; i < stepToProcNodeIds.length; i += 1) {
      stepParents[i] = Array.from(stepParentSet[i] || []).sort((a, b) => a - b);
    }
    return { stepToProcNodeIds, procToOutputNodeIds, inputToProcNodeIds, stepParents };
  }, [nodes, edges]);

  const applyRuntimeStatusMap = useCallback((statuses: RuntimeStatus[], inputReadyByStep: boolean[] = []) => {
    const sourceRunId =
      runContextMode === "historical"
        ? String(selectedCacheRun?.id || "").trim()
        : String(currentRunId || "").trim();
    const sourceRunRecord = runContextMode === "historical"
      ? selectedCacheRun
      : historyRuns.find((r) => String(r.id || "").trim() === sourceRunId);
    const sourceRunStatus = normalizeStateToken(sourceRunRecord?.status || "");
    const sourceRunIsPreflight =
      sourceRunStatus === "preparing"
      || sourceRunStatus === "queued"
      || sourceRunStatus === "retrying";

    const runtimeByNodeId: Record<string, RuntimeStatus> = {};

    runtimeGraph.stepToProcNodeIds.forEach((procId, idx) => {
      const st = statuses[idx] ?? "pending";
      runtimeByNodeId[procId] = st;
      const outputIds = runtimeGraph.procToOutputNodeIds[procId] ?? [];
      for (const oid of outputIds) {
        runtimeByNodeId[oid] = st === "loading" ? "pending" : st;
      }
    });

    Object.entries(runtimeGraph.inputToProcNodeIds).forEach(([inputId, procIds]) => {
      const connected = procIds.map((pid) => {
        const idx = runtimeGraph.stepToProcNodeIds.indexOf(pid);
        return {
          status: runtimeByNodeId[pid] ?? "pending",
          inputReady: idx >= 0 ? !!inputReadyByStep[idx] : false,
        };
      });
      const hasInputReady = connected.some((s) => s.inputReady);
      if (connected.some((s) => s.status === "error")) runtimeByNodeId[inputId] = "error";
      else if (connected.some((s) => s.status === "cancelled")) runtimeByNodeId[inputId] = "cancelled";
      else if (connected.some((s) => s.status === "done")) runtimeByNodeId[inputId] = "done";
      else if (connected.some((s) => s.status === "cached")) runtimeByNodeId[inputId] = "cached";
      else if (connected.some((s) => s.status === "loading" && s.inputReady)) runtimeByNodeId[inputId] = "done";
      else if (hasInputReady) runtimeByNodeId[inputId] = runContextMode === "historical" ? "cached" : "done";
      else if (sourceRunIsPreflight) runtimeByNodeId[inputId] = "loading";
      else if (connected.some((s) => s.status === "loading")) runtimeByNodeId[inputId] = "loading";
      else runtimeByNodeId[inputId] = "pending";
    });

    setNodes(ns => {
      const nowMs = Date.now();
      let changed = false;
      const next = ns.map(n => {
        const d = n.data as PipelineNodeData;
        const nextStatus = runtimeByNodeId[n.id] ?? "pending";
        const prevStatus = (d.runtimeStatus as RuntimeStatus | undefined) ?? "pending";
        const prevStartedAtMs = Number(d.runtimeStartedAtMs || 0) || undefined;

        if (prevStatus === nextStatus) {
          if (nextStatus === "loading" && !prevStartedAtMs) {
            changed = true;
            return {
              ...n,
              data: { ...d, runtimeStartedAtMs: nowMs } satisfies PipelineNodeData,
            };
          }
          if (nextStatus !== "loading" && prevStartedAtMs) {
            changed = true;
            const nextData = { ...d } as PipelineNodeData;
            delete nextData.runtimeStartedAtMs;
            return { ...n, data: nextData };
          }
          return n;
        }

        changed = true;
        const nextData = {
          ...d,
          runtimeStatus: nextStatus,
          runtimeStartedAtMs:
            nextStatus === "loading"
              ? (prevStatus === "loading" && prevStartedAtMs ? prevStartedAtMs : nowMs)
              : undefined,
        } satisfies PipelineNodeData;
        if (nextStatus !== "loading") delete nextData.runtimeStartedAtMs;
        return { ...n, data: nextData };
      });
      return changed ? next : ns;
    });
  }, [runtimeGraph, runContextMode, selectedCacheRun, currentRunId, historyRuns, setNodes]);

  useEffect(() => {
    if (running) return;
    const stepCount = runtimeGraph.stepToProcNodeIds.length;
    if (stepCount <= 0) {
      setStepStatuses([]);
      setStepInputReady([]);
      applyRuntimeStatusMap([], []);
      return;
    }
    const next = Array.from({ length: stepCount }, () => "pending" as RuntimeStatus);
    const nextInputReady = Array.from({ length: stepCount }, () => false);
    const sourceRunId =
      runContextMode === "historical"
        ? String(selectedCacheRun?.id || "").trim()
        : String(currentRunId || "").trim();
    const sourceRunRecord = runContextMode === "historical"
      ? selectedCacheRun
      : historyRuns.find((r) => String(r.id || "").trim() === sourceRunId);
    const sourceRunStatus = normalizeStateToken(sourceRunRecord?.status || "");
    const sourceRunFinishedAtMs = (() => {
      const raw = String(sourceRunRecord?.finished_at || "").trim();
      if (!raw) return null;
      const ts = Date.parse(raw);
      return Number.isFinite(ts) ? ts : null;
    })();
    const sourceRunIsActive = isActiveRunLike(sourceRunStatus) && sourceRunFinishedAtMs == null;
    const sourceRunIsCancelled = isCancelledLike(sourceRunStatus);
    const sourceRunIsFailed = isFailedLike(sourceRunStatus);
    const sourceRunIsCompleted = isCompletedLike(sourceRunStatus);
    const sourceRunIsPreflight =
      sourceRunStatus === "preparing"
      || sourceRunStatus === "queued"
      || sourceRunStatus === "retrying";
    if (sourceRunId && !parsedRunStepsById.has(sourceRunId)) {
      // Do not keep stale in-memory statuses (can incorrectly show "running" forever).
      // Reset from current run terminal state while waiting for step payload to load.
      if (sourceRunIsCancelled) {
        next.fill("cancelled");
      } else if (sourceRunIsFailed) {
        next.fill("error");
      } else if (sourceRunIsCompleted) {
        next.fill("done");
      }
      setStepStatuses(next);
      setStepInputReady(nextInputReady);
      applyRuntimeStatusMap(next, nextInputReady);
      return;
    }
    if (sourceRunId) {
      const runSteps = parsedRunStepsById.get(sourceRunId) ?? [];
      runSteps.forEach((row, idx) => {
        if (idx >= next.length || !row) return;
        const rawState = normalizeStateToken(row.state || row.status);
        if (!rawState) return;
        const hasCachedLocations = Array.isArray((row as any).cached_locations)
          ? ((row as any).cached_locations as any[]).length > 0
          : !!(row as any).cached_locations;
        if (rawState === "cached" || rawState === "cache_hit" || (isCompletedLike(rawState) && hasCachedLocations)) {
          next[idx] = "cached";
        } else if (isCompletedLike(rawState)) {
          next[idx] = "done";
        }
        else if (isRunningLike(rawState)) {
          if (sourceRunIsPreflight) next[idx] = "pending";
          else if (sourceRunIsCancelled) next[idx] = "cancelled";
          else if (sourceRunIsFailed) next[idx] = "error";
          else if (sourceRunIsCompleted) next[idx] = hasCachedLocations ? "cached" : "done";
          else if (!sourceRunIsActive) next[idx] = "cancelled";
          else next[idx] = "loading";
        }
        else if (isCancelledLike(rawState)) next[idx] = "cancelled";
        else if (isFailedLike(rawState)) next[idx] = "error";
        nextInputReady[idx] = !!row.input_ready || next[idx] === "done" || next[idx] === "cached";
      });
    }
    setStepStatuses(next);
    setStepInputReady(nextInputReady);
    applyRuntimeStatusMap(next, nextInputReady);
  }, [
    runtimeGraph.stepToProcNodeIds,
    running,
    applyRuntimeStatusMap,
    runContextMode,
    selectedCacheRun,
    currentRunId,
    parsedRunStepsById,
  ]);

  useEffect(() => {
    applyRuntimeStatusMap(stepStatuses, stepInputReady);
  }, [stepStatuses, stepInputReady, applyRuntimeStatusMap]);

  // Keep processing node agent metadata in sync with agent library edits from other pages.
  useEffect(() => {
    if (!allAgents.length) return;
    setNodes(ns => {
      let changed = false;
      const next = ns.map(n => {
        if (n.type !== "processing") return n;
        const d = n.data as PipelineNodeData;
        const aid = String(d.agentId || "").trim();
        if (!aid) return n;
        const ag = allAgents.find(a => a.id === aid);
        if (!ag) return n;
        const prevAgentName = String(d.agentName || "");
        const prevLabel = String(d.label || "");
        const shouldSyncName  = !prevAgentName || prevAgentName === ag.name || prevAgentName === aid;
        const shouldSyncLabel = !prevLabel     || prevLabel     === ag.name || prevLabel     === aid;
        const nextAgentName = shouldSyncName  ? ag.name : prevAgentName;
        const nextLabel     = shouldSyncLabel ? ag.name : prevLabel;
        if (prevAgentName === nextAgentName && String(d.agentClass || "") === String(ag.agent_class || "") && prevLabel === nextLabel) {
          return n;
        }
        changed = true;
        return {
          ...n,
          data: {
            ...d,
            agentName: nextAgentName,
            agentClass: ag.agent_class ?? "",
            label: nextLabel,
          } satisfies PipelineNodeData,
        };
      });
      return changed ? next : ns;
    });
  }, [allAgents, setNodes]);

  // Reactive fit: auto-zoom so all lanes fill the canvas height
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;
    const update = () => {
      const { height, width } = el.getBoundingClientRect();
      if (!height || !width) return;
      const totalH = Y_INIT + stagesRef.current.length * SLEEVE_H + 20;
      const zoom   = height / totalH;
      const x      = width / 2 - LANE_CENTER_X * zoom;
      const y      = 8 - Y_INIT * zoom;
      setCanvasViewport({ x, y, zoom });
      setViewport({ x, y, zoom }, { duration: 200 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stages.length, setViewport]);

  const exitHistoricalRunContext = useCallback((clearLogs = true) => {
    if (runContextMode !== "historical") return;
    setRunContextMode("new");
    setSelectedCacheRunId("");
    setCurrentRunId("");
    setCanvasLocked(false);
    if (clearLogs) setRunLogLines([]);
  }, [runContextMode]);

  const toggleRunContextFromHistory = useCallback((run: PipelineRunRecord) => {
    const rid = String(run.id || "").trim();
    if (!rid) return;
    const isSame = runContextMode === "historical" && String(selectedCacheRunId || "") === rid;
    if (isSame) {
      exitHistoricalRunContext(true);
      return;
    }
    const runPipelineId = String(run.pipeline_id || "").trim();
    const runPipelineName = String(run.pipeline_name || "").trim();
    const runAgent = String(run.sales_agent || "").trim();
    const runCustomer = String(run.customer || "").trim();
    const runCallId = inferRunCallIdFromRecord(run);

    setCanvasLocked(false);
    setRunContextMode("historical");
    setSelectedCacheRunId(rid);
    setCurrentRunId(rid);
    if (runAgent && runCustomer && (runAgent !== salesAgent || runCustomer !== customer)) {
      setCustomer(runCustomer, runAgent);
    }
    if (runCallId) {
      setPendingRunCallId(runCallId);
      setCallId(runCallId);
    }
    // If the run belongs to a different pipeline than what's currently loaded (or nothing
    // is loaded), kick off the full pipeline-load flow so the canvas graph appears.
    if (runPipelineId !== pipelineId || (!pipelineId && runPipelineName)) {
      setPendingOpenRunPayload({
        source: "history_sidebar",
        run_id: rid,
        pipeline_id: runPipelineId,
        pipeline_name: runPipelineName,
        sales_agent: runAgent,
        customer: runCustomer,
        call_id: runCallId,
      });
    }
  }, [
    runContextMode,
    selectedCacheRunId,
    exitHistoricalRunContext,
    setCallId,
    setPendingRunCallId,
    salesAgent,
    customer,
    setCustomer,
    pipelineId,
    setPendingOpenRunPayload,
  ]);

  const markElementMutation = useCallback(() => {
    if (runContextMode === "historical") exitHistoricalRunContext(false);
  }, [runContextMode, exitHistoricalRunContext]);

  // Render only actual flow nodes; swimbars are drawn as a non-interactive backdrop.
  const allNodes = useMemo(() => {
    const procStepIndexByNodeId: Record<string, number> = {};
    runtimeGraph.stepToProcNodeIds.forEach((nodeId, idx) => {
      procStepIndexByNodeId[nodeId] = idx;
    });
    const inputStepIndicesByNodeId: Record<string, number[]> = {};
    const outputStepIndexByNodeId: Record<string, number> = {};
    const incomingByNode: Record<string, string[]> = {};
    edges.forEach((e) => {
      (incomingByNode[String(e.target)] ??= []).push(String(e.source));
    });
    for (const n of nodes) {
      if (n.type === "output") {
        const incoming = incomingByNode[n.id] || [];
        const srcProc = incoming.find((sid) => procStepIndexByNodeId[sid] != null);
        if (srcProc != null) outputStepIndexByNodeId[n.id] = procStepIndexByNodeId[srcProc];
      }
    }
    Object.entries(runtimeGraph.inputToProcNodeIds).forEach(([inputNodeId, procNodeIds]) => {
      const idxs = procNodeIds
        .map((pid) => procStepIndexByNodeId[pid])
        .filter((idx): idx is number => Number.isFinite(idx))
        .sort((a, b) => a - b);
      if (idxs.length) inputStepIndicesByNodeId[inputNodeId] = idxs;
    });

    const runButtonDisabled = canvasLocked || running || !pipelineId || !salesAgent || !customer || (runNeedsCall && !callId);
    return nodes.map((n) => {
      const base = n.data as PipelineNodeData;
      let runStepIndex: number | null = null;
      if (n.type === "processing") {
        runStepIndex = procStepIndexByNodeId[n.id] ?? null;
      } else if (n.type === "output") {
        runStepIndex = outputStepIndexByNodeId[n.id] ?? null;
      } else if (n.type === "input") {
        const idxs = inputStepIndicesByNodeId[n.id] || [];
        runStepIndex = idxs.length ? idxs[0] : null;
      }
      const inputRunIndices = n.type === "input" ? (inputStepIndicesByNodeId[n.id] || []) : [];
      const inputSource = n.type === "input"
        ? String((n.data as PipelineNodeData).inputSource || "").trim()
        : "";
      const onRunStepHandler =
        canvasLocked
          ? undefined
          : n.type === "input"
            ? (inputRunIndices.length ? () => runInputNodeStep(inputRunIndices, inputSource) : undefined)
            : (runStepIndex != null ? () => runNodeStep(runStepIndex) : undefined);
      return {
        ...n,
        data: {
          ...base,
          runStepIndex,
          runButtonDisabled,
          onRunStep: onRunStepHandler,
          onMutate: canvasLocked ? undefined : markElementMutation,
        } satisfies PipelineNodeData,
      };
    });
  }, [
    nodes,
    edges,
    runtimeGraph.stepToProcNodeIds,
    running,
    canvasLocked,
    pipelineId,
    salesAgent,
    customer,
    runNeedsCall,
    callId,
    runtimeGraph.inputToProcNodeIds,
    markElementMutation,
  ]);

  // Prevent removal of sleeves; lock INPUT nodes to their Y axis during drag
  const onNodesChangeFiltered = useCallback((changes: NodeChange[]) => {
    if (canvasLocked) return;
    const shouldMarkDirty = changes.some((c) =>
      c.type === "position" || c.type === "remove" || c.type === "add" || c.type === "replace"
    );
    if (shouldMarkDirty) markElementMutation();
    const processed = changes.map(c => {
      if (c.type === "position" && c.position) {
        const node = nodesRef.current.find(n => n.id === c.id);
        if (node && node.type === "input") {
          const snapY = laneY(0) + SLEEVE_INNER;
          return {
            ...c,
            position:         { x: c.position.x, y: snapY },
            positionAbsolute: c.positionAbsolute
              ? { x: c.positionAbsolute.x, y: snapY }
              : undefined,
          };
        }
      }
      return c;
    });
    onNodesChange(processed as NodeChange[]);
  }, [onNodesChange, canvasLocked, markElementMutation]);

  const pushCanvasHistory = useCallback((ns: Node[], es: Edge[]) => {
    canvasHistoryRef.current = [...canvasHistoryRef.current.slice(-29), { nodes: ns, edges: es }];
    canvasRedoRef.current = [];
    setCanvasUndoLen(canvasHistoryRef.current.length);
    setCanvasRedoLen(0);
  }, []);

  const handleUndo = useCallback(() => {
    const prev = canvasHistoryRef.current.pop();
    if (!prev) return;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    canvasRedoRef.current = [...canvasRedoRef.current, prev];
    setCanvasUndoLen(canvasHistoryRef.current.length);
    setCanvasRedoLen(canvasRedoRef.current.length);
    markElementMutation();
  }, [setNodes, setEdges, markElementMutation]);

  const handleRedo = useCallback(() => {
    const next = canvasRedoRef.current.pop();
    if (!next) return;
    canvasHistoryRef.current = [...canvasHistoryRef.current, next];
    setNodes(next.nodes);
    setEdges(next.edges);
    setCanvasUndoLen(canvasHistoryRef.current.length);
    setCanvasRedoLen(canvasRedoRef.current.length);
    markElementMutation();
  }, [setNodes, setEdges, markElementMutation]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); handleUndo(); }
      if ((e.key === "y") || (e.key === "z" && e.shiftKey)) { e.preventDefault(); handleRedo(); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo]);

  // Snap processing/output nodes to the nearest same-type lane on drag end
  const onNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    if (canvasLocked) return;
    pushCanvasHistory(nodes, edges);
    markElementMutation();
    const kind = node.type as NodeKind;
    if (kind === "input") {
      // Y is locked during drag; just snap X to nearest slot
      const snapX = snapXToSlot(node.position.x);
      if (snapX !== node.position.x) {
        setNodes(ns => ns.map(n => n.id === node.id ? { ...n, position: { x: snapX, y: n.position.y } } : n));
      }
      return;
    }

    const currentStages = stagesRef.current;
    const matchingLanes = currentStages
      .map((s, i) => ({ kind: s, index: i }))
      .filter(s => s.kind === kind);
    if (matchingLanes.length === 0) return;

    const closest = matchingLanes.reduce<{ index: number; dist: number }>(
      (best, lane) => {
        const dist = Math.abs(node.position.y - (laneY(lane.index) + SLEEVE_INNER));
        return dist < best.dist ? { index: lane.index, dist } : best;
      },
      { index: matchingLanes[0].index, dist: Infinity },
    );

    const newStageIndex = closest.index;
    const snapY         = laneY(newStageIndex) + SLEEVE_INNER;
    const snapX         = snapXToSlot(node.position.x);
    setNodes(ns => ns.map(n =>
      n.id === node.id
        ? { ...n, position: { x: snapX, y: snapY }, data: { ...(n.data as PipelineNodeData), stageIndex: newStageIndex } }
        : n
    ));
  }, [setNodes, canvasLocked, markElementMutation]);

  // Validates connections drawn manually by the user
  const isValidConnectionFn = useCallback((conn: Connection | Edge): boolean => {
    const src = String(conn.source ?? "");
    const tgt = String(conn.target ?? "");
    if (edgesRef.current.some(e => e.source === src && e.target === tgt)) return false;
    const sn = nodesRef.current.find(n => n.id === src);
    const tn = nodesRef.current.find(n => n.id === tgt);
    if (!sn || !tn) return false;
    const sk = sn.type as NodeKind;
    const tk = tn.type as NodeKind;
    const sStage = (sn.data as PipelineNodeData).stageIndex;
    const tStage = (tn.data as PipelineNodeData).stageIndex;
    // Only top-to-bottom: target must be in a strictly lower lane
    if (tStage <= sStage) return false;
    if (tk === "input") return false;
    if (sk === "input" && tk === "output") return false;
    if (sk === "processing" && tk === "processing") return false;
    // Output may only receive from one processing node
    if (tk === "output" && edgesRef.current.some(e => e.target === tgt)) return false;
    return true;
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    if (canvasLocked) return;
    pushCanvasHistory(nodesRef.current, edgesRef.current);
    markElementMutation();
    // Compatibility check: output → processing edge
    const srcNode = nodesRef.current.find(n => n.id === conn.source);
    const tgtNode = nodesRef.current.find(n => n.id === conn.target);
    if (srcNode?.type === "output" && tgtNode?.type === "processing") {
      const subType = (srcNode.data as PipelineNodeData).subType;
      const artifactSrc = `artifact_${subType}`;
      const agentId = (tgtNode.data as PipelineNodeData).agentId;
      const agent = agentId ? allAgents.find(a => a.id === agentId) : null;
      if (agent) {
        const hasMatch = agent.inputs.some(
          inp => inp.source === artifactSrc || inp.source === "artifact_output" || inp.source === "chain_previous"
        );
        if (!hasMatch) {
          const artifactLabel = subType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          showToast(
            `⚠ "${agent.name}" has no ${artifactLabel} input. Open the agent and add an "${artifactSrc}" input so the connection is explicit.`,
            false,
          );
        }
      }
    }
    setEdges(es => addEdge({
      ...conn,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 18, height: 18 },
      style:     { stroke: "#818cf8", strokeWidth: 2 },
    }, es));
  }, [setEdges, allAgents, canvasLocked, markElementMutation]);

  function showToast(msg: string, ok = false) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3500);
  }

  const sendNoteToCrmFromCanvas = useCallback(async (noteId: string, runId?: string) => {
    if (!canRunPipelines) {
      showToast("You do not have permission to send notes to CRM.", false);
      return;
    }
    const nid = String(noteId || "").trim();
    if (!nid) {
      showToast("No saved note found for this step yet.", false);
      return;
    }
    setManualNoteSendPendingId(nid);
    setManualNoteSendMessage("");
    setManualNoteSendError(false);
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(nid)}/send-to-crm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: "", run_id: String(runId || "").trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = body?.detail;
        const fallback = String(body?.message || body?.error || `HTTP ${res.status}`);
        const msg = typeof detail === "string" ? detail : fallback;
        throw new Error(msg);
      }
      const statusRaw = Number(body?.crm_status);
      const statusText = Number.isFinite(statusRaw) ? `status ${statusRaw}` : "status unknown";
      const endpoint = String(body?.endpoint || "").trim();
      const historyRunIds = Array.isArray(body?.history_run_ids)
        ? body.history_run_ids.map((v: any) => String(v || "").trim()).filter(Boolean)
        : [];
      setManualNoteSendError(false);
      setManualNoteSendMessage(
        endpoint
          ? (
              historyRunIds.length
                ? `Sent manually (${statusText}) via ${endpoint}. Logged in history run ${historyRunIds[0].slice(0, 8)}.`
                : `Sent manually (${statusText}) via ${endpoint}.`
            )
          : (
              historyRunIds.length
                ? `Sent manually (${statusText}). Logged in history run ${historyRunIds[0].slice(0, 8)}.`
                : `Sent manually (${statusText}).`
            ),
      );
      showToast(`Note sent to CRM (${statusText})`, true);
      void Promise.allSettled([mutateRuns(), mutateLivePipelineState()]);
    } catch (e: any) {
      const msg = String(e?.message || "Manual CRM send failed.");
      setManualNoteSendError(true);
      setManualNoteSendMessage(msg);
      showToast(msg, false);
    } finally {
      setManualNoteSendPendingId("");
    }
  }, [canRunPipelines, mutateRuns, mutateLivePipelineState]);

  // ── Core: add node → determine stage → position → auto-connect ────────────

  const addNodeToCanvas = useCallback((
    kind:    NodeKind,
    subType: string,
    dropPos?: { x: number; y: number },
  ) => {
    if (canvasLocked) return;
    markElementMutation();
    const currentNodes  = nodesRef.current;
    const currentEdges  = edgesRef.current;
    const currentStages = stagesRef.current;

    const meta = getMeta(kind, subType);
    const id   = nextId();

    // ── Determine stageIndex: find the LAST lane of matching kind ─────────────
    let stageIndex: number;
    const newStages = [...currentStages];

    if (kind === "input") {
      stageIndex = 0; // inputs always in the top lane
    } else if (dropPos) {
      // Drag-drop should honor the user's intended lane when possible.
      const lanesOfKind = newStages
        .map((k, i) => ({ k, i }))
        .filter(x => x.k === kind)
        .map(x => x.i);
      const freeLanes = lanesOfKind.filter(i =>
        currentNodes.filter(n => (n.data as PipelineNodeData).stageIndex === i).length < MAX_PER_LANE
      );
      const candidateLanes = freeLanes.length > 0 ? freeLanes : lanesOfKind;

      if (candidateLanes.length > 0) {
        stageIndex = candidateLanes.reduce((best, laneIdx) => {
          const laneCenterY = laneY(laneIdx) + SLEEVE_INNER;
          const bestCenterY = laneY(best) + SLEEVE_INNER;
          return Math.abs(dropPos.y - laneCenterY) < Math.abs(dropPos.y - bestCenterY) ? laneIdx : best;
        }, candidateLanes[0]);
      } else {
        newStages.push(kind);
        stageIndex = newStages.length - 1;
      }
    } else {
      // Walk forward: first lane of this kind that still has free slots
      let firstIdx = -1;
      for (let i = 0; i < newStages.length; i++) {
        if (newStages[i] === kind) {
          const count = currentNodes.filter(n => (n.data as PipelineNodeData).stageIndex === i).length;
          if (count < MAX_PER_LANE) { firstIdx = i; break; }
        }
      }
      if (firstIdx !== -1) {
        stageIndex = firstIdx;
      } else {
        newStages.push(kind); // all matching lanes full — create new one
        stageIndex = newStages.length - 1;
      }
    }

    // ── Position: centered within lane, or snapped to nearest slot on drop ──
    const nodesInStage = currentNodes.filter(n => (n.data as PipelineNodeData).stageIndex === stageIndex);
    let position: { x: number; y: number };
    let repositionFn: ((ns: Node[]) => Node[]) | null = null;

    if (dropPos) {
      position = { x: snapXToSlot(dropPos.x), y: laneY(stageIndex) + SLEEVE_INNER };
    } else {
      const newCount   = Math.min(nodesInStage.length + 1, MAX_PER_LANE);
      const newXArr    = CENTERED_X[newCount - 1];
      // Reposition existing nodes sorted left-to-right into the new centered layout
      if (nodesInStage.length > 0 && nodesInStage.length < MAX_PER_LANE) {
        const sorted = [...nodesInStage].sort((a, b) => a.position.x - b.position.x);
        const idMap: Record<string, number> = {};
        sorted.forEach((n, i) => { idMap[n.id] = newXArr[i]; });
        repositionFn = (ns: Node[]) => ns.map(n =>
          idMap[n.id] !== undefined ? { ...n, position: { x: idMap[n.id], y: n.position.y } } : n
        );
      }
      position = { x: newXArr[Math.min(nodesInStage.length, MAX_PER_LANE - 1)], y: laneY(stageIndex) + SLEEVE_INNER };
    }

    const newNode: Node = {
      id,
      type:           kind,
      position,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      style: { background: "transparent", padding: 0, border: "none", boxShadow: "none" },
      data: {
        label:      `${meta.label} ${nodeSeq - 1}`,
        subType,
        prompt:     "",
        stageIndex,
        agentId:     "",
        agentClass:  "",
        agentName:   "",
        inputSource: "",
        outputProfileId: "",
      } satisfies PipelineNodeData,
    };

    const conn = findAutoConnect(newNode, currentNodes, currentEdges);

    // Commit stage change synchronously so rapid adds stay consistent
    if (newStages.length !== currentStages.length) {
      setStages(newStages);
      stagesRef.current = newStages;
    }

    setNodes(ns => [...(repositionFn ? repositionFn(ns) : ns), newNode]);
    if (conn) setEdges(es => [...es, makeEdge(conn.source, conn.target)]);
    setSelectedNodeId(id);
  }, [setNodes, setEdges, setStages, canvasLocked, markElementMutation]);

  // ── Drag from palette ─────────────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (canvasLocked) return;
    markElementMutation();
    const kind    = e.dataTransfer.getData("application/nodeKind")    as NodeKind | "";
    const subType = e.dataTransfer.getData("application/nodeSubType") as string   | "";
    if (!kind) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeToCanvas(kind, subType, pos);
  }, [screenToFlowPosition, addNodeToCanvas, canvasLocked, markElementMutation]);

  // ── Node interactions ─────────────────────────────────────────────────────

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  function updateNodeData(
    id: string,
    patch: Partial<PipelineNodeData>,
    opts?: { markDirty?: boolean },
  ) {
    if (canvasLocked) return;
    if (opts?.markDirty !== false) markElementMutation();
    setNodes(ns => ns.map(n =>
      n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
    ));
  }

  function deleteNode(id: string) {
    if (canvasLocked) return;
    markElementMutation();
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  }

  function handleAddStage() {
    if (canvasLocked) return;
    markElementMutation();
    if (stagesRef.current.length >= MAX_TOTAL_STAGES) return;
    const next: NodeKind[] = [...stagesRef.current, "processing", "output"];
    setStages(next);
    stagesRef.current = next;
  }

  function handleRemoveStage() {
    if (canvasLocked) return;
    markElementMutation();
    const currentStages = stagesRef.current;
    if (currentStages.length <= INIT_STAGES.length) return;

    const procIdx = currentStages.length - 2;
    const outIdx = currentStages.length - 1;
    if (currentStages[procIdx] !== "processing" || currentStages[outIdx] !== "output") return;

    const removeStageIdx = new Set([procIdx, outIdx]);
    const nodesToRemove = nodesRef.current.filter(n =>
      removeStageIdx.has((n.data as PipelineNodeData).stageIndex)
    );

    if (nodesToRemove.length > 0) {
      const ok = window.confirm(
        `Remove last layer and delete ${nodesToRemove.length} node(s) in it?`,
      );
      if (!ok) return;
    }

    const removeIds = new Set(nodesToRemove.map(n => n.id));
    setNodes(ns => ns.filter(n => !removeIds.has(n.id)));
    setEdges(es => es.filter(e => !removeIds.has(e.source) && !removeIds.has(e.target)));

    if (selectedNodeId && removeIds.has(selectedNodeId)) setSelectedNodeId(null);

    const next = currentStages.slice(0, -2);
    setStages(next);
    stagesRef.current = next;
  }

  function beginResizePipelinesPanel(e: React.MouseEvent<HTMLDivElement>) {
    if (canvasLocked) return;
    e.preventDefault();
    e.stopPropagation();
    pipelinesPanelResizeRef.current = {
      active: true,
      startX: e.clientX,
      startWidth: pipelinesPanelWidth,
    };
    const onMove = (ev: MouseEvent) => {
      if (!pipelinesPanelResizeRef.current.active) return;
      const { startX, startWidth } = pipelinesPanelResizeRef.current;
      // Pipelines panel lives on the left side; dragging the right edge right should widen it.
      const delta = ev.clientX - startX;
      const next = Math.max(240, Math.min(640, Math.round(startWidth + delta)));
      setPipelinesPanelWidth(next);
    };
    const onUp = () => {
      pipelinesPanelResizeRef.current.active = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleClear() {
    if (canvasLocked) return;
    runAbortRef.current?.abort();
    setRunning(false);
    setRunError("");
    setStepStatuses([]);
    setNodes([]);
    setEdges([]);
    setStages([...INIT_STAGES]);
    stagesRef.current = [...INIT_STAGES];
    setSelectedNodeId(null);
    setPipelineName("");
    setPipelineId(null);
    setPipelineFolder("");
  }

  async function handleDeletePipeline(pid: string) {
    if (canvasLocked) return;
    if (!canEditPipelines) { showToast("You do not have permission to delete pipelines.", false); return; }
    const pl = allPipelines.find(p => p.id === pid);
    if (!pl) return;
    if (!window.confirm(`Delete pipeline "${pl.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/pipelines/${pid}`, { method: "DELETE" });
      if (!res.ok) { showToast(`Delete failed (${res.status})`, false); return; }
      mutate("/api/pipelines");
      if (activePipelineId === pid) setActivePipeline("", "");
      if (pipelineId === pid) handleClear();
      showToast(`Pipeline "${pl.name}" deleted`, true);
    } catch { showToast("Network error — could not delete pipeline", false); }
  }

  async function createPipelineFolder(rawName?: string, opts?: { color?: string; description?: string }): Promise<PipelineFolderDef | false> {
    if (canvasLocked) return false;
    if (!canCreatePipelines) { showToast("You do not have permission to create pipeline folders.", false); return false; }
    const name = (rawName ?? newPipelineFolderDraft).trim();
    if (!name) { showToast("Folder name is required", false); return false; }
    const res = await fetch("/api/pipelines/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color: opts?.color ?? newFolderColor, description: opts?.description ?? "" }),
    });
    if (!res.ok) { showToast("Could not create folder", false); return false; }
    const created: PipelineFolderDef = await res.json();
    mutate("/api/pipelines/folders");
    setShowCreatePipelineFolder(false);
    setNewPipelineFolderDraft("");
    setNewFolderColor("");
    showToast(`Folder "${name}" created`, true);
    return created;
  }

  async function deletePipelineFolder(folderId: string, folderLabel?: string) {
    if (canvasLocked) return;
    if (!canEditPipelines) { showToast("You do not have permission to edit folders.", false); return; }
    if (!folderId) return;
    const isOrphan = folderId.startsWith("__orphan__") || folderId.startsWith("__name__");
    const folderName = folderLabel ?? (isOrphan ? folderId.replace(/^__(?:orphan|name)__/, "") : folderId);
    const count = isOrphan
      ? (pipelinesByFolderId[`__name__${folderName}`]?.length ?? 0)
      : (pipelinesByFolderId[folderId]?.length ?? 0);
    const msg = count > 0
      ? `Delete folder "${folderName}"? ${count} pipeline(s) will move to Unfiled.`
      : `Delete folder "${folderName}"?`;
    if (!window.confirm(msg)) return;

    let res: Response;
    if (isOrphan) {
      // Orphan: use legacy name-based delete endpoint
      res = await fetch("/api/pipelines/folders", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName }),
      });
    } else {
      res = await fetch(`/api/pipelines/folders/${folderId}`, { method: "DELETE" });
    }
    if (!res.ok) { showToast("Could not delete folder", false); return; }
    if (pipelineFolder === folderName) setPipelineFolder("");
    mutate("/api/pipelines");
    mutate("/api/pipelines/folders");
    showToast(`Folder "${folderName}" deleted`, true);
  }

  async function commitFolderRename(folderId: string) {
    const newName = renameDraft.trim();
    setRenamingFolderId(null);
    if (!newName) return;
    const existing = pipelineFolders.find(f => f.id === folderId);
    if (existing?.name === newName) return;
    const res = await fetch(`/api/pipelines/folders/${folderId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) { showToast("Could not rename folder", false); return; }
    mutate("/api/pipelines");
    mutate("/api/pipelines/folders");
    showToast(`Folder renamed to "${newName}"`, true);
  }

  async function reorderFolders(orderedIds: string[]) {
    await fetch("/api/pipelines/folders/reorder", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_ids: orderedIds }),
    });
    mutate("/api/pipelines/folders");
  }

  async function movePipelineToFolder(pid: string, folderId: string | null) {
    if (canvasLocked) return;
    if (!canEditPipelines) { showToast("You do not have permission to move pipelines.", false); return; }
    const isOrphan = folderId?.startsWith("__orphan__") || folderId?.startsWith("__name__");
    let resolvedFolderId = folderId;
    if (isOrphan && folderId) {
      const name = folderId.replace(/^__(?:orphan|name)__/, "");
      const created = await createPipelineFolder(name);
      if (!created) return;
      resolvedFolderId = created.id;
    }
    const res = await fetch(`/api/pipelines/${pid}/folder`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: resolvedFolderId ?? null }),
    });
    if (!res.ok) { showToast("Could not move pipeline", false); return; }
    const folderDef = pipelineFolders.find(f => f.id === resolvedFolderId);
    if (pipelineId === pid) setPipelineFolder(folderDef?.name ?? "");
    mutate("/api/pipelines");
    mutate("/api/pipelines/folders");
  }

  async function handleDuplicatePipeline(pid: string) {
    if (canvasLocked) return;
    if (!canCreatePipelines) { showToast("You do not have permission to duplicate pipelines.", false); return; }
    const pl = allPipelines.find(p => p.id === pid);
    if (!pl) return;
    try {
      // Deep copy via bundle export/import so dependent agents are duplicated too.
      const bundleRes = await fetch(`/api/pipelines/${pid}/bundle`);
      if (!bundleRes.ok) {
        const txt = await bundleRes.text().catch(() => "");
        showToast(`Duplicate failed (${bundleRes.status})${txt ? `: ${txt.slice(0, 120)}` : ""}`, false);
        return;
      }
      const bundle = await bundleRes.json() as PipelineBundle;
      const importRes = await fetch("/api/pipelines/bundles/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle,
          target_folder: String(bundle?.pipeline?.folder || pl.folder || "").trim(),
        }),
      });
      if (!importRes.ok) {
        const txt = await importRes.text().catch(() => "");
        showToast(`Duplicate failed (${importRes.status})${txt ? `: ${txt.slice(0, 120)}` : ""}`, false);
        return;
      }
      const saved = await importRes.json() as PipelineBundleImportResponse;
      const outPipeline = saved?.pipeline;
      if (!outPipeline?.id) {
        showToast("Duplicate failed (invalid import response)", false);
        return;
      }
      mutate("/api/universal-agents");
      mutate("/api/universal-agents/folders");
      mutate("/api/pipelines");
      mutate("/api/pipelines/folders");
      showToast(
        `Duplicated as "${outPipeline.name}" (${Number(saved?.agents_created || 0)} agent copies)`,
        true,
      );
      loadPipelineToCanvas(outPipeline.id, {
        id: outPipeline.id,
        name: outPipeline.name,
        folder: outPipeline.folder ?? "",
        steps: outPipeline.steps ?? [],
        canvas: outPipeline.canvas,
      });
    } catch { showToast("Network error — could not duplicate pipeline", false); }
  }

  function findProfileIdFromStepOverride(
    step: PipelineStepDef | undefined,
    subType: string,
  ): string {
    const ov = step?.output_contract_override;
    if (!ov) return "";
    const candidateProfiles = outputProfiles.filter(p => profileMatchesArtifactSubType(p, subType));
    for (const p of candidateProfiles) {
      const sameType = !("artifact_type" in ov) || String(ov.artifact_type || "") === p.artifact_type;
      const sameClass = !("artifact_class" in ov) || String(ov.artifact_class || "") === p.artifact_class;
      const sameName = !("artifact_name" in ov) || String(ov.artifact_name || "") === p.artifact_name;
      const sameSchema = !("output_schema" in ov) || String(ov.output_schema || "") === p.output_schema;
      const sameFormat = !("output_format" in ov) || String(ov.output_format || "").toLowerCase() === String(p.output_format || "").toLowerCase();
      const sameMode = !("output_response_mode" in ov) || String(ov.output_response_mode || "").toLowerCase() === String(p.output_response_mode || "").toLowerCase();
      const sameTarget = !("output_target_type" in ov) || String(ov.output_target_type || "").toLowerCase() === String(p.output_target_type || "").toLowerCase();
      const sameTemplate = !("output_template" in ov) || String(ov.output_template || "") === String(p.output_template || "");
      const samePlaceholder = !("output_placeholder" in ov) || String(ov.output_placeholder || "") === String(p.output_placeholder || "");
      const samePrevPlaceholder = !("output_previous_placeholder" in ov) || String(ov.output_previous_placeholder || "") === String(p.output_previous_placeholder || "");
      if (sameType && sameClass && sameName && sameSchema && sameFormat && sameMode && sameTarget && sameTemplate && samePlaceholder && samePrevPlaceholder) return p.id;
    }
    return "";
  }

  function loadPipelineToCanvas(pid: string, override?: { id: string; name: string; folder?: string; steps: PipelineStepDef[]; canvas?: { nodes: any[]; edges: any[]; stages: string[] } }) {
    const pl = override ?? allPipelines.find(p => p.id === pid);
    if (!pl) return;

    // ── Lossless restore from saved canvas JSON (n8n-style) ───────────────────
    const cv = pl.canvas;
    if (cv?.nodes?.length) {
      // Advance nodeSeq past the highest stored node id to avoid collisions
      const maxSeq = cv.nodes.reduce((max: number, n: any) => {
        const m = String(n.id ?? "").match(/^pn(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      nodeSeq = maxSeq + 1;

      const restoredNodes: Node[] = cv.nodes.map((n: any) => {
        const nodeData = (n.data as PipelineNodeData) || ({} as PipelineNodeData);
        const migratedSource = nodeData.inputSource === "chain_previous" ? "artifact_output" : nodeData.inputSource;
        let outputProfileId = String((nodeData as any).outputProfileId || "");
        if (!outputProfileId && n.type === "output") {
          const oldType = String((nodeData as any).outputArtifactType || "").trim();
          const oldClass = String((nodeData as any).outputArtifactClass || "").trim();
          const oldSchema = String((nodeData as any).outputSchema || "").trim();
          const oldFormat = String((nodeData as any).outputFormat || "").trim().toLowerCase();
          if (oldType || oldClass || oldSchema) {
            const subType = String(nodeData.subType || "");
            const candidates = outputProfiles.filter(p => profileMatchesArtifactSubType(p, subType));
            const matched = candidates.find(p => {
              const sameType = !oldType || p.artifact_type === oldType;
              const sameClass = !oldClass || p.artifact_class === oldClass;
              const sameSchema = !oldSchema || p.output_schema === oldSchema;
              const sameFormat = !oldFormat || p.output_format === oldFormat;
              return sameType && sameClass && sameSchema && sameFormat;
            });
            outputProfileId = matched?.id || "";
          }
        }
        return {
          id: n.id,
          type: n.type,
          position: n.position,
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          style: { background: "transparent", padding: 0, border: "none", boxShadow: "none" },
          data: { ...nodeData, inputSource: migratedSource, outputProfileId } as PipelineNodeData,
        };
      });

      const restoredEdges: Edge[] = cv.edges.map((e: any) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 18, height: 18 },
        style: { stroke: "#818cf8", strokeWidth: 2 },
      }));

      const restoredStages: NodeKind[] = (cv.stages as NodeKind[]) ?? [...INIT_STAGES];
      setStages(restoredStages);
      stagesRef.current = restoredStages;
      setNodes(restoredNodes);
      setEdges(restoredEdges);
      setPipelineName(pl.name);
      setPipelineId(pl.id);
      setPipelineFolder((pl.folder ?? "").trim());
      setSelectedNodeId(null);
      setRunError("");
      setStepStatuses([]);
      return;
    }

    // ── Legacy fallback: derive canvas from agent metadata ────────────────────
    // Collect unique canvas-level input sources.
    // Only add a source as a top-level input node when:
    //   a) it's always-external (transcript / merged_transcript / manual), OR
    //   b) the user explicitly overrode it to a non-virtual source.
    // Never add "notes", "merged_notes", "agent_output", or artifact-output aliases
    // as top-level nodes when they come from an agent's DEFAULT — those are
    // resolved internally by the executor or chained from a prior step.
    const ALWAYS_TOPLEVEL = new Set(["transcript", "merged_transcript", "manual"]);
    // artifact_* sources resolve from upstream output at runtime — never top-level input nodes.
    const VIRTUAL_SOURCES = new Set(["artifact_output", "chain_previous", "agent_output", "artifact_persona", "artifact_persona_score", "artifact_notes", "artifact_notes_compliance"]);

    const sourceSet = new Set<string>();
    pl.steps.forEach(step => {
      const agent = allAgents.find(a => a.id === step.agent_id);
      if (agent?.inputs?.length) {
        agent.inputs.forEach(inp => {
          const overrideSrc = step.input_overrides?.[inp.key];
          const defaultSrc  = inp.source;
          const effectiveSrc = overrideSrc ?? defaultSrc;
          if (ALWAYS_TOPLEVEL.has(effectiveSrc)) {
            // Primary file-based / manual sources always appear on the canvas
            sourceSet.add(effectiveSrc);
          } else if (overrideSrc && !VIRTUAL_SOURCES.has(overrideSrc)) {
            // User explicitly wired a non-virtual override → show as input node
            sourceSet.add(overrideSrc);
          }
          // Notes, merged_notes, artifact-output aliases, and agent_output as
          // defaults are resolved internally — do NOT create canvas input nodes.
        });
      } else {
        sourceSet.add("transcript"); // safe fallback when agent has no inputs
      }
    });
    const sources = [...sourceSet];

    // Build stages: input, then per-step: processing + output
    const newStages: NodeKind[] = ["input"];
    pl.steps.forEach(() => { newStages.push("processing"); newStages.push("output"); });
    // Always show at least INIT_STAGES rows so there is room to expand
    while (newStages.length < INIT_STAGES.length) {
      newStages.push("processing", "output");
    }

    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    nodeSeq = 1;

    // Input nodes (stage 0)
    const inputIds: string[] = [];
    sources.forEach((src, i) => {
      const srcMeta = INPUT_SOURCES.find(s => s.value === src);
      const id = nextId();
      inputIds.push(id);
      newNodes.push({
        id, type: "input",
        position: { x: X_SLOTS[Math.min(i, MAX_PER_LANE - 1)], y: laneY(0) + SLEEVE_INNER },
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        style: { background: "transparent", padding: 0, border: "none", boxShadow: "none" },
        data: {
          label: srcMeta?.label ?? src, subType: "input", prompt: "", stageIndex: 0,
          agentId: "", agentClass: "", agentName: "", inputSource: src,
        } satisfies PipelineNodeData,
      });
    });

    // Processing + output nodes per step
    pl.steps.forEach((step, i) => {
      const agent = allAgents.find(a => a.id === step.agent_id);
      const procStage = 1 + i * 2;
      const outStage  = 2 + i * 2;

      const procId = nextId();
      newNodes.push({
        id: procId, type: "processing",
        position: { x: X_SLOTS[0], y: laneY(procStage) + SLEEVE_INNER },
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        style: { background: "transparent", padding: 0, border: "none", boxShadow: "none" },
        data: {
          label: agent?.name ?? step.agent_id, subType: "agent", prompt: "", stageIndex: procStage,
          agentId: step.agent_id, agentClass: agent?.agent_class ?? "", agentName: agent?.name ?? step.agent_id,
          inputSource: "",
        } satisfies PipelineNodeData,
      });
      // Only connect an input node to this processor if the agent actually
      // reads that source (by default or via override).  Connecting every
      // input to every processor was causing wrong overrides on next save.
      const agentSrcs = new Set(
        (agent?.inputs ?? []).map(inp => step.input_overrides?.[inp.key] ?? inp.source)
      );
      sources.forEach((src, si) => {
        if (agentSrcs.has(src)) newEdges.push(makeEdge(inputIds[si], procId));
      });

      const outId = nextId();
      const outputProfileId = findProfileIdFromStepOverride(step, "notes");
      newNodes.push({
        id: outId, type: "output",
        position: { x: X_SLOTS[0], y: laneY(outStage) + SLEEVE_INNER },
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        style: { background: "transparent", padding: 0, border: "none", boxShadow: "none" },
        data: {
          label: `${agent?.name ?? "Step " + (i + 1)} Output`, subType: "notes", prompt: "", stageIndex: outStage,
          agentId: "", agentClass: "", agentName: "", inputSource: "",
          outputProfileId,
        } satisfies PipelineNodeData,
      });
      newEdges.push(makeEdge(procId, outId));
    });

    setStages(newStages);
    stagesRef.current = newStages;
    setNodes(newNodes);
    setEdges(newEdges);
    setPipelineName(pl.name);
    setPipelineId(pl.id);
    setPipelineFolder((pl.folder ?? "").trim());
    setSelectedNodeId(null);
    setRunError("");
    setStepStatuses([]);
  }

  async function importPresets() {
    if (canvasLocked) return;
    if (!canEditPipelines) { showToast("You do not have permission to modify pipeline agents.", false); return; }
    try {
      await fetch("/api/universal-agents/import-presets", { method: "POST" });
      mutate("/api/universal-agents");
      mutate("/api/pipelines");
      mutate("/api/pipelines/folders");
      showToast("Presets imported", true);
    } catch { showToast("Import failed", false); }
  }

  async function handleCopyPipelineBundle() {
    if (!pipelineId) {
      showToast("Select a pipeline first", false);
      return;
    }
    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/bundle`);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        showToast(`Bundle export failed (${res.status})${txt ? `: ${txt.slice(0, 80)}` : ""}`, false);
        return;
      }
      const bundle = await res.json() as PipelineBundle;
      const jsonText = JSON.stringify(bundle, null, 2);
      try {
        await navigator.clipboard.writeText(jsonText);
        showToast(`Bundle copied (${bundle.agents?.length ?? 0} agents)`, true);
      } catch {
        setBundleCopyText(jsonText);
        setShowBundleCopyFallback(true);
        showToast("Clipboard blocked — copy from popup", false);
      }
    } catch {
      showToast("Network error — could not export bundle", false);
    }
  }

  async function handleImportPipelineBundle() {
    if (canvasLocked) return;
    if (!canCreatePipelines) { showToast("You do not have permission to import pipeline bundles.", false); return; }
    const raw = bundleImportText.trim();
    if (!raw) {
      showToast("Paste a bundle JSON first", false);
      return;
    }
    let parsed: PipelineBundle | null = null;
    try {
      parsed = JSON.parse(raw) as PipelineBundle;
    } catch {
      showToast("Invalid JSON format", false);
      return;
    }
    if (!parsed || !parsed.pipeline || !Array.isArray(parsed.agents)) {
      showToast("Invalid bundle structure", false);
      return;
    }

    setBundleImporting(true);
    try {
      const res = await fetch("/api/pipelines/bundles/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle: parsed,
          target_folder: bundleImportFolder.trim(),
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        showToast(`Bundle import failed (${res.status})${txt ? `: ${txt.slice(0, 120)}` : ""}`, false);
        return;
      }
      const out = await res.json() as PipelineBundleImportResponse;
      mutate("/api/universal-agents");
      mutate("/api/universal-agents/folders");
      mutate("/api/pipelines");
      mutate("/api/pipelines/folders");
      setShowBundleImport(false);
      setBundleImportText("");
      setBundleImportFolder("");
      if (out?.pipeline?.id) {
        loadPipelineToCanvas(out.pipeline.id, {
          id: out.pipeline.id,
          name: out.pipeline.name,
          folder: out.pipeline.folder ?? out.folder ?? "",
          steps: out.pipeline.steps ?? [],
          canvas: out.pipeline.canvas,
        });
      }
      showToast(`Bundle imported: pipeline + ${out.agents_created} agent(s)`, true);
    } catch {
      showToast("Network error — could not import bundle", false);
    } finally {
      setBundleImporting(false);
    }
  }

  async function handleSavePipeline() {
    if (canvasLocked) return;
    if (pipelineId && !canEditPipelines) { showToast("You do not have permission to edit pipelines.", false); return; }
    if (!pipelineId && !canCreatePipelines) { showToast("You do not have permission to create pipelines.", false); return; }
    if (!pipelineName.trim()) { showToast("Enter a pipeline name first", false); return; }
    const validationErr = validatePipeline(nodes, edges);
    if (validationErr) { showToast(validationErr, false); return; }

    // Build steps from processing nodes that have an agent assigned.
    // For each step, derive input_overrides from canvas edges:
    // if a canvas Input node is connected whose inputSource differs from the agent's default source
    // for that key, record the override so execution uses the canvas-indicated source.
    const steps = nodes
      .filter(n => n.type === "processing" && (n.data as PipelineNodeData).agentId)
      .sort((a, b) => {
        const da = a.data as PipelineNodeData, db = b.data as PipelineNodeData;
        return da.stageIndex !== db.stageIndex ? da.stageIndex - db.stageIndex : a.position.x - b.position.x;
      })
      .map(n => {
        const d = n.data as PipelineNodeData;
        const agent = allAgents.find(a => a.id === d.agentId);
        const input_overrides: Record<string, string> = {};
        if (agent && agent.inputs.length > 0) {
          const connectedInputNodes = edges
            .filter(e => e.target === n.id)
            .map(e => nodes.find(x => x.id === e.source))
            .filter(src => src?.type === "input")
            .sort((a, b) => {
              const da = a!.data as PipelineNodeData;
              const db = b!.data as PipelineNodeData;
              if (da.stageIndex !== db.stageIndex) return da.stageIndex - db.stageIndex;
              if (a!.position.x !== b!.position.x) return a!.position.x - b!.position.x;
              return a!.id.localeCompare(b!.id);
            });
          const connectedInputSources = Array.from(new Set(
            connectedInputNodes
              .map(src => (src!.data as PipelineNodeData).inputSource)
              .filter(Boolean),
          ));
          // Edges from output nodes (e.g. Persona → pazi notes) carry semantic artifact type.
          // Use artifact_{subType} (e.g. artifact_persona) so the display shows "Persona"
          // instead of the legacy generic previous-output alias.
          const outputPredecessor = edges
            .filter(e => e.target === n.id)
            .map(e => nodes.find(x => x.id === e.source))
            .find(src => src?.type === "output");
          const artifactSrc = outputPredecessor
            ? `artifact_${(outputPredecessor.data as PipelineNodeData).subType || "output"}`
            : null;
          const defaultSourceSet = new Set(agent.inputs.map(inp => inp.source));
          const nonDefaultConnected = connectedInputSources.filter(src => !defaultSourceSet.has(src));
          const canUsePositionalMap = connectedInputSources.length === agent.inputs.length && connectedInputSources.length > 1;
          const isArtifactLike = (src: string) =>
            src === "chain_previous" || src === "artifact_output" || src.startsWith("artifact_");

          // Prefer deterministic matching by source value. Use positional mapping only when
          // cardinality is equal (avoids edge-order-induced override corruption).
          agent.inputs.forEach((inp, idx) => {
            const defaultSrc = inp.source;

            // Artifact-like inputs should follow the upstream output artifact edge, not
            // be remapped to a top-level input source when both are connected.
            if (isArtifactLike(defaultSrc)) {
              if (artifactSrc && defaultSrc !== artifactSrc) input_overrides[inp.key] = artifactSrc;
              return;
            }

            if (connectedInputSources.includes(defaultSrc)) return;
            if (connectedInputSources.length === 1) {
              const onlySrc = connectedInputSources[0];
              if (onlySrc && onlySrc !== defaultSrc) input_overrides[inp.key] = onlySrc;
              return;
            }
            if (canUsePositionalMap) {
              const canvasSrc = connectedInputSources[idx];
              if (canvasSrc && canvasSrc !== defaultSrc) input_overrides[inp.key] = canvasSrc;
              return;
            }
            if (nonDefaultConnected.length === 1) {
              const onlyNonDefault = nonDefaultConnected[0];
              if (onlyNonDefault && !isArtifactLike(onlyNonDefault) && onlyNonDefault !== defaultSrc) {
                input_overrides[inp.key] = onlyNonDefault;
              }
              return;
            }
          });
        }
        const connectedOutputNodes = edges
          .filter(e => e.source === n.id)
          .map(e => nodes.find(x => x.id === e.target))
          .filter(dst => dst?.type === "output")
          .sort((a, b) => {
            const da = a!.data as PipelineNodeData;
            const db = b!.data as PipelineNodeData;
            if (da.stageIndex !== db.stageIndex) return da.stageIndex - db.stageIndex;
            if (a!.position.x !== b!.position.x) return a!.position.x - b!.position.x;
            return a!.id.localeCompare(b!.id);
          });
        const primaryOutput = connectedOutputNodes[0];
        let output_contract_override: StepOutputContractOverride | undefined;
        if (primaryOutput) {
          const od = primaryOutput.data as PipelineNodeData;
          const profileId = String(od.outputProfileId || "").trim();
          if (profileId) {
            const profile = outputProfiles.find(p => p.id === profileId);
            if (profile) {
              output_contract_override = {
                artifact_type: profile.artifact_type,
                artifact_class: profile.artifact_class,
                artifact_name: profile.artifact_name,
                output_format: profile.output_format,
                output_schema: profile.output_schema,
                output_taxonomy: profile.output_taxonomy,
                output_contract_mode: profile.output_contract_mode,
                output_fit_strategy: profile.output_fit_strategy,
                output_response_mode: profile.output_response_mode,
                output_target_type: profile.output_target_type,
                output_template: profile.output_template,
                output_placeholder: profile.output_placeholder,
                output_previous_placeholder: profile.output_previous_placeholder,
              };
            }
          }
        }
        return output_contract_override
          ? { agent_id: d.agentId, input_overrides, output_contract_override }
          : { agent_id: d.agentId, input_overrides };
      });

    // Derive scope: if any step reads a merged source → per_pair, else → per_call
    const MERGED_SOURCES = new Set(["merged_transcript", "merged_notes"]);
    let scope = "per_call";
    for (const step of steps) {
      const agent = allAgents.find(a => a.id === step.agent_id);
      if (!agent) continue;
      agent.inputs.forEach((inp) => {
        const src = step.input_overrides?.[inp.key] ?? inp.source;
        if (MERGED_SOURCES.has(src)) scope = "per_pair";
      });
    }

    // Serialize the full canvas state so reload is lossless (n8n-style)
    const canvasData = {
      nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
      edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
      stages,
    };

    setPipelineSaving(true);
    try {
      // Flush all pending agent saves — agents are pipeline-local, so save pipeline = save all agents.
      for (const [nodeId, draft] of Array.from(pendingAgentSaves.current.entries())) {
        if (!draft?.name?.trim()) continue;
        const nd2 = nodes.find(n => n.id === nodeId)?.data as PipelineNodeData | undefined;
        if (!nd2?.agentId) continue;
        await fetch(`/api/universal-agents/${String(nd2.agentId)}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        }).catch(() => {});
      }
      pendingAgentSaves.current = new Map();

      const url    = pipelineId ? `/api/pipelines/${pipelineId}` : `/api/pipelines`;
      const method = pipelineId ? "PUT" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pipelineName, description: "", scope, steps, canvas: canvasData, folder: pipelineFolder }) });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        showToast(`Save failed (${res.status})${txt ? `: ${txt.slice(0, 80)}` : ""}`, false);
        return;
      }
      const saved = await res.json();
      const newId = saved.id ?? pipelineId;
      if (newId) setPipelineId(newId);
      mutate("/api/pipelines");
      mutate("/api/universal-agents");
      showToast(`Pipeline "${pipelineName}" saved`, true);
    } catch { showToast("Network error — could not save pipeline", false); }
    finally  { setPipelineSaving(false); }
  }

  // Create a new blank agent on the backend and attach it to the selected node
  async function handleCreateAgent() {
    if (canvasLocked) return;
    if (!selectedNodeId) return;
    const draft = {
      name: "New Agent", description: "", agent_class: "general",
      model: "gpt-5.4", temperature: 0,
      system_prompt: "", user_prompt: "",
      inputs: [{ key: "transcript", source: "transcript" }],
      output_format: "markdown", tags: [], is_default: false,
    };
    try {
      const res = await fetch("/api/universal-agents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) { showToast("Failed to create agent", false); return; }
      const created: UniversalAgent = await res.json();
      mutate("/api/universal-agents");
      updateNodeData(selectedNodeId, {
        agentId: created.id, agentClass: created.agent_class, agentName: created.name, label: created.name,
      });
      setAgentDraft({ ...draft, inputs: created.inputs ?? draft.inputs });
      showToast("Agent created — configure below, then Save Pipeline", true);
    } catch { showToast("Network error — could not create agent", false); }
  }

  // Remove the agent association from this canvas node (agent stays in backend)
  function handleDetachAgent() {
    if (canvasLocked) return;
    if (!selectedNodeId) return;
    updateNodeData(selectedNodeId, { agentId: "", agentClass: "", agentName: "" });
    setAgentDraft({ name: "", description: "", agent_class: "", model: "gpt-5.4",
      temperature: 0, system_prompt: "", user_prompt: "", inputs: [],
      output_format: "markdown", tags: [], is_default: false });
  }

  // Permanently delete the agent from the backend, then detach from node
  async function handleDeleteAgent() {
    if (canvasLocked) return;
    if (!selectedNodeId) return;
    const nd = nodes.find(n => n.id === selectedNodeId)?.data as PipelineNodeData | undefined;
    if (!nd?.agentId) return;
    if (!window.confirm(`Delete agent "${nd.agentName}"? This cannot be undone.`)) return;
    setAgentDeleting(true);
    try {
      const res = await fetch(`/api/universal-agents/${nd.agentId}`, { method: "DELETE" });
      if (!res.ok) { showToast(`Delete failed (${res.status})`, false); return; }
      mutate("/api/universal-agents");
      handleDetachAgent();
      showToast("Agent deleted", true);
    } catch { showToast("Network error — could not delete agent", false); }
    finally { setAgentDeleting(false); }
  }

  function handleSave() {
    const err = validatePipeline(nodes, edges);
    if (err) showToast(err, false);
    else showToast(`Pipeline valid — ${nodes.length} nodes, ${edges.length} connections.`, true);
  }

  async function readPipelineSSE(
    res: Response,
    onEvent: (type: string, data: any, step: number) => void,
  ): Promise<{ sawPipelineDone: boolean; sawError: boolean }> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const summary = { sawPipelineDone: false, sawError: false };
    let buffer = "";

    const processBlock = (rawBlock: string) => {
      const block = rawBlock.replace(/\r/g, "");
      const dataLines = block
        .split("\n")
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart());
      if (!dataLines.length) return;
      try {
        const evt = JSON.parse(dataLines.join("\n"));
        const type = evt.type as string;
        const data = evt.data ?? {};
        const step = typeof data?.step === "number" ? data.step : -1;
        if (type === "pipeline_done") summary.sawPipelineDone = true;
        if (type === "error") summary.sawError = true;
        onEvent(type, data, step);
      } catch {
        // ignore malformed event
      }
    };

    while (true) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep < 0) break;
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        processBlock(block);
      }
    }
    if (buffer.trim()) processBlock(buffer);
    return summary;
  }

  const appendRunLog = useCallback((line: string, levelHint?: CanvasLogLine["level"]) => {
    const ts = formatLocalTime(new Date(), true);
    const text = String(line || "");
    const level = levelHint ?? classifyCanvasLogLine(text);
    setRunLogLines((prev) => {
      const next = [...prev, { ts, text, level }];
      return next.length > 800 ? next.slice(next.length - 800) : next;
    });
  }, []);

  useEffect(() => {
    liveWaitAbortRef.current?.abort();

    if (!liveModeEnabled) {
      setLiveWebhookStatus("off");
      setLiveTriggeredAt("");
      return;
    }
    if (
      !pipelineId
      || (
        !liveListenAnyCall
        && (!salesAgent || !customer || (runNeedsCall && !callId))
      )
    ) {
      setLiveWebhookStatus("error");
      appendRunLog(
        liveListenAnyCall
          ? "Live mode needs a selected pipeline"
          : "Live mode needs pipeline + sales agent + customer" + (runNeedsCall ? " + call id" : ""),
        "warn",
      );
      return;
    }

    const ctrl = new AbortController();
    liveWaitAbortRef.current = ctrl;
    let stopped = false;
    let cursorMs = Number(liveCursorRef.current || 0);
    if (!Number.isFinite(cursorMs) || cursorMs <= 0) {
      cursorMs = Date.now() - 1000;
      setLiveCursorMs(cursorMs);
      liveCursorRef.current = cursorMs;
    }

    setLiveWebhookStatus("waiting");
    setLogsExpanded(true);
    setLogsCollapsed(false);
    appendRunLog(
      liveListenAnyCall
        ? "Live mode armed for ANY CRM call webhook"
        : `Live mode armed for ${salesAgent} · ${customer}${runNeedsCall ? ` · call ${callId}` : ""}`,
      "pipeline",
    );

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const loop = async () => {
      while (!stopped && !ctrl.signal.aborted) {
        try {
          const qp = new URLSearchParams();
          if (!liveListenAnyCall) {
            qp.set("sales_agent", salesAgent);
            qp.set("customer", customer);
            if (runNeedsCall && callId) qp.set("call_id", callId);
          }
          qp.set("after_ms", String(Math.max(0, Math.floor(cursorMs))));
          qp.set("timeout_s", "45");
          const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/live-webhook/wait?${qp.toString()}`, {
            signal: ctrl.signal,
            cache: "no-store",
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Live wait failed (${res.status})${body ? `: ${body.slice(0, 120)}` : ""}`);
          }
          const data = await res.json();
          const nextCursor = Number(data?.cursor_ms || 0);
          if (Number.isFinite(nextCursor) && nextCursor > cursorMs) {
            cursorMs = nextCursor;
            setLiveCursorMs(nextCursor);
            liveCursorRef.current = nextCursor;
          }

          if (data?.triggered && data?.event) {
            setLiveWebhookStatus("triggered");
            const event = data.event as Record<string, any>;
            const payload = (event?.payload && typeof event.payload === "object") ? event.payload : {};
            const eventCallId = String(payload.call_id || "").trim();
            const eventAgent = String(payload.agent || "").trim();
            const eventAt = String(event?.received_at || "");
            setLiveTriggeredAt(eventAt || new Date().toISOString());
            appendRunLog(
              `[LIVE] webhook ${String(event?.webhook_type || "event")} received${eventCallId ? ` · call ${eventCallId}` : ""}${eventAgent ? ` · agent ${eventAgent}` : ""}`,
              "pipeline",
            );
            const payloadPretty = JSON.stringify(payload, null, 2);
            const clipped = payloadPretty.length > 4000
              ? `${payloadPretty.slice(0, 4000)}\n… [payload truncated]`
              : payloadPretty;
            appendRunLog(`[LIVE] payload:\n${clipped}`, "pipeline");
            await sleep(950);
            if (!stopped && !ctrl.signal.aborted) setLiveWebhookStatus("waiting");
          }
        } catch (e: any) {
          if (e?.name === "AbortError" || stopped || ctrl.signal.aborted) break;
          setLiveWebhookStatus("error");
          appendRunLog(`[LIVE] wait error: ${String(e?.message || "unknown error")}`, "error");
          await sleep(1200);
          if (!stopped && !ctrl.signal.aborted) setLiveWebhookStatus("waiting");
        }
      }
    };

    void loop();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [
    liveModeEnabled,
    liveListenAnyCall,
    pipelineId,
    salesAgent,
    customer,
    runNeedsCall,
    callId,
    appendRunLog,
  ]);

  async function runPipeline(
    execMode: HistoricalRunExecMode | "default" = "default",
    execOpts: PipelineRunExecOptions = {},
  ) {
    if (!canRunPipelines) {
      showToast("You do not have permission to run pipelines.", false);
      return;
    }
    if (!pipelineId) {
      showToast("Select and save a pipeline first", false);
      return;
    }
    if (!salesAgent || !customer) {
      showToast("Select sales agent and customer first", false);
      return;
    }
    if (runNeedsCall && !callId) {
      showToast("Select a call before running a per-call pipeline", false);
      return;
    }
    if (runtimeGraph.stepToProcNodeIds.length === 0) {
      showToast("Pipeline has no runnable processing steps", false);
      return;
    }
    const stepCount = runtimeGraph.stepToProcNodeIds.length;
    const executeStepIndices = Array.from(
      new Set((execOpts.executeStepIndices || [])
        .map((i) => Number(i))
        .filter((i) => Number.isFinite(i) && i >= 0 && i < stepCount)
        .map((i) => Math.floor(i))),
    ).sort((a, b) => a - b);
    if ((execOpts.executeStepIndices || []).length > 0 && executeStepIndices.length === 0) {
      showToast("No valid target step selected", false);
      return;
    }

    runAbortRef.current?.abort();
    const ctrl = new AbortController();
    runAbortRef.current = ctrl;
    setRunning(true);
    setRunError("");
    if (executeStepIndices.length > 0) {
      const targetSet = new Set(executeStepIndices);
      setStepStatuses(prev => prev.map((s, i) => (targetSet.has(i) ? "pending" as RuntimeStatus : s)));
      setStepInputReady(prev => prev.map((v, i) => (targetSet.has(i) ? false : v)));
    } else {
      setStepStatuses(Array.from({ length: runtimeGraph.stepToProcNodeIds.length }, () => "pending" as RuntimeStatus));
      setStepInputReady(Array.from({ length: runtimeGraph.stepToProcNodeIds.length }, () => false));
    }
    setSelectedNodeId(null);
    setLogsExpanded(true);
    setLogsCollapsed(false);
    setRunLogLines([]);
    setLiveThinkingByStep({});
    setLiveStreamByStep({});
    appendRunLog(`Run started for ${salesAgent} · ${customer}${runNeedsCall ? ` · call ${callId}` : ""}`);

    let force = true;
    let resumePartial = false;
    let forceStepIndices: number[] = [];
    if (executeStepIndices.length > 0) {
      force = execOpts.force ?? false;
      resumePartial = execOpts.resumePartial ?? true;
      forceStepIndices = Array.from(new Set((execOpts.forceStepIndices || [])
        .map((i) => Number(i))
        .filter((i) => Number.isFinite(i) && i >= 0 && i < stepCount)
        .map((i) => Math.floor(i))));
      appendRunLog(
        `Targeted run: step ${executeStepIndices.map((i) => i + 1).join(", ")}${execOpts.prepareInputOnly ? " · inputs only" : ""}${forceStepIndices.length ? ` · force steps ${forceStepIndices.map((i) => i + 1).join(", ")}` : ""}`,
        "pipeline",
      );
    } else if (runContextMode === "historical") {
      if (execMode === "failed_only") {
        if (!selectedCacheRun) {
          showToast("Select a historical run first", false);
          setRunning(false);
          return;
        }
        if (!selectedCacheRunFailedStepIndices.length) {
          showToast("Selected run has no failed steps", false);
          setRunning(false);
          return;
        }
        force = false;
        resumePartial = true;
        forceStepIndices = [...selectedCacheRunFailedStepIndices];
        appendRunLog(
          `Historical rerun mode: failed-only (${forceStepIndices.length} step${forceStepIndices.length === 1 ? "" : "s"})`,
          "pipeline",
        );
      } else {
        force = true;
        resumePartial = false;
        forceStepIndices = [];
        appendRunLog("Historical rerun mode: force full rerun", "pipeline");
      }
    }
    if (execOpts.force != null) force = !!execOpts.force;
    if (execOpts.resumePartial != null) resumePartial = !!execOpts.resumePartial;
    if ((execOpts.forceStepIndices || []).length > 0) {
      forceStepIndices = Array.from(new Set((execOpts.forceStepIndices || [])
        .map((i) => Number(i))
        .filter((i) => Number.isFinite(i) && i >= 0 && i < stepCount)
        .map((i) => Math.floor(i))));
    }
    // Safety net: any targeted non-input-only run should execute the selected
    // step, not silently cache-hit, even if a caller omitted forceStepIndices.
    if (
      executeStepIndices.length > 0
      && !execOpts.prepareInputOnly
      && !force
      && forceStepIndices.length === 0
    ) {
      forceStepIndices = [...executeStepIndices];
    }
    const continueRunId = String(execOpts.continueRunId || "").trim();
    if (continueRunId) {
      appendRunLog(`Continuing run id ${continueRunId.slice(0, 8)}`, "pipeline");
    }

    try {
      const res = await fetch(`/api/pipelines/${pipelineId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sales_agent: salesAgent,
          customer,
          call_id: callId || "",
          context_call_id: callId || "",
          run_id: continueRunId,
          force,
          resume_partial: resumePartial,
          force_step_indices: forceStepIndices,
          execute_step_indices: executeStepIndices,
          prepare_input_only: !!execOpts.prepareInputOnly,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Pipeline run failed (${res.status})${txt ? `: ${txt.slice(0, 120)}` : ""}`);
      }
      if (!res.body) throw new Error("No response body");

      const setInputRuntimeBySource = (sources: string[], status: RuntimeStatus) => {
        const wanted = new Set(sources.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean));
        if (!wanted.size) return;
        setNodes((prev) => {
          const nowMs = Date.now();
          let changed = false;
          const next = prev.map((n) => {
            if (n.type !== "input") return n;
            const d = n.data as PipelineNodeData;
            const src = String(d.inputSource || "").toLowerCase().trim();
            if (!wanted.has(src)) return n;
            const prevStatus = ((d.runtimeStatus as RuntimeStatus | undefined) ?? "pending");
            const prevStartedAtMs = Number(d.runtimeStartedAtMs || 0) || undefined;
            if (prevStatus === status) {
              if (status === "loading" && !prevStartedAtMs) {
                changed = true;
                return {
                  ...n,
                  data: { ...d, runtimeStartedAtMs: nowMs } satisfies PipelineNodeData,
                };
              }
              if (status !== "loading" && prevStartedAtMs) {
                changed = true;
                const nextData = { ...d } as PipelineNodeData;
                delete nextData.runtimeStartedAtMs;
                return { ...n, data: nextData };
              }
              return n;
            }
            changed = true;
            const nextData = {
              ...d,
              runtimeStatus: status,
              runtimeStartedAtMs:
                status === "loading"
                  ? (prevStatus === "loading" && prevStartedAtMs ? prevStartedAtMs : nowMs)
                  : undefined,
            } satisfies PipelineNodeData;
            if (status !== "loading") delete nextData.runtimeStartedAtMs;
            return { ...n, data: nextData };
          });
          return changed ? next : prev;
        });
      };

      const summary = await readPipelineSSE(res, (type, evt, stepIdx) => {
        if (type === "pipeline_start") appendRunLog(`Pipeline started`, "pipeline");
        if (type === "pipeline_done") appendRunLog(`Pipeline finished`, "pipeline");
        if (type === "pipeline_start" && evt?.run_id) {
          const rid = String(evt.run_id || "").trim();
          if (rid) setCurrentRunId(rid);
        }
        if (type === "progress" && evt?.msg) {
          const msg = String(evt.msg || "");
          appendRunLog(msg);
          const low = msg.toLowerCase();
          const mentionsAutoTx = low.includes("auto-transcription");

          if (mentionsAutoTx && (low.includes("missing transcript inputs detected") || low.includes("auto-transcription running"))) {
            if (low.includes("(merged)")) {
              setInputRuntimeBySource(["merged_transcript"], "loading");
            } else if (low.includes("(call)")) {
              setInputRuntimeBySource(["transcript"], "loading");
            } else {
              setInputRuntimeBySource(["transcript", "merged_transcript"], "loading");
            }
          } else if (mentionsAutoTx && low.includes("ready")) {
            const readyStatus: RuntimeStatus = runContextMode === "historical" ? "cached" : "done";
            setInputRuntimeBySource(["transcript", "merged_transcript"], readyStatus);
          } else if (mentionsAutoTx && (low.includes("failed") || low.includes("still missing") || low.includes("timed out"))) {
            setInputRuntimeBySource(["transcript", "merged_transcript"], "error");
          }
        }
        const liveKey = Number.isFinite(stepIdx) ? stepIdx : -1;
        if (type === "stream" && evt?.text) {
          const chunk = String(evt.text || "");
          appendRunLog(chunk, "llm");
          setLiveStreamByStep((prev) => ({
            ...prev,
            [liveKey]: `${String(prev[liveKey] || "")}${chunk}`,
          }));
        }
        if (type === "thinking" && evt?.content) {
          const chunk = String(evt.content || "");
          appendRunLog(chunk, "llm");
          setLiveThinkingByStep((prev) => ({
            ...prev,
            [liveKey]: `${String(prev[liveKey] || "")}${chunk}`,
          }));
        }
        if (stepIdx == null || stepIdx < 0) return;
        const stepName = runtimeGraph.stepToProcNodeIds[stepIdx] || `step_${stepIdx + 1}`;
        if (type === "step_start") appendRunLog(`${stepName}: started`, "pipeline");
        if (type === "step_cached") appendRunLog(`${stepName}: cache hit`, "pipeline");
        if (type === "step_done") appendRunLog(`${stepName}: done`, "pipeline");
        if (type === "step_start") {
          setLiveThinkingByStep((prev) => ({ ...prev, [stepIdx]: "" }));
          setLiveStreamByStep((prev) => ({ ...prev, [stepIdx]: "" }));
          setStepStatuses(prev => prev.map((s, i) => (i === stepIdx ? "loading" : s)));
          setStepInputReady(prev => prev.map((ready, i) => (i === stepIdx ? false : ready)));
        }
        if (type === "step_cached") {
          setStepStatuses(prev => prev.map((s, i) => (i === stepIdx ? "cached" : s)));
          setStepInputReady(prev => prev.map((ready, i) => (i === stepIdx ? true : ready)));
        }
        if (type === "step_done") {
          setStepStatuses(prev => prev.map((s, i) => (i === stepIdx ? "done" : s)));
          setStepInputReady(prev => prev.map((ready, i) => (i === stepIdx ? true : ready)));
        }
        if (type === "input_prepared") {
          setStepInputReady(prev => prev.map((ready, i) => (i === stepIdx ? true : ready)));
          setStepStatuses(prev => prev.map((s, i) => (i === stepIdx ? "pending" : s)));
          appendRunLog(`${stepName}: input prepared`, "pipeline");
        }
        if (type === "input_ready") {
          setStepInputReady(prev => prev.map((ready, i) => (i === stepIdx ? true : ready)));
          appendRunLog(`${stepName}: input ready`, "pipeline");
        }
        if (type === "error" && evt?.step != null) {
          setStepStatuses(prev => prev.map((s, i) => (i === evt.step ? "error" : s)));
          setRunError(prev => prev || String(evt?.msg || "Pipeline run ended with an error"));
          appendRunLog(`ERROR at step ${evt.step + 1}: ${String(evt?.msg || "unknown error")}`, "error");
        }
      });

      if (!summary.sawPipelineDone && !ctrl.signal.aborted) {
        setRunError(prev => prev || (summary.sawError
          ? "Pipeline ended with an error."
          : "Pipeline stream ended before completion."));
        appendRunLog("Pipeline ended before completion");
      } else if (!summary.sawError) {
        showToast("Pipeline run completed", true);
        appendRunLog("Pipeline run completed");
      }
      mutateCache();
      mutateLivePipelineState();
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setRunError(e?.message || "Pipeline run failed");
        showToast(e?.message || "Pipeline run failed", false);
        appendRunLog(`Run failed: ${String(e?.message || "unknown error")}`, "error");
      }
    } finally {
      try { await mutateRuns(); } catch { /* best-effort */ }
      setRunning(false);
    }
  }

  function runNodeStep(targetStepIndex: number) {
    if (!Number.isFinite(targetStepIndex) || targetStepIndex < 0) {
      showToast("Invalid target step", false);
      return;
    }
    if (running) {
      showToast("A run is already in progress", false);
      return;
    }
    const preferredRunId = String(
      (runContextMode === "historical" ? selectedCacheRun?.id : "") || currentRunId || "",
    ).trim();
    void runPipeline("default", {
      executeStepIndices: [targetStepIndex],
      forceStepIndices: [targetStepIndex],
      force: false,
      resumePartial: true,
      continueRunId: preferredRunId,
    });
  }

  function runInputNodeStep(targetStepIndices: number[], inputSource = "") {
    const executeStepIndices = Array.from(
      new Set((targetStepIndices || [])
        .map((i) => Number(i))
        .filter((i) => Number.isFinite(i) && i >= 0)
        .map((i) => Math.floor(i))),
    ).sort((a, b) => a - b);
    if (!executeStepIndices.length) {
      showToast("No connected consumer step found for this input", false);
      return;
    }
    if (running) {
      showToast("A run is already in progress", false);
      return;
    }
    // New-run input prep should bootstrap a fresh run id so old historical
    // step states never bleed into current visual status.
    const preferredRunId = runContextMode === "historical"
      ? String(selectedCacheRun?.id || "").trim()
      : "";
    const sourceNorm = String(inputSource || "").trim().toLowerCase();
    if (sourceNorm === "merged_transcript") {
      const runCall = String(callId || "").trim();
      appendRunLog(
        `Merged input recalculation requested${runCall ? ` for call ${runCall}` : ""}`,
        "pipeline",
      );
      void fetchInputPreviewForSource("merged_transcript", true);
    }
    void runPipeline("default", {
      executeStepIndices,
      force: false,
      resumePartial: false,
      continueRunId: preferredRunId,
      prepareInputOnly: true,
    });
  }

  async function stopPipeline() {
    if (!canRunPipelines) {
      showToast("You do not have permission to stop pipeline runs.", false);
      return;
    }
    if (!pipelineId || !running) return;
    runAbortRef.current?.abort();
    setRunning(false);
    setRunError("Run stopped by user.");
    appendRunLog("Run stopped by user", "warn");
    setStepStatuses((prev) => prev.map((st) => (st === "loading" ? "cancelled" : st)));
    try {
      await fetch(`/api/pipelines/${pipelineId}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sales_agent: salesAgent,
          customer,
          call_id: callId || "",
        }),
      });
    } catch {
      // local abort already stopped UI
    }
    mutateRuns();
    mutateLivePipelineState();
  }

  // ── Right properties panel ────────────────────────────────────────────────

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const selData      = selectedNode ? (selectedNode.data as PipelineNodeData) : null;
  const selKind      = selectedNode?.type as NodeKind | undefined;
  const selMeta      = selData && selKind ? getMeta(selKind, selData.subType) : null;
  const selectedOutputProducer = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "output") return null;
    const incoming = edges.find(e => e.target === selectedNode.id);
    if (!incoming) return null;
    const src = nodes.find(n => n.id === incoming.source);
    if (!src || src.type !== "processing") return null;
    const d = src.data as PipelineNodeData;
    return {
      node_id: src.id,
      agent_id: String(d.agentId || ""),
      agent_name: String(d.agentName || d.label || "Agent"),
    };
  }, [selectedNode, edges, nodes]);

  const artifactTemplateUrl = useMemo(() => {
    if (selKind !== "output" || !selData?.subType) return null;
    if (!selectedOutputProducer?.agent_id) return null;
    const qp = new URLSearchParams({
      agent_id: selectedOutputProducer.agent_id,
      artifact_sub_type: String(selData.subType),
    });
    return `/api/pipelines/artifact-template?${qp.toString()}`;
  }, [selKind, selData?.subType, selectedOutputProducer?.agent_id]);

  const selectableOutputProfiles = useMemo(() => {
    if (selKind !== "output" || !selData?.subType) return [];
    return outputProfiles.filter(p => profileMatchesArtifactSubType(p, String(selData.subType)));
  }, [selKind, selData?.subType, outputProfiles]);

  const {
    data: artifactTemplate,
    isLoading: artifactTemplateLoading,
  } = useSWR<ArtifactPromptTemplate>(artifactTemplateUrl, fetcher, { revalidateOnFocus: false });

  useEffect(() => {
    if (!pendingOpenRunPayload) return;
    // Wait until pipeline list fetch is resolved (success or error) before consuming
    // open-run payload, otherwise we can clear it too early and force manual selection.
    if (pipelinesData === undefined && !pipelinesError) return;
    let cancelled = false;

    const targetAgent = String(pendingOpenRunPayload.sales_agent || "").trim();
    const targetCustomer = String(pendingOpenRunPayload.customer || "").trim();
    const targetCallId = String(pendingOpenRunPayload.call_id || "").trim();
    const targetPipelineId = String(pendingOpenRunPayload.pipeline_id || "").trim();
    const targetPipelineName = String(pendingOpenRunPayload.pipeline_name || "").trim();
    const targetRunId = String(pendingOpenRunPayload.run_id || "").trim();
    const lockRequested = !!pendingOpenRunPayload.locked;

    setCanvasLocked(lockRequested);

    if (targetAgent && targetCustomer) {
      setCustomer(targetCustomer, targetAgent);
    }
    if (targetCallId) {
      setPendingRunCallId(targetCallId);
      setCallId(targetCallId);
    }

    let resolvedPipelineId = targetPipelineId;
    let resolvedPipelineName = targetPipelineName;
    let needsRunCanvasFallback = false;

    if (targetPipelineId) {
      const existingById = allPipelines.find((p) => p.id === targetPipelineId);
      const existingByName = !existingById && targetPipelineName
        ? allPipelines.find((p) => String(p.name || "").trim() === targetPipelineName)
        : undefined;
      const existing = existingById || existingByName;
      if (existing) {
        resolvedPipelineId = existing.id;
        resolvedPipelineName = targetPipelineName || existing.name || "";
        loadPipelineToCanvas(existing.id);
        setActivePipeline(existing.id, resolvedPipelineName);
      } else {
        // Dev mirror can receive runs from production with pipeline ids not present locally.
        // Fall back to opening by historical run canvas snapshot below.
        needsRunCanvasFallback = true;
      }
    } else if (targetPipelineName) {
      const existingByName = allPipelines.find((p) => String(p.name || "").trim() === targetPipelineName);
      if (existingByName) {
        resolvedPipelineId = existingByName.id;
        resolvedPipelineName = existingByName.name || targetPipelineName;
        loadPipelineToCanvas(existingByName.id);
        setActivePipeline(existingByName.id, resolvedPipelineName);
      }
    }

    if (targetRunId) {
      setRunContextMode("historical");
      setSelectedCacheRunId(targetRunId);
      setCurrentRunId(targetRunId);
    } else if (lockRequested) {
      setRunContextMode("historical");
    }

    if (targetRunId && (needsRunCanvasFallback || !resolvedPipelineId)) {
      void (async () => {
        try {
          const qs = new URLSearchParams({ mirror: "1" });
          const runRow = await fetcher(
            `/api/history/runs/${encodeURIComponent(targetRunId)}?${qs.toString()}`,
          ) as PipelineRunRecord;
          if (cancelled || !runRow) return;
          const runPipelineId = String(runRow.pipeline_id || "").trim();
          const runPipelineName = String(runRow.pipeline_name || "").trim();
          const existingById = runPipelineId
            ? allPipelines.find((p) => p.id === runPipelineId)
            : undefined;
          const existingByName = !existingById && runPipelineName
            ? allPipelines.find((p) => String(p.name || "").trim() === runPipelineName)
            : undefined;
          const existing = existingById || existingByName;
          if (existing) {
            loadPipelineToCanvas(existing.id);
            setActivePipeline(existing.id, existing.name || runPipelineName || resolvedPipelineName || "");
            return;
          }
          const rawCanvas = JSON.parse(String(runRow.canvas_json || "{}"));
          const canvas = (rawCanvas && typeof rawCanvas === "object")
            ? {
                nodes: Array.isArray((rawCanvas as any).nodes) ? (rawCanvas as any).nodes : [],
                edges: Array.isArray((rawCanvas as any).edges) ? (rawCanvas as any).edges : [],
                stages: Array.isArray((rawCanvas as any).stages) ? (rawCanvas as any).stages : [],
              }
            : { nodes: [], edges: [], stages: [] };
          if (!Array.isArray(canvas.nodes) || canvas.nodes.length === 0) return;
          const fallbackPipelineId =
            String(runPipelineId || resolvedPipelineId || targetPipelineId || `run-${targetRunId}`).trim();
          const fallbackPipelineName =
            String(runPipelineName || resolvedPipelineName || targetPipelineName || `Historical ${targetRunId.slice(0, 8)}`).trim();
          loadPipelineToCanvas(fallbackPipelineId, {
            id: fallbackPipelineId,
            name: fallbackPipelineName || `Historical ${targetRunId.slice(0, 8)}`,
            folder: "",
            steps: [],
            canvas,
          });
          setActivePipeline(fallbackPipelineId, fallbackPipelineName || `Historical ${targetRunId.slice(0, 8)}`);
        } catch {
          // If fallback fails we still keep historical run context selected.
        } finally {
          if (!cancelled) setPendingOpenRunPayload(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    setPendingOpenRunPayload(null);
    return () => {
      cancelled = true;
    };
  }, [pendingOpenRunPayload, allPipelines, pipelinesData, pipelinesError, setCustomer, setCallId, setActivePipeline, setPendingRunCallId]);

  useEffect(() => {
    if (runContextMode !== "new") return;
    // New run mode should start clean: do not preload a previous run id/cache context.
    setCurrentRunId("");
  }, [runContextMode, pipelineId, salesAgent, customer, runNeedsCall, callId]);

  useEffect(() => {
    const fromLive = String(livePipelineState?.run_id || "").trim();
    if (!fromLive) return;
    setCurrentRunId((prev) => (prev === fromLive ? prev : fromLive));
  }, [livePipelineState?.run_id]);

  useEffect(() => {
    if (running) return;
    if (runContextMode !== "new") return;
    if (currentRunId) return;
    const fromLive = String(livePipelineState?.run_id || "").trim();
    if (!fromLive) return;
    const liveStatus = String(livePipelineState?.status || "").toLowerCase().trim();
    const isActiveLive =
      liveStatus === "running"
      || liveStatus === "started"
      || liveStatus === "preparing"
      || liveStatus === "queued"
      || liveStatus === "retrying";
    if (!isActiveLive) return;
    setCurrentRunId(fromLive);
  }, [running, runContextMode, currentRunId, livePipelineState?.run_id, livePipelineState?.status]);

  // SSE can be buffered or flaky in some browser/network paths.
  // While a run is active, use polled live-state snapshots as a fallback so
  // node runtime animation still updates in near real-time.
  useEffect(() => {
    if (!running) return;
    if (runContextMode !== "new") return;

    const live = livePipelineState;
    if (!live) return;

    const liveRunId = String(live.run_id || "").trim();
    const activeRunId = String(currentRunId || "").trim();
    if (activeRunId && liveRunId && activeRunId !== liveRunId) return;

    const stepCount = runtimeGraph.stepToProcNodeIds.length;
    if (stepCount <= 0) return;

    const processingStates = live.node_states?.processing || {};
    const liveSteps = Array.isArray(live.steps) ? live.steps : [];
    const liveRunStatus = normalizeStateToken(live.status || "");

    const observedStatuses = Array.from({ length: stepCount }, (_, idx): RuntimeStatus => {
      const procNodeId = runtimeGraph.stepToProcNodeIds[idx];
      const fromNodeState = runtimeStatusFromToken((processingStates as Record<string, string>)[procNodeId]);
      if (fromNodeState !== "pending") return fromNodeState;
      const row = liveSteps[idx];
      const cachedCount = Array.isArray(row?.cached_locations) ? row.cached_locations.length : 0;
      return runtimeStatusFromToken(row?.state || row?.status || "", cachedCount > 0);
    });

    if (isCancelledLike(liveRunStatus)) {
      for (let i = 0; i < observedStatuses.length; i += 1) {
        if (observedStatuses[i] === "pending" || observedStatuses[i] === "loading") {
          observedStatuses[i] = "cancelled";
        }
      }
    } else if (isFailedLike(liveRunStatus)) {
      for (let i = 0; i < observedStatuses.length; i += 1) {
        if (observedStatuses[i] === "pending" || observedStatuses[i] === "loading") {
          observedStatuses[i] = "error";
        }
      }
    } else if (isCompletedLike(liveRunStatus)) {
      for (let i = 0; i < observedStatuses.length; i += 1) {
        if (observedStatuses[i] === "pending" || observedStatuses[i] === "loading") {
          observedStatuses[i] = "done";
        }
      }
    }

    const observedInputReady = Array.from({ length: stepCount }, (_, idx) => {
      const row = liveSteps[idx];
      if (!row) return observedStatuses[idx] === "done" || observedStatuses[idx] === "cached";
      return !!row.input_ready || observedStatuses[idx] === "done" || observedStatuses[idx] === "cached";
    });

    setStepStatuses((prev) => {
      const base = prev.length === stepCount
        ? prev
        : Array.from({ length: stepCount }, () => "pending" as RuntimeStatus);
      let changed = false;
      const merged = base.map((current, idx) => {
        const observed = observedStatuses[idx] ?? "pending";
        let next = observed;
        if (current === "loading" && observed === "pending") next = current;
        if ((current === "done" || current === "cached") && (observed === "pending" || observed === "loading")) next = current;
        if (current === "error" && observed === "pending") next = current;
        if (next !== current) changed = true;
        return next;
      });
      return changed ? merged : prev;
    });

    setStepInputReady((prev) => {
      const base = prev.length === stepCount
        ? prev
        : Array.from({ length: stepCount }, () => false);
      let changed = false;
      const merged = base.map((current, idx) => {
        const next = current || !!observedInputReady[idx];
        if (next !== current) changed = true;
        return next;
      });
      return changed ? merged : prev;
    });
  }, [running, runContextMode, livePipelineState, currentRunId, runtimeGraph.stepToProcNodeIds]);

  const selectedNodeAgentId = useMemo(() => {
    if (!selData || selKind !== "processing") return "";
    return String((selData as PipelineNodeData).agentId || "").trim();
  }, [selData, selKind]);

  // Sync agentDraft when selected node or agent library changes.
  // NOTE: selData is intentionally excluded from deps — it changes on every updateNodeData call
  // (new object reference), which would reset the draft on every keystroke in the name input.
  // selKind and selectedNodeAgentId already capture the relevant parts of selData.
  useEffect(() => {
    if (selKind !== "processing") { setAgentDraft(null); agentDraftLoadedFor.current = ""; return; }
    const agId   = selectedNodeAgentId;
    const loadKey = `${selectedNodeId ?? ""}::${agId}`;
    const a      = agId ? allAgents.find(x => x.id === agId) : null;

    // Guard: same node+agent and already loaded successfully → don't overwrite ongoing edits.
    // This prevents allAgents SWR re-fetches from stomping a name the user is mid-edit.
    if (agentDraftLoadedFor.current === loadKey && a) return;

    // Prefer the node's current display name (set by inline/header renames) over the
    // stale library name — the library won't reflect unsaved edits.
    const nodeAgentName = String((selData as PipelineNodeData | null)?.agentName || "").trim();
    setAgentDraft({
      name:          nodeAgentName  || (a?.name ?? ""),
      description:   a?.description   ?? "",
      agent_class:   a?.agent_class   ?? "",
      model:         a?.model         ?? "gpt-5.4",
      temperature:   a?.temperature   ?? 0,
      system_prompt: a?.system_prompt ?? "",
      user_prompt:   a?.user_prompt   ?? "",
      // IMPORTANT: preserve the agent's inputs — the pipeline executor uses these
      // to know which data sources to fetch. Wiping them breaks execution.
      inputs:        a?.inputs        ?? [],
      output_format: a?.output_format ?? "markdown",
      tags:          a?.tags          ?? [],
      is_default:    a?.is_default    ?? false,
    });
    // Only mark as loaded once we actually have agent data; if a === null the agent
    // isn't in the cache yet (e.g. fresh after clone) — keep retrying on next allAgents tick.
    if (a) agentDraftLoadedFor.current = loadKey;
  }, [selectedNodeId, selKind, selectedNodeAgentId, allAgents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Accumulate every draft edit into pendingAgentSaves so pipeline-save can flush them all.
  useEffect(() => {
    if (selectedNodeId && agentDraft) {
      pendingAgentSaves.current.set(selectedNodeId, agentDraft);
    }
  }, [agentDraft, selectedNodeId]);

  useEffect(() => {
    if (selKind !== "processing" || !selectedNodeId || !agentDraft) return;
    const connectedOutputNodes = edges
      .filter((e) => e.source === selectedNodeId)
      .map((e) => nodes.find((n) => n.id === e.target))
      .filter((n): n is Node => {
        if (!n) return false;
        return n.type === "output";
      });
    const inferred = inferAgentClassFromConnectedOutputs(connectedOutputNodes, outputProfiles);
    if (!inferred) return;

    const draftClass = normalizeAgentClass(agentDraft.agent_class || "");
    const nodeClass = normalizeAgentClass(String(selData?.agentClass || ""));

    if (draftClass !== inferred) {
      setAgentDraft((prev) => (prev ? { ...prev, agent_class: inferred } : prev));
    }
    if (nodeClass !== inferred) {
      updateNodeData(selectedNodeId, { agentClass: inferred }, { markDirty: false });
    }
  }, [
    selKind,
    selectedNodeId,
    edges,
    nodes,
    outputProfiles,
    agentDraft,
    selData?.agentClass,
  ]);

  useEffect(() => {
    setResultViewMode("rendered");
  }, [selectedNodeId]);

  const previewCallId = useMemo(() => {
    if (runContextMode === "historical") {
      const fromRun = inferRunCallIdFromRecord(selectedCacheRun);
      if (fromRun) return fromRun;
    }
    return String(callId || "").trim();
  }, [runContextMode, selectedCacheRun, callId]);

  useEffect(() => {
    inputPreviewSnapshotRef.current = inputPreviewBySource;
  }, [inputPreviewBySource]);

  const fetchInputPreviewForSource = useCallback(async (
    source: string,
    includeFileRefs = false,
    historicalMeta?: { resolvedCallId: string; mergedScope: string; mergedUntilCallId: string },
  ) => {
    const src = String(source || "").trim();
    const agentCtx = String(salesAgent || "").trim();
    const customerCtx = String(customer || "").trim();
    const callCtx = String(previewCallId || "").trim();
    const runId = runContextMode === "historical" ? String(selectedCacheRunId || "").trim() : "";
    const heavyFileRefSources = new Set(["transcript", "merged_transcript", "notes", "merged_notes"]);
    const requestFileRefs = includeFileRefs && !heavyFileRefSources.has(src);
    const metaSuffix = historicalMeta?.resolvedCallId ? `${historicalMeta.resolvedCallId}|${historicalMeta.mergedScope}` : "";
    const requestKey = `${src}||${agentCtx.toLowerCase()}||${customerCtx.toLowerCase()}||${callCtx.toLowerCase()}||${runId}||${metaSuffix}||${requestFileRefs ? "refs" : "norefs"}`;
    if (!src) return;

    if (!agentCtx || !customerCtx) {
      setInputPreviewBySource((prev) => ({
        ...prev,
        [src]: {
          loading: false,
          content: "",
          error: "Select sales agent + customer first.",
          requestKey,
        },
      }));
      return;
    }

    const existing = inputPreviewSnapshotRef.current[src];
    const existingHasFileRefs = !!(
      (existing?.fileRefs && Object.keys(existing.fileRefs).length > 0)
      || String(existing?.fileRefsError || "").trim()
    );
    if (
      existing
      && !existing.loading
      && !existing.error
      && existing.requestKey === requestKey
      && (!requestFileRefs || existingHasFileRefs)
    ) {
      return;
    }

    const inFlight = inputPreviewInFlightRef.current[requestKey];
    if (inFlight) {
      await inFlight;
      return;
    }

    setInputPreviewBySource((prev) => ({
      ...prev,
      [src]: {
        loading: true,
        content: "",
        error: "",
        requestKey,
        source: src,
        origin: "",
        cacheFile: "",
        resolvedCallId: "",
        fileRefs: {},
        fileRefsError: "",
      },
    }));

    const run = (async () => {
      try {
        const params = new URLSearchParams({
          source: src,
          sales_agent: agentCtx,
          customer: customerCtx,
        });
        if (historicalMeta?.resolvedCallId) {
          params.set("call_id", historicalMeta.resolvedCallId);
          params.set("merged_scope", "upto_call");
          params.set("merged_until_call_id", historicalMeta.resolvedCallId);
        } else if (callCtx) {
          params.set("call_id", callCtx);
        }
        if (requestFileRefs) {
          params.set("model", "gpt-5.4");
          params.set("include_file_refs", "1");
        }
        const res = await fetch(`/api/universal-agents/raw-input?${params.toString()}`);
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(txt || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const content = String(data?.content || "");
        const meta = (data?.meta && typeof data.meta === "object") ? data.meta : {};
        const fileRefs = (data?.file_refs && typeof data.file_refs === "object")
          ? (data.file_refs as Record<string, string>)
          : {};
        const fileRefsError = requestFileRefs
          ? String(data?.file_refs_error || "")
          : (
            includeFileRefs
              ? "Skipped provider file-ref lookup for large source to keep preview fast."
              : ""
          );
        setInputPreviewBySource((prev) => ({
          ...prev,
          [src]: {
            loading: false,
            content,
            error: "",
            requestKey,
            source: src,
            origin: String(meta?.origin || ""),
            cacheFile: String(meta?.cache_file || ""),
            resolvedCallId: String(meta?.resolved_call_id || ""),
            fileRefs,
            fileRefsError,
          },
        }));
      } catch (e: any) {
        setInputPreviewBySource((prev) => ({
          ...prev,
          [src]: {
            loading: false,
            content: "",
            error: `Could not load input preview: ${e?.message || "fetch failed"}`,
            requestKey,
            source: src,
            origin: "",
            cacheFile: "",
            resolvedCallId: "",
            fileRefs: {},
            fileRefsError: "",
          },
        }));
      }
    })();
    inputPreviewInFlightRef.current[requestKey] = run;
    try {
      await run;
    } finally {
      delete inputPreviewInFlightRef.current[requestKey];
    }
  }, [salesAgent, customer, previewCallId, runContextMode, selectedCacheRunId]);

  useEffect(() => {
    setInputPreviewBySource({});
    inputPreviewSnapshotRef.current = {};
    inputPreviewInFlightRef.current = {};
  }, [salesAgent, customer, previewCallId, selectedCacheRunId]);

  useEffect(() => {
    if (!selectedNode || !selKind) return;

    const wantedSources = new Set<string>();
    if (selKind === "input") {
      const src = String((selectedNode.data as PipelineNodeData).inputSource || "").trim();
      if (src) wantedSources.add(src);
    } else if (selKind === "processing") {
      edges
        .filter((e) => e.target === selectedNode.id)
        .forEach((e) => {
          const srcNode = nodes.find((n) => n.id === e.source);
          if (!srcNode || srcNode.type !== "input") return;
          const src = String((srcNode.data as PipelineNodeData).inputSource || "").trim();
          if (src) wantedSources.add(src);
        });
    }

    // In historical mode, find resolved metadata stored during the run
    let resolvedMetaBySource: Map<string, { resolvedCallId: string; mergedScope: string; mergedUntilCallId: string }> | null = null;
    if (runContextMode === "historical" && selectedCacheRun) {
      const nodeData = selectedNode.data as PipelineNodeData;
      const stepIdx = typeof nodeData.runStepIndex === "number" ? nodeData.runStepIndex : null;
      const runSteps = parsedRunStepsById.get(selectedCacheRun.id) ?? [];
      if (stepIdx !== null && runSteps[stepIdx]) {
        resolvedMetaBySource = new Map();
        for (const srcEntry of (runSteps[stepIdx].input_sources || [])) {
          const s = String(srcEntry.source || "").trim();
          const resolvedCallId = String(srcEntry.resolved_call_id || "").trim();
          if (s && resolvedCallId) {
            resolvedMetaBySource.set(s, {
              resolvedCallId,
              mergedScope: String(srcEntry.merged_scope || "auto"),
              mergedUntilCallId: String(srcEntry.merged_until_call_id || ""),
            });
          }
        }
      }
    }

    const shouldIncludeFileRefs = selKind === "input";
    Array.from(wantedSources).forEach((src) => {
      const histMeta = resolvedMetaBySource?.get(src);
      void fetchInputPreviewForSource(src, shouldIncludeFileRefs, histMeta);
    });
  }, [selectedNode, selKind, edges, nodes, fetchInputPreviewForSource, runContextMode, selectedCacheRun, parsedRunStepsById]);

  function renderResultViewToggle() {
    return (
      <div className="inline-flex rounded-md border border-gray-700 overflow-hidden">
        <button
          type="button"
          onClick={() => setResultViewMode("rendered")}
          className={cn(
            "px-2 py-0.5 text-[10px] transition-colors",
            resultViewMode === "rendered"
              ? "bg-indigo-900/50 text-indigo-300"
              : "bg-gray-900 text-gray-500 hover:text-gray-300",
          )}
          title="Rendered view"
        >
          Rendered
        </button>
        <button
          type="button"
          onClick={() => setResultViewMode("raw")}
          className={cn(
            "px-2 py-0.5 text-[10px] transition-colors border-l border-gray-700",
            resultViewMode === "raw"
              ? "bg-indigo-900/50 text-indigo-300"
              : "bg-gray-900 text-gray-500 hover:text-gray-300",
          )}
          title="Raw view"
        >
          Raw
        </button>
      </div>
    );
  }

  function stripCodeFence(raw: string): string {
    const s = String(raw || "").trim();
    if (!s.startsWith("```")) return s;
    const lines = s.split("\n");
    if (lines.length < 3) return s;
    if (!lines[0].startsWith("```")) return s;
    const last = lines[lines.length - 1].trim();
    if (last !== "```") return s;
    return lines.slice(1, -1).join("\n").trim();
  }

  function unwrapResponseEnvelope(raw: string): { text: string; unwrapped: boolean } {
    const original = String(raw || "");
    let current = stripCodeFence(original);
    let unwrapped = false;

    const pickPayload = (obj: Record<string, unknown>): unknown => {
      const keys = ["response", "results", "content", "data", "note", "output", "result", "text"];
      for (const key of keys) {
        if (obj[key] != null) return obj[key];
      }
      const ownKeys = Object.keys(obj);
      if (ownKeys.length === 1) return obj[ownKeys[0]];
      return undefined;
    };

    for (let depth = 0; depth < 6; depth += 1) {
      if (!current) break;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(current);
      } catch {
        break;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) break;
      const payload = pickPayload(parsed as Record<string, unknown>);
      if (payload == null) break;

      if (typeof payload === "string") {
        const next = stripCodeFence(payload);
        if (!next.trim()) break;
        current = next.trim();
        unwrapped = true;
        continue;
      }

      if (typeof payload === "object") {
        current = JSON.stringify(payload, null, 2);
        unwrapped = true;
        continue;
      }

      break;
    }

    return { text: current || original, unwrapped };
  }

  const requestRenderedMarkdown = useCallback(async (cacheKey: string, baseText: string) => {
    if (!cacheKey || !baseText.trim()) return;
    setRenderedLlmCache((prev) => {
      const existing = prev[cacheKey];
      if (existing && (existing.status === "loading" || existing.status === "ready")) return prev;
      return {
        ...prev,
        [cacheKey]: { status: "loading", markdown: "", error: "" },
      };
    });

    try {
      const maxChars = 60000;
      const clipped = baseText.length > maxChars
        ? `${baseText.slice(0, maxChars)}\n\n[TRUNCATED_FOR_RENDERING]`
        : baseText;
      const res = await fetch("/api/agent-comparison/reformat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clipped, model: "gpt-4.1" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(body?.detail || body?.error || `HTTP ${res.status}`));
      const markdown = String(body?.result || "").trim();
      if (!markdown) throw new Error("Empty rendered markdown");
      setRenderedLlmCache((prev) => ({
        ...prev,
        [cacheKey]: { status: "ready", markdown, error: "" },
      }));
    } catch (e: any) {
      setRenderedLlmCache((prev) => ({
        ...prev,
        [cacheKey]: {
          status: "error",
          markdown: "",
          error: String(e?.message || "LLM render failed"),
        },
      }));
    }
  }, []);

  function RenderResultContent({ content, sourceHint = "", expand = false }: { content: string; sourceHint?: string; expand?: boolean }) {
    const text = String(content || "");
    const hint = sourceHint.toLowerCase();
    const unwrapped = unwrapResponseEnvelope(text);
    const baseText = String(unwrapped.text || text || "").trim();
    const cacheKey = useMemo(
      () => `${hint || "content"}|${quickHash(baseText)}`,
      [hint, baseText],
    );
    const cacheEntry = renderedLlmCache[cacheKey];
    const shouldEnhanceWithLlm =
      resultViewMode === "rendered"
      && !hint.includes("transcript")
      && baseText.length >= 120;

    useEffect(() => {
      if (!shouldEnhanceWithLlm) return;
      if (cacheEntry && (cacheEntry.status === "loading" || cacheEntry.status === "ready")) return;
      void requestRenderedMarkdown(cacheKey, baseText);
    }, [cacheKey, baseText, cacheEntry, requestRenderedMarkdown, shouldEnhanceWithLlm]);

    if (!text.trim()) {
      return <p className="text-[10px] text-gray-500">No content.</p>;
    }

    const viewportClass = cn(
      "overflow-y-auto overscroll-contain nowheel rounded-lg border border-gray-700 bg-gray-900/60",
      expand ? "flex-1 min-h-0" : "max-h-80",
    );

    const renderRawText = (rawText: string) => (
      <pre
        className={cn(
          "w-full px-2 py-1.5 text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words",
          viewportClass,
        )}
        onWheelCapture={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {rawText}
      </pre>
    );

    if (resultViewMode === "raw") {
      return (
        <div className={cn(expand && "h-full min-h-0 flex flex-col overflow-hidden")}>
          {renderRawText(text)}
        </div>
      );
    }

    // Merged transcript can be extremely long; keep it in raw layout with a
    // dedicated viewport so scrolling is always deterministic.
    if (hint.includes("merged_transcript")) {
      return (
        <div className={cn(expand && "h-full min-h-0 flex flex-col overflow-hidden")}>
          {renderRawText(text)}
        </div>
      );
    }

    if (hint.includes("transcript")) {
      return (
        <div className={cn(expand && "h-full min-h-0 flex flex-col overflow-hidden")}>
          {renderRawText(text)}
        </div>
      );
    }

    if (!baseText) {
      return <p className="text-[10px] text-gray-500">No content.</p>;
    }

    const renderedMarkdown = cacheEntry?.status === "ready" && cacheEntry.markdown.trim()
      ? cacheEntry.markdown
      : baseText;

    return (
      <div className={cn(expand ? "h-full min-h-0 flex flex-col gap-1.5 overflow-hidden" : "space-y-1.5")}>
        {cacheEntry?.status === "loading" && (
          <div className="shrink-0 flex items-center gap-1.5 text-[10px] text-indigo-300">
            <Loader2 className="w-3 h-3 animate-spin" />
            Enhancing rendered layout with LLM…
          </div>
        )}
        {cacheEntry?.status === "error" && (
          <p className="shrink-0 text-[10px] text-amber-300">
            LLM render unavailable ({cacheEntry.error}). Showing local rendered view.
          </p>
        )}
        <div
          className={viewportClass}
          onWheelCapture={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1.5">
            <SectionContent content={renderedMarkdown} format="markdown" />
          </div>
        </div>
      </div>
    );
  }

  function renderInputPreview(source: string, expand = false) {
    const src = String(source || "").trim();
    const preview = src ? inputPreviewBySource[src] : null;
    if (!src) return <p className="text-[11px] text-gray-500">Select an input source type first.</p>;
    if (preview?.loading) {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading input preview…
          </div>
        </div>
      );
    }
    if (preview?.error) return <p className="text-[10px] text-amber-300 whitespace-pre-wrap">{preview.error}</p>;

    const origin = String(preview?.origin || "").trim().toLowerCase();
    const originLabel = origin === "cache"
      ? "Pulled from cache"
      : origin === "computed"
        ? "Calculated now"
        : "";
    const cacheFile = String(preview?.cacheFile || "").trim();
    const resolvedCallId = String(preview?.resolvedCallId || "").trim();
    const fileRefs = preview?.fileRefs && typeof preview.fileRefs === "object"
      ? Object.entries(preview.fileRefs).filter(([k, v]) => String(k).trim() && String(v).trim())
      : [];
    const fileRefText = fileRefs.length
      ? fileRefs.map(([k, v]) => `${k}=${v}`).join(", ")
      : "";
    const fileRefsError = String(preview?.fileRefsError || "").trim();

    return (
      <div className={cn(expand ? "h-full min-h-0 flex flex-col gap-2 overflow-hidden" : "space-y-2")}>
        {(originLabel || cacheFile || resolvedCallId || fileRefText || fileRefsError) && (
          <div className={cn(
            "rounded-lg border border-gray-700 bg-gray-900/50 px-2 py-1.5 space-y-1",
            expand && "shrink-0",
          )}>
            {originLabel && (
              <p className="text-[10px] text-gray-300">
                Source: <span className="text-indigo-300">{originLabel}</span>
              </p>
            )}
            {resolvedCallId && (
              <p className="text-[10px] text-gray-400">Resolved call: {resolvedCallId}</p>
            )}
            {cacheFile && (
              <p className="text-[10px] text-gray-500 break-all">Cache file: {cacheFile}</p>
            )}
            {fileRefText && (
              <p className="text-[10px] text-emerald-300 break-all">File refs: {fileRefText}</p>
            )}
            {fileRefsError && (
              <p className="text-[10px] text-amber-300 break-all">File ref warning: {fileRefsError}</p>
            )}
          </div>
        )}
        <div className={cn(expand && "h-full flex-1 min-h-0 overflow-hidden")}>
          <RenderResultContent content={preview?.content || ""} sourceHint={src} expand={expand} />
        </div>
      </div>
    );
  }

  function openDetailViewer(payload: CanvasDetailViewerState) {
    setDetailViewer({
      title: String(payload.title || "Viewer"),
      subtitle: String(payload.subtitle || ""),
      content: String(payload.content || ""),
      sourceHint: String(payload.sourceHint || ""),
    });
  }

  function renderPopoutButton(payload: CanvasDetailViewerState | null) {
    const disabled = !payload || !String(payload.content || "").trim();
    return (
      <button
        type="button"
        onClick={() => {
          if (!payload) return;
          openDetailViewer(payload);
        }}
        disabled={disabled}
        className={cn(
          "px-2 py-0.5 rounded border text-[10px] transition-colors",
          disabled
            ? "border-gray-800 text-gray-600 cursor-not-allowed"
            : "border-indigo-700/60 text-indigo-300 bg-indigo-950/30 hover:bg-indigo-950/60",
        )}
        title={disabled ? "No content yet" : "Open in separate scrollable window"}
      >
        Open Viewer
      </button>
    );
  }

  function renderDetailViewerModal() {
    if (!detailViewer) return null;
    const text = String(detailViewer.content || "");
    const hint = String(detailViewer.sourceHint || "").toLowerCase();
    const forceRaw = hint.includes("transcript");
    const showRaw = forceRaw || resultViewMode === "raw";

    return (
      <div className="absolute inset-3 z-50 bg-black/70 backdrop-blur-[1px] rounded-xl flex items-center justify-center">
        <div className="relative w-[min(92vw,1240px)] h-[min(84vh,860px)] rounded-xl border border-indigo-700 bg-gray-900 shadow-[0_24px_70px_rgba(0,0,0,0.65)] flex flex-col overflow-hidden">
          <div className="shrink-0 px-3 py-2 border-b border-gray-800 flex items-center gap-2">
            <p className="text-sm font-semibold text-white truncate">{detailViewer.title}</p>
            {detailViewer.subtitle ? (
              <p className="text-[10px] text-gray-500 truncate">· {detailViewer.subtitle}</p>
            ) : null}
            <div className="ml-auto flex items-center gap-1.5">
              {forceRaw ? (
                <span className="text-[10px] px-2 py-0.5 rounded border border-gray-700 text-gray-300 bg-gray-900">
                  Raw
                </span>
              ) : (
                renderResultViewToggle()
              )}
              <button
                type="button"
                onClick={() => setDetailViewer(null)}
                className="h-6 w-6 rounded-md border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 transition-colors flex items-center justify-center"
                title="Close viewer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden p-3">
            {!text.trim() ? (
              <p className="text-[11px] text-gray-500">No content.</p>
            ) : showRaw ? (
              <pre
                className="h-full min-h-0 overflow-y-auto overscroll-contain nowheel rounded-lg border border-gray-700 bg-gray-900 px-2 py-1.5 text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-words"
                onWheelCapture={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
              >
                {text}
              </pre>
            ) : (
              <div
                className="h-full min-h-0 overflow-y-auto overscroll-contain nowheel rounded-lg border border-gray-700 bg-gray-900/60 px-2 py-1.5"
                onWheelCapture={(e) => e.stopPropagation()}
                onWheel={(e) => e.stopPropagation()}
              >
                <SectionContent content={text} format="markdown" />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderCacheRunSelector() {
    if (runContextMode !== "historical") {
      const rid = String(currentRunId || "").trim();
      return (
        <div className="space-y-1">
          <label className="block text-[9px] text-gray-500">Run Context</label>
          <p className="text-[10px] text-gray-500">
            {rid
              ? `New run mode · showing current run ${rid.slice(0, 8)}`
              : "New run mode (no historical results selected)."}
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <label className="block text-[9px] text-gray-500">Historical Run</label>
        <select
          value={selectedCacheRunId}
          onChange={(e) => setSelectedCacheRunId(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[11px] text-white outline-none focus:border-indigo-500"
        >
          <option value="">Select run…</option>
          {cacheRunOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  function renderStepRuntimeDiagnostics(stepCache: StepCacheDisplay | null, stepIndex: number) {
    if (stepIndex < 0) return null;
    const modelInfo = (stepCache?.modelInfo && typeof stepCache.modelInfo === "object")
      ? stepCache.modelInfo
      : {};
    const requestRaw = (stepCache?.requestRaw && typeof stepCache.requestRaw === "object")
      ? stepCache.requestRaw
      : {};
    const responseRaw = String(stepCache?.responseRaw || "");
    const capturedThinking = String(stepCache?.thinking || "");
    const liveThinking = String(liveThinkingByStep[stepIndex] || liveThinkingByStep[-1] || "");
    const liveStream = String(liveStreamByStep[stepIndex] || liveStreamByStep[-1] || "");
    const provider = String(modelInfo.provider || "").trim();
    const modelName = String(modelInfo.model || stepCache?.model || "").trim();
    const temperature = modelInfo.temperature;
    const inputTokens = Number(stepCache?.inputTokenEst || 0);
    const outputTokens = Number(stepCache?.outputTokenEst || 0);
    const hasAnything = Boolean(
      modelName
      || provider
      || inputTokens
      || outputTokens
      || Object.keys(requestRaw).length
      || responseRaw
      || capturedThinking
      || liveThinking
      || liveStream,
    );
    if (!hasAnything) return null;

    const pretty = (obj: any) => JSON.stringify(obj ?? {}, null, 2);

    return (
      <div className="space-y-1.5">
        <details className="rounded-lg border border-gray-700 bg-gray-900/40" open>
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Model Information</summary>
          <div className="px-2 pb-2 text-[10px] text-gray-300 space-y-0.5">
            <div>Provider: {provider || "UNKNOWN"}</div>
            <div>Model: {modelName || "UNKNOWN"}</div>
            <div>Temperature: {temperature == null ? "UNKNOWN" : String(temperature)}</div>
            <div>Agent Class: {String(modelInfo.agent_class || "UNKNOWN")}</div>
            <div>Output Format: {String(modelInfo.output_format || "UNKNOWN")}</div>
          </div>
        </details>

        <details className="rounded-lg border border-gray-700 bg-gray-900/40">
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Token Usage</summary>
          <div className="px-2 pb-2 text-[10px] text-gray-300 space-y-0.5">
            <div>Input Tokens: {Number.isFinite(inputTokens) ? inputTokens : 0}</div>
            <div>Output Tokens: {Number.isFinite(outputTokens) ? outputTokens : 0}</div>
          </div>
        </details>

        <details className="rounded-lg border border-gray-700 bg-gray-900/40">
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Raw Input (Request)</summary>
          <pre className="max-h-44 overflow-auto px-2 pb-2 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words">
            {pretty(requestRaw)}
          </pre>
        </details>

        <details className="rounded-lg border border-gray-700 bg-gray-900/40">
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Raw Response</summary>
          <pre className="max-h-44 overflow-auto px-2 pb-2 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words">
            {responseRaw || String(stepCache?.content || "")}
          </pre>
        </details>

        <details className="rounded-lg border border-gray-700 bg-gray-900/40">
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Thinking (Captured)</summary>
          <pre className="max-h-40 overflow-auto px-2 pb-2 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words">
            {capturedThinking || "No captured thinking."}
          </pre>
        </details>

        <details className="rounded-lg border border-gray-700 bg-gray-900/40" open={running}>
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Thinking (Live Stream)</summary>
          <pre className="max-h-40 overflow-auto px-2 pb-2 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words">
            {liveThinking || (running ? "Streaming thinking…" : "No live thinking stream.")}
          </pre>
        </details>

        <details className="rounded-lg border border-gray-700 bg-gray-900/40" open={running}>
          <summary className="cursor-pointer px-2 py-1 text-[10px] text-indigo-300 font-medium">Output (Live Stream)</summary>
          <pre className="max-h-40 overflow-auto px-2 pb-2 text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-words">
            {liveStream || (running ? "Streaming output…" : "No live output stream.")}
          </pre>
        </details>
      </div>
    );
  }

  function renderPanel() {
    if (!selectedNode || !selData || !selKind || !selMeta) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center text-gray-700">
          <div className="w-14 h-14 rounded-xl border-2 border-dashed border-gray-800 flex items-center justify-center text-2xl">
            ↖
          </div>
          <p className="text-sm font-medium text-gray-600">Click a node on the canvas to edit its properties</p>
        </div>
      );
    }

    if (canvasLocked) {
      const processingStepIndex = selKind === "processing"
        ? runtimeGraph.stepToProcNodeIds.indexOf(selectedNode.id)
        : -1;
      const processingCache = processingStepIndex >= 0 ? getStepCacheDisplay(processingStepIndex) : null;
      const outputProducerNode = (() => {
        if (selKind !== "output") return null;
        const incoming = edges.find(e => e.target === selectedNode.id);
        if (!incoming) return null;
        const src = nodes.find(n => n.id === incoming.source);
        if (!src || src.type !== "processing") return null;
        return src;
      })();
      const outputStepIndex = outputProducerNode
        ? runtimeGraph.stepToProcNodeIds.indexOf(outputProducerNode.id)
        : -1;
      const outputCache = outputStepIndex >= 0 ? getStepCacheDisplay(outputStepIndex) : null;
      const lockedInputSource = selKind === "input" ? String(selData.inputSource || "").trim() : "";
      const lockedInputPreview = lockedInputSource ? inputPreviewBySource[lockedInputSource] : null;
      const lockedViewerPayload: CanvasDetailViewerState | null =
        selKind === "input"
          ? {
              title: "Input Data",
              subtitle: lockedInputSource || "input",
              content: String(lockedInputPreview?.content || ""),
              sourceHint: lockedInputSource || "input",
            }
          : selKind === "processing"
            ? {
                title: "Agent Response",
                subtitle: processingStepIndex >= 0 ? `Step ${processingStepIndex + 1}` : "",
                content: String(processingCache?.content || ""),
                sourceHint: "agent_response",
              }
            : selKind === "output"
              ? {
                  title: "Artifact Result",
                  subtitle: outputStepIndex >= 0 ? `Step ${outputStepIndex + 1}` : "",
                  content: String(outputCache?.content || ""),
                  sourceHint: String(selData.subType || "output"),
                }
              : null;

      return (
        <div className="h-full min-h-0 p-3">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 h-full min-h-0 overflow-hidden lg:[grid-template-rows:minmax(0,1fr)]">
            <div className="lg:col-span-5 min-h-0 overflow-y-auto pr-1 space-y-3">
              <div className={`flex items-center gap-3 px-3.5 py-3 rounded-xl ${selMeta.color}`}>
                <span className="text-white text-lg shrink-0">{selMeta.icon}</span>
                <div className="min-w-0">
                  <p className="text-[10px] text-white/60 uppercase tracking-widest font-bold">
                    {selKind === "output" ? "artifact" : selKind}
                  </p>
                  <p className="text-sm font-bold text-white truncate">{String(selData.label || "Element")}</p>
                </div>
              </div>
              <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-1.5">
                <p className="text-[10px] text-gray-500">Locked live run view</p>
                <p className="text-[11px] text-gray-300">
                  Editing is disabled. You can inspect outputs and runtime state only.
                </p>
                {selKind === "processing" && processingStepIndex >= 0 && (
                  <p className="text-[10px] text-gray-500">Step {processingStepIndex + 1}</p>
                )}
                {selKind === "output" && outputStepIndex >= 0 && (
                  <p className="text-[10px] text-gray-500">Producer Step {outputStepIndex + 1}</p>
                )}
                {selKind === "input" && (
                  <p className="text-[10px] text-gray-500">Source: {String(selData.inputSource || "—")}</p>
                )}
              </div>
            </div>

            <div className={cn(
              "lg:col-span-7 min-h-0 space-y-2.5",
              selKind === "input" ? "h-full min-h-0 flex flex-col overflow-hidden" : "overflow-y-auto",
            )}>
              <PropertiesSection
                title={selKind === "input" ? "Input Data" : selKind === "output" ? "Artifact Result" : "Agent Response"}
                className={selKind === "input" ? "h-full min-h-0 flex-1 flex flex-col" : undefined}
                bodyClassName={selKind === "input" ? "h-full flex-1 min-h-0 flex flex-col overflow-hidden" : undefined}
              >
                <div className={cn("space-y-2", selKind === "input" && "h-full min-h-0 flex flex-col")}>
                  {selKind !== "input" ? renderCacheRunSelector() : null}
                  <div className={cn("flex items-center justify-between gap-2", selKind === "input" && "shrink-0")}>
                    <p className="text-[10px] text-gray-500">
                      {selKind === "processing"
                        ? (processingStepIndex >= 0 ? `Step ${processingStepIndex + 1}` : "Not in execution path")
                        : selKind === "output"
                          ? (outputStepIndex >= 0 ? `Step ${outputStepIndex + 1}` : "No producer connected")
                          : `Context: ${salesAgent || "agent"} · ${customer || "customer"} · ${previewCallId || "no call"}`}
                    </p>
                    <div className="flex items-center gap-1.5">
                      {renderResultViewToggle()}
                      {renderPopoutButton(lockedViewerPayload)}
                    </div>
                  </div>

                  {selKind === "input" ? (
                    <div className="h-full flex-1 min-h-0 flex flex-col overflow-hidden">
                      {(() => {
                        const src = String(selData.inputSource || "").trim();
                        return renderInputPreview(src, true);
                      })()}
                    </div>
                  ) : null}

                  {selKind === "processing" ? (
                    processingCache ? (
                      <>
                        <p className="text-[10px] text-gray-500">
                          {processingCache.source === "selected_run"
                            ? `Run ${String(processingCache.runId || "").slice(0, 8)}`
                            : processingCache.source === "current_run"
                              ? `Current run ${String(processingCache.runId || "").slice(0, 8)}`
                              : "Latest cache"}
                          {processingCache.createdAt ? ` · ${new Date(processingCache.createdAt).toLocaleString()}` : ""}
                        </p>
                        {processingCache.errorMsg && (
                          <p className="text-[10px] text-red-300 whitespace-pre-wrap">{processingCache.errorMsg}</p>
                        )}
                        <RenderResultContent content={processingCache.content || ""} expand />
                        {renderStepRuntimeDiagnostics(processingCache, processingStepIndex)}
                      </>
                    ) : (
                      <p className="text-[11px] text-gray-500">No agent response found for this step in the current context.</p>
                    )
                  ) : null}

                  {selKind === "output" ? (
                    outputCache ? (
                      <>
                        <p className="text-[10px] text-gray-500">
                          {outputCache.source === "selected_run"
                            ? `Run ${String(outputCache.runId || "").slice(0, 8)}`
                            : outputCache.source === "current_run"
                              ? `Current run ${String(outputCache.runId || "").slice(0, 8)}`
                              : "Latest cache"}
                          {outputCache.createdAt ? ` · ${new Date(outputCache.createdAt).toLocaleString()}` : ""}
                        </p>
                        {outputCache.errorMsg && (
                          <p className="text-[10px] text-red-300 whitespace-pre-wrap">{outputCache.errorMsg}</p>
                        )}
                        <RenderResultContent content={outputCache.content || ""} expand />
                      </>
                    ) : (
                      <p className="text-[11px] text-gray-500">No artifact result found for this step in the current context.</p>
                    )
                  ) : null}
                </div>
              </PropertiesSection>
            </div>
          </div>
        </div>
      );
    }

    // ── Agent configurator panel ──────────────────────────────────────────
    if (selKind === "processing") {
      const agId  = selData.agentId as string;
      const agCls = selData.agentClass as string;
      const cm    = classMeta(agCls);
      const usage = agId ? (agentUsageByPipeline[agId] ?? { total: 0, other: 0 }) : { total: 0, other: 0 };
      const stepIndex = runtimeGraph.stepToProcNodeIds.indexOf(selectedNode.id);
      const stepCache = getStepCacheDisplay(stepIndex);
      const processingViewerPayload: CanvasDetailViewerState | null = {
        title: "Agent Response",
        subtitle: stepIndex >= 0 ? `Step ${stepIndex + 1}` : "",
        content: String(stepCache?.content || ""),
        sourceHint: "agent_response",
      };

      type CS = { nodeId: string; typeLabel: string; nodeLabel: string; icon: React.ReactNode; badge: string };
      const incomingSources = edges
        .filter((e) => e.target === selectedNode.id)
        .map((e) => nodes.find((n) => n.id === e.source))
        .filter(Boolean) as Node[];
      const connectedOutputNodes = edges
        .filter((e) => e.source === selectedNode.id)
        .map((e) => nodes.find((n) => n.id === e.target))
        .filter((n): n is Node => {
          if (!n) return false;
          return n.type === "output";
        });
      const inferredAgentClass = inferAgentClassFromConnectedOutputs(connectedOutputNodes, outputProfiles);
      const connectedSources = incomingSources
        .map((src): CS | null => {
          const srcData = src.data as PipelineNodeData;

          if (src.type === "input") {
            const srcMeta = INPUT_SOURCES.find(s => s.value === srcData.inputSource) ?? null;
            const IconComp = srcMeta?.icon ?? Zap;
            return {
              nodeId: src.id,
              typeLabel: srcMeta?.label ?? "Input",
              nodeLabel: srcData.label as string,
              icon: <IconComp className="w-3 h-3 shrink-0" />,
              badge: srcMeta?.badge ?? "bg-gray-700/50 text-gray-300 border-gray-600/50",
            };
          }

          if (src.type === "output") {
            const am = (ARTIFACT_META as Record<string, Meta>)[srcData.subType as string] ?? GENERIC_ARTIFACT_META;
            return {
              nodeId: src.id,
              typeLabel: am.label,
              nodeLabel: srcData.label as string,
              icon: am.icon,
              badge: `${am.color.replace("-700", "-900/40").replace("-800", "-900/30")} ${am.text} ${am.border}`,
            };
          }

          if (src.type === "processing") {
            return {
              nodeId: src.id,
              typeLabel: "Agent Output",
              nodeLabel: srcData.label as string,
              icon: <Bot className="w-3 h-3 shrink-0" />,
              badge: "bg-purple-900/50 text-purple-300 border-purple-700/50",
            };
          }
          return null;
        })
        .filter(Boolean) as CS[];

      return (
        <div className="flex flex-col h-full min-h-0">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
            <AgentClassIcon cls={agCls} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white truncate">
                {agId ? (selData.agentName as string || "Agent") : "Configure Agent"}
              </p>
              <p className={`text-[10px] ${cm.textColor}`}>{agId ? cm.label : "No agent selected"}</p>
              {agId && usage.other > 0 && (
                <p className="text-[10px] mt-0.5 text-amber-300">
                  {`Also in ${usage.other} other pipeline${usage.other !== 1 ? "s" : ""}`}
                </p>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 p-3">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 h-full min-h-0">
              {/* Left: settings */}
              <div className="lg:col-span-3 min-h-0 overflow-y-auto pr-1 space-y-2.5">
                <PropertiesSection title="Name">
                  <input
                    key={`agent-name-${selectedNode.id}-${agId}`}
                    defaultValue={String(selData.agentName || "")}
                    onChange={e => {
                      const next = e.target.value;
                      markElementMutation();
                      setAgentDraft(f => f ? { ...f, name: next } : f);
                    }}
                    onBlur={e => {
                      const next = e.target.value;
                      updateNodeData(selectedNode.id, { agentName: next, label: next });
                    }}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                    placeholder="Agent name…"
                  />
                </PropertiesSection>
                {!agId && (
                  <PropertiesSection title="Agent">
                    <button
                      onClick={handleCreateAgent}
                      className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 text-xs transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" /> Create agent for this node
                    </button>
                  </PropertiesSection>
                )}

                {connectedSources.length > 0 && (
                  <PropertiesSection title="Connected Inputs" defaultOpen={false}>
                    <div className="space-y-1">
                      {connectedSources.map(cs => (
                        <div key={cs.nodeId} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-[10px] ${cs.badge}`}>
                          {cs.icon}
                          <span className="font-medium">{cs.typeLabel}</span>
                          <span className="opacity-60 truncate ml-auto">{cs.nodeLabel}</span>
                        </div>
                      ))}
                    </div>
                  </PropertiesSection>
                )}

                {agentDraft && (
                  <>
                    <PropertiesSection title="Model & Settings">
                      <div className="space-y-2.5">
                        <div className="space-y-1.5">
                          <label className="block text-[9px] text-gray-500">Agent Class</label>
                          <div className="grid grid-cols-2 gap-1.5">
                            {AGENT_CLASS_ORDER.map((cls) => {
                              const meta = classMeta(cls);
                              const isSelected = String(agentDraft.agent_class || "").toLowerCase() === cls;
                              return (
                                <button
                                  key={cls}
                                  type="button"
                                  onClick={() => {
                                    markElementMutation();
                                    setAgentDraft((f) => (f ? { ...f, agent_class: cls } : f));
                                    updateNodeData(selectedNode.id, { agentClass: cls });
                                  }}
                                  className={cn(
                                    "px-2 py-1.5 rounded-lg border text-[10px] text-left transition-colors",
                                    isSelected
                                      ? `${meta.borderColor} bg-gray-800 ${meta.textColor}`
                                      : "border-gray-700/50 bg-gray-800/30 text-gray-400 hover:bg-gray-800",
                                  )}
                                >
                                  {meta.label}
                                </button>
                              );
                            })}
                          </div>
                          {inferredAgentClass ? (
                            <p className="text-[9px] text-gray-500">
                              Auto from connected output:{" "}
                              <span className={classMeta(inferredAgentClass).textColor}>
                                {classMeta(inferredAgentClass).label}
                              </span>
                            </p>
                          ) : (
                            <p className="text-[9px] text-gray-600">No connected output artifact detected.</p>
                          )}
                        </div>
                        <div>
                          <label className="block text-[9px] text-gray-500 mb-1">Model</label>
                          <ModelSelect value={agentDraft.model} onChange={v => {
                            markElementMutation();
                            setAgentDraft(f => f ? { ...f, model: v } : f);
                          }} />
                        </div>
                        <div>
                          <label className="block text-[9px] text-gray-500 mb-1">Temperature</label>
                          <input
                            type="number"
                            min={0}
                            max={2}
                            step={0.1}
                            value={agentDraft.temperature}
                            onChange={e => {
                              markElementMutation();
                              setAgentDraft(f => f ? { ...f, temperature: parseFloat(e.target.value) || 0 } : f);
                            }}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[9px] text-gray-500 mb-1">Output format</label>
                          <div className="flex gap-1.5">
                            {Object.entries(OUTPUT_FMT).map(([k, m]) => {
                              const FmtIcon = m.icon;
                              const isSelected = agentDraft.output_format === k;
                              return (
                                <button
                                  key={k}
                                  onClick={() => {
                                    markElementMutation();
                                    setAgentDraft(f => f ? { ...f, output_format: k } : f);
                                  }}
                                  className={`flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg border text-[9px] transition-all
                                    ${isSelected ? `${m.border} ${m.bg}` : "border-gray-800 bg-gray-900 hover:border-gray-700"}`}
                                >
                                  <FmtIcon className={`w-3.5 h-3.5 ${isSelected ? m.text : "text-gray-600"}`} />
                                  <span className={isSelected ? m.text : "text-gray-500"}>{m.label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </PropertiesSection>

                  </>
                )}

                <button
                  onClick={() => deleteNode(selectedNode.id)}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-gray-800 text-red-500 hover:bg-red-950/40 hover:border-red-800 text-xs transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete node
                </button>
              </div>

              {/* Middle: prompts */}
              <div className="lg:col-span-6 min-h-0 overflow-y-auto pr-1 space-y-2.5">
                {agentDraft ? (
                  <>
                    <PropertiesSection title="System Prompt">
                      <textarea
                        value={agentDraft.system_prompt}
                        onChange={e => {
                          markElementMutation();
                          setAgentDraft(f => f ? { ...f, system_prompt: e.target.value } : f);
                        }}
                        rows={18}
                        placeholder="You are a…"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
                      />
                    </PropertiesSection>

                    <PropertiesSection title="User Prompt">
                      <textarea
                        value={agentDraft.user_prompt}
                        onChange={e => {
                          markElementMutation();
                          setAgentDraft(f => f ? { ...f, user_prompt: e.target.value } : f);
                        }}
                        rows={18}
                        placeholder={"Analyse this:\n\n{transcript}"}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y"
                      />
                    </PropertiesSection>
                  </>
                ) : (
                  <div className="h-full rounded-xl border border-gray-800 bg-gray-900 p-4 text-xs text-gray-500">
                    Select an agent on the left to edit prompts.
                  </div>
                )}
              </div>

              {/* Right: agent response only */}
              <div className="lg:col-span-3 min-h-0 overflow-y-auto space-y-2.5">
                <PropertiesSection title="Agent Response">
                  <div className="space-y-2">
                    {renderCacheRunSelector()}
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] text-gray-500">
                        {stepIndex >= 0 ? `Step ${stepIndex + 1}` : "Not in execution path"}
                      </p>
                      <div className="flex items-center gap-1.5">
                        {renderResultViewToggle()}
                        {renderPopoutButton(processingViewerPayload)}
                      </div>
                    </div>
                    {stepCache ? (
                      <>
                        <p className="text-[10px] text-gray-500">
                          {stepCache.source === "selected_run"
                            ? `Run ${String(stepCache.runId || "").slice(0, 8)}`
                            : stepCache.source === "current_run"
                              ? `Current run ${String(stepCache.runId || "").slice(0, 8)}`
                            : "Latest cache"}
                          {stepCache.createdAt ? ` · ${new Date(stepCache.createdAt).toLocaleString()}` : ""}
                        </p>
                        {stepCache.errorMsg && (
                          <p className="text-[10px] text-red-300 whitespace-pre-wrap">{stepCache.errorMsg}</p>
                        )}
                        <RenderResultContent content={stepCache.content || ""} />
                        {renderStepRuntimeDiagnostics(stepCache, stepIndex)}
                      </>
                    ) : (
                      <p className="text-[11px] text-gray-500">
                        No agent response found for this step in the current context.
                      </p>
                    )}
                  </div>
                </PropertiesSection>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // ── Input / Artifact panel ────────────────────────────────────────────
    const ioCacheTarget = (() => {
      if (selKind !== "output") return null;
      if (!selectedOutputProducer?.node_id) return null;
      const outputStepIndex = runtimeGraph.stepToProcNodeIds.indexOf(selectedOutputProducer.node_id);
      if (outputStepIndex < 0) return null;
      return {
        title: selectedOutputProducer.agent_name || "Producer",
        subtitle: `Step ${outputStepIndex + 1}`,
        stepIndex: outputStepIndex,
      };
    })();
    const inputSource = selKind === "input" ? String(selData.inputSource || "").trim() : "";
    const inputPreview = inputSource ? inputPreviewBySource[inputSource] : null;
    const inputViewerPayload: CanvasDetailViewerState | null = selKind === "input"
      ? {
          title: "Input Data",
          subtitle: inputSource || "input",
          content: String(inputPreview?.content || ""),
          sourceHint: inputSource || "input",
        }
      : null;
    const outputCache = ioCacheTarget ? getStepCacheDisplay(ioCacheTarget.stepIndex) : null;
    const outputSubType = String(selData?.subType || "").trim().toLowerCase();
    const outputIsNotesArtifact = selKind === "output" && (outputSubType === "notes" || outputSubType === "notes_compliance");
    const outputNoteId = String(outputCache?.noteId || "").trim();
    const outputNoteCallId = String(outputCache?.noteCallId || "").trim();

    return (
      <div className="h-full min-h-0 p-3">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 h-full min-h-0 overflow-hidden lg:[grid-template-rows:minmax(0,1fr)]">
          <div className={cn(
            "min-h-0 overflow-y-auto pr-1 space-y-4",
            selKind === "input"
              ? "lg:col-span-3"
              : selKind === "output"
                ? "lg:col-span-7"
                : "lg:col-span-8",
          )}>
            <div className={`flex items-center gap-3 px-3.5 py-3 rounded-xl ${selMeta.color}`}>
              <span className="text-white text-lg shrink-0">{selMeta.icon}</span>
              <div className="min-w-0">
                <p className="text-[10px] text-white/60 uppercase tracking-widest font-bold">
                  {selKind === "output" ? "artifact" : selKind}
                </p>
                <p className="text-sm font-bold text-white truncate">{selData.label}</p>
              </div>
            </div>

            <PropertiesSection title="Name">
              <input value={selData.label}
                onChange={e => updateNodeData(selectedNode.id, { label: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors" />
            </PropertiesSection>

            {selKind === "output" && (
              <PropertiesSection title="Locked Producer">
                {selectedOutputProducer?.agent_id ? (
                  <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-gray-700 bg-gray-800/60">
                    <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="text-xs text-white truncate">{selectedOutputProducer.agent_name}</span>
                  </div>
                ) : (
                  <div className="px-2.5 py-2 rounded-lg border border-gray-700 bg-gray-800/40 text-[11px] text-amber-300">
                    Connect this artifact to a processing node with an assigned agent to lock its template.
                  </div>
                )}
              </PropertiesSection>
            )}

            {selKind === "input" && (
              <PropertiesSection title="Source Type">
                <div className="grid grid-cols-2 gap-1">
                  {INPUT_SOURCES.map(s => {
                    const SrcIcon = s.icon;
                    const isSel = selData.inputSource === s.value;
                    return (
                      <button key={s.value}
                        onClick={() => updateNodeData(selectedNode.id, { inputSource: s.value })}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-left transition-colors
                          ${isSel ? `${s.badge} border` : "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 text-gray-400"}`}>
                        <SrcIcon className="w-3 h-3 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-[10px] font-medium leading-tight truncate">{s.shortLabel}</p>
                          <p className="text-[9px] opacity-60 leading-tight">{s.desc}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </PropertiesSection>
            )}

            {selKind === "output" && (
              <PropertiesSection title="Artifact Type">
                <div className="grid grid-cols-2 gap-1">
                  {(Object.entries(ARTIFACT_META) as [ArtifactSubType, Meta][]).map(([k, m]) => {
                    const req = ARTIFACT_REQUIRES[k];
                    const blocked = req != null && !nodes.some(
                      n => n.type === "output" && n.id !== selectedNode.id && (n.data as PipelineNodeData).subType === req
                    );
                    const isSel = selData.subType === k;
                    if (blocked) {
                      return (
                        <div key={k} title={`Requires ${ARTIFACT_META[req!].label} in the pipeline first`}
                          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-gray-700/30 bg-gray-800/20 opacity-35 cursor-not-allowed">
                          <span className={`p-0.5 rounded-md ${m.color} text-white shrink-0`}>{m.icon}</span>
                          <div className="min-w-0">
                            <p className="text-[10px] font-medium text-gray-500 truncate">{m.label}</p>
                            <p className="text-[9px] text-gray-600 leading-tight">Needs {ARTIFACT_META[req!].label}</p>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <button key={k}
                        onClick={() => updateNodeData(selectedNode.id, { subType: k, label: m.label })}
                        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-left transition-colors
                          ${isSel ? `${m.border} bg-gray-800` : "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 text-gray-400"}`}>
                        <span className={`p-0.5 rounded-md ${m.color} text-white shrink-0`}>{m.icon}</span>
                        <div className="min-w-0 flex-1">
                          <p className={`text-[10px] font-medium truncate ${isSel ? "text-white" : ""}`}>{m.label}</p>
                        </div>
                        {isSel && <Check className="w-3 h-3 text-white shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </PropertiesSection>
            )}

            {selKind === "output" && (
              <PropertiesSection title="Output Profile" defaultOpen={false}>
                <div className="space-y-2">
                  <label className="block text-[9px] text-gray-500 mb-1">
                    Select saved output profile
                  </label>
                  <select
                    value={String(selData.outputProfileId || "")}
                    onChange={e => updateNodeData(selectedNode.id, { outputProfileId: e.target.value })}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-[11px] text-white outline-none focus:border-indigo-500"
                  >
                    <option value="">Default {selMeta.label}</option>
                    {selectableOutputProfiles.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.artifact_type || "artifact"})
                      </option>
                    ))}
                  </select>
                  {String(selData.outputProfileId || "") ? (
                    (() => {
                      const selectedProfile = selectableOutputProfiles.find(p => p.id === String(selData.outputProfileId || ""));
                      if (!selectedProfile) return null;
                      return (
                        <div className="rounded-lg border border-gray-800 bg-gray-900 p-2 space-y-1">
                          <p className="text-[10px] text-indigo-300 font-medium">{selectedProfile.name}</p>
                          <p className="text-[10px] text-gray-500">
                            type: {selectedProfile.artifact_type || "—"} · class: {selectedProfile.artifact_class || "—"} · format: {selectedProfile.output_format}
                          </p>
                          <p className="text-[10px] text-gray-500">
                            mode: {selectedProfile.output_response_mode} · target: {selectedProfile.output_target_type}
                          </p>
                        </div>
                      );
                    })()
                  ) : (
                    <p className="text-[10px] text-gray-500">
                      Using default artifact behavior.
                    </p>
                  )}
                </div>
              </PropertiesSection>
            )}

            {selKind === "output" && (
              <PropertiesSection title="Expected Output Template (Auto)" defaultOpen={false}>
                {!selectedOutputProducer?.agent_id && (
                  <p className="text-[11px] text-gray-600">
                    Template appears automatically once this artifact is linked to a producing agent.
                  </p>
                )}
                {selectedOutputProducer?.agent_id && artifactTemplateLoading && (
                  <div className="flex items-center gap-2 text-[11px] text-gray-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Generating schema from agent prompts…
                  </div>
                )}
                {selectedOutputProducer?.agent_id && !artifactTemplateLoading && artifactTemplate && (
                  <>
                    <textarea
                      readOnly
                      value={artifactTemplate.schema_template || ""}
                      rows={8}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-2 text-[11px] text-gray-300 font-mono resize-y"
                    />
                    <div className="flex flex-wrap gap-1">
                      {(artifactTemplate.taxonomy || []).map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded border border-indigo-700/50 bg-indigo-900/30 text-indigo-300">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] text-gray-600">
                      Locked to producer agent prompt: {selectedOutputProducer.agent_name}
                    </p>
                  </>
                )}
              </PropertiesSection>
            )}

            <p className="text-[10px] text-gray-600">{selMeta.desc}</p>

            <button onClick={() => deleteNode(selectedNode.id)}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-gray-800 text-red-500 hover:bg-red-950/40 hover:border-red-800 text-sm transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> Delete node
            </button>
          </div>

          <div className={cn(
            "min-h-0 space-y-2.5",
            selKind === "input"
              ? "lg:col-span-9 h-full min-h-0 flex flex-col overflow-hidden"
              : selKind === "output"
                ? "lg:col-span-5 min-h-0 flex flex-col overflow-hidden"
                : "lg:col-span-4 overflow-y-auto",
          )}>
            {selKind === "input" && (
              <PropertiesSection
                title="Input Data"
                className="h-full min-h-0 flex-1 flex flex-col"
                bodyClassName="h-full flex-1 min-h-0 flex flex-col overflow-hidden"
              >
                <div className="space-y-2 h-full min-h-0 flex flex-col">
                  <div className="flex items-center justify-between gap-2 shrink-0">
                    <p className="text-[10px] text-gray-500">
                      Context: {salesAgent || "agent"} · {customer || "customer"} · {previewCallId || "no call"}
                    </p>
                    <div className="flex items-center gap-1.5">
                      {renderResultViewToggle()}
                      {renderPopoutButton(inputViewerPayload)}
                    </div>
                  </div>
                  <div className="h-full flex-1 min-h-0 flex flex-col overflow-hidden">
                  {(() => {
                    const src = String(selData.inputSource || "").trim();
                    return renderInputPreview(src, true);
                  })()}
                  </div>
                </div>
              </PropertiesSection>
            )}

            {selKind === "output" && (
              <PropertiesSection
                title="Artifact Result"
                className="h-full flex flex-col"
                bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
              >
                <div className="space-y-2 h-full min-h-0 flex flex-col">
                  {renderCacheRunSelector()}
                  <div className="flex items-center justify-between gap-2 shrink-0">
                    <p className="text-[10px] text-gray-500">
                      {ioCacheTarget ? `${ioCacheTarget.title} · ${ioCacheTarget.subtitle}` : "No producer connected"}
                    </p>
                    <div className="flex items-center gap-1.5">
                      {renderResultViewToggle()}
                      {renderPopoutButton(ioCacheTarget ? {
                        title: "Artifact Result",
                        subtitle: ioCacheTarget.subtitle,
                        content: String(outputCache?.content || ""),
                        sourceHint: String(selData.subType || "output"),
                      } : null)}
                    </div>
                  </div>
                  {outputIsNotesArtifact && ioCacheTarget && (
                    <div className="shrink-0 rounded-lg border border-sky-800/40 bg-sky-950/20 px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold text-sky-200">Manual CRM Send</p>
                          <p className="text-[10px] text-gray-500 truncate">
                            {outputNoteId
                              ? `Note ${outputNoteId.slice(0, 8)}${outputNoteCallId ? ` · call ${outputNoteCallId}` : ""}`
                              : "No saved note_id on this step yet."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void sendNoteToCrmFromCanvas(outputNoteId, String(outputCache?.runId || "").trim())}
                          disabled={!canRunPipelines || !outputNoteId || manualNoteSendPendingId === outputNoteId}
                          title={
                            !canRunPipelines
                              ? "You do not have permission to send notes."
                              : !outputNoteId
                                ? "Run this step first to persist a note artifact."
                                : "Send this note to CRM manually"
                          }
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] font-semibold transition-colors",
                            !outputNoteId || manualNoteSendPendingId === outputNoteId
                              ? "opacity-45 cursor-not-allowed border-gray-700 bg-gray-900 text-gray-400"
                              : "border-sky-700 text-sky-200 bg-sky-900/40 hover:bg-sky-900/60",
                          )}
                        >
                          {manualNoteSendPendingId === outputNoteId ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Send className="w-3 h-3" />
                          )}
                          {manualNoteSendPendingId === outputNoteId ? "Sending…" : "Send Note"}
                        </button>
                      </div>
                      {manualNoteSendMessage && (
                        <p className={cn(
                          "mt-1.5 text-[10px] whitespace-pre-wrap",
                          manualNoteSendError ? "text-red-300" : "text-emerald-300",
                        )}>
                          {manualNoteSendMessage}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {!ioCacheTarget ? (
                      <p className="text-[11px] text-gray-500">
                        Connect this artifact to a processing node to resolve its result.
                      </p>
                    ) : !outputCache ? (
                      <p className="text-[10px] text-gray-500">No artifact result for this step in the current context.</p>
                    ) : (
                      <div className="space-y-2 h-full min-h-0 flex flex-col">
                        <p className="text-[10px] text-gray-500 shrink-0">
                          {outputCache.source === "selected_run"
                            ? `Run ${String(outputCache.runId || "").slice(0, 8)}`
                            : outputCache.source === "current_run"
                              ? `Current run ${String(outputCache.runId || "").slice(0, 8)}`
                              : "Latest cache"}
                          {outputCache.createdAt ? ` · ${new Date(outputCache.createdAt).toLocaleString()}` : ""}
                        </p>
                        {outputCache.errorMsg && (
                          <p className="text-[10px] text-red-300 whitespace-pre-wrap shrink-0">{outputCache.errorMsg}</p>
                        )}
                        <div className="flex-1 min-h-0">
                          <RenderResultContent content={outputCache.content || ""} expand />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </PropertiesSection>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isActivePipeline = !!(pipelineId && pipelineId === activePipelineId);
  const openCrmOverlay = () => {
    setShowCrmPanel(true);
    setShowCallsPanel(false);
    setSelectedNodeId(null);
  };
  const openCallsOverlay = () => {
    if (!salesAgent || !customer) {
      showToast("Select sales agent + customer first", false);
      return;
    }
    setShowCallsPanel(true);
    setShowCrmPanel(false);
    setSelectedNodeId(null);
  };

  const filteredRunLogs = useMemo(() => {
    const byMode = runLogFilterMode === "all"
      ? runLogLines
      : runLogFilterMode === "llm"
        ? runLogLines.filter((l) => l.level === "llm")
        : runLogFilterMode === "pipeline"
          ? runLogLines.filter((l) => l.level === "pipeline")
          : runLogLines.filter((l) => l.level === "error" || l.level === "warn");
    const q = runLogsSearch.trim().toLowerCase();
    if (!q) return byMode;
    return byMode.filter((l) => l.text.toLowerCase().includes(q));
  }, [runLogLines, runLogFilterMode, runLogsSearch]);

  const groupedRunLogs = useMemo(() => {
    const groups: Record<string, CanvasLogLine[]> = {};
    for (const line of filteredRunLogs) {
      const key = line.level;
      (groups[key] ??= []).push(line);
    }
    return groups;
  }, [filteredRunLogs]);

  const logLevelClass = (level: CanvasLogLine["level"]) => {
    if (level === "error") return "text-red-300";
    if (level === "warn") return "text-yellow-300";
    if (level === "pipeline") return "text-indigo-300";
    if (level === "llm") return "text-teal-300";
    return "text-gray-300";
  };

  const liveModeReady = !!(
    pipelineId && (
      liveListenAnyCall
      || (salesAgent && customer && (!runNeedsCall || callId))
    )
  );
  const liveStatusTone =
    liveWebhookStatus === "triggered" ? "border-emerald-600 text-emerald-300 bg-emerald-950/50 hover:bg-emerald-950/70" :
    liveWebhookStatus === "waiting" ? "border-amber-600 text-amber-300 bg-amber-950/40 hover:bg-amber-950/60" :
    liveWebhookStatus === "error" ? "border-red-700 text-red-300 bg-red-950/40 hover:bg-red-950/60" :
    "border-gray-700 text-gray-300 hover:bg-gray-800";
  const liveStatusText =
    liveWebhookStatus === "triggered" ? "Triggered" :
    liveWebhookStatus === "waiting" ? "Waiting" :
    liveWebhookStatus === "error" ? "Error" :
    "Off";

  return (
    <>
    <div className="flex flex-col h-full w-full">

      {/* ── Top toolbar (Context) ─────────────────────────────────────── */}
      <div className="shrink-0 border-b border-gray-800 bg-gray-900">
        <ContextTopBar
          salesAgent={salesAgent}
          customer={customer}
          callId={callId}
          runNeedsCall={runNeedsCall}
          onOpenCrm={openCrmOverlay}
          onOpenCalls={openCallsOverlay}
          disabled={canvasLocked}
          lockedBadge={canvasLocked ? (
            <span className="text-[10px] px-2 py-1 rounded-lg border border-amber-700/60 bg-amber-950/40 text-amber-300 shrink-0">
              LOCKED VIEW
            </span>
          ) : null}
        />

        {/* ── Top toolbar (Pipeline Controls) ─────────────────────────── */}
        <div className="flex flex-nowrap items-center gap-2 px-3 py-2 overflow-x-auto">
          <Workflow className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-sm font-bold text-white shrink-0">Pipeline</span>
          <input
            value={pipelineName}
            onChange={e => setPipelineName(e.target.value)}
            placeholder="Name your pipeline…"
            disabled={canvasLocked}
            className="flex-1 min-w-[180px] bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors"
          />
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-gray-800 bg-gray-950/40">
          <History className="w-3 h-3 text-indigo-400 shrink-0" />
          <span className="px-2 py-1 rounded border border-gray-700 bg-gray-900 text-[10px] text-gray-200 min-w-[115px] text-center">
            {runContextMode === "historical" ? "Historical run" : "New run"}
          </span>
          {runContextMode === "historical" && (
            <button
              type="button"
              onClick={() => exitHistoricalRunContext(true)}
              className="px-2 py-1 rounded border border-gray-700 text-[10px] text-gray-300 hover:bg-gray-800 transition-colors"
              title="Exit historical run view"
            >
              Reset
            </button>
          )}
          <span
            className="px-2 py-1 rounded border border-gray-700 bg-gray-900 text-[10px] text-indigo-300 font-mono min-w-[86px] text-center"
            title={currentRunId ? `Current run id: ${currentRunId}` : "No run id yet"}
          >
            {currentRunId ? currentRunId.slice(0, 8) : "no-run"}
          </span>
        </div>
        <span className="text-[10px] px-2 py-1 rounded-lg border border-gray-800 text-gray-400 bg-gray-950/40 shrink-0">
          Scope: {runNeedsCall ? "per call" : "per pair"}
        </span>

        {pipelineId && (
          <button
            onClick={() => isActivePipeline ? setActivePipeline("", "") : setActivePipeline(pipelineId, pipelineName)}
            disabled={canvasLocked}
            title={isActivePipeline ? "Deactivate this pipeline" : "Set as active pipeline for all executions"}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors shrink-0
              ${isActivePipeline
                ? "bg-emerald-900/50 border-emerald-700 text-emerald-300 hover:bg-emerald-900/80"
                : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isActivePipeline ? "bg-emerald-400" : "bg-gray-600"}`} />
            {isActivePipeline ? "Active" : "Set active"}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (canvasLocked) return;
            if (liveModeEnabled) {
              showToast("Disable Live mode before changing scope", false);
              return;
            }
            setLiveListenAnyCall((v) => !v);
          }}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors shrink-0",
            liveListenAnyCall
              ? "border-cyan-600 text-cyan-200 bg-cyan-950/50 hover:bg-cyan-950/70"
              : "border-gray-700 text-gray-300 hover:bg-gray-800",
          )}
          title={liveListenAnyCall ? "Listening scope: any CRM call" : "Listening scope: selected pair/call"}
        >
          <PhoneCall className="w-3 h-3" />
          Any Call
        </button>

        <button
          type="button"
          onClick={() => {
            if (canvasLocked) return;
            if (liveModeEnabled) {
              setLiveModeEnabled(false);
              setLiveWebhookStatus("off");
              setLiveTriggeredAt("");
              appendRunLog("Live mode disabled", "warn");
              return;
            }
            if (!liveModeReady) {
              showToast(
                liveListenAnyCall
                  ? "Live mode needs a selected pipeline"
                  : `Live mode needs pipeline + sales agent + customer${runNeedsCall ? " + call id" : ""}`,
                false,
              );
              return;
            }
            liveCursorRef.current = Date.now() - 1000;
            setLiveCursorMs(liveCursorRef.current);
            setLiveModeEnabled(true);
            setLiveWebhookStatus("waiting");
            setLogsExpanded(true);
            setLogsCollapsed(false);
          }}
          disabled={canvasLocked || (!liveModeEnabled && !liveModeReady)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors shrink-0",
            liveStatusTone,
            liveModeEnabled && liveWebhookStatus === "waiting" ? "animate-pulse" : "",
            (!liveModeEnabled && !liveModeReady) ? "opacity-40 cursor-not-allowed" : "",
          )}
          title={
            liveModeEnabled
              ? "Disable live webhook wait"
              : "Enable live webhook wait mode for current context"
          }
        >
          <Zap className="w-3 h-3" />
          Live
          <span className="text-[10px] opacity-90">{liveStatusText}</span>
        </button>

        <button
          onClick={() => {
            if (canvasLocked) return;
            if (runContextMode === "historical") {
              setShowHistoricalRunModeDialog(true);
              return;
            }
            void runPipeline("default");
          }}
          disabled={running || canvasLocked || !pipelineId || pipelineSaving || (!salesAgent || !customer) || (runNeedsCall && !callId) || !canRunPipelines}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors shrink-0",
            "bg-emerald-900/30 border-emerald-700 text-emerald-300 hover:bg-emerald-900/50",
            running ? "opacity-45 cursor-not-allowed" : "",
          )}
          title="Run pipeline for selected context"
        >
          <Play className="w-3 h-3" />
          Run
        </button>
        <button
          onClick={() => {
            if (canvasLocked || !running) return;
            void stopPipeline();
          }}
          disabled={canvasLocked || !running || !canRunPipelines}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors shrink-0",
            "bg-slate-900/50 border-slate-700 text-slate-200 hover:bg-slate-800/70",
            !running ? "opacity-45 cursor-not-allowed" : "",
          )}
          title="Cancel current run"
        >
          <Square className="w-3 h-3" />
          Cancel
        </button>
        <button
          onClick={() => {
            setLogsExpanded((prev) => {
              const next = !prev;
              if (next) setLogsCollapsed(false);
              return next;
            });
          }}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors shrink-0",
            logsExpanded
              ? "border-indigo-700 text-indigo-300 bg-indigo-950/40 hover:bg-indigo-950/60"
              : "border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800",
          )}
          title="Toggle run logs panel"
        >
          <History className="w-3 h-3" />
          Logs
        </button>

        {runError && (
          <span className="text-[10px] text-red-300 bg-red-950/40 border border-red-800/40 px-2 py-1 rounded-lg max-w-[360px] truncate">
            {runError}
          </span>
        )}
        {liveModeEnabled && liveTriggeredAt && (
          <span className="text-[10px] text-emerald-300 bg-emerald-950/40 border border-emerald-800/40 px-2 py-1 rounded-lg max-w-[260px] truncate">
            Last live trigger: {formatLocalTime(liveTriggeredAt, true)}
          </span>
        )}
        </div>
      </div>

      {/* ── Main content ──────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left panel: Pipelines + elements ────────────────────────── */}
        <aside
          className={cn(
            "relative shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden order-1 transition-all duration-200",
            logsExpanded && !logsCollapsed && "w-0 border-r-0 opacity-0 pointer-events-none",
          )}
          style={{ width: logsExpanded && !logsCollapsed ? 0 : pipelinesPanelWidth }}
        >
          <div
            onMouseDown={beginResizePipelinesPanel}
            title="Resize pipelines panel"
            className={cn(
              "absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-20 bg-transparent hover:bg-indigo-500/25",
              canvasLocked && "pointer-events-none opacity-40",
            )}
          />

          {/* Pipelines list */}
          <div className="border-b border-gray-800 shrink-0">
            {/* Header row */}
            <div className="px-3 py-2 flex items-center justify-between">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Pipelines</p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { if (!canvasLocked) { setNewPipelineFolderDraft(""); setShowCreatePipelineFolder(true); } }}
                  title="New folder" disabled={canvasLocked}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-indigo-400 hover:bg-gray-800 transition-colors">
                  <Layers className="w-3 h-3" />
                </button>
                <button onClick={handleClear} title="New pipeline" disabled={canvasLocked}
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-indigo-400 hover:bg-gray-800 transition-colors">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="px-2 pb-1.5">
              <input
                type="text"
                value={pipelineSidebarSearch}
                onChange={e => setPipelineSidebarSearch(e.target.value)}
                placeholder="Search pipelines…"
                className="w-full bg-gray-950 border border-gray-800 rounded-md px-2 py-1 text-[11px] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            {/* Folder + pipeline tree */}
            <div className="px-2 pb-2">
              <div className="min-h-[200px] max-h-[52vh] resize-y overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/30 p-1.5 space-y-1.5">
                {pipelineOwners.map((owner) => {
                  const ownerCollapsed = !!collapsedPipelineOwnerIds[owner.ownerKey];
                  return (
                    <div key={owner.ownerKey} className="rounded-lg border border-gray-800 bg-gray-900/35 p-1">
                      {/* Owner header */}
                      <button
                        onClick={() => setCollapsedPipelineOwnerIds(prev => ({ ...prev, [owner.ownerKey]: !prev[owner.ownerKey] }))}
                        className="w-full flex items-center gap-1.5 text-left hover:bg-gray-800/60 rounded px-1.5 py-1 transition-colors"
                      >
                        <ChevronRight className={cn("w-3 h-3 text-gray-500 transition-transform shrink-0", !ownerCollapsed && "rotate-90")} />
                        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest truncate">{owner.ownerLabel}</p>
                        <span className="ml-auto text-[9px] text-gray-600 shrink-0">{owner.total}</span>
                      </button>

                      {!ownerCollapsed && (
                        <div className="mt-1 space-y-1">
                          {owner.folders.map((section) => {
                            const list = section.pipelines ?? [];
                            const sectionId = `${owner.ownerKey}::${section.key || "__unfiled__"}`;
                            const folderCollapsed = !!collapsedPipelineFolderIds[sectionId];
                            const isRenaming = renamingFolderId === section.folderId;
                            const isDraggingThis = draggingFolderId === section.folderId;
                            const isDropTargetReorder = dragOverFolderReorderId === section.folderId;
                            const isDropTargetPipeline = dragOverPipelineFolder === sectionId;

                            return (
                              <div
                                key={sectionId}
                                draggable={section.key !== ""}
                                onDragStart={(e) => {
                                  if (!section.key) return;
                                  e.stopPropagation();
                                  e.dataTransfer.setData("application/x-folder-id", section.folderId);
                                  e.dataTransfer.effectAllowed = "move";
                                  setDraggingFolderId(section.folderId);
                                }}
                                onDragEnd={() => { setDraggingFolderId(null); setDragOverFolderReorderId(null); }}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  if (draggingFolderId && section.key !== "") {
                                    setDragOverFolderReorderId(section.folderId);
                                    setDragOverPipelineFolder(null);
                                  } else {
                                    setDragOverPipelineFolder(sectionId);
                                    setDragOverFolderReorderId(null);
                                  }
                                }}
                                onDragLeave={() => { setDragOverPipelineFolder(null); setDragOverFolderReorderId(null); }}
                                onDrop={async (e) => {
                                  if (canvasLocked) return;
                                  e.preventDefault();
                                  setDragOverPipelineFolder(null);
                                  setDragOverFolderReorderId(null);
                                  const draggedFId = e.dataTransfer.getData("application/x-folder-id");
                                  if (draggedFId && draggedFId !== section.folderId && section.key !== "") {
                                    setDraggingFolderId(null);
                                    const currentOrder = owner.folders.filter(f => f.key !== "").map(f => f.folderId);
                                    const fromIdx = currentOrder.indexOf(draggedFId);
                                    const toIdx = currentOrder.indexOf(section.folderId);
                                    if (fromIdx !== -1 && toIdx !== -1) {
                                      const reordered = [...currentOrder];
                                      reordered.splice(fromIdx, 1);
                                      reordered.splice(toIdx, 0, draggedFId);
                                      void reorderFolders(reordered);
                                    }
                                    return;
                                  }
                                  const pid = e.dataTransfer.getData("application/x-pipeline-id");
                                  if (pid) await movePipelineToFolder(pid, section.folderId);
                                }}
                                className={cn(
                                  "rounded-lg border transition-colors",
                                  isDraggingThis ? "opacity-40 border-gray-700" :
                                  isDropTargetReorder ? "border-blue-500 bg-blue-900/20" :
                                  isDropTargetPipeline ? "border-indigo-500 bg-indigo-900/20" : "border-gray-800",
                                )}
                              >
                                {/* Folder header row */}
                                <div className="group/folder flex items-center gap-0.5 px-1.5 py-0.5">
                                  {/* Color dot */}
                                  {section.color
                                    ? <span className="w-2 h-2 rounded-full shrink-0" style={{ background: section.color }} />
                                    : <span className="w-2 shrink-0" />
                                  }

                                  {/* Rename input OR collapse toggle */}
                                  {isRenaming ? (
                                    <div className="flex-1 min-w-0 flex items-center gap-1">
                                      <input
                                        ref={renameInputRef}
                                        autoFocus
                                        value={renameDraft}
                                        onChange={e => setRenameDraft(e.target.value)}
                                        onBlur={() => void commitFolderRename(section.folderId)}
                                        onKeyDown={e => {
                                          if (e.key === "Enter") { e.preventDefault(); void commitFolderRename(section.folderId); }
                                          if (e.key === "Escape") { setRenamingFolderId(null); }
                                        }}
                                        className="flex-1 min-w-0 bg-gray-800 border border-indigo-500 rounded px-2 py-0.5 text-[11px] text-white focus:outline-none"
                                      />
                                      <button
                                        onClick={() => setRenamingFolderId(null)}
                                        className="shrink-0 p-0.5 text-gray-500 hover:text-gray-300"
                                        title="Cancel"
                                      ><X className="w-3 h-3" /></button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => setCollapsedPipelineFolderIds(prev => ({ ...prev, [sectionId]: !prev[sectionId] }))}
                                      className="flex-1 min-w-0 flex items-center gap-1 text-left hover:bg-gray-800/50 rounded px-1 py-0.5 transition-colors"
                                      title={section.description || undefined}
                                    >
                                      <ChevronRight className={cn("w-3 h-3 text-gray-500 transition-transform shrink-0", !folderCollapsed && "rotate-90")} />
                                      <span className="flex-1 min-w-0 text-[10px] font-semibold text-gray-400 truncate">{section.label}</span>
                                      <span className="text-[9px] text-gray-600 shrink-0">{list.length}</span>
                                    </button>
                                  )}

                                  {/* Hover actions — rename + delete */}
                                  {section.key !== "" && !isRenaming && (
                                    <div className="flex items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 transition-opacity shrink-0">
                                      <button
                                        onClick={() => { setRenamingFolderId(section.folderId); setRenameDraft(section.label); }}
                                        title="Rename folder"
                                        className="p-0.5 text-gray-600 hover:text-indigo-400 transition-colors"
                                      ><PenLine className="w-3 h-3" /></button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); void deletePipelineFolder(section.folderId, section.label); }}
                                        disabled={canvasLocked}
                                        title="Delete folder"
                                        className="p-0.5 text-gray-600 hover:text-red-400 transition-colors disabled:opacity-30"
                                      ><Trash2 className="w-3 h-3" /></button>
                                    </div>
                                  )}
                                </div>

                                {/* Pipeline list */}
                                {!folderCollapsed && (
                                  <div className="pb-0.5">
                                    {list.length === 0 ? (
                                      <p className="text-[9px] text-gray-700 italic px-3 py-1">Empty — drop pipelines here</p>
                                    ) : list.map((p) => (
                                      <div key={p.id} className="flex items-center group/pipeline px-1">
                                        <button
                                          draggable
                                          onDragStart={(e) => {
                                            if (canvasLocked) return;
                                            e.dataTransfer.setData("application/x-pipeline-id", p.id);
                                            e.dataTransfer.effectAllowed = "move";
                                          }}
                                          onClick={async () => {
                                            if (canvasLocked) return;
                                            const fullPl = await fetch(`/api/pipelines/${p.id}`).then(r => r.json());
                                            loadPipelineToCanvas(p.id, { id: fullPl.id, name: fullPl.name, folder: fullPl.folder ?? "", steps: fullPl.steps ?? [], canvas: fullPl.canvas });
                                          }}
                                          disabled={canvasLocked}
                                          className={cn(
                                            "flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] text-left transition-colors",
                                            pipelineId === p.id ? "bg-indigo-900/40 text-white" : "text-gray-400 hover:text-white hover:bg-gray-800",
                                          )}
                                        >
                                          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", pipelinesWithActiveRuns.has(p.id) ? "bg-amber-400 animate-pulse" : p.id === activePipelineId ? "bg-emerald-400" : "bg-gray-700")}
                                            title={pipelinesWithActiveRuns.has(p.id) ? "Has active runs" : p.id === activePipelineId ? "Active" : ""} />
                                          <span className="truncate flex-1">{p.name}</span>
                                          {p.scope && p.scope !== "per_call" && (
                                            <span className="shrink-0 text-[8px] px-1 rounded bg-gray-800 text-gray-500 uppercase leading-none"
                                              title={p.scope === "per_pair" ? "Runs once per agent-customer pair" : p.scope}>
                                              {p.scope === "per_pair" ? "pair" : p.scope}
                                            </span>
                                          )}
                                        </button>
                                        <button onClick={() => handleDuplicatePipeline(p.id)} disabled={canvasLocked}
                                          title="Duplicate" className="shrink-0 p-1 text-gray-700 hover:text-indigo-400 opacity-0 group-hover/pipeline:opacity-100 transition-all">
                                          <Copy className="w-3 h-3" />
                                        </button>
                                        <button onClick={() => handleDeletePipeline(p.id)} disabled={canvasLocked}
                                          title="Delete" className="shrink-0 p-1 text-gray-700 hover:text-red-400 opacity-0 group-hover/pipeline:opacity-100 transition-all">
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {allPipelines.length === 0 && pipelineFolders.length === 0 && (
                  <p className="text-[10px] text-gray-700 italic px-2 py-2">No pipelines yet</p>
                )}
              </div>
            </div>
          </div>

          {/* Elements header */}
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Elements</p>
            <p className="text-[9px] text-gray-700 mt-0.5">Click to add to next available slot</p>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
            <div className="rounded-lg border border-gray-800 bg-gray-950/30 p-2 space-y-1.5">
              <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest px-0.5">Pipeline Actions</p>
              <button
                onClick={importPresets}
                title="Import agent presets"
                disabled={canvasLocked}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:text-white hover:bg-gray-800 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-3 h-3" />
                Presets
              </button>
              <button
                onClick={handleCopyPipelineBundle}
                disabled={canvasLocked}
                title="Copy full pipeline bundle (workflow + agents)"
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:text-white hover:bg-gray-800 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ClipboardCopy className="w-3 h-3" />
                Copy Bundle
              </button>
              <button
                onClick={() => setShowBundleImport(true)}
                disabled={canvasLocked}
                title="Paste bundle from another environment"
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:text-white hover:bg-gray-800 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ClipboardPaste className="w-3 h-3" />
                Paste Bundle
              </button>
              <div className="flex gap-1 w-full">
                <button
                  onClick={handleUndo}
                  disabled={canvasLocked || canvasUndoLen === 0}
                  title="Undo (Ctrl+Z)"
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Undo2 className="w-3 h-3" />
                </button>
                <button
                  onClick={handleRedo}
                  disabled={canvasLocked || canvasRedoLen === 0}
                  title="Redo (Ctrl+Y)"
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Redo2 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setShowPipelineHistoryModal(true)}
                  disabled={!pipelineId}
                  title="Restore from saved history"
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <History className="w-3 h-3" />
                </button>
              </div>
              <button
                onClick={handleSave}
                disabled={canvasLocked}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-800/60 text-emerald-300 hover:text-emerald-200 hover:bg-emerald-950/30 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Check className="w-3 h-3" />
                Validate
              </button>
              <button
                onClick={handleSavePipeline}
                disabled={canvasLocked || pipelineSaving}
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pipelineSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                Save
              </button>
              <button
                onClick={handleClear}
                disabled={canvasLocked}
                title="Clear canvas / new pipeline"
                className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-500 hover:text-red-400 hover:border-red-900 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            </div>

            {PALETTE_GROUPS.map(group => (
              <div key={group.kind}>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1 mb-1.5">
                  {group.label}
                </p>

                {/* flat items (processing) */}
                {group.items && (
                  <div className="space-y-1">
                    {group.items.map(({ subType, meta }) => (
                      <PaletteItem key={subType} kind={group.kind} subType={subType} meta={meta} onAdd={addNodeToCanvas} />
                    ))}
                  </div>
                )}

                {/* sub-grouped items (data sources) */}
                {group.subGroups && (
                  <div className="space-y-2">
                    {group.subGroups.map(sg => (
                      <div key={sg.label}>
                        <p className="text-[9px] font-bold text-gray-700 uppercase tracking-wider px-1 mb-1">{sg.label}</p>
                        <div className="space-y-1">
                          {sg.items.map(({ subType, meta }) => (
                            <PaletteItem key={subType} kind={group.kind} subType={subType} meta={meta} onAdd={addNodeToCanvas} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* ── Artifacts section ────────────────────────────────────── */}
            <div>
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1 mb-1.5">Artifacts</p>
              <div className="space-y-1">
                <PaletteItem kind="output" subType="" meta={GENERIC_ARTIFACT_META} onAdd={addNodeToCanvas} />
              </div>
            </div>
          </div>

          {/* Flow rules + Add Stage */}
          <div className="p-2.5 border-t border-gray-800 shrink-0">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest">Flow rules</p>
              <div className="flex items-center gap-2">
                {stages.length > INIT_STAGES.length && (
                  <button onClick={handleRemoveStage}
                    disabled={canvasLocked}
                    className="text-[10px] text-red-500 hover:text-red-400 font-semibold transition-colors">
                    - Layer
                  </button>
                )}
                {stages.length < MAX_TOTAL_STAGES && (
                  <button onClick={handleAddStage}
                    disabled={canvasLocked}
                    className="text-[10px] text-indigo-500 hover:text-indigo-400 font-semibold transition-colors">
                    + Layer
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-0.5 text-[10px]">
              <p className="text-gray-500"><span className="text-blue-400">Input</span> → <span className="text-indigo-400">Processing</span> ✓</p>
              <p className="text-gray-500"><span className="text-indigo-400">Processing</span> → <span className="text-violet-400">Artifact</span> ✓</p>
              <p className="text-gray-700 line-through text-[9px]">Processing → Processing</p>
              <p className="text-gray-600 text-[9px]">Flows top-to-bottom only</p>
            </div>
          </div>
        </aside>

        {/* ── Canvas ────────────────────────────────────────────────────── */}
        <style>{HANDLE_CSS + NODE_RUNTIME_CSS}</style>
        <div className="flex-1 relative order-2" ref={canvasContainerRef} onDrop={onDrop} onDragOver={onDragOver}>
          <SwimbarBackdrop stages={stages} viewport={canvasViewport} />
          <ReactFlow
            nodes={allNodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChangeFiltered}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            isValidConnection={isValidConnectionFn}
            nodesDraggable={!canvasLocked}
            nodesConnectable={!canvasLocked}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={canvasLocked ? null : "Delete"}
            proOptions={{ hideAttribution: true }}
            className="bg-gray-900 relative z-10"
          >
            <Background variant={BackgroundVariant.Dots} color="#4b5563" gap={22} size={1.25} />
          </ReactFlow>

          {nodes.length === 0 && (
            <div className="absolute pointer-events-none select-none"
              style={{ left: 240, top: 40 + 52 + 22 }}>
              <p className="text-xs text-gray-700 italic">← click elements from the left panel to add them</p>
            </div>
          )}

          {showCallsPanel && (
            <div className="absolute inset-0 z-40 bg-black p-3 flex items-center justify-center">
              <div
                className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-indigo-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible"
                style={{ animation: "canvasPopupIn 180ms ease-out" }}
              >
                <button
                  onClick={() => setShowCallsPanel(false)}
                  className="absolute -top-6 left-1/2 -translate-x-1/2 z-40 h-12 w-12 rounded-full border-2 border-red-300/80 bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center shadow-2xl"
                  title="Close Calls panel"
                >
                  <X className="w-6 h-6" />
                </button>
                <div className="h-full w-full rounded-[inherit] overflow-hidden">
                  <div className="h-12 px-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
                    <PhoneCall className="w-4 h-4 text-amber-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-white font-semibold truncate">Calls</p>
                      <p className="text-[10px] text-gray-500 truncate">
                        {salesAgent || "Agent"} · {customer || "Customer"} · {callId ? `Call ${callId}` : "No call selected"}
                      </p>
                    </div>
                  </div>
                  <div className="h-[calc(100%-3rem)] min-h-0 grid grid-cols-1 lg:grid-cols-12">
                    <section className="lg:col-span-4 border-r border-gray-800 min-h-0 flex flex-col">
                      <div className="h-10 px-3 border-b border-gray-800 flex items-center">
                        <p className="text-[11px] font-semibold text-gray-200">Call IDs</p>
                      </div>
                      <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {callOptions.length === 0 && (
                          <p className="text-xs text-gray-500 italic px-1 py-2">
                            Select sales agent + customer to load calls.
                          </p>
                        )}
                        {callOptions.map(([cid, meta]) => {
                          const selected = normalizeCallId(cid) === normalizeCallId(callId);
                          const txCall = transcriptCallMapByNorm.get(normalizeCallId(cid));
                          const hasTranscript = !!(
                            txCall?.final_path
                            || txCall?.smoothed_path
                            || txCall?.voted_path
                            || txCall?.pipeline_final_files?.[0]?.path
                          );
                          const callArtifacts = pipelineCallMapByNorm[normalizeCallId(cid)];
                          const artifactTypes = Array.from(new Set((callArtifacts?.artifact_types ?? []).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)));
                          return (
                            <button
                              key={cid}
                              onClick={() => applySelectedCallId(cid)}
                              className={cn(
                                "w-full text-left px-2.5 py-2 rounded-lg border transition-colors",
                                selected
                                  ? "border-amber-600/70 bg-amber-900/30"
                                  : "border-gray-800 bg-gray-900 hover:bg-gray-800",
                              )}
                            >
                              <div className="flex items-center gap-1.5">
                                <p className="text-xs font-mono text-gray-100 truncate flex-1">{cid}</p>
                                {hasTranscript && (
                                  <span
                                    title="Transcript available"
                                    className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-teal-700/60 bg-teal-900/35 text-teal-300"
                                  >
                                    <FileText className="h-3 w-3" />
                                  </span>
                                )}
                                {artifactTypes.map((tp) => {
                                  const isPersona = tp.includes("persona") && !tp.includes("score");
                                  const isScore = tp.includes("score");
                                  const isNotes = tp.includes("note") && !tp.includes("compliance");
                                  const isCompliance = tp.includes("compliance") || tp.includes("violation");
                                  const Icon = isPersona ? User : isScore ? BadgeCheck : isNotes ? StickyNote : isCompliance ? ShieldCheck : Bot;
                                  const classes = isPersona
                                    ? "border-fuchsia-700/60 bg-fuchsia-900/35 text-fuchsia-300"
                                    : isScore
                                      ? "border-amber-700/60 bg-amber-900/35 text-amber-300"
                                      : isNotes
                                        ? "border-indigo-700/60 bg-indigo-900/35 text-indigo-300"
                                        : isCompliance
                                          ? "border-emerald-700/60 bg-emerald-900/35 text-emerald-300"
                                          : "border-violet-700/60 bg-violet-900/35 text-violet-300";
                                  return (
                                    <span
                                      key={`${cid}-${tp}`}
                                      title={`Artifact: ${tp}`}
                                      className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md border", classes)}
                                    >
                                      <Icon className="h-3 w-3" />
                                    </span>
                                  );
                                })}
                              </div>
                              <p className="text-[10px] text-gray-500 truncate">
                                {formatDateLabel(meta?.date)}
                                {formatDurationLabel(meta?.duration_s) ? ` · ${formatDurationLabel(meta?.duration_s)}` : ""}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                    <section className="lg:col-span-8 min-h-0 flex flex-col">
                      <div className="h-10 px-3 border-b border-gray-800 flex items-center">
                        <p className="text-[11px] font-semibold text-gray-200">Transcript</p>
                      </div>
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {!callId ? (
                          <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                            Select a Call ID to preview transcript.
                          </div>
                        ) : callTranscriptLoading ? (
                          <div className="h-full flex items-center justify-center gap-2 text-gray-400 text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading transcript…
                          </div>
                        ) : callTranscriptError ? (
                          <div className="h-full flex items-center justify-center text-red-300 text-sm px-4 text-center">
                            {callTranscriptError}
                          </div>
                        ) : callTranscriptText ? (
                          <div className="h-full p-2">
                            <TranscriptViewer content={callTranscriptText} format="txt" className="h-full" />
                          </div>
                        ) : (
                          <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                            No transcript content.
                          </div>
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showCrmPanel && (
            <div className="absolute inset-0 z-40 bg-black p-3 flex items-center justify-center">
              <div
                className="relative w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-cyan-800 bg-gray-950 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible"
                style={{ animation: "canvasPopupIn 180ms ease-out" }}
              >
                <button
                  onClick={() => setShowCrmPanel(false)}
                  className="absolute -top-6 left-1/2 -translate-x-1/2 z-40 h-12 w-12 rounded-full border-2 border-red-300/80 bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center shadow-2xl"
                  title="Close CRM panel"
                >
                  <X className="w-6 h-6" />
                </button>
                <div className="h-full w-full rounded-[inherit] overflow-hidden">
                  <iframe
                    title="CRM Browser"
                    src={crmPanelUrl}
                    className="w-full h-full border-0 bg-gray-900"
                  />
                </div>
              </div>
            </div>
          )}

          {showHistoricalRunModeDialog && (
            <div className="absolute inset-0 z-50 bg-black/80 p-4 flex items-center justify-center">
              <div className="w-full max-w-md rounded-xl border border-indigo-700 bg-gray-900 shadow-2xl">
                <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                  <p className="text-sm font-semibold text-white">Historical Run Options</p>
                  <button
                    onClick={() => setShowHistoricalRunModeDialog(false)}
                    className="p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
                    title="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-xs text-gray-400">
                    Choose how to execute this pipeline from historical context.
                  </p>
                  <button
                    onClick={() => {
                      setShowHistoricalRunModeDialog(false);
                      void runPipeline("force_full");
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-red-700/60 bg-red-950/30 hover:bg-red-950/50 transition-colors"
                  >
                    <p className="text-xs font-semibold text-red-200">Force Full Rerun</p>
                    <p className="text-[11px] text-red-300/80 mt-0.5">Run all steps again from scratch.</p>
                  </button>
                  <button
                    onClick={() => {
                      setShowHistoricalRunModeDialog(false);
                      void runPipeline("failed_only");
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border border-amber-700/60 bg-amber-950/30 hover:bg-amber-950/50 transition-colors"
                  >
                    <p className="text-xs font-semibold text-amber-200">Run Failed Parts Only</p>
                    <p className="text-[11px] text-amber-300/80 mt-0.5">
                      Re-run failed steps, reuse cache for the rest.
                    </p>
                  </button>
                </div>
              </div>
            </div>
          )}

          {logsExpanded && (
            <div
              className={cn(
                "absolute right-0 top-0 bottom-0 z-20 border-l border-indigo-800 bg-gray-950 shadow-2xl overflow-hidden transition-all duration-200",
                logsCollapsed ? "w-14" : "",
              )}
              style={{ width: logsCollapsed ? 56 : LOGS_PANEL_WIDTH }}
            >
              <div className="h-12 px-3 flex items-center gap-2 border-b border-gray-800">
                <History className="w-4 h-4 text-indigo-400 shrink-0" />
                {!logsCollapsed && (
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-200 font-semibold">Run Logs</p>
                    <p className="text-[10px] text-gray-500 truncate">
                      {running ? "Pipeline executing…" : (runLogLines.length ? `${runLogLines.length} events` : "No run events yet")}
                    </p>
                  </div>
                )}
                <button
                  onClick={() => setLogsCollapsed(v => !v)}
                  className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
                  title={logsCollapsed ? "Expand logs panel" : "Minimize logs panel"}
                >
                  {logsCollapsed ? <ChevronRight className="w-4 h-4" /> : <X className="w-4 h-4" />}
                </button>
              </div>
              {!logsCollapsed && (
                <div className="h-[calc(100%-3rem)] flex flex-col min-h-0">
                  <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-1">
                    {(["all", "llm", "pipeline", "errors"] as CanvasLogFilterMode[]).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setRunLogFilterMode(mode)}
                        className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                          runLogFilterMode === mode
                            ? mode === "llm"
                              ? "bg-teal-800 text-teal-200"
                              : mode === "pipeline"
                                ? "bg-indigo-800 text-indigo-200"
                                : mode === "errors"
                                  ? "bg-red-800 text-red-200"
                                  : "bg-gray-700 text-white"
                            : "text-gray-500 hover:text-gray-300",
                        )}
                      >
                        {mode === "all" ? "All" : mode === "llm" ? "LLM" : mode === "pipeline" ? "Pipeline" : "Errors"}
                      </button>
                    ))}
                  </div>
                  <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2">
                    <input
                      className="flex-1 min-w-0 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-[11px] text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                      placeholder="Filter logs…"
                      value={runLogsSearch}
                      onChange={(e) => setRunLogsSearch(e.target.value)}
                    />
                    <button
                      onClick={() => setRunLogsGrouped((v) => !v)}
                      className={cn(
                        "px-2 py-1 rounded border text-[10px] transition-colors",
                        runLogsGrouped
                          ? "border-violet-700 bg-violet-900 text-violet-200"
                          : "border-gray-700 text-gray-400 hover:bg-gray-800",
                      )}
                    >
                      Group
                    </button>
                    <button
                      onClick={() => setRunLogLines([])}
                      className="px-2 py-1 rounded border border-gray-700 text-[10px] text-gray-400 hover:bg-gray-800 transition-colors"
                    >
                      Clear
                    </button>
                    <span className="text-[10px] text-gray-600">{filteredRunLogs.length}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-1 font-mono">
                    {filteredRunLogs.length === 0 ? (
                      <p className="text-xs text-gray-600 italic px-1 py-2">Run logs will appear here.</p>
                    ) : runLogsGrouped ? (
                      <>
                        {Object.entries(groupedRunLogs).map(([group, lines]) => (
                          <div key={group} className="mb-2">
                            <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                              {group} ({lines.length})
                            </p>
                            <div className="pl-2 border-l border-gray-800 space-y-0.5">
                              {lines.map((line, idx) => (
                                <div key={`${group}-${idx}`} className="flex gap-2 leading-5 items-start">
                                  <span className="text-gray-700 shrink-0 w-16">{line.ts}</span>
                                  <span className={cn("min-w-0 whitespace-pre-wrap break-words", logLevelClass(line.level))}>
                                    {line.text}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <>
                        {filteredRunLogs.map((line, idx) => (
                          <div key={`${line.ts}-${idx}`} className="flex gap-2 leading-5 items-start">
                            <span className="text-gray-700 shrink-0 w-16">{line.ts}</span>
                            <span className={cn("min-w-0 whitespace-pre-wrap break-words", logLevelClass(line.level))}>
                              {line.text}
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {showCreatePipelineFolder && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
              <div
                className="w-full max-w-2xl rounded-xl border border-indigo-700 bg-gray-900 shadow-[0_30px_80px_rgba(0,0,0,0.7)]"
                style={{ animation: "canvasPopupIn 180ms ease-out" }}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                  <p className="text-sm font-semibold text-white">Create Pipeline Folder</p>
                  <button
                    onClick={() => setShowCreatePipelineFolder(false)}
                    className="text-gray-500 hover:text-gray-300 transition-colors"
                    disabled={canvasLocked}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-xs text-gray-400">
                    Folder names can be long (for example: Production / Brokerage / Per-Call Notes). You can resize the input box.
                  </p>
                  <textarea
                    value={newPipelineFolderDraft}
                    onChange={(e) => setNewPipelineFolderDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void createPipelineFolder();
                      }
                    }}
                    placeholder="Folder name"
                    rows={4}
                    className="w-full min-h-[110px] bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-[12px] text-gray-200 resize focus:outline-none focus:border-indigo-500"
                    disabled={canvasLocked}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setShowCreatePipelineFolder(false)}
                      disabled={canvasLocked}
                      className="px-3 py-1.5 rounded-lg border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { void createPipelineFolder(); }}
                      disabled={canvasLocked}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors disabled:opacity-60"
                    >
                      Create Folder
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showBundleImport && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black p-4">
              <div
                className="w-full max-w-3xl rounded-xl border border-indigo-700 bg-gray-900 shadow-[0_30px_80px_rgba(0,0,0,0.7)]"
                style={{ animation: "canvasPopupIn 180ms ease-out" }}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                  <p className="text-sm font-semibold text-white">Paste Pipeline Bundle</p>
                  <button
                    onClick={() => !bundleImporting && setShowBundleImport(false)}
                    className="text-gray-500 hover:text-gray-300 transition-colors"
                    disabled={bundleImporting}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-xs text-gray-400">
                    Paste exported bundle JSON. Import will recreate pipeline + agents in a dedicated folder.
                  </p>
                  <input
                    value={bundleImportFolder}
                    onChange={e => setBundleImportFolder(e.target.value)}
                    placeholder="Target folder (optional). Example: Imported Bundles / Dev Sync"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    disabled={bundleImporting}
                  />
                  <textarea
                    value={bundleImportText}
                    onChange={e => setBundleImportText(e.target.value)}
                    placeholder='{"bundle_version":1,"pipeline":{...},"agents":[...]}'
                    rows={14}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-[11px] text-gray-200 font-mono resize-y focus:outline-none focus:border-indigo-500"
                    disabled={bundleImporting}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setShowBundleImport(false)}
                      disabled={bundleImporting}
                      className="px-3 py-1.5 rounded-lg border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleImportPipelineBundle}
                      disabled={bundleImporting}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors disabled:opacity-60"
                    >
                      {bundleImporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardPaste className="w-3 h-3" />}
                      Import Bundle
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showBundleCopyFallback && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black p-4">
              <div
                className="w-full max-w-3xl rounded-xl border border-indigo-700 bg-gray-900 shadow-[0_30px_80px_rgba(0,0,0,0.7)]"
                style={{ animation: "canvasPopupIn 180ms ease-out" }}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                  <p className="text-sm font-semibold text-white">Copy Pipeline Bundle</p>
                  <button
                    onClick={() => setShowBundleCopyFallback(false)}
                    className="text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="p-4 space-y-3">
                  <p className="text-xs text-gray-400">
                    Clipboard is blocked in this browser context. Copy this JSON manually.
                  </p>
                  <textarea
                    value={bundleCopyText}
                    readOnly
                    rows={14}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-[11px] text-gray-200 font-mono resize-y"
                  />
                  <div className="flex items-center justify-end">
                    <button
                      onClick={() => setShowBundleCopyFallback(false)}
                      className="px-3 py-1.5 rounded-lg border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {toast && (
            <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-5 py-3 rounded-xl border text-sm font-medium shadow-2xl whitespace-nowrap
              ${toast.ok
                ? "bg-emerald-950 border-emerald-700 text-emerald-200"
                : "bg-red-950 border-red-800 text-red-300"}`}>
              {toast.msg}
              <button onClick={() => setToast(null)} className="opacity-60 hover:opacity-100 transition-opacity">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {selectedNodeId && (
            <div className="absolute inset-0 z-30 bg-black p-3 flex items-center justify-center">
              <div
                className="relative nowheel w-[min(95vw,1500px)] h-[min(90vh,920px)] rounded-xl border border-indigo-700 bg-gray-900 shadow-[0_32px_90px_rgba(0,0,0,0.68)] overflow-visible flex flex-col"
                style={{ animation: "canvasPopupIn 180ms ease-out" }}
              >
                <button
                  onClick={() => setSelectedNodeId(null)}
                  className="absolute -top-6 left-1/2 -translate-x-1/2 z-40 h-12 w-12 rounded-full border-2 border-red-300/80 bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center shadow-2xl"
                  title="Close editor"
                >
                  <X className="w-6 h-6" />
                </button>
                <div className="h-full w-full rounded-[inherit] overflow-hidden flex flex-col">
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {renderPanel()}
                  </div>
                </div>
                {renderDetailViewerModal()}
              </div>
            </div>
          )}

        </div>

        {/* ── Right panel: Run history ────────────────────────────────── */}
        <aside className="w-52 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col overflow-hidden order-3">
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Run History</p>
            <p className="text-[9px] text-gray-700 mt-0.5">
              {historyRuns.length > 0
                ? `${historyRuns.length} runs for current context`
                : "No runs yet for current filter"}
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {historyRuns.length === 0 && (
              <p className="text-xs text-gray-600 italic px-1 py-2">No runs found.</p>
            )}
            {historyRunDayGroups.map((group) => {
              const dayCollapsed = !!collapsedHistoryDayIds[group.dayId];
              return (
                <div key={group.dayId} className="space-y-1.5">
                  <button
                    onClick={() => setCollapsedHistoryDayIds((prev) => ({ ...prev, [group.dayId]: !prev[group.dayId] }))}
                    className="w-full flex items-center gap-1.5 px-1 py-1 rounded text-left hover:bg-gray-800/60 transition-colors"
                    title={dayCollapsed ? "Expand day folder" : "Collapse day folder"}
                  >
                    <ChevronRight className={cn("w-3.5 h-3.5 text-gray-500 transition-transform shrink-0", !dayCollapsed && "rotate-90")} />
                    <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wide truncate">{group.label}</span>
                    <span className="ml-auto text-[9px] text-gray-600">{group.runs.length}</span>
                  </button>
                  {!dayCollapsed && group.runs.map((run) => {
                    const expanded = !!expandedHistoryRunIds[run.id];
                    const historicalSelected = runContextMode === "historical" && selectedCacheRunId === run.id;
                    const timeline = runTimelineById.get(run.id);
                    const runStatus = normalizeStateToken(run.status);
                    const rowStatuses = timeline?.rows.map((r) => r.status) ?? [];
                    const hasRowCancelled = rowStatuses.includes("cancelled");
                    const hasRowFailed = rowStatuses.includes("failed");
                    const hasRowRunning = rowStatuses.includes("running");
                    const runFinishedTs = (() => {
                      const raw = String(run.finished_at || "").trim();
                      if (!raw) return null;
                      const ts = Date.parse(raw);
                      return Number.isFinite(ts) ? ts : null;
                    })();
                    const runIsActive = isActiveRunLike(runStatus) && runFinishedTs == null;
                    const displayStatus = hasRowCancelled
                      ? "cancelled"
                      : hasRowFailed
                        ? "failed"
                        : hasRowRunning && !runIsActive
                          ? "cancelled"
                          : runStatus;
                    const runStatusClass = isCompletedLike(displayStatus)
                      ? "text-emerald-300 border-emerald-700/50 bg-emerald-950/40"
                      : isFailedLike(displayStatus)
                        ? "text-red-300 border-red-700/50 bg-red-950/40"
                        : isCancelledLike(displayStatus)
                          ? "text-slate-200 border-slate-700/50 bg-slate-900/50"
                        : displayStatus === "queued"
                          ? "text-sky-200 border-sky-700/50 bg-sky-950/40"
                          : displayStatus === "preparing"
                            ? "text-cyan-200 border-cyan-700/50 bg-cyan-950/40"
                            : displayStatus === "retrying"
                              ? "text-violet-200 border-violet-700/50 bg-violet-950/40"
                              : "text-orange-300 border-orange-700/50 bg-orange-950/40";
                    return (
                      <div
                        key={run.id}
                        className={cn(
                          "rounded-lg border px-2 py-2 transition-colors",
                          historicalSelected
                            ? "border-indigo-500 bg-indigo-950/35 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]"
                            : "border-gray-800 bg-gray-900",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setExpandedHistoryRunIds((prev) => ({ ...prev, [run.id]: !prev[run.id] }))}
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-gray-800 bg-gray-950/70 text-gray-500 hover:text-gray-300 hover:border-gray-700 transition-colors shrink-0"
                            title={expanded ? "Collapse run details" : "Expand run details"}
                          >
                            <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-90")} />
                          </button>
                          <button
                            onClick={() => toggleRunContextFromHistory(run)}
                            className={cn(
                              "min-w-0 flex-1 flex items-center text-left rounded px-1.5 py-1 transition-colors",
                              historicalSelected
                                ? "bg-indigo-900/35 text-indigo-100"
                                : "text-gray-200 hover:bg-gray-800/70",
                            )}
                            title={
                              historicalSelected
                                ? "Selected historical run. Click again to return to New run."
                                : "Click to load this run on canvas"
                            }
                          >
                            <span className="text-[10px] font-medium truncate">{run.pipeline_name}</span>
                          </button>
                          <button
                            onClick={() => toggleRunContextFromHistory(run)}
                            className={cn(
                              "text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded border transition-colors",
                              historicalSelected
                                ? "text-indigo-100 border-indigo-500 bg-indigo-700/40"
                                : "text-indigo-300 border-indigo-800/50 bg-indigo-950/40 hover:bg-indigo-900/40",
                            )}
                            title={
                              historicalSelected
                                ? "Click to return to New run"
                                : "Click to load this historical run on canvas"
                            }
                          >
                            {run.id.slice(0, 8)}
                          </button>
                          <span className={cn("inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold border shrink-0", runStatusClass)}>
                            {displayStatus || run.status}
                          </span>
                        </div>
                        <p className="mt-1 text-[9px] text-gray-500 truncate">
                          {(() => {
                            const runCallId = inferRunCallIdFromRecord(run);
                            return `${relativeTime(run.started_at)}${runCallId ? ` · call ${runCallId}` : ""}`;
                          })()}
                        </p>
                        {expanded && (
                          <div className="mt-2 space-y-1.5">
                            {!timeline || timeline.rows.length === 0 ? (
                              <p className="text-[10px] text-gray-500 italic">No step execution data.</p>
                            ) : (
                              timeline.rows.map((row) => (
                                <div key={`${run.id}-step-${row.stepIndex}`} className="rounded border border-gray-800 bg-gray-950 p-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <p className="text-[9px] text-gray-500 shrink-0">S{row.stepIndex + 1}</p>
                                    <p className="text-[10px] text-gray-200 truncate flex-1">{row.elementName}</p>
                                    <span className={cn("inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold border", row.statusClass)}>
                                      {row.statusLabel}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-[9px] text-gray-500 truncate">
                                    {row.durationLabel}{row.model ? ` · ${row.model}` : ""}
                                  </p>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

      </div>
    </div>

    {/* ── Pipeline history restore modal ─────────────────────────────────── */}
    {showPipelineHistoryModal && pipelineId && (
      <PipelineHistoryModal
        pipelineId={pipelineId}
        onClose={() => setShowPipelineHistoryModal(false)}
        onRestore={(snap) => {
          pushCanvasHistory(nodes, edges);
          loadPipelineToCanvas(pipelineId, {
            id: snap.id || pipelineId,
            name: snap.name || pipelineName,
            folder: snap.folder ?? pipelineFolder,
            steps: snap.steps ?? [],
            canvas: snap.canvas,
          });
          setShowPipelineHistoryModal(false);
        }}
      />
    )}
    </>
  );
}

// ── Page wrapper ──────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-full w-full bg-gray-950" />;
  }

  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <PipelineCanvas />
      </ReactFlowProvider>
    </div>
  );
}
