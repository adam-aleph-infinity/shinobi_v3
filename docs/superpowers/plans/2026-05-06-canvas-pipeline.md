# Canvas Pipeline Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `app/canvas/` as a full modular replacement for `app/pipeline/page.tsx` — a canvas-based pipeline editor using React Flow with rich inline nodes, folder sidebar, inspector panel, and live execution monitoring.

**Architecture:** Modular feature folder under `app/canvas/`: thin `page.tsx` shell, shared `types.ts`, three custom node components, layout components (sidebar, toolbar, board, inspector, log panel, modal), and three hooks (data fetching, canvas state, run execution). Reuses `ContextTopBar`, `AppCtx`, and all existing backend API endpoints unchanged.

**Tech Stack:** Next.js 14 App Router, `@xyflow/react` v12, TypeScript, Tailwind CSS, SWR, lucide-react

---

## File Map

| File | Responsibility |
|------|---------------|
| `app/canvas/types.ts` | All TS interfaces and status helpers |
| `app/canvas/hooks/usePipelineData.ts` | SWR: pipelines, folders, agents |
| `app/canvas/hooks/useCanvasState.ts` | Nodes/edges state, undo/redo, clipboard |
| `app/canvas/hooks/useRunExecution.ts` | SSE run launch, step-to-node status mapping, log lines |
| `app/canvas/components/node-types/InputNode.tsx` | Input card (transcript/merged/manual) |
| `app/canvas/components/node-types/AgentNode.tsx` | Rich inline agent card |
| `app/canvas/components/node-types/OutputNode.tsx` | Artifact output card |
| `app/canvas/components/CanvasSidebar.tsx` | Folder icon rail + pipeline list panel |
| `app/canvas/components/CanvasToolbar.tsx` | Floating pill toolbar |
| `app/canvas/components/CanvasBoard.tsx` | ReactFlow wrapper (grid, minimap, nodeTypes) |
| `app/canvas/components/inspector/NodeInspector.tsx` | Right-side config panel |
| `app/canvas/components/BottomLogPanel.tsx` | Collapsible log strip |
| `app/canvas/components/RunLaunchModal.tsx` | Launch options modal |
| `app/canvas/page.tsx` | Layout shell (~80 lines) |
| `app/layout.tsx` | Add `/canvas` nav link |

---

## Task 1: Scaffold directory structure + types.ts

**Files:**
- Create: `ui/frontend/app/canvas/types.ts`
- Create dirs: `ui/frontend/app/canvas/hooks/`, `ui/frontend/app/canvas/components/node-types/`, `ui/frontend/app/canvas/components/inspector/`

- [ ] **Step 1: Create directories**

```bash
mkdir -p ui/frontend/app/canvas/hooks
mkdir -p ui/frontend/app/canvas/components/node-types
mkdir -p ui/frontend/app/canvas/components/inspector
```

- [ ] **Step 2: Write `ui/frontend/app/canvas/types.ts`**

```typescript
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

export function runtimeStatusFromToken(value: unknown): RuntimeStatus {
  const s = normalizeStateToken(value);
  if (!s) return "pending";
  if (s === "cached" || s === "cache_hit") return "cached";
  if (s.includes("cancel") || s.includes("abort") || s.includes("stop")) return "cancelled";
  if (s === "failed" || s === "error" || s === "fail" || s.includes("exception")) return "error";
  if (s === "running" || s === "loading" || s === "started" || s.includes("in_progress")) return "loading";
  if (s === "completed" || s === "done" || s === "pass" || s === "success" || s === "ok") return "done";
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
    .map(n => ({
      agent_id: n.data.agentId!,
      input_overrides: n.data.inputSource ? { transcript: n.data.inputSource } : {},
    }));
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to `app/canvas/types.ts`

- [ ] **Step 4: Commit**

```bash
git add ui/frontend/app/canvas/types.ts
git commit -m "feat(canvas): add types.ts foundation"
```

---

## Task 2: usePipelineData hook

**Files:**
- Create: `ui/frontend/app/canvas/hooks/usePipelineData.ts`

- [ ] **Step 1: Write `ui/frontend/app/canvas/hooks/usePipelineData.ts`**

```typescript
"use client";

import useSWR, { useSWRConfig } from "swr";
import { useCallback } from "react";
import type { PipelineDef, PipelineFolderDef, UniversalAgent } from "../types";

const fetcher = (url: string) => fetch(url).then(r => r.json());

export function usePipelineData() {
  const { mutate } = useSWRConfig();

  const { data: agents = [], isLoading: agentsLoading } =
    useSWR<UniversalAgent[]>("/api/universal-agents", fetcher);

  const { data: pipelines = [], mutate: mutatePipelines } =
    useSWR<PipelineDef[]>("/api/pipelines", fetcher);

  const { data: folders = [], mutate: mutateFolders } =
    useSWR<PipelineFolderDef[]>("/api/pipelines/folders", fetcher);

  const revalidateAll = useCallback(() => {
    void mutate("/api/universal-agents");
    void mutate("/api/pipelines");
    void mutate("/api/pipelines/folders");
  }, [mutate]);

  // ── Pipeline CRUD ───────────────────────────────────────────────────────────

  async function savePipeline(
    pipeline: Partial<PipelineDef> & { name: string },
  ): Promise<PipelineDef> {
    const url    = pipeline.id ? `/api/pipelines/${pipeline.id}` : "/api/pipelines";
    const method = pipeline.id ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pipeline),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    const saved: PipelineDef = await res.json();
    void mutatePipelines();
    return saved;
  }

  async function deletePipeline(id: string): Promise<void> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Delete failed (${res.status})`);
    void mutatePipelines();
  }

  async function loadPipeline(id: string): Promise<PipelineDef> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Load failed (${res.status})`);
    return res.json();
  }

  // ── Folder CRUD ─────────────────────────────────────────────────────────────

  async function createFolder(name: string): Promise<PipelineFolderDef> {
    const res = await fetch("/api/pipelines/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "" }),
    });
    if (!res.ok) throw new Error(`Create folder failed (${res.status})`);
    const folder: PipelineFolderDef = await res.json();
    void mutateFolders();
    return folder;
  }

  async function renameFolder(id: string, name: string): Promise<void> {
    const res = await fetch(`/api/pipelines/folders/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename folder failed (${res.status})`);
    void mutateFolders();
  }

  async function deleteFolder(id: string): Promise<void> {
    const res = await fetch(`/api/pipelines/folders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Delete folder failed (${res.status})`);
    void mutatePipelines();
    void mutateFolders();
  }

  async function movePipelineToFolder(pipelineId: string, folderId: string): Promise<void> {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/folder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    });
    if (!res.ok) throw new Error(`Move failed (${res.status})`);
    void mutatePipelines();
  }

  return {
    agents, agentsLoading,
    pipelines, folders,
    revalidateAll,
    savePipeline, deletePipeline, loadPipeline,
    createFolder, renameFolder, deleteFolder,
    movePipelineToFolder,
  };
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "canvas/hooks/usePipelineData" | head -10
```

Expected: no output (no errors)

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/hooks/usePipelineData.ts
git commit -m "feat(canvas): add usePipelineData hook"
```

---

## Task 3: useCanvasState hook

**Files:**
- Create: `ui/frontend/app/canvas/hooks/useCanvasState.ts`

- [ ] **Step 1: Write `ui/frontend/app/canvas/hooks/useCanvasState.ts`**

```typescript
"use client";

import { useCallback, useRef, useState } from "react";
import {
  useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange,
} from "@xyflow/react";
import type { CanvasNodeData } from "../types";

export type CanvasNode = Node<CanvasNodeData>;
export type CanvasEdge = Edge;

const MAX_UNDO = 50;

function cloneState(nodes: CanvasNode[], edges: CanvasEdge[]) {
  return { nodes: JSON.parse(JSON.stringify(nodes)) as CanvasNode[], edges: JSON.parse(JSON.stringify(edges)) as CanvasEdge[] };
}

export function useCanvasState() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isDirty, setIsDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const undoStack = useRef<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>>([]);
  const redoStack = useRef<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>>([]);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const clipboard = useRef<CanvasNode[]>([]);

  const snapshot = useCallback((currentNodes: CanvasNode[], currentEdges: CanvasEdge[]) => {
    undoStack.current = [...undoStack.current.slice(-MAX_UNDO), cloneState(currentNodes, currentEdges)];
    redoStack.current = [];
    setUndoLen(undoStack.current.length);
    setRedoLen(0);
    setIsDirty(true);
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNodeData>[]) => {
    const hasMeaningfulChange = changes.some(c =>
      c.type === "remove" || c.type === "add" ||
      (c.type === "position" && !c.dragging),
    );
    if (hasMeaningfulChange) {
      snapshot(nodes, edges);
    }
    onNodesChange(changes);
  }, [nodes, edges, onNodesChange, snapshot]);

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    snapshot(nodes, edges);
    onEdgesChange(changes);
  }, [nodes, edges, onEdgesChange, snapshot]);

  const handleConnect = useCallback((connection: Connection) => {
    snapshot(nodes, edges);
    setEdges(prev => addEdge({ ...connection, animated: false }, prev));
    setIsDirty(true);
  }, [nodes, edges, setEdges, snapshot]);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(cloneState(nodes, edges));
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setUndoLen(undoStack.current.length);
    setRedoLen(redoStack.current.length);
  }, [nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(cloneState(nodes, edges));
    setNodes(next.nodes);
    setEdges(next.edges);
    setUndoLen(undoStack.current.length);
    setRedoLen(redoStack.current.length);
  }, [nodes, edges, setNodes, setEdges]);

  const updateNodeData = useCallback((id: string, patch: Partial<CanvasNodeData>) => {
    setNodes(prev => prev.map(n =>
      n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
    ));
    setIsDirty(true);
  }, [setNodes]);

  const addNode = useCallback((node: CanvasNode) => {
    snapshot(nodes, edges);
    setNodes(prev => [...prev, node]);
    setIsDirty(true);
  }, [nodes, edges, setNodes, snapshot]);

  const deleteSelected = useCallback(() => {
    snapshot(nodes, edges);
    const sel = new Set(nodes.filter(n => n.selected).map(n => n.id));
    setNodes(prev => prev.filter(n => !sel.has(n.id)));
    setEdges(prev => prev.filter(e => !sel.has(e.source) && !sel.has(e.target)));
    setSelectedNodeId(null);
    setIsDirty(true);
  }, [nodes, edges, setNodes, setEdges, snapshot]);

  const copySelected = useCallback(() => {
    clipboard.current = nodes.filter(n => n.selected);
  }, [nodes]);

  const pasteNodes = useCallback(() => {
    if (!clipboard.current.length) return;
    snapshot(nodes, edges);
    const pasted = clipboard.current.map(n => ({
      ...n,
      id: `${n.id}-copy-${Date.now()}`,
      position: { x: n.position.x + 30, y: n.position.y + 30 },
      selected: true,
    }));
    setNodes(prev => [...prev.map(n => ({ ...n, selected: false })), ...pasted]);
    setIsDirty(true);
  }, [nodes, edges, setNodes, snapshot]);

  const loadFromPipeline = useCallback((
    rawNodes: CanvasNode[],
    rawEdges: CanvasEdge[],
  ) => {
    undoStack.current = [];
    redoStack.current = [];
    setUndoLen(0);
    setRedoLen(0);
    setNodes(rawNodes);
    setEdges(rawEdges);
    setIsDirty(false);
  }, [setNodes, setEdges]);

  return {
    nodes, edges, isDirty, selectedNodeId, setSelectedNodeId,
    undoLen, redoLen,
    handleNodesChange, handleEdgesChange, handleConnect,
    undo, redo, addNode, deleteSelected, copySelected, pasteNodes,
    updateNodeData, loadFromPipeline, setIsDirty,
    setNodes, setEdges,
  };
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "useCanvasState" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/hooks/useCanvasState.ts
git commit -m "feat(canvas): add useCanvasState hook (undo/redo/clipboard)"
```

---

## Task 4: useRunExecution hook

**Files:**
- Create: `ui/frontend/app/canvas/hooks/useRunExecution.ts`

- [ ] **Step 1: Write `ui/frontend/app/canvas/hooks/useRunExecution.ts`**

```typescript
"use client";

import { useCallback, useRef, useState } from "react";
import type { CanvasNode } from "./useCanvasState";
import type { CanvasLogLine, RunLaunchOptions, RuntimeStatus } from "../types";
import { runtimeStatusFromToken } from "../types";

export function useRunExecution(
  onNodeStatusChange: (nodeId: string, status: RuntimeStatus, durationS?: number, preview?: string, noteId?: string) => void,
) {
  const [running, setRunning]       = useState(false);
  const [runError, setRunError]     = useState("");
  const [currentRunId, setCurrentRunId] = useState("");
  const [logLines, setLogLines]     = useState<CanvasLogLine[]>([]);
  const abortRef                    = useRef<AbortController | null>(null);

  const appendLog = useCallback((text: string, level?: CanvasLogLine["level"]) => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    const resolved: CanvasLogLine["level"] = level ?? (
      text.toLowerCase().includes("error") || text.toLowerCase().includes("fail") ? "error"
      : text.toLowerCase().includes("llm") || text.toLowerCase().includes("token") ? "llm"
      : "pipeline"
    );
    setLogLines(prev => {
      const next = [...prev, { ts, text, level: resolved }];
      return next.length > 800 ? next.slice(-800) : next;
    });
  }, []);

  const clearLogs = useCallback(() => setLogLines([]), []);

  // Maps step index → agent node id (built from sorted agent nodes before run)
  const stepToNodeRef = useRef<string[]>([]);

  async function readSSE(
    res: Response,
    onEvent: (type: string, data: Record<string, unknown>, stepIdx: number) => void,
  ) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep < 0) break;
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = block.replace(/\r/g, "").split("\n")
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        try {
          const evt = JSON.parse(dataLines.join("\n"));
          const type = String(evt.type || "");
          const data = (evt.data ?? {}) as Record<string, unknown>;
          const step = typeof data.step === "number" ? data.step : -1;
          onEvent(type, data, step);
        } catch { /* ignore malformed */ }
      }
    }
    if (buffer.trim()) {
      const dataLines = buffer.replace(/\r/g, "").split("\n")
        .filter(l => l.startsWith("data:"))
        .map(l => l.slice(5).trimStart());
      if (dataLines.length) {
        try {
          const evt = JSON.parse(dataLines.join("\n"));
          const type = String(evt.type || "");
          const data = (evt.data ?? {}) as Record<string, unknown>;
          const step = typeof data.step === "number" ? data.step : -1;
          onEvent(type, data, step);
        } catch { /* ignore */ }
      }
    }
  }

  const launch = useCallback(async (
    pipelineId: string,
    salesAgent: string,
    customer: string,
    callId: string,
    agentNodesSortedByX: CanvasNode[],
    opts: RunLaunchOptions,
  ) => {
    if (!pipelineId || !salesAgent || !customer) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Build step → nodeId map
    stepToNodeRef.current = agentNodesSortedByX.map(n => n.id);

    setRunning(true);
    setRunError("");
    clearLogs();
    appendLog(`Starting pipeline run for ${salesAgent} · ${customer}`, "pipeline");

    // Reset all agent nodes to pending
    agentNodesSortedByX.forEach(n => onNodeStatusChange(n.id, "pending"));

    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          sales_agent:   salesAgent,
          customer,
          call_id:       callId || "",
          context_call_id: callId || "",
          run_id:        opts.resumeRunId || "",
          force:         opts.force && !opts.failedOnly,
          resume_partial: !!opts.resumeRunId,
          force_step_indices: [],
          execute_step_indices: [],
          prepare_input_only: false,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Run failed (${res.status})${txt ? `: ${txt.slice(0, 120)}` : ""}`);
      }
      if (!res.body) throw new Error("No response body");

      await readSSE(res, (type, data, stepIdx) => {
        if (type === "pipeline_start") {
          appendLog("Pipeline started", "pipeline");
          const rid = String(data.run_id || "").trim();
          if (rid) setCurrentRunId(rid);
        }
        if (type === "pipeline_done") appendLog("Pipeline finished", "pipeline");
        if (type === "error") {
          appendLog(String(data.msg || data.message || "Pipeline error"), "error");
          setRunError(String(data.msg || data.message || "Pipeline error"));
        }
        if (type === "progress" && data.msg) appendLog(String(data.msg), "pipeline");
        if (type === "stream"   && data.text) appendLog(String(data.text), "llm");

        if (stepIdx < 0 || stepIdx >= stepToNodeRef.current.length) return;
        const nodeId = stepToNodeRef.current[stepIdx];
        if (!nodeId) return;

        const agentName = String(data.agent_name || `Step ${stepIdx + 1}`);
        if (type === "step_start")  {
          onNodeStatusChange(nodeId, "loading");
          appendLog(`${agentName}: started`, "pipeline");
        }
        if (type === "step_cached") {
          onNodeStatusChange(nodeId, "cached");
          appendLog(`${agentName}: cache hit`, "pipeline");
        }
        if (type === "step_done") {
          const dur = typeof data.execution_time_s === "number" ? data.execution_time_s : undefined;
          const preview = String(data.content || "").slice(0, 120) || undefined;
          const noteId  = String(data.note_id || "").trim() || undefined;
          onNodeStatusChange(nodeId, "done", dur, preview, noteId);
          appendLog(`${agentName}: done${dur != null ? ` (${dur.toFixed(1)}s)` : ""}`, "pipeline");
        }
        if (type === "step_error") {
          onNodeStatusChange(nodeId, "error");
          appendLog(`${agentName}: error — ${String(data.msg || "")}`, "error");
        }
      });

    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        appendLog("Run cancelled", "pipeline");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setRunError(msg);
        appendLog(`Error: ${msg}`, "error");
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, clearLogs, onNodeStatusChange]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, runError, currentRunId, logLines, launch, cancel, clearLogs, appendLog };
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "useRunExecution" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/hooks/useRunExecution.ts
git commit -m "feat(canvas): add useRunExecution hook (SSE streaming)"
```

---

## Task 5: InputNode component

**Files:**
- Create: `ui/frontend/app/canvas/components/node-types/InputNode.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/node-types/InputNode.tsx`**

```typescript
"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Zap, Layers, StickyNote, BookOpen, Bot, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeData } from "../../types";
import { RUNTIME_BADGE } from "../../types";

const SOURCE_META: Record<string, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  transcript:        { label: "Transcript",        Icon: Zap },
  merged_transcript: { label: "Merged Transcript", Icon: Layers },
  notes:             { label: "Notes",             Icon: StickyNote },
  merged_notes:      { label: "Merged Notes",      Icon: BookOpen },
  agent_output:      { label: "Agent Output",      Icon: Bot },
  manual:            { label: "Manual",            Icon: PenLine },
};

export function InputNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const src = String(data.inputSource || "transcript");
  const meta = SOURCE_META[src] ?? SOURCE_META.transcript;
  const Icon = meta.Icon;
  const status = data.runtimeStatus ?? "pending";
  const badge = RUNTIME_BADGE[status];

  return (
    <div className={cn(
      "w-52 rounded-xl border-2 bg-blue-950/60 overflow-hidden transition-shadow",
      selected ? "border-blue-400 shadow-[0_0_0_3px_rgba(96,165,250,0.2)]" : "border-blue-700",
    )}>
      {/* Header */}
      <div className="bg-blue-950/80 px-3 py-2 flex items-center gap-2 border-b border-blue-700/50">
        <div className="bg-blue-700 rounded px-1.5 py-0.5 text-[9px] font-bold text-white uppercase tracking-wider shrink-0">
          Input
        </div>
        <span className="text-blue-200 text-xs font-bold truncate flex-1">{meta.label}</span>
        <div className={cn("w-2 h-2 rounded-full shrink-0", badge.dot,
          status === "loading" && "animate-pulse")} />
      </div>

      {/* Body */}
      <div className="px-3 py-2 flex items-center gap-2">
        <Icon className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-blue-300 text-[11px]">{String(data.label || meta.label)}</span>
      </div>

      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !bg-blue-600 !border-2 !border-gray-900 !right-[-6px]" />
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "InputNode" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/node-types/InputNode.tsx
git commit -m "feat(canvas): add InputNode component"
```

---

## Task 6: AgentNode component

**Files:**
- Create: `ui/frontend/app/canvas/components/node-types/AgentNode.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/node-types/AgentNode.tsx`**

```typescript
"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, Play, Eye, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeData } from "../../types";
import { RUNTIME_BADGE } from "../../types";

export function AgentNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const status  = data.runtimeStatus ?? "pending";
  const badge   = RUNTIME_BADGE[status];
  const dur     = data.lastRunDurationS != null ? `${Number(data.lastRunDurationS).toFixed(1)}s` : "";
  const preview = String(data.lastOutputPreview || "");

  return (
    <div className={cn(
      "w-56 rounded-xl border-2 bg-indigo-950/60 overflow-hidden transition-shadow",
      selected
        ? "border-indigo-400 shadow-[0_0_0_3px_rgba(99,102,241,0.25)]"
        : "border-indigo-700",
    )}>
      {/* Header */}
      <div className="bg-indigo-950/80 px-3 py-2 flex items-center gap-2 border-b border-indigo-700/40">
        <div className="bg-indigo-700 rounded-lg w-6 h-6 flex items-center justify-center shrink-0">
          <Bot className="w-3.5 h-3.5 text-indigo-200" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-indigo-100 text-xs font-bold truncate">
            {String(data.agentName || data.label || "Agent")}
          </div>
          {data.agentClass && (
            <div className="text-indigo-400 text-[9px]">{String(data.agentClass)}</div>
          )}
        </div>
        {/* Status badge */}
        <div className={cn(
          "flex items-center gap-1 border rounded-full px-1.5 py-0.5 shrink-0",
          badge.badge,
        )}>
          <div className={cn("w-1.5 h-1.5 rounded-full", badge.dot,
            status === "loading" && "animate-pulse")} />
          <span className="text-[8px] font-bold">{badge.label}</span>
        </div>
      </div>

      {/* Config summary */}
      <div className="px-3 py-2 space-y-1">
        {data.model && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-500">model</span>
            <span className="text-[10px] text-indigo-300 bg-gray-800/60 px-1.5 py-0.5 rounded">
              {String(data.model)}
            </span>
          </div>
        )}
        {data.inputSource && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-500">input</span>
            <span className="text-[10px] text-blue-300 bg-gray-800/60 px-1.5 py-0.5 rounded">
              {String(data.inputSource)}
            </span>
          </div>
        )}
      </div>

      {/* Running progress bar */}
      {status === "loading" && (
        <div className="h-0.5 bg-indigo-950">
          <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-400 animate-[progressBar_2s_ease-in-out_infinite]" />
        </div>
      )}

      {/* Output preview */}
      {preview && (
        <div className="mx-2.5 mb-2 bg-gray-900/60 border border-gray-700/40 rounded-lg px-2.5 py-1.5">
          <p className="text-[9px] text-gray-400 leading-relaxed line-clamp-2">{preview}</p>
        </div>
      )}

      {/* Footer actions */}
      <div className="bg-indigo-950/60 px-2.5 py-1.5 flex items-center gap-1.5 border-t border-indigo-700/30">
        <button className="flex items-center gap-1 bg-indigo-700/30 border border-indigo-600/40 rounded px-2 py-0.5 text-[9px] text-indigo-300 hover:bg-indigo-700/50 transition-colors">
          <Play className="w-2.5 h-2.5" /> Run
        </button>
        <button className="flex items-center gap-1 bg-gray-800/40 border border-gray-700/40 rounded px-2 py-0.5 text-[9px] text-gray-400 hover:bg-gray-800/60 transition-colors">
          <Eye className="w-2.5 h-2.5" /> View
        </button>
        <button className="ml-auto bg-gray-800/40 border border-gray-700/40 rounded p-0.5 text-gray-500 hover:bg-gray-800/60 transition-colors">
          <MoreHorizontal className="w-3 h-3" />
        </button>
        {dur && <span className="text-[9px] text-gray-600 ml-1">{dur}</span>}
      </div>

      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !bg-indigo-600 !border-2 !border-gray-900 !left-[-6px]" />
      <Handle type="source" position={Position.Right}
        className="!w-3 !h-3 !bg-indigo-600 !border-2 !border-gray-900 !right-[-6px]" />
    </div>
  );
}
```

- [ ] **Step 2: Add animation to `ui/frontend/app/globals.css`**

```css
/* At the end of globals.css, add: */
@keyframes progressBar {
  0%   { width: 10%; }
  50%  { width: 75%; }
  100% { width: 10%; }
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "AgentNode" | head -10
```

Expected: no output

- [ ] **Step 4: Commit**

```bash
git add ui/frontend/app/canvas/components/node-types/AgentNode.tsx ui/frontend/app/globals.css
git commit -m "feat(canvas): add AgentNode component (rich inline card)"
```

---

## Task 7: OutputNode component

**Files:**
- Create: `ui/frontend/app/canvas/components/node-types/OutputNode.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/node-types/OutputNode.tsx`**

```typescript
"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Star, User, StickyNote, BadgeCheck, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNodeData } from "../../types";
import { RUNTIME_BADGE } from "../../types";

const SUBTYPE_META: Record<string, {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  border: string; bg: string; text: string;
}> = {
  persona:          { label: "Persona Profile",    Icon: User,       border: "border-violet-600",  bg: "bg-violet-950/60",  text: "text-violet-200" },
  persona_score:    { label: "Persona Score",      Icon: BadgeCheck, border: "border-violet-700",  bg: "bg-violet-950/50",  text: "text-violet-300" },
  notes:            { label: "Call Notes",         Icon: StickyNote, border: "border-amber-600",   bg: "bg-amber-950/60",   text: "text-amber-200"  },
  notes_compliance: { label: "Compliance Notes",   Icon: ShieldCheck,border: "border-emerald-600", bg: "bg-emerald-950/60", text: "text-emerald-200"},
  custom:           { label: "Custom Output",      Icon: Star,       border: "border-yellow-600",  bg: "bg-yellow-950/60",  text: "text-yellow-200" },
};
const DEFAULT_META = { label: "Output", Icon: Star, border: "border-gray-600", bg: "bg-gray-900/60", text: "text-gray-200" };

export function OutputNode({ data, selected }: NodeProps<CanvasNodeData>) {
  const sub  = String(data.outputSubType || "custom");
  const meta = SUBTYPE_META[sub] ?? DEFAULT_META;
  const Icon = meta.Icon;
  const status = data.runtimeStatus ?? "pending";
  const badge  = RUNTIME_BADGE[status];

  return (
    <div className={cn(
      "w-52 rounded-xl border-2 overflow-hidden transition-shadow",
      meta.bg,
      selected
        ? `${meta.border} shadow-[0_0_0_3px_rgba(99,102,241,0.2)]`
        : meta.border,
    )}>
      {/* Header */}
      <div className={cn("px-3 py-2 flex items-center gap-2 border-b opacity-90", meta.border.replace("border-", "border-b-"))}>
        <div className="bg-gray-800/60 rounded px-1.5 py-0.5 text-[9px] font-bold text-white uppercase shrink-0">
          Output
        </div>
        <Icon className={cn("w-3.5 h-3.5 shrink-0", meta.text)} />
        <span className={cn("text-xs font-bold truncate flex-1", meta.text)}>{meta.label}</span>
        <div className={cn("w-2 h-2 rounded-full shrink-0", badge.dot)} />
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        {data.outputFormat && (
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-500">format</span>
            <span className={cn("text-[10px] bg-gray-800/60 px-1.5 py-0.5 rounded", meta.text)}>
              {String(data.outputFormat)}
            </span>
          </div>
        )}
        {data.lastNoteId && (
          <div className="mt-1.5 bg-emerald-950/40 border border-emerald-700/30 rounded px-2 py-1">
            <span className="text-[9px] text-emerald-400">note saved ✓</span>
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Left}
        className="!w-3 !h-3 !bg-violet-600 !border-2 !border-gray-900 !left-[-6px]" />
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "OutputNode" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/node-types/OutputNode.tsx
git commit -m "feat(canvas): add OutputNode component"
```

---

## Task 8: CanvasSidebar

**Files:**
- Create: `ui/frontend/app/canvas/components/CanvasSidebar.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/CanvasSidebar.tsx`**

```typescript
"use client";

import { useState, useRef, useEffect } from "react";
import { Folder, Plus, MoreVertical, Pencil, Trash2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PipelineDef, PipelineFolderDef } from "../types";

interface Props {
  folders:         PipelineFolderDef[];
  pipelines:       PipelineDef[];
  activeFolderId:  string;
  activePipelineId: string;
  onSelectFolder:  (id: string) => void;
  onSelectPipeline:(id: string) => void;
  onCreateFolder:  () => void;
  onRenameFolder:  (id: string, name: string) => void;
  onDeleteFolder:  (id: string) => void;
  onCreatePipeline: () => void;
  onRenamePipeline: (id: string, name: string) => void;
  onDeletePipeline: (id: string) => void;
  onDuplicatePipeline: (id: string) => void;
}

export function CanvasSidebar({
  folders, pipelines,
  activeFolderId, activePipelineId,
  onSelectFolder, onSelectPipeline,
  onCreateFolder,
  onRenameFolder, onDeleteFolder,
  onCreatePipeline,
  onRenamePipeline, onDeletePipeline, onDuplicatePipeline,
}: Props) {
  const [editingFolderId,   setEditingFolderId]   = useState<string | null>(null);
  const [editingPipelineId, setEditingPipelineId] = useState<string | null>(null);
  const [editName,          setEditName]           = useState("");
  const [folderMenuId,      setFolderMenuId]       = useState<string | null>(null);
  const [pipelineMenuId,    setPipelineMenuId]     = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const activeFolder = folders.find(f => f.id === activeFolderId);
  const folderPipelines = pipelines.filter(p =>
    activeFolderId ? p.folder_id === activeFolderId : !p.folder_id,
  );

  useEffect(() => {
    if (editingFolderId || editingPipelineId) editInputRef.current?.focus();
  }, [editingFolderId, editingPipelineId]);

  function startEditFolder(f: PipelineFolderDef) {
    setEditingFolderId(f.id);
    setEditName(f.name);
    setFolderMenuId(null);
  }

  function commitFolderRename() {
    if (editingFolderId && editName.trim()) onRenameFolder(editingFolderId, editName.trim());
    setEditingFolderId(null);
  }

  function startEditPipeline(p: PipelineDef) {
    setEditingPipelineId(p.id);
    setEditName(p.name);
    setPipelineMenuId(null);
  }

  function commitPipelineRename() {
    if (editingPipelineId && editName.trim()) onRenamePipeline(editingPipelineId, editName.trim());
    setEditingPipelineId(null);
  }

  return (
    <div className="flex h-full" onClick={() => { setFolderMenuId(null); setPipelineMenuId(null); }}>

      {/* Icon rail */}
      <div className="w-12 bg-gray-950 border-r border-gray-800 flex flex-col items-center py-3 gap-2 shrink-0">
        {folders.map(f => (
          <button
            key={f.id}
            title={f.name}
            onClick={() => onSelectFolder(f.id)}
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center transition-colors",
              f.id === activeFolderId
                ? "bg-indigo-600/30 border border-indigo-500"
                : "bg-gray-800/50 hover:bg-gray-800 border border-transparent",
            )}
          >
            <Folder className={cn("w-4 h-4", f.id === activeFolderId ? "text-indigo-400" : "text-gray-500")} />
          </button>
        ))}
        <button
          title="New folder"
          onClick={onCreateFolder}
          className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-800/30 hover:bg-blue-900/30 border border-dashed border-gray-700 hover:border-blue-600 transition-colors mt-auto"
        >
          <Plus className="w-3.5 h-3.5 text-gray-500 hover:text-blue-400" />
        </button>
      </div>

      {/* Pipeline list */}
      <div className="w-44 bg-gray-950/80 border-r border-gray-800 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-800 shrink-0">
          <span className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest truncate block">
            {activeFolder?.name ?? "All Pipelines"}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {folderPipelines.map(p => (
            <div key={p.id} className="relative px-2">
              {editingPipelineId === p.id ? (
                <div className="flex items-center gap-1 px-1 py-1">
                  <input
                    ref={editInputRef}
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") commitPipelineRename(); if (e.key === "Escape") setEditingPipelineId(null); }}
                    className="flex-1 bg-gray-800 border border-indigo-500 rounded px-1.5 py-0.5 text-xs text-white outline-none min-w-0"
                  />
                  <button onClick={commitPipelineRename}><Check className="w-3 h-3 text-emerald-400" /></button>
                  <button onClick={() => setEditingPipelineId(null)}><X className="w-3 h-3 text-gray-500" /></button>
                </div>
              ) : (
                <button
                  onClick={() => onSelectPipeline(p.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors group",
                    p.id === activePipelineId
                      ? "bg-indigo-600/20 border border-indigo-600/40 text-white"
                      : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200 border border-transparent",
                  )}
                >
                  {p.id === activePipelineId && (
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                  )}
                  <span className="text-xs truncate flex-1">{p.name}</span>
                  <button
                    onClick={e => { e.stopPropagation(); setPipelineMenuId(p.id === pipelineMenuId ? null : p.id); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-700 rounded transition-all"
                  >
                    <MoreVertical className="w-3 h-3 text-gray-500" />
                  </button>
                </button>
              )}

              {/* Pipeline context menu */}
              {pipelineMenuId === p.id && (
                <div className="absolute right-0 top-7 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 w-36 text-xs"
                  onClick={e => e.stopPropagation()}>
                  <button onClick={() => startEditPipeline(p)} className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                    <Pencil className="w-3 h-3" /> Rename
                  </button>
                  <button onClick={() => { onDuplicatePipeline(p.id); setPipelineMenuId(null); }} className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                    <Plus className="w-3 h-3" /> Duplicate
                  </button>
                  <div className="h-px bg-gray-700 my-1" />
                  <button onClick={() => { onDeletePipeline(p.id); setPipelineMenuId(null); }} className="w-full px-3 py-1.5 text-left hover:bg-red-900/40 flex items-center gap-2 text-red-400">
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              )}
            </div>
          ))}

          {folderPipelines.length === 0 && (
            <p className="text-center text-gray-600 text-xs py-4 italic">No pipelines</p>
          )}
        </div>

        <div className="p-2 border-t border-gray-800 shrink-0">
          <button
            onClick={onCreatePipeline}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-dashed border-blue-700/50 text-blue-500 text-xs hover:bg-blue-900/20 hover:border-blue-600 transition-colors"
          >
            <Plus className="w-3 h-3" /> New Pipeline
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "CanvasSidebar" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/CanvasSidebar.tsx
git commit -m "feat(canvas): add CanvasSidebar (folder rail + pipeline list)"
```

---

## Task 9: CanvasToolbar

**Files:**
- Create: `ui/frontend/app/canvas/components/CanvasToolbar.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/CanvasToolbar.tsx`**

```typescript
"use client";

import { useReactFlow } from "@xyflow/react";
import { Undo2, Redo2, Plus, Trash2, Minus, Maximize2, Play, Save, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  undoLen:    number;
  redoLen:    number;
  isDirty:    boolean;
  saving:     boolean;
  running:    boolean;
  onUndo:     () => void;
  onRedo:     () => void;
  onAddNode:  () => void;
  onDelete:   () => void;
  onSave:     () => void;
  onRun:      () => void;
}

export function CanvasToolbar({
  undoLen, redoLen, isDirty, saving, running,
  onUndo, onRedo, onAddNode, onDelete, onSave, onRun,
}: Props) {
  const { zoomIn, zoomOut, fitView, getZoom } = useReactFlow();

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-gray-900/90 backdrop-blur-sm border border-gray-700/60 rounded-3xl px-4 py-2 shadow-xl">

      {/* Undo / Redo */}
      <button onClick={onUndo} disabled={undoLen === 0}
        className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 text-indigo-400 transition-colors" title="Undo (Ctrl+Z)">
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button onClick={onRedo} disabled={redoLen === 0}
        className="p-1 rounded hover:bg-gray-700 disabled:opacity-30 text-indigo-400 transition-colors" title="Redo (Ctrl+Y)">
        <Redo2 className="w-3.5 h-3.5" />
      </button>

      <div className="w-px h-4 bg-gray-700" />

      {/* Add / Delete */}
      <button onClick={onAddNode}
        className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-600/60 rounded-lg px-2.5 py-1 text-xs text-gray-200 transition-colors" title="Add node">
        <Plus className="w-3 h-3" /> Node
      </button>
      <button onClick={onDelete}
        className="flex items-center gap-1 bg-red-950/30 hover:bg-red-900/40 border border-red-800/40 rounded-lg px-2.5 py-1 text-xs text-red-400 transition-colors" title="Delete selected (Delete)">
        <Trash2 className="w-3 h-3" />
      </button>

      <div className="w-px h-4 bg-gray-700" />

      {/* Zoom */}
      <button onClick={() => zoomOut()} className="p-1 rounded hover:bg-gray-700 text-gray-400 transition-colors">
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="text-[10px] text-gray-500 w-8 text-center font-mono select-none">
        {Math.round(getZoom() * 100)}%
      </span>
      <button onClick={() => zoomIn()} className="p-1 rounded hover:bg-gray-700 text-gray-400 transition-colors">
        <Plus className="w-3 h-3" />
      </button>
      <button onClick={() => fitView({ padding: 0.15, duration: 300 })}
        className="p-1 rounded hover:bg-gray-700 text-gray-400 transition-colors" title="Fit to screen">
        <Maximize2 className="w-3.5 h-3.5" />
      </button>

      <div className="w-px h-4 bg-gray-700" />

      {/* Save */}
      <button onClick={onSave} disabled={saving || !isDirty}
        className={cn(
          "flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-colors",
          isDirty && !saving
            ? "bg-gray-700 hover:bg-gray-600 border border-gray-500/60 text-white"
            : "bg-gray-800/40 border border-gray-700/30 text-gray-600 cursor-default",
        )} title="Save (Ctrl+S)">
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
        {saving ? "Saving…" : "Save"}
      </button>

      {/* Run */}
      <button onClick={onRun} disabled={running}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold transition-colors",
          running
            ? "bg-amber-700/30 border border-amber-600/40 text-amber-300 cursor-default"
            : "bg-emerald-700/30 hover:bg-emerald-700/50 border border-emerald-600/50 text-emerald-300",
        )} title="Run pipeline">
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
        {running ? "Running…" : "Run"}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "CanvasToolbar" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/CanvasToolbar.tsx
git commit -m "feat(canvas): add CanvasToolbar (floating pill)"
```

---

## Task 10: CanvasBoard

**Files:**
- Create: `ui/frontend/app/canvas/components/CanvasBoard.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/CanvasBoard.tsx`**

```typescript
"use client";

import { useCallback, useState } from "react";
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  type NodeTypes, type NodeMouseHandler, type OnConnectEnd,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { InputNode }  from "./node-types/InputNode";
import { AgentNode }  from "./node-types/AgentNode";
import { OutputNode } from "./node-types/OutputNode";
import { CanvasToolbar } from "./CanvasToolbar";
import type { CanvasNode, CanvasEdge } from "../hooks/useCanvasState";
import type { NodeChange, EdgeChange, Connection } from "@xyflow/react";
import type { CanvasNodeData } from "../types";

const NODE_TYPES: NodeTypes = {
  input:  InputNode  as unknown as NodeTypes[string],
  agent:  AgentNode  as unknown as NodeTypes[string],
  output: OutputNode as unknown as NodeTypes[string],
};

interface ContextMenuState {
  x: number; y: number;
  type: "node" | "canvas";
  nodeId?: string;
}

interface Props {
  nodes:    CanvasNode[];
  edges:    CanvasEdge[];
  isDirty:  boolean;
  saving:   boolean;
  running:  boolean;
  undoLen:  number;
  redoLen:  number;
  onNodesChange: (changes: NodeChange<CanvasNodeData>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect:     (connection: Connection) => void;
  onNodeClick:   NodeMouseHandler<CanvasNodeData>;
  onUndo:    () => void;
  onRedo:    () => void;
  onAddNode: () => void;
  onDelete:  () => void;
  onSave:    () => void;
  onRun:     () => void;
  onDuplicateNode?: (id: string) => void;
  onDeleteNode?:    (id: string) => void;
}

export function CanvasBoard({
  nodes, edges, isDirty, saving, running, undoLen, redoLen,
  onNodesChange, onEdgesChange, onConnect, onNodeClick,
  onUndo, onRedo, onAddNode, onDelete, onSave, onRun,
  onDuplicateNode, onDeleteNode,
}: Props) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const handlePaneContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, type: "canvas" });
  }, []);

  const handleNodeContextMenu: NodeMouseHandler<CanvasNodeData> = useCallback((e, node) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, type: "node", nodeId: node.id });
  }, []);

  const closeCtx = useCallback(() => setCtxMenu(null), []);

  return (
    <div className="flex-1 relative" onClick={closeCtx}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={closeCtx}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={3}
        selectionOnDrag
        multiSelectionKeyCode="Control"
        deleteKeyCode={["Delete", "Backspace"]}
        className="bg-[#0d0f1c]"
        defaultEdgeOptions={{ type: "smoothstep", style: { stroke: "#6366f1", strokeWidth: 2, opacity: 0.7 } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#1e2235" />
        <MiniMap
          position="bottom-left"
          nodeColor={(n) => {
            const kind = (n.data as CanvasNodeData).kind;
            return kind === "input" ? "#1d4ed8" : kind === "agent" ? "#4f46e5" : "#7c3aed";
          }}
          maskColor="rgba(13,15,28,0.7)"
          style={{ background: "#111320", border: "1px solid #2d3149", borderRadius: 6 }}
        />
        <Controls position="bottom-right" showInteractive={false}
          className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-400 [&>button:hover]:bg-gray-700" />

        <CanvasToolbar
          undoLen={undoLen} redoLen={redoLen}
          isDirty={isDirty} saving={saving} running={running}
          onUndo={onUndo} onRedo={onRedo}
          onAddNode={onAddNode} onDelete={onDelete}
          onSave={onSave} onRun={onRun}
        />
      </ReactFlow>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl py-1 text-xs min-w-[140px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {ctxMenu.type === "node" && ctxMenu.nodeId ? (
            <>
              <button onClick={() => { onDuplicateNode?.(ctxMenu.nodeId!); closeCtx(); }}
                className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                📋 Duplicate
              </button>
              <div className="h-px bg-gray-700 my-1" />
              <button onClick={() => { onDeleteNode?.(ctxMenu.nodeId!); closeCtx(); }}
                className="w-full px-3 py-1.5 text-left hover:bg-red-900/40 flex items-center gap-2 text-red-400">
                🗑 Delete
              </button>
            </>
          ) : (
            <>
              <button onClick={() => { onAddNode(); closeCtx(); }}
                className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                ＋ Add Node
              </button>
              <button onClick={() => { fitView(); closeCtx(); }}
                className="w-full px-3 py-1.5 text-left hover:bg-gray-700 flex items-center gap-2 text-gray-300">
                ⊡ Fit to Screen
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// tiny shim so fitView works in context menu
function fitView() {
  // Called via useReactFlow in CanvasToolbar; here we just close the menu
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "CanvasBoard" | head -10
```

Expected: no output (or only the dummy `fitView` shim which is harmless)

- [ ] **Step 3: Fix the `fitView` shim** — replace the dummy function with `useReactFlow`:

In `CanvasBoard.tsx`, add to imports:
```typescript
import { useReactFlow } from "@xyflow/react";
```

Add inside the component, after the `closeCtx` declaration:
```typescript
const { fitView } = useReactFlow();
```

Then remove the module-level `function fitView()` stub at the bottom.

- [ ] **Step 4: Final verify**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "canvas" | head -20
```

- [ ] **Step 5: Commit**

```bash
git add ui/frontend/app/canvas/components/CanvasBoard.tsx
git commit -m "feat(canvas): add CanvasBoard (ReactFlow wrapper + context menus)"
```

---

## Task 11: NodeInspector

**Files:**
- Create: `ui/frontend/app/canvas/components/inspector/NodeInspector.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/inspector/NodeInspector.tsx`**

```typescript
"use client";

import { useState } from "react";
import { X, Eye, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "../../hooks/useCanvasState";
import type { UniversalAgent, CanvasNodeData } from "../../types";
import { INPUT_SOURCES, MODEL_GROUPS, OUTPUT_SUBTYPES, RUNTIME_BADGE } from "../../types";

interface Props {
  node:       CanvasNode | null;
  agents:     UniversalAgent[];
  onClose:    () => void;
  onUpdate:   (id: string, patch: Partial<CanvasNodeData>) => void;
  onSendNote: (noteId: string) => void;
}

export function NodeInspector({ node, agents, onClose, onUpdate, onSendNote }: Props) {
  const [viewingOutput, setViewingOutput] = useState(false);

  if (!node) return null;

  const data   = node.data;
  const status = data.runtimeStatus ?? "pending";
  const badge  = RUNTIME_BADGE[status];

  function field(label: string, children: React.ReactNode) {
    return (
      <div className="space-y-1">
        <div className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">{label}</div>
        {children}
      </div>
    );
  }

  const selectCls = "w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500 transition-colors";

  return (
    <div className="w-56 bg-gray-950/90 border-l border-gray-800 flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold text-white truncate">
            {String(data.agentName || data.label || data.kind)}
          </div>
          <div className={cn("flex items-center gap-1 mt-0.5", badge.badge, "border-0 bg-transparent p-0")}>
            <div className={cn("w-1.5 h-1.5 rounded-full", badge.dot,
              status === "loading" && "animate-pulse")} />
            <span className="text-[9px]">{badge.label}</span>
            {data.lastRunDurationS != null && (
              <span className="text-[9px] text-gray-600 ml-1">· {Number(data.lastRunDurationS).toFixed(1)}s</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-400 shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Scrollable config area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">

        {/* INPUT NODE */}
        {data.kind === "input" && (
          field("Input Source",
            <select value={String(data.inputSource || "transcript")}
              onChange={e => onUpdate(node.id, { inputSource: e.target.value })}
              className={selectCls}>
              {INPUT_SOURCES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          )
        )}

        {/* AGENT NODE */}
        {data.kind === "agent" && (
          <>
            {field("Agent",
              <select value={String(data.agentId || "")}
                onChange={e => {
                  const a = agents.find(x => x.id === e.target.value);
                  if (!a) return;
                  onUpdate(node.id, {
                    agentId: a.id, agentName: a.name,
                    agentClass: a.agent_class, model: a.model,
                    label: a.name,
                  });
                }}
                className={selectCls}>
                <option value="">Select agent…</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            {field("Model",
              <select value={String(data.model || "")}
                onChange={e => onUpdate(node.id, { model: e.target.value })}
                className={selectCls}>
                {MODEL_GROUPS.map(g => (
                  <optgroup key={g.provider} label={g.provider}>
                    {g.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
            {field("Input Source",
              <select value={String(data.inputSource || "transcript")}
                onChange={e => onUpdate(node.id, { inputSource: e.target.value })}
                className={selectCls}>
                {INPUT_SOURCES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}
          </>
        )}

        {/* OUTPUT NODE */}
        {data.kind === "output" && (
          <>
            {field("Output Type",
              <select value={String(data.outputSubType || "custom")}
                onChange={e => onUpdate(node.id, { outputSubType: e.target.value })}
                className={selectCls}>
                {OUTPUT_SUBTYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            )}
            {field("Format",
              <select value={String(data.outputFormat || "markdown")}
                onChange={e => onUpdate(node.id, { outputFormat: e.target.value })}
                className={selectCls}>
                <option value="markdown">Markdown</option>
                <option value="json">JSON</option>
                <option value="text">Plain Text</option>
              </select>
            )}
          </>
        )}

        {/* Last output preview */}
        {data.lastOutputPreview && (
          <div className="space-y-1 border-t border-gray-800 pt-3">
            <div className="text-[9px] text-gray-500 uppercase tracking-wider font-medium">Last Output</div>
            <div className="bg-gray-900/80 border border-gray-700/40 rounded-lg p-2.5 text-[10px] text-gray-300 leading-relaxed max-h-28 overflow-y-auto">
              {String(data.lastOutputPreview)}
            </div>
            <button onClick={() => setViewingOutput(true)}
              className="w-full flex items-center justify-center gap-1.5 bg-indigo-700/20 border border-indigo-600/40 rounded-lg py-1.5 text-[10px] text-indigo-300 hover:bg-indigo-700/30 transition-colors">
              <Eye className="w-3 h-3" /> View Full Output
            </button>
            {data.lastNoteId && (
              <button onClick={() => onSendNote(String(data.lastNoteId))}
                className="w-full flex items-center justify-center gap-1.5 bg-emerald-700/20 border border-emerald-600/40 rounded-lg py-1.5 text-[10px] text-emerald-300 hover:bg-emerald-700/30 transition-colors">
                <Send className="w-3 h-3" /> Push to CRM
              </button>
            )}
          </div>
        )}
      </div>

      {/* Full output modal */}
      {viewingOutput && data.lastOutputPreview && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={() => setViewingOutput(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
              <span className="text-sm font-bold text-white">
                {String(data.agentName || "Output")}
              </span>
              <button onClick={() => setViewingOutput(false)}>
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <pre className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed font-mono">
                {String(data.lastOutputPreview)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "NodeInspector" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/inspector/NodeInspector.tsx
git commit -m "feat(canvas): add NodeInspector panel"
```

---

## Task 12: BottomLogPanel

**Files:**
- Create: `ui/frontend/app/canvas/components/BottomLogPanel.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/BottomLogPanel.tsx`**

```typescript
"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasLogLine } from "../types";

interface Props {
  lines:    CanvasLogLine[];
  running:  boolean;
  onClear:  () => void;
}

export function BottomLogPanel({ lines, running, onClear }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (running) setExpanded(true);
  }, [running]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const levelColor: Record<CanvasLogLine["level"], string> = {
    pipeline: "text-blue-400",
    llm:      "text-purple-400",
    error:    "text-red-400",
    warn:     "text-amber-400",
    info:     "text-gray-400",
  };

  const latest = lines[lines.length - 1];

  return (
    <div className={cn(
      "border-t border-gray-800 bg-gray-950/95 transition-all duration-200 shrink-0",
      expanded ? "h-48" : "h-8",
    )}>
      {/* Strip header */}
      <div className="h-8 flex items-center px-3 gap-3">
        {!expanded && latest && (
          <span className={cn("text-[10px] font-mono truncate flex-1", levelColor[latest.level])}>
            [{latest.ts}] {latest.text}
          </span>
        )}
        {expanded && (
          <span className="text-[10px] text-gray-500 font-mono">
            Execution Log ({lines.length} lines)
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto shrink-0">
          {expanded && (
            <button onClick={onClear} className="text-gray-600 hover:text-gray-400 p-0.5">
              <X className="w-3 h-3" />
            </button>
          )}
          <button onClick={() => setExpanded(e => !e)} className="text-gray-500 hover:text-gray-300 p-0.5">
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5" />
              : <ChevronUp   className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Expanded log */}
      {expanded && (
        <div className="h-[calc(100%-2rem)] overflow-y-auto px-3 pb-2 space-y-0.5">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 font-mono text-[10px] leading-5">
              <span className="text-gray-600 shrink-0">[{l.ts}]</span>
              <span className={levelColor[l.level]}>{l.text}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "BottomLogPanel" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/BottomLogPanel.tsx
git commit -m "feat(canvas): add BottomLogPanel (collapsible log strip)"
```

---

## Task 13: RunLaunchModal

**Files:**
- Create: `ui/frontend/app/canvas/components/RunLaunchModal.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/components/RunLaunchModal.tsx`**

```typescript
"use client";

import { useState } from "react";
import { X, Play, Loader2 } from "lucide-react";
import type { RunLaunchOptions } from "../types";

interface Props {
  open:      boolean;
  running:   boolean;
  onClose:   () => void;
  onLaunch:  (opts: RunLaunchOptions) => void;
}

export function RunLaunchModal({ open, running, onClose, onLaunch }: Props) {
  const [force,       setForce]      = useState(false);
  const [failedOnly,  setFailedOnly] = useState(false);
  const [resumeRunId, setResumeRunId]= useState("");

  if (!open) return null;

  function handleLaunch() {
    onLaunch({ force, failedOnly, resumeRunId: resumeRunId.trim() });
    onClose();
  }

  const toggleCls = (on: boolean) =>
    `w-8 h-4 rounded-full transition-colors flex items-center px-0.5 ${on ? "bg-indigo-600" : "bg-gray-700"}`;
  const thumbCls  = (on: boolean) =>
    `w-3 h-3 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0"}`;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-80 shadow-2xl"
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <div className="text-sm font-bold text-white">Run Pipeline</div>
            <div className="text-xs text-gray-500 mt-0.5">Choose execution options</div>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-500" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Force re-run */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-white font-medium">Force re-run</div>
              <div className="text-[10px] text-gray-500 mt-0.5">Bypass cache for all steps</div>
            </div>
            <button onClick={() => { setForce(f => !f); setFailedOnly(false); }}
              className={toggleCls(force)}>
              <div className={thumbCls(force)} />
            </button>
          </div>

          {/* Failed steps only */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-white font-medium">Failed steps only</div>
              <div className="text-[10px] text-gray-500 mt-0.5">Re-run only errored steps</div>
            </div>
            <button onClick={() => { setFailedOnly(f => !f); setForce(false); }}
              className={toggleCls(failedOnly)}>
              <div className={thumbCls(failedOnly)} />
            </button>
          </div>

          {/* Resume run ID */}
          <div className="space-y-1.5">
            <div className="text-xs text-white font-medium">Resume run ID <span className="text-gray-600">(optional)</span></div>
            <input
              value={resumeRunId}
              onChange={e => setResumeRunId(e.target.value)}
              placeholder="run-id to continue from…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
            />
          </div>
        </div>

        <div className="px-5 pb-5 flex gap-2">
          <button onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl py-2 text-xs text-gray-300 transition-colors">
            Cancel
          </button>
          <button onClick={handleLaunch} disabled={running}
            className="flex-1 bg-emerald-700/40 hover:bg-emerald-700/60 border border-emerald-600/50 rounded-xl py-2 text-xs text-emerald-300 font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50">
            {running
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</>
              : <><Play className="w-3.5 h-3.5" /> Launch</>}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | grep "RunLaunchModal" | head -10
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/components/RunLaunchModal.tsx
git commit -m "feat(canvas): add RunLaunchModal"
```

---

## Task 14: page.tsx — main shell

**Files:**
- Create: `ui/frontend/app/canvas/page.tsx`

- [ ] **Step 1: Write `ui/frontend/app/canvas/page.tsx`**

```typescript
"use client";

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useAppCtx } from "@/lib/app-context";
import ContextTopBar from "@/components/shared/ContextTopBar";
import { CanvasSidebar }    from "./components/CanvasSidebar";
import { CanvasBoard }      from "./components/CanvasBoard";
import { NodeInspector }    from "./components/inspector/NodeInspector";
import { BottomLogPanel }   from "./components/BottomLogPanel";
import { RunLaunchModal }   from "./components/RunLaunchModal";
import { usePipelineData }  from "./hooks/usePipelineData";
import { useCanvasState }   from "./hooks/useCanvasState";
import { useRunExecution }  from "./hooks/useRunExecution";
import type { CanvasNode }  from "./hooks/useCanvasState";
import type { CanvasNodeData, RunLaunchOptions } from "./types";
import { deriveStepsFromNodes } from "./types";
import type { NodeMouseHandler } from "@xyflow/react";

function CanvasPageInner() {
  const {
    salesAgent, customer, callId,
    activePipelineId, setActivePipeline,
  } = useAppCtx();

  const {
    agents, pipelines, folders,
    savePipeline, deletePipeline, loadPipeline,
    createFolder, renameFolder, deleteFolder,
  } = usePipelineData();

  const {
    nodes, edges, isDirty, selectedNodeId, setSelectedNodeId,
    undoLen, redoLen,
    handleNodesChange, handleEdgesChange, handleConnect,
    undo, redo, addNode, deleteSelected, copySelected, pasteNodes,
    updateNodeData, loadFromPipeline, setIsDirty,
    setNodes, setEdges,
  } = useCanvasState();

  const handleNodeStatusChange = useCallback((
    nodeId: string, status: import("./types").RuntimeStatus,
    durationS?: number, preview?: string, noteId?: string,
  ) => {
    updateNodeData(nodeId, {
      runtimeStatus: status,
      ...(durationS  != null && { lastRunDurationS: durationS }),
      ...(preview    != null && { lastOutputPreview: preview }),
      ...(noteId     != null && { lastNoteId: noteId }),
    });
  }, [updateNodeData]);

  const { running, runError, logLines, launch, cancel, clearLogs } =
    useRunExecution(handleNodeStatusChange);

  const [activeFolderId,  setActiveFolderId]  = useState("");
  const [showRunModal,    setShowRunModal]     = useState(false);
  const [saving,          setSaving]           = useState(false);
  const [showAddNode,     setShowAddNode]      = useState(false);
  const [crmOpen,         setCrmOpen]          = useState(false);
  const [callsOpen,       setCallsOpen]        = useState(false);

  // ── Load pipeline when activePipelineId changes ───────────────────────────

  useEffect(() => {
    if (!activePipelineId) return;
    loadPipeline(activePipelineId).then(pl => {
      const raw = pl.canvas;
      if (raw?.nodes?.length) {
        loadFromPipeline(
          raw.nodes as CanvasNode[],
          raw.edges as import("./hooks/useCanvasState").CanvasEdge[],
        );
      } else {
        loadFromPipeline([], []);
      }
    }).catch(console.error);
  }, [activePipelineId, loadPipeline, loadFromPipeline]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "c") { e.preventDefault(); copySelected(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") { e.preventDefault(); pasteNodes(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, copySelected, pasteNodes]);

  // ── Save ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!activePipelineId) return;
    setSaving(true);
    try {
      const pl = pipelines.find(p => p.id === activePipelineId);
      if (!pl) return;
      const steps = deriveStepsFromNodes(nodes);
      const canvasData = {
        nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
      };
      await savePipeline({ ...pl, steps, canvas: canvasData });
      setIsDirty(false);
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  function handleRun() {
    if (!activePipelineId) return;
    setShowRunModal(true);
  }

  function handleLaunch(opts: RunLaunchOptions) {
    const agentNodes = nodes
      .filter(n => n.data.kind === "agent" && n.data.agentId)
      .sort((a, b) => a.position.x - b.position.x);
    void launch(activePipelineId, salesAgent, customer, callId, agentNodes, opts);
  }

  // ── Node interactions ─────────────────────────────────────────────────────

  const handleNodeClick: NodeMouseHandler<CanvasNodeData> = useCallback((_, node) => {
    setSelectedNodeId(node.id);
  }, [setSelectedNodeId]);

  function handleAddNode() {
    const kinds: Array<CanvasNodeData["kind"]> = ["input", "agent", "output"];
    const kind  = kinds[nodes.filter(n => n.data.kind).length % 3] ?? "agent";
    const id    = `node-${Date.now()}`;
    const newNode: CanvasNode = {
      id,
      type: kind,
      position: { x: 100 + nodes.length * 30, y: 150 },
      data: { kind, label: kind === "agent" ? "New Agent" : kind === "input" ? "Transcript" : "Output" },
    };
    addNode(newNode);
  }

  function handleDuplicateNode(id: string) {
    const src = nodes.find(n => n.id === id);
    if (!src) return;
    const newNode: CanvasNode = {
      ...src,
      id: `node-${Date.now()}`,
      position: { x: src.position.x + 30, y: src.position.y + 30 },
      selected: false,
    };
    addNode(newNode);
  }

  function handleDeleteNode(id: string) {
    setNodes(prev => prev.filter(n => n.id !== id));
    setEdges(prev => prev.filter(e => e.source !== id && e.target !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    setIsDirty(true);
  }

  async function handleSendNote(noteId: string) {
    await fetch(`/api/notes/${encodeURIComponent(noteId)}/send-to-crm`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sales_agent: salesAgent, customer }),
    });
  }

  async function handleCreatePipeline() {
    const pl = await savePipeline({
      name: "New Pipeline",
      description: "",
      folder_id: activeFolderId || undefined,
      steps: [],
    });
    setActivePipeline(pl.id, pl.name);
  }

  async function handleRenamePipeline(id: string, name: string) {
    const pl = pipelines.find(p => p.id === id);
    if (!pl) return;
    await savePipeline({ ...pl, name });
    if (id === activePipelineId) setActivePipeline(id, name);
  }

  async function handleDeletePipeline(id: string) {
    await deletePipeline(id);
    if (id === activePipelineId) setActivePipeline("", "");
  }

  async function handleDuplicatePipeline(id: string) {
    const pl = await loadPipeline(id);
    await savePipeline({ ...pl, id: undefined as unknown as string, name: `${pl.name} (copy)` });
  }

  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null;

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Context top bar */}
      <ContextTopBar
        salesAgent={salesAgent}
        customer={customer}
        callId={callId}
        onOpenCrm={() => setCrmOpen(true)}
        onOpenCalls={() => setCallsOpen(true)}
      />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <CanvasSidebar
          folders={folders}
          pipelines={pipelines}
          activeFolderId={activeFolderId}
          activePipelineId={activePipelineId}
          onSelectFolder={setActiveFolderId}
          onSelectPipeline={id => {
            const p = pipelines.find(x => x.id === id);
            if (p) setActivePipeline(p.id, p.name);
          }}
          onCreateFolder={async () => {
            const f = await createFolder("New Folder");
            setActiveFolderId(f.id);
          }}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onCreatePipeline={handleCreatePipeline}
          onRenamePipeline={handleRenamePipeline}
          onDeletePipeline={handleDeletePipeline}
          onDuplicatePipeline={handleDuplicatePipeline}
        />

        {/* Canvas */}
        <CanvasBoard
          nodes={nodes}
          edges={edges}
          isDirty={isDirty}
          saving={saving}
          running={running}
          undoLen={undoLen}
          redoLen={redoLen}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeClick={handleNodeClick}
          onUndo={undo}
          onRedo={redo}
          onAddNode={handleAddNode}
          onDelete={deleteSelected}
          onSave={handleSave}
          onRun={handleRun}
          onDuplicateNode={handleDuplicateNode}
          onDeleteNode={handleDeleteNode}
        />

        {/* Inspector */}
        {selectedNode && (
          <NodeInspector
            node={selectedNode}
            agents={agents}
            onClose={() => setSelectedNodeId(null)}
            onUpdate={updateNodeData}
            onSendNote={handleSendNote}
          />
        )}
      </div>

      {/* Bottom log */}
      <BottomLogPanel lines={logLines} running={running} onClear={clearLogs} />

      {/* Run modal */}
      <RunLaunchModal
        open={showRunModal}
        running={running}
        onClose={() => setShowRunModal(false)}
        onLaunch={handleLaunch}
      />
    </div>
  );
}

export default function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasPageInner />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | head -40
```

Fix any type errors before proceeding. Common fixes:
- If `loadPipeline` async call complains about unused promise: add `void` prefix
- If `NodeMouseHandler<CanvasNodeData>` import errors: ensure the import path is correct

- [ ] **Step 3: Commit**

```bash
git add ui/frontend/app/canvas/page.tsx
git commit -m "feat(canvas): add page.tsx shell — canvas pipeline editor"
```

---

## Task 15: Add navigation link

**Files:**
- Modify: `ui/frontend/app/layout.tsx`

- [ ] **Step 1: Read current layout.tsx to find the nav**

```bash
grep -n "pipeline\|Pipeline\|nav\|href=" ui/frontend/app/layout.tsx | head -20
```

- [ ] **Step 2: Add canvas link alongside the pipeline link**

Find the line with `/pipeline` in the nav and add `/canvas` next to it. Example — if the existing nav looks like:
```tsx
<Link href="/pipeline">Pipeline</Link>
```
Add:
```tsx
<Link href="/canvas">Canvas</Link>
```

The exact change depends on the layout structure found in Step 1.

- [ ] **Step 3: Verify TypeScript**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add ui/frontend/app/layout.tsx
git commit -m "feat(canvas): add /canvas nav link"
```

---

## Task 16: Integration test + version bump

**Files:**
- Modify: `ui/frontend/lib/version.ts`
- Modify: `ui/frontend/package.json`

- [ ] **Step 1: Full TypeScript check**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1
```

Expected: zero errors. Fix any remaining type issues before continuing.

- [ ] **Step 2: Start dev server and verify the page loads**

```bash
cd ui/frontend && npm run dev
```

Open `http://localhost:3000/canvas` in browser.

**Verify checklist:**
- [ ] Page loads without console errors
- [ ] Folder icon rail shows existing folders
- [ ] Pipeline list shows pipelines in active folder
- [ ] Clicking a pipeline loads it onto the canvas
- [ ] Nodes appear as rich inline cards
- [ ] Clicking a node opens the inspector panel on the right
- [ ] Inspector dropdowns update node data (agent/model/input)
- [ ] ▶ Run button opens the RunLaunchModal
- [ ] Launching a run shows progress in the bottom log strip
- [ ] Node status badges update live during run (amber → green)
- [ ] Undo/redo work (Ctrl+Z / Ctrl+Y)
- [ ] Ctrl+S saves the pipeline
- [ ] Right-click on canvas shows context menu
- [ ] Right-click on node shows Duplicate/Delete

- [ ] **Step 3: Bump version**

In `ui/frontend/lib/version.ts`, increment the version (e.g., `6.3.23` → `6.4.0`):
```typescript
export const VERSION = "6.4.0";
```

In `ui/frontend/package.json`, set the same version:
```json
"version": "6.4.0"
```

- [ ] **Step 4: Final commit**

```bash
git add ui/frontend/lib/version.ts ui/frontend/package.json
git commit -m "feat(canvas): v6.4.0 — canvas pipeline editor (full /pipeline replacement)"
```

---

---

## Task 16.5: Add Node picker modal + bundle export + transcript viewer

These three items complete v1 parity. Add them after Task 16 passes the integration checklist.

- [ ] **Add Node picker modal** — replace the rotation logic in `handleAddNode` in `page.tsx` with a small modal that lets the user pick Input / Agent / Output:

```typescript
// In page.tsx, add state:
const [showNodePicker, setShowNodePicker] = useState(false);

// Replace handleAddNode body:
function handleAddNode() { setShowNodePicker(true); }

// Add picker modal JSX at bottom of return (before RunLaunchModal):
{showNodePicker && (
  <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setShowNodePicker(false)}>
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-72 shadow-2xl" onClick={e => e.stopPropagation()}>
      <div className="text-sm font-bold text-white mb-4">Add Node</div>
      {(["input", "agent", "output"] as const).map(kind => (
        <button key={kind} onClick={() => {
          const id = `node-${Date.now()}`;
          addNode({ id, type: kind, position: { x: 200 + nodes.length * 30, y: 150 },
            data: { kind, label: kind === "agent" ? "New Agent" : kind === "input" ? "Transcript" : "Output" }});
          setShowNodePicker(false);
        }} className="w-full flex items-center gap-3 p-3 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 mb-2 text-left transition-colors">
          <span className="text-lg">{kind === "input" ? "⚡" : kind === "agent" ? "🤖" : "⭐"}</span>
          <div>
            <div className="text-xs font-bold text-white capitalize">{kind} Node</div>
            <div className="text-[10px] text-gray-500">
              {kind === "input" ? "Data source" : kind === "agent" ? "AI processing step" : "Artifact output"}
            </div>
          </div>
        </button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Bundle export** — add an Export button to `CanvasToolbar.tsx`. In the toolbar JSX, after the Save button, add:

```typescript
// Add prop to CanvasToolbar Props interface:
onExport?: () => void;

// Add button in toolbar JSX (after Save, before Run divider):
{onExport && (
  <button onClick={onExport}
    className="flex items-center gap-1 bg-gray-800 hover:bg-gray-700 border border-gray-600/60 rounded-lg px-2.5 py-1 text-xs text-gray-400 transition-colors" title="Export bundle">
    <Download className="w-3 h-3" /> Export
  </button>
)}
```

Add `Download` to lucide imports. In `page.tsx`, pass `onExport`:
```typescript
// In handleExport:
async function handleExport() {
  if (!activePipelineId) return;
  const res = await fetch(`/api/pipelines/${encodeURIComponent(activePipelineId)}/snapshots`, { method: "POST" });
  if (!res.ok) return;
  const data = await res.json();
  const url  = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `${activePipelineId}.json`; a.click();
  URL.revokeObjectURL(url);
}
// Pass onExport={handleExport} to CanvasBoard → CanvasToolbar
```

- [ ] **Transcript viewer** — in `NodeInspector.tsx`, for input nodes with `inputSource` of "transcript" or "merged_transcript", add a "View Transcript" button that opens the shared `TranscriptViewer`:

```typescript
// Add to NodeInspector imports:
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";

// Add state inside NodeInspector:
const [showTranscript, setShowTranscript] = useState(false);

// Add in the input node section:
{(data.inputSource === "transcript" || data.inputSource === "merged_transcript") && (
  <button onClick={() => setShowTranscript(true)}
    className="w-full flex items-center justify-center gap-1.5 bg-blue-700/20 border border-blue-600/40 rounded-lg py-1.5 text-[10px] text-blue-300 hover:bg-blue-700/30 transition-colors mt-2">
    <Eye className="w-3 h-3" /> View Transcript
  </button>
)}
{showTranscript && (
  <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowTranscript(false)}>
    <div className="bg-gray-900 border border-gray-700 rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
      <TranscriptViewer onClose={() => setShowTranscript(false)} />
    </div>
  </div>
)}
```

- [ ] **Verify TypeScript after all additions**

```bash
cd ui/frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Commit**

```bash
git add -u ui/frontend/app/canvas/
git commit -m "feat(canvas): add node picker, bundle export, transcript viewer"
```

---

## Self-review notes

- All API paths verified against `pipeline/page.tsx`: `/api/pipelines`, `/api/pipelines/folders`, `/api/pipelines/{id}/run`, `/api/universal-agents`, `/api/notes/{id}/send-to-crm`
- `deriveStepsFromNodes` sorts agent nodes by x position — same topological proxy used by the existing page
- `readSSE` in `useRunExecution` is a direct extraction from the existing `readPipelineSSE` function
- Node types `"input"`, `"agent"`, `"output"` match `CanvasNodeData["kind"]` throughout — consistent across all files
- `ContextTopBar` used unchanged with the same props signature as the existing page
- `AppCtx.activePipelineId` drives which pipeline is loaded — same global state as existing page
- The `progressBar` animation added to `globals.css` is additive (won't break existing styles)
- Task 10 includes a self-correction step (fix the `fitView` shim) — must not be skipped
