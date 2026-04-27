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
  Check, Loader2, ChevronDown, ChevronUp, TriangleAlert,
  Mic2, Layers, BookOpen, PenLine, FileText, Braces, AlignLeft,
  Plus, Trash2, ChevronRight, X, Download, Workflow, Copy, ClipboardCopy, ClipboardPaste,
  Lock,
} from "lucide-react";
import { useAppCtx } from "@/lib/app-context";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(r => r.json());

// ── Sub-type metadata ─────────────────────────────────────────────────────────

type NodeKind = "input" | "processing" | "output";  // "output" = artifact internally
type ProcessSubType = "agent";
type ArtifactSubType = "persona" | "persona_score" | "notes" | "notes_compliance";

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

interface PipelineDef {
  id: string;
  name: string;
  description: string;
  folder?: string;
  steps: PipelineStepDef[];
  canvas?: { nodes: any[]; edges: any[]; stages: string[] };
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
  const filtered = allAgents.filter(a =>
    (a.name ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (a.agent_class ?? "").toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="space-y-1.5">
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search agents…"
        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500" />
      <div className="grid grid-cols-2 gap-1 max-h-52 overflow-y-auto">
        {filtered.map(a => {
          const meta  = classMeta(a.agent_class ?? "");
          const isSel = value === a.id;
          const req   = CLASS_REQUIRES_PREV[a.agent_class?.toLowerCase() ?? ""];
          const usage = usageByAgent[a.id] ?? { total: 0, other: 0 };
          return (
            <button key={a.id} onClick={() => onChange(a)} title={a.description}
              className={`flex items-center gap-1.5 p-2 rounded-lg border text-left transition-colors
                ${isSel ? `${meta.borderColor} bg-gray-800` : "border-gray-700/50 bg-gray-800/30 hover:bg-gray-800 hover:border-gray-600"}`}>
              <AgentClassIcon cls={a.agent_class ?? ""} size="sm" />
              <div className="min-w-0 flex-1">
                <p className={`text-[10px] font-medium truncate ${isSel ? "text-white" : "text-gray-300"}`}>{a.name}</p>
                <p className={`text-[9px] ${meta.textColor}`}>{meta.label}</p>
                {usage.total > 0 && (
                  <p className={`text-[9px] mt-0.5 ${usage.other > 0 ? "text-amber-300" : "text-gray-500"}`}>
                    {usage.other > 0
                      ? `Used in ${usage.total} pipelines (${usage.other} other)`
                      : `Used in ${usage.total} pipeline${usage.total !== 1 ? "s" : ""}`}
                  </p>
                )}
              </div>
              {isSel && <Check className="w-3 h-3 text-white shrink-0" />}
              {req && !isSel && (
                <span title={`Should follow a ${req} step`}><TriangleAlert className="w-3 h-3 text-amber-600/60 shrink-0" /></span>
              )}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-2 text-xs text-gray-600 italic text-center py-3">No agents match</p>
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
}: {
  children: React.ReactNode;
  meta:     Meta;
  selected: boolean;
  kind:     NodeKind;
}) {
  const ringColor =
    kind === "input"      ? "ring-blue-400/50" :
    kind === "processing" ? "ring-indigo-400/50" :
                            "ring-yellow-400/50";
  return (
    <div className={`w-[200px] rounded-xl border-2 shadow-2xl transition-all duration-150
      ${meta.border} bg-gray-900
      ${selected ? `ring-2 ${ringColor} shadow-indigo-900/40` : "opacity-90 hover:opacity-100"}`}>
      {children}
    </div>
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
  return (
    <NodeCard meta={m} selected={!!selected} kind="input">
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5 rounded-t-xl`}>
        <span className="text-white/90 shrink-0">{SrcIcon ? <SrcIcon className="w-4 h-4" /> : m.icon}</span>
        <EditableNodeLabel
          value={String(data.label || "Input")}
          onCommit={(next) => setNodes(ns => ns.map(n =>
            n.id === id
              ? { ...n, data: { ...(n.data as PipelineNodeData), label: next } }
              : n
          ))}
        />
      </div>
      <div className="px-4 py-1.5 bg-gray-900 rounded-b-xl">
        <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide`}>
          ⬤ {src ? src.label : "Input"}
        </span>
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
  return (
    <NodeCard meta={m} selected={!!selected} kind="processing">
      <Handle type="target" position={Position.Top} className="rf-tgt" />
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5 rounded-t-xl`}>
        <span className="text-white/90 shrink-0">
          {hasAgent ? <Icon className="w-4 h-4" /> : m.icon}
        </span>
        <EditableNodeLabel
          value={String(hasAgent ? (data.agentName as string) : data.label || "Agent")}
          onCommit={(next) => setNodes(ns => ns.map(n =>
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
          ))}
        />
      </div>
      <div className="px-4 py-1.5 bg-gray-900 rounded-b-xl">
        {hasAgent ? (
          <span className={`text-[11px] font-semibold ${cm.textColor} uppercase tracking-wide`}>
            ⬡ Agent · {cm.label}
          </span>
        ) : (
          <span className="text-[11px] text-gray-600 italic">tap to configure</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="rf-src" />
    </NodeCard>
  );
}

function OutputNode({ id, data, selected }: { id: string; data: PipelineNodeData; selected?: boolean }) {
  const { setNodes } = useReactFlow();
  const m = getMeta("output", data.subType);
  return (
    <NodeCard meta={m} selected={!!selected} kind="output">
      <Handle type="target" position={Position.Top} className="rf-tgt" />
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5 rounded-t-xl`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <EditableNodeLabel
          value={String(data.label || "Output")}
          onCommit={(next) => setNodes(ns => ns.map(n =>
            n.id === id
              ? { ...n, data: { ...(n.data as PipelineNodeData), label: next } }
              : n
          ))}
        />
      </div>
      <div className="px-4 py-1.5 bg-gray-900 rounded-b-xl">
        {(ARTIFACT_META as Record<string, Meta>)[data.subType as string] ? (
          <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide`}>
            ◆ {m.label}
          </span>
        ) : (
          <span className="text-[11px] text-gray-600 italic">tap to configure</span>
        )}
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
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="border border-gray-800 rounded-lg overflow-hidden">
      <summary className="list-none cursor-pointer px-2.5 py-1.5 bg-gray-900/70 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </summary>
      <div className="p-2.5">{children}</div>
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

function PipelineCanvas() {
  const { screenToFlowPosition, setViewport } = useReactFlow();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const { mutate } = useSWRConfig();
  const { activePipelineId, setActivePipeline } = useAppCtx();

  // Backend data
  const { data: agentsData }    = useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);
  const { data: pipelinesData } = useSWR<PipelineDef[]>("/api/pipelines", fetcher);
  const { data: pipelineFoldersData } = useSWR<string[]>("/api/pipelines/folders", fetcher);
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
  const [dragOverPipelineFolder, setDragOverPipelineFolder] = useState<string | null>(null);
  // Agent config panel state (for selected processing node)
  const [agentDraft, setAgentDraft] = useState<Omit<UniversalAgent, "id"|"created_at"> | null>(null);
  const [agentSaving,   setAgentSaving]   = useState(false);
  const [agentSaved,    setAgentSaved]    = useState(false);
  const [agentDeleting, setAgentDeleting] = useState(false);
  const [showModel,     setShowModel]     = useState(false);
  const [canvasViewport, setCanvasViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [propertiesPanelWidth, setPropertiesPanelWidth] = useState(320);
  const [isResizingPropertiesPanel, setIsResizingPropertiesPanel] = useState(false);
  const propertiesResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function startPropertiesPanelResize(clientX: number) {
    propertiesResizeRef.current = { startX: clientX, startWidth: propertiesPanelWidth };
    setIsResizingPropertiesPanel(true);
  }

  useEffect(() => {
    if (!isResizingPropertiesPanel) return;
    const onMove = (e: MouseEvent) => {
      const drag = propertiesResizeRef.current;
      if (!drag) return;
      const delta = drag.startX - e.clientX;
      const draftWidth = drag.startWidth + delta;
      const minWidth = 240;
      const maxWidth = Math.max(minWidth, Math.min(760, window.innerWidth - 460));
      const clamped = Math.max(minWidth, Math.min(maxWidth, draftWidth));
      setPropertiesPanelWidth(clamped);
    };
    const onUp = () => {
      propertiesResizeRef.current = null;
      setIsResizingPropertiesPanel(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizingPropertiesPanel]);

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
  const pipelineFolders = useMemo(() => {
    const fromPipelines = allPipelines
      .map(p => normalizeFolder(p.folder))
      .filter(Boolean);
    const fromFolders = (pipelineFoldersData ?? [])
      .map(f => normalizeFolder(f))
      .filter(Boolean);
    return [...new Set([...fromFolders, ...fromPipelines])]
      .sort((a, b) => a.localeCompare(b));
  }, [allPipelines, pipelineFoldersData]);

  const pipelinesByFolder = useMemo(() => {
    const grouped: Record<string, typeof allPipelines> = {};
    for (const p of allPipelines) {
      const folder = normalizeFolder(p.folder);
      (grouped[folder] ??= []).push(p);
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    return grouped;
  }, [allPipelines]);

  // Refs for fresh state in callbacks (avoid stale closures)
  const nodesRef  = useRef<Node[]>([]);
  const edgesRef  = useRef<Edge[]>([]);
  const stagesRef = useRef<NodeKind[]>([...INIT_STAGES]);
  nodesRef.current  = nodes;
  edgesRef.current  = edges;
  stagesRef.current = stages;

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
        const shouldSyncLabel = !prevLabel || prevLabel === prevAgentName || prevLabel === aid;
        const nextLabel = shouldSyncLabel ? ag.name : prevLabel;
        if (prevAgentName === ag.name && String(d.agentClass || "") === String(ag.agent_class || "") && prevLabel === nextLabel) {
          return n;
        }
        changed = true;
        return {
          ...n,
          data: {
            ...d,
            agentName: ag.name,
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

  // Render only actual flow nodes; swimbars are drawn as a non-interactive backdrop.
  const allNodes = useMemo(() => [...nodes], [nodes]);

  // Prevent removal of sleeves; lock INPUT nodes to their Y axis during drag
  const onNodesChangeFiltered = useCallback((changes: NodeChange[]) => {
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
  }, [onNodesChange]);

  // Snap processing/output nodes to the nearest same-type lane on drag end
  const onNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
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
  }, [setNodes]);

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
  }, [setEdges, allAgents]);

  function showToast(msg: string, ok = false) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Core: add node → determine stage → position → auto-connect ────────────

  const addNodeToCanvas = useCallback((
    kind:    NodeKind,
    subType: string,
    dropPos?: { x: number; y: number },
  ) => {
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
  }, [setNodes, setEdges, setStages]);

  // ── Drag from palette ─────────────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const kind    = e.dataTransfer.getData("application/nodeKind")    as NodeKind | "";
    const subType = e.dataTransfer.getData("application/nodeSubType") as string   | "";
    if (!kind) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeToCanvas(kind, subType, pos);
  }, [screenToFlowPosition, addNodeToCanvas]);

  // ── Node interactions ─────────────────────────────────────────────────────

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  function updateNodeData(id: string, patch: Partial<PipelineNodeData>) {
    setNodes(ns => ns.map(n =>
      n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
    ));
  }

  function deleteNode(id: string) {
    setNodes(ns => ns.filter(n => n.id !== id));
    setEdges(es => es.filter(e => e.source !== id && e.target !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  }

  function handleAddStage() {
    if (stagesRef.current.length >= MAX_TOTAL_STAGES) return;
    const next: NodeKind[] = [...stagesRef.current, "processing", "output"];
    setStages(next);
    stagesRef.current = next;
  }

  function handleRemoveStage() {
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

  function handleClear() {
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

  async function createPipelineFolder() {
    const raw = window.prompt("Folder name");
    const name = (raw ?? "").trim();
    if (!name) return;
    const res = await fetch("/api/pipelines/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      showToast("Could not create folder", false);
      return;
    }
    mutate("/api/pipelines/folders");
  }

  async function movePipelineToFolder(pid: string, folder: string) {
    const res = await fetch(`/api/pipelines/${pid}/folder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    if (!res.ok) {
      showToast("Could not move pipeline", false);
      return;
    }
    if (pipelineId === pid) setPipelineFolder(folder);
    mutate("/api/pipelines");
    mutate("/api/pipelines/folders");
  }

  async function handleDuplicatePipeline(pid: string) {
    const pl = allPipelines.find(p => p.id === pid);
    if (!pl) return;
    try {
      const fullPl = await fetch(`/api/pipelines/${pid}`).then(r => r.json());
      const newName = `Copy of ${pl.name}`;
      const res = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          steps: fullPl.steps ?? [],
          scope: fullPl.scope ?? "per_call",
          canvas: fullPl.canvas ?? {},
          folder: fullPl.folder ?? pl.folder ?? "",
        }),
      });
      if (!res.ok) { showToast(`Duplicate failed (${res.status})`, false); return; }
      const saved = await res.json();
      mutate("/api/pipelines");
      showToast(`Duplicated as "${newName}"`, true);
      loadPipelineToCanvas(saved.id, {
        id: saved.id,
        name: newName,
        folder: fullPl.folder ?? pl.folder ?? "",
        steps: fullPl.steps ?? [],
        canvas: fullPl.canvas,
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
  }

  async function importPresets() {
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
      showToast(`Pipeline "${pipelineName}" saved`, true);
    } catch { showToast("Network error — could not save pipeline", false); }
    finally  { setPipelineSaving(false); }
  }

  async function handleSaveAgent() {
    if (!selectedNodeId || !agentDraft) return;
    const nd = (nodes.find(n => n.id === selectedNodeId)?.data as PipelineNodeData | undefined);
    if (!nd?.agentId) return;
    setAgentSaving(true);
    try {
      const usagePipelines = allPipelines.filter(p =>
        (p.steps ?? []).some(s => String(s.agent_id || "") === nd.agentId),
      );
      const usedInOther = usagePipelines.filter(p => p.id !== pipelineId);

      let targetAgentId = String(nd.agentId || "");
      if (usedInOther.length > 0) {
        const choice = window.prompt(
          `This agent is used in ${usagePipelines.length} pipelines (${usedInOther.length} other).\n` +
          "Type:\n" +
          "1 = Apply changes to all workflows\n" +
          "2 = Create copy and apply only in this workflow\n" +
          "Anything else = Cancel",
          "2",
        );
        if (!choice || !["1", "2"].includes(choice.trim())) {
          showToast("Agent update cancelled", false);
          return;
        }
        if (choice.trim() === "2") {
          const copyRes = await fetch(`/api/universal-agents/${nd.agentId}/copy`, { method: "POST" });
          if (!copyRes.ok) {
            showToast(`Agent copy failed (${copyRes.status})`, false);
            return;
          }
          const copied: UniversalAgent = await copyRes.json();
          targetAgentId = copied.id;
          const putCopy = await fetch(`/api/universal-agents/${copied.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(agentDraft),
          });
          if (!putCopy.ok) {
            showToast(`Copied agent save failed (${putCopy.status})`, false);
            return;
          }
          // Rebind all nodes in current workflow using the old agent id to the new copy.
          setNodes(ns => ns.map(n => {
            if (n.type !== "processing") return n;
            const d = n.data as PipelineNodeData;
            if (String(d.agentId || "") !== nd.agentId) return n;
            return {
              ...n,
              data: {
                ...d,
                agentId: copied.id,
                agentClass: agentDraft.agent_class || copied.agent_class || "",
                agentName: agentDraft.name,
                label: agentDraft.name,
              } satisfies PipelineNodeData,
            };
          }));
          showToast("Created copied agent and applied changes only in this workflow", true);
        }
      }

      if (targetAgentId === nd.agentId) {
        const res = await fetch(`/api/universal-agents/${nd.agentId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(agentDraft),
        });
        if (!res.ok) { showToast(`Agent save failed (${res.status})`, false); return; }
      }
      mutate("/api/universal-agents");
      // Keep canvas node header in sync with the (possibly renamed) agent
      updateNodeData(selectedNodeId, { agentId: targetAgentId, agentName: agentDraft.name, label: agentDraft.name });
      setAgentSaved(true); setTimeout(() => setAgentSaved(false), 2000);
    } finally { setAgentSaving(false); }
  }

  // Create a new blank agent on the backend and attach it to the selected node
  async function handleCreateAgent() {
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
      setAgentSaved(false);
      showToast("New agent created — edit and save below", true);
    } catch { showToast("Network error — could not create agent", false); }
  }

  // Remove the agent association from this canvas node (agent stays in backend)
  function handleDetachAgent() {
    if (!selectedNodeId) return;
    updateNodeData(selectedNodeId, { agentId: "", agentClass: "", agentName: "" });
    setAgentDraft({ name: "", description: "", agent_class: "", model: "gpt-5.4",
      temperature: 0, system_prompt: "", user_prompt: "", inputs: [],
      output_format: "markdown", tags: [], is_default: false });
    setAgentSaved(false);
  }

  // Permanently delete the agent from the backend, then detach from node
  async function handleDeleteAgent() {
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

  // Sync agentDraft when selected node changes — always init so prompts are visible immediately
  useEffect(() => {
    if (!selData || selKind !== "processing") { setAgentDraft(null); return; }
    const agId = selData.agentId as string;
    const a    = agId ? allAgents.find(x => x.id === agId) : null;
    setAgentDraft({
      name:          a?.name          ?? "",
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId, allAgents.length]);

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

    // ── Agent configurator panel ──────────────────────────────────────────
    if (selKind === "processing") {
      const agId  = selData.agentId as string;
      const agCls = selData.agentClass as string;
      const cm    = classMeta(agCls);
      const usage = agId ? (agentUsageByPipeline[agId] ?? { total: 0, other: 0 }) : { total: 0, other: 0 };

      return (
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 shrink-0">
            <AgentClassIcon cls={agCls} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-white truncate">
                {agId ? (selData.agentName as string || "Agent") : "Configure Agent"}
              </p>
              <p className={`text-[9px] ${cm.textColor}`}>{agId ? cm.label : "No agent selected"}</p>
              {agId && usage.total > 0 && (
                <p className={`text-[9px] mt-0.5 ${usage.other > 0 ? "text-amber-300" : "text-gray-500"}`}>
                  {usage.other > 0
                    ? `Used in ${usage.total} pipelines (${usage.other} other)`
                    : `Used in ${usage.total} pipeline${usage.total !== 1 ? "s" : ""}`}
                </p>
              )}
            </div>
            <button onClick={() => setSelectedNodeId(null)} className="p-1 text-gray-600 hover:text-white transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="p-3 space-y-2.5">
              <PropertiesSection title="Select Agent">
                {allAgents.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">Loading agents…</p>
                ) : (
                  <AgentPickerGrid
                    value={agId}
                    allAgents={allAgents}
                    usageByAgent={agentUsageByPipeline}
                    onChange={agent => {
                      updateNodeData(selectedNode.id, {
                        agentId: agent.id, agentClass: agent.agent_class, agentName: agent.name, label: agent.name,
                      });
                      setAgentDraft({
                        name: agent.name, description: agent.description ?? "",
                        agent_class: agent.agent_class ?? "", model: agent.model ?? "gpt-5.4",
                        temperature: agent.temperature ?? 0, system_prompt: agent.system_prompt ?? "",
                        user_prompt: agent.user_prompt ?? "",
                        // Preserve the agent's inputs — pipeline executor uses these for source resolution
                        inputs: agent.inputs ?? [],
                        output_format: agent.output_format ?? "markdown",
                        tags: agent.tags ?? [], is_default: agent.is_default ?? false,
                      });
                      setAgentSaved(false);
                    }}
                  />
                )}
                {/* Agent action buttons — New / Detach / Delete */}
                <div className="flex gap-1.5 mt-2">
                  <button onClick={handleCreateAgent}
                    title="Create a new blank agent and attach it to this node"
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-[10px] transition-colors">
                    <Plus className="w-3 h-3" /> New
                  </button>
                  {agId && (
                    <>
                      <button onClick={handleDetachAgent}
                        title="Remove the agent from this node (agent stays in library)"
                        className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-amber-400 hover:border-amber-800 text-[10px] transition-colors">
                        <X className="w-3 h-3" /> Detach
                      </button>
                      <button onClick={handleDeleteAgent} disabled={agentDeleting}
                        title="Permanently delete this agent from the backend"
                        className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-gray-700 text-red-500 hover:bg-red-950/40 hover:border-red-800 text-[10px] transition-colors disabled:opacity-40">
                        {agentDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </PropertiesSection>

            {/* Connected inputs — auto-derived from canvas connections (input + artifact + agent nodes) */}
            {(() => {
              type CS = { nodeId: string; typeLabel: string; nodeLabel: string; icon: React.ReactNode; badge: string };
              const connectedSources = edges
                .filter(e => e.target === selectedNode.id)
                .map((e): CS | null => {
                  const src = nodes.find(n => n.id === e.source);
                  if (!src) return null;
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

              if (connectedSources.length === 0) return null;
              return (
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
              );
            })()}

            {/* Prompts + settings — always visible when processing node selected */}
            {agentDraft && (
              <PropertiesSection title="Agent Prompt & Settings">
              <div className="space-y-3">
                {agId && (
                  <div>
                    <label className="block text-[9px] text-gray-500 mb-1">Name</label>
                    <input value={agentDraft.name}
                      onChange={e => setAgentDraft(f => f ? { ...f, name: e.target.value } : f)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
                  </div>
                )}

                <div>
                  <label className="block text-[9px] text-gray-500 mb-1">System Prompt</label>
                  <textarea value={agentDraft.system_prompt}
                    onChange={e => setAgentDraft(f => f ? { ...f, system_prompt: e.target.value } : f)}
                    rows={5} placeholder="You are a…"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
                </div>

                <div>
                  <label className="block text-[9px] text-gray-500 mb-1">User Prompt</label>
                  <textarea value={agentDraft.user_prompt}
                    onChange={e => setAgentDraft(f => f ? { ...f, user_prompt: e.target.value } : f)}
                    rows={5} placeholder={"Analyse this:\n\n{transcript}"}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-[11px] text-gray-300 font-mono outline-none focus:border-indigo-500 resize-y" />
                </div>

                {/* Model & settings (collapsible) */}
                <div className="border border-gray-800 rounded-xl overflow-hidden">
                  <button onClick={() => setShowModel(s => !s)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-gray-900 hover:bg-gray-800 transition-colors text-xs">
                    <span className="text-gray-400">Model & settings</span>
                    {showModel ? <ChevronUp className="w-3.5 h-3.5 text-gray-600" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-600" />}
                  </button>
                  {showModel && (
                    <div className="p-3 space-y-2.5 border-t border-gray-800">
                      <div>
                        <label className="block text-[9px] text-gray-500 mb-1">Model</label>
                        <ModelSelect value={agentDraft.model} onChange={v => setAgentDraft(f => f ? { ...f, model: v } : f)} />
                      </div>
                      <div>
                        <label className="block text-[9px] text-gray-500 mb-1">Temperature</label>
                        <input type="number" min={0} max={2} step={0.1} value={agentDraft.temperature}
                          onChange={e => setAgentDraft(f => f ? { ...f, temperature: parseFloat(e.target.value) || 0 } : f)}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500" />
                      </div>
                      <div>
                        <label className="block text-[9px] text-gray-500 mb-1">Output format</label>
                        <div className="flex gap-1.5">
                          {Object.entries(OUTPUT_FMT).map(([k, m]) => {
                            const FmtIcon = m.icon;
                            const sel = agentDraft.output_format === k;
                            return (
                              <button key={k} onClick={() => setAgentDraft(f => f ? { ...f, output_format: k } : f)}
                                className={`flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg border text-[9px] transition-all
                                  ${sel ? `${m.border} ${m.bg}` : "border-gray-800 bg-gray-900 hover:border-gray-700"}`}>
                                <FmtIcon className={`w-3.5 h-3.5 ${sel ? m.text : "text-gray-600"}`} />
                                <span className={sel ? m.text : "text-gray-500"}>{m.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <button onClick={handleSaveAgent} disabled={!agId || agentSaving || !agentDraft.name.trim()}
                  className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-40">
                  {agentSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : agentSaved ? <Check className="w-3 h-3" /> : null}
                  {agentSaved ? "Saved" : agId ? "Save agent" : "Select an agent above to save"}
                </button>
              </div>
              </PropertiesSection>
            )}
            </div>
          </div>

          {/* Footer: delete */}
          <div className="p-3 border-t border-gray-800 shrink-0">
            <button onClick={() => deleteNode(selectedNode.id)}
              className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg border border-gray-800 text-red-500 hover:bg-red-950/40 hover:border-red-800 text-xs transition-colors">
              <Trash2 className="w-3.5 h-3.5" /> Delete node
            </button>
          </div>
        </div>
      );
    }

    // ── Input / Artifact panel ────────────────────────────────────────────
    return (
      <div className="p-4 space-y-4">
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
                Select saved output profile from Agents & Artifacts
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
                    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-2 space-y-1">
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
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isActivePipeline = !!(pipelineId && pipelineId === activePipelineId);

  return (
    <div className="flex flex-col h-full w-full">

      {/* ── Top toolbar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-gray-900 shrink-0">
        <Workflow className="w-4 h-4 text-indigo-400 shrink-0" />
        <span className="text-sm font-bold text-white shrink-0">Pipeline</span>
        <input
          value={pipelineName}
          onChange={e => setPipelineName(e.target.value)}
          placeholder="Name your pipeline…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors min-w-0"
        />
        {pipelineId && (
          <button
            onClick={() => isActivePipeline ? setActivePipeline("", "") : setActivePipeline(pipelineId, pipelineName)}
            title={isActivePipeline ? "Deactivate this pipeline" : "Set as active pipeline for all executions"}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors shrink-0
              ${isActivePipeline
                ? "bg-emerald-900/50 border-emerald-700 text-emerald-300 hover:bg-emerald-900/80"
                : "border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isActivePipeline ? "bg-emerald-400" : "bg-gray-600"}`} />
            {isActivePipeline ? "Active" : "Set active"}
          </button>
        )}
        <button onClick={importPresets} title="Import agent presets"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-xs transition-colors shrink-0">
          <Download className="w-3 h-3" /> Presets
        </button>
        <button
          onClick={handleCopyPipelineBundle}
          title="Copy full pipeline bundle (workflow + agents)"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-xs transition-colors shrink-0"
        >
          <ClipboardCopy className="w-3 h-3" /> Copy Bundle
        </button>
        <button
          onClick={() => setShowBundleImport(true)}
          title="Paste bundle from another environment"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 text-xs transition-colors shrink-0"
        >
          <ClipboardPaste className="w-3 h-3" /> Paste Bundle
        </button>
        <button onClick={handleSave}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-emerald-400 hover:border-emerald-800 text-xs transition-colors shrink-0">
          <Check className="w-3 h-3" /> Validate
        </button>
        <button onClick={handleSavePipeline} disabled={pipelineSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-colors disabled:opacity-60 shrink-0">
          {pipelineSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          Save
        </button>
        <button onClick={handleClear} title="Clear canvas / new pipeline"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-600 hover:text-red-400 hover:border-red-900 text-xs transition-colors shrink-0">
          <Trash2 className="w-3 h-3" /> Clear
        </button>
      </div>

      {/* ── Main content ──────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Left panel ──────────────────────────────────────────────── */}
        <aside className="w-52 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden">

          {/* Pipelines list */}
          <div className="border-b border-gray-800 shrink-0">
            <div className="px-3 py-2 flex items-center justify-between">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Pipelines</p>
              <div className="flex items-center gap-1">
                <button onClick={createPipelineFolder} title="New folder"
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-indigo-400 hover:bg-gray-800 transition-colors">
                  <Layers className="w-3 h-3" />
                </button>
                <button onClick={handleClear} title="New pipeline"
                  className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-indigo-400 hover:bg-gray-800 transition-colors">
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto px-2 pb-2 space-y-1.5">
              {([
                { key: "", label: "Unfiled" },
                ...pipelineFolders.map(f => ({ key: f, label: f })),
              ]).map(section => {
                const list = pipelinesByFolder[section.key] ?? [];
                return (
                  <div
                    key={section.label}
                    onDragOver={e => { e.preventDefault(); setDragOverPipelineFolder(section.key); }}
                    onDragLeave={() => setDragOverPipelineFolder(null)}
                    onDrop={async e => {
                      e.preventDefault();
                      const pid = e.dataTransfer.getData("application/x-pipeline-id");
                      setDragOverPipelineFolder(null);
                      if (!pid) return;
                      await movePipelineToFolder(pid, section.key);
                    }}
                    className={cn(
                      "rounded-lg border p-1 transition-colors",
                      dragOverPipelineFolder === section.key ? "border-indigo-500 bg-indigo-900/20" : "border-gray-800",
                    )}>
                    <p className="text-[9px] font-bold text-gray-500 uppercase tracking-widest px-1.5 mb-0.5">{section.label}</p>
                    {list.length === 0 ? (
                      <p className="text-[9px] text-gray-700 italic px-2 py-1">Drop pipelines here</p>
                    ) : list.map(p => (
                      <div key={p.id} className="flex items-center group">
                        <button
                          draggable
                          onDragStart={e => {
                            e.dataTransfer.setData("application/x-pipeline-id", p.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={async () => {
                            const fullPl = await fetch(`/api/pipelines/${p.id}`).then(r => r.json());
                            loadPipelineToCanvas(p.id, { id: fullPl.id, name: fullPl.name, folder: fullPl.folder ?? "", steps: fullPl.steps ?? [], canvas: fullPl.canvas });
                          }}
                          className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] text-left transition-colors
                            ${pipelineId === p.id
                              ? "bg-indigo-900/40 text-white"
                              : "text-gray-400 hover:text-white hover:bg-gray-800"}`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.id === activePipelineId ? "bg-emerald-400" : "bg-gray-700"}`} />
                          <span className="truncate flex-1">{p.name}</span>
                        </button>
                        <button
                          onClick={() => handleDuplicatePipeline(p.id)}
                          title="Duplicate pipeline"
                          className="shrink-0 p-1 text-gray-700 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-all">
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDeletePipeline(p.id)}
                          title="Delete pipeline"
                          className="shrink-0 p-1 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
              {allPipelines.length === 0 && pipelineFolders.length === 0 && (
                <p className="text-[10px] text-gray-700 italic px-2 py-1">No pipelines yet</p>
              )}
            </div>
          </div>

          {/* Elements header */}
          <div className="px-3 py-2 border-b border-gray-800 shrink-0">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Elements</p>
            <p className="text-[9px] text-gray-700 mt-0.5">Click to add to next available slot</p>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
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
                    className="text-[10px] text-red-500 hover:text-red-400 font-semibold transition-colors">
                    - Layer
                  </button>
                )}
                {stages.length < MAX_TOTAL_STAGES && (
                  <button onClick={handleAddStage}
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
        <style>{HANDLE_CSS}</style>
        <div className="flex-1 relative" ref={canvasContainerRef} onDrop={onDrop} onDragOver={onDragOver}>
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
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            deleteKeyCode="Delete"
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

          {showBundleImport && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-4">
              <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
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
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-4">
              <div className="w-full max-w-3xl rounded-xl border border-gray-700 bg-gray-900 shadow-2xl">
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
        </div>

        <div
          onMouseDown={e => startPropertiesPanelResize(e.clientX)}
          className="w-1.5 shrink-0 cursor-col-resize bg-gray-900 hover:bg-indigo-500/40 transition-colors"
          title="Drag to resize properties panel"
        />

        {/* ── Right properties panel ────────────────────────────────────── */}
        <aside
          className="shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col transition-[width] duration-75"
          style={{ width: `${propertiesPanelWidth}px` }}
        >
          {selKind !== "processing" && (
            <div className="p-3 border-b border-gray-800 flex items-center justify-between">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Properties</p>
              {selectedNodeId && (
                <button onClick={() => setSelectedNodeId(null)} className="text-gray-600 hover:text-gray-400 transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="flex-1 overflow-y-auto min-h-0">
            {renderPanel()}
          </div>
        </aside>

      </div>
    </div>
  );
}

// ── Page wrapper ──────────────────────────────────────────────────────────────

export default function PipelinePage() {
  return (
    <div className="-m-6 h-[calc(100vh-5rem)]">
      <ReactFlowProvider>
        <PipelineCanvas />
      </ReactFlowProvider>
    </div>
  );
}
