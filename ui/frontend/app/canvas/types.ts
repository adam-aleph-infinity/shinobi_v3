// ── Core domain types ─────────────────────────────────────────────────────────

export type RuntimeStatus =
  | "pending" | "loading" | "cached" | "done" | "error" | "cancelled";

export type NodeKind = "input" | "agent" | "output";

export interface CanvasNodeData extends Record<string, unknown> {
  kind:            NodeKind;
  label:           string;
  // input-specific
  inputSource?:    string;  // "transcript" | "merged_transcript" | "notes" | "merged_notes" | "agent_output" | "manual"
  // agent-specific
  agentId?:        string;
  agentClass?:     string;
  agentName?:      string;
  model?:          string;
  // output-specific
  outputSubType?:  string;  // "persona" | "notes" | "persona_score" | "notes_compliance"
  outputFormat?:   string;  // "markdown" | "json" | "text"
  // runtime (set by useRunExecution, not persisted)
  runtimeStatus?:      RuntimeStatus;
  runtimeStepIndex?:   number;   // which step index this agent node maps to
  runtimeStartedAtMs?: number;
  lastOutputPreview?:  string;
  lastRunDurationS?:   number;
  lastNoteId?:         string;
}

export interface PipelineFolderDef {
  id:           string;
  name:         string;
  description?: string | null;
  color?:       string | null;
  sort_order:   number;
  owner_email?: string | null;
  pipeline_count: number;
  created_at:   string;
  updated_at:   string;
}

export interface PipelineStepDef {
  agent_id:        string;
  input_overrides: Record<string, string>;
  output_contract_override?: Record<string, unknown>;
}

export interface PipelineDef {
  id:          string;
  name:        string;
  description: string;
  scope?:      string;
  folder?:     string;
  folder_id?:  string;
  workspace_user_email?: string;
  workspace_user_name?: string;
  steps:       PipelineStepDef[];
  canvas?:     { nodes: unknown[]; edges: unknown[]; stages?: string[] };
}

export interface UniversalAgent {
  id:           string;
  name:         string;
  description:  string;
  agent_class:  string;
  model:        string;
  temperature:  number;
  system_prompt: string;
  user_prompt:  string;
  inputs:       Array<{ key: string; source: string; agent_id?: string }>;
  output_format: string;
  tags:         string[];
  is_default:   boolean;
  created_at:   string;
  artifact_type?:    string;
  artifact_class?:   string;
  artifact_name?:    string;
  output_schema?:    Record<string, unknown> | null;
  output_taxonomy?:  string | null;
  output_contract_mode?: string | null;
  output_fit_strategy?: string | null;
  output_response_mode?: string | null;
  output_target_type?: string | null;
  output_template?: string | null;
  output_placeholder?: string | null;
  output_previous_placeholder?: string | null;
}

export interface PipelineRunStep {
  agent_id?:       string;
  agent_name?:     string;
  model?:          string;
  status?:         string;
  state?:          string;
  start_time?:     string | null;
  end_time?:       string | null;
  execution_time_s?: number | null;
  content?:        string;
  error_msg?:      string;
  note_id?:        string;
}

export interface PipelineRunRecord {
  id:           string;
  pipeline_id:  string;
  pipeline_name: string;
  sales_agent:  string;
  customer:     string;
  call_id:      string;
  started_at:   string | null;
  finished_at:  string | null;
  status:       string;
  steps_json:   string;
  canvas_json?: string;
  log_json?:    string;
}

export interface CanvasLogLine {
  ts:    string;
  text:  string;
  level: "llm" | "pipeline" | "error" | "warn" | "info";
}

export interface RunLaunchOptions {
  force:         boolean;
  failedOnly:    boolean;
  resumeRunId:   string;
}

// ── Status helpers ─────────────────────────────────────────────────────────────

export function normalizeStateToken(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function runtimeStatusFromToken(value: unknown, hasCached = false): RuntimeStatus {
  const s = normalizeStateToken(value);
  if (!s) return "pending";
  if (s === "cached" || s === "cache_hit") return "cached";
  if (s.includes("cancel") || s.includes("abort") || s.includes("stop")) return "cancelled";
  if (s === "failed" || s === "error" || s === "fail" || s.includes("exception")) return "error";
  if (s === "running" || s === "loading" || s === "started" || s.includes("in_progress")) return "loading";
  if (s === "completed" || s === "done" || s === "pass" || s === "success" || s === "ok")
    return hasCached ? "cached" : "done";
  if (s === "input_prepared" || s === "prepared") return "pending";
  return "pending";
}

export function isActiveRunStatus(status: string): boolean {
  const s = normalizeStateToken(status);
  return s === "running" || s === "queued" || s === "preparing" || s === "retrying";
}

export const RUNTIME_BADGE: Record<RuntimeStatus, { label: string; dot: string; badge: string }> = {
  pending:   { label: "idle",     dot: "bg-gray-500",    badge: "text-gray-400 border-gray-700/60 bg-gray-900/70" },
  loading:   { label: "running",  dot: "bg-amber-400",   badge: "text-amber-300 border-amber-700/60 bg-amber-950/50" },
  cached:    { label: "cached",   dot: "bg-amber-400",   badge: "text-amber-300 border-amber-700/60 bg-amber-950/50" },
  done:      { label: "done",     dot: "bg-emerald-400", badge: "text-emerald-300 border-emerald-700/60 bg-emerald-950/50" },
  error:     { label: "error",    dot: "bg-red-400",     badge: "text-red-300 border-red-700/60 bg-red-950/50" },
  cancelled: { label: "cancelled",dot: "bg-slate-400",   badge: "text-slate-300 border-slate-600/70 bg-slate-900/70" },
};

export const INPUT_SOURCES = [
  { value: "transcript",        label: "Transcript",    icon: "🎙" },
  { value: "merged_transcript", label: "Merged Transcript", icon: "🔗" },
  { value: "notes",             label: "Notes",         icon: "📝" },
  { value: "merged_notes",      label: "Merged Notes",  icon: "📚" },
  { value: "agent_output",      label: "Agent Output",  icon: "🤖" },
  { value: "manual",            label: "Manual",        icon: "✍️" },
] as const;

export const MODEL_GROUPS = [
  { provider: "OpenAI",    models: ["gpt-5.4", "gpt-4.1", "gpt-4.1-mini"] },
  { provider: "Anthropic", models: ["claude-opus-4-6", "claude-sonnet-4-6"] },
  { provider: "Google",    models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { provider: "xAI",       models: ["grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"] },
];

export const OUTPUT_SUBTYPES = [
  { value: "persona",          label: "Persona Profile" },
  { value: "persona_score",    label: "Persona Score" },
  { value: "notes",            label: "Call Notes" },
  { value: "notes_compliance", label: "Compliance Notes" },
  { value: "custom",           label: "Custom Output" },
];

// ── Canvas serialisation helpers ───────────────────────────────────────────────

/** Derive the backend `steps[]` from canvas nodes (sorted by x position). */
export function deriveStepsFromNodes(
  nodes: Array<{ data: CanvasNodeData; position: { x: number } }>,
): PipelineStepDef[] {
  return nodes
    .filter(n => n.data.kind === "agent" && n.data.agentId)
    .sort((a, b) => a.position.x - b.position.x)
    .map(n => {
      const input_overrides: Record<string, string> = {};
      if (n.data.inputSource) {
        input_overrides.transcript = n.data.inputSource;
      }
      return {
        agent_id: n.data.agentId!,
        input_overrides,
      };
    });
}
