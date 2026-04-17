"use client";

import { useCallback, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  addEdge, useNodesState, useEdgesState, useReactFlow,
  Handle, Position, MarkerType,
  type Node, type Edge, type Connection, type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  FileText, Mic, Database, StickyNote, Info,
  AlignLeft, List, Code2, Zap, LayoutTemplate,
  FileJson, Trash2, ChevronRight, X,
} from "lucide-react";

// ── Sub-type metadata ─────────────────────────────────────────────────────────

type NodeKind        = "input" | "processing" | "output";
type InputSubType    = "transcript" | "recording" | "crm_data" | "notes" | "metadata";
type ProcessSubType  = "summarizer" | "classifier" | "extractor" | "analyzer" | "scorer";
type OutputSubType   = "json" | "text" | "markdown" | "structured";

interface Meta {
  label: string;
  icon:  React.ReactNode;
  color: string;   // header bg
  border: string;  // node border
  text:  string;   // accent text
  desc:  string;
}

const INPUT_META: Record<InputSubType, Meta> = {
  transcript: { label: "Transcript", icon: <FileText    className="w-3.5 h-3.5" />, color: "bg-blue-700",   border: "border-blue-600",   text: "text-blue-300",   desc: "Call transcript text" },
  recording:  { label: "Recording",  icon: <Mic         className="w-3.5 h-3.5" />, color: "bg-cyan-700",   border: "border-cyan-600",   text: "text-cyan-300",   desc: "Audio recording file" },
  crm_data:   { label: "CRM Data",   icon: <Database    className="w-3.5 h-3.5" />, color: "bg-green-700",  border: "border-green-600",  text: "text-green-300",  desc: "CRM contact & account data" },
  notes:      { label: "Notes",      icon: <StickyNote  className="w-3.5 h-3.5" />, color: "bg-amber-700",  border: "border-amber-600",  text: "text-amber-300",  desc: "Agent or customer notes" },
  metadata:   { label: "Metadata",   icon: <Info        className="w-3.5 h-3.5" />, color: "bg-slate-600",  border: "border-slate-500",  text: "text-slate-300",  desc: "Call metadata & attributes" },
};

const PROCESS_META: Record<ProcessSubType, Meta> = {
  summarizer: { label: "Summarizer", icon: <AlignLeft      className="w-3.5 h-3.5" />, color: "bg-indigo-700", border: "border-indigo-600", text: "text-indigo-300", desc: "Condenses content into a summary" },
  classifier: { label: "Classifier", icon: <List           className="w-3.5 h-3.5" />, color: "bg-violet-700", border: "border-violet-600", text: "text-violet-300", desc: "Categorises into predefined classes" },
  extractor:  { label: "Extractor",  icon: <Code2          className="w-3.5 h-3.5" />, color: "bg-blue-700",   border: "border-blue-600",   text: "text-blue-300",   desc: "Pulls structured data from text" },
  analyzer:   { label: "Analyzer",   icon: <Zap            className="w-3.5 h-3.5" />, color: "bg-cyan-700",   border: "border-cyan-600",   text: "text-cyan-300",   desc: "Deep analysis and insights" },
  scorer:     { label: "Scorer",     icon: <LayoutTemplate className="w-3.5 h-3.5" />, color: "bg-teal-700",   border: "border-teal-600",   text: "text-teal-300",   desc: "Assigns numeric or categorical scores" },
};

const OUTPUT_META: Record<OutputSubType, Meta> = {
  json:       { label: "JSON",       icon: <FileJson  className="w-3.5 h-3.5" />, color: "bg-yellow-700", border: "border-yellow-600", text: "text-yellow-300", desc: "Structured JSON output" },
  text:       { label: "Plain Text", icon: <AlignLeft className="w-3.5 h-3.5" />, color: "bg-slate-600",  border: "border-slate-500",  text: "text-slate-300",  desc: "Unformatted plain text" },
  markdown:   { label: "Markdown",   icon: <Code2     className="w-3.5 h-3.5" />, color: "bg-indigo-700", border: "border-indigo-600", text: "text-indigo-300", desc: "Markdown formatted output" },
  structured: { label: "Structured", icon: <List      className="w-3.5 h-3.5" />, color: "bg-purple-700", border: "border-purple-600", text: "text-purple-300", desc: "Structured report format" },
};

function getMeta(kind: NodeKind, subType: string): Meta {
  if (kind === "input")      return (INPUT_META   as Record<string, Meta>)[subType] ?? INPUT_META.transcript;
  if (kind === "processing") return (PROCESS_META as Record<string, Meta>)[subType] ?? PROCESS_META.summarizer;
  return (OUTPUT_META as Record<string, Meta>)[subType] ?? OUTPUT_META.json;
}

// ── Node data ─────────────────────────────────────────────────────────────────

interface PipelineNodeData extends Record<string, unknown> {
  label:   string;
  subType: string;
  prompt:  string;
}

// ── Custom node components ────────────────────────────────────────────────────

function InputNode({ data, selected }: { data: PipelineNodeData; selected?: boolean }) {
  const m = getMeta("input", data.subType);
  return (
    <div className={`rounded-xl border-2 min-w-[170px] shadow-xl overflow-hidden transition-all
      ${selected ? `${m.border} ring-2 ring-white/25` : `${m.border} opacity-85 hover:opacity-100`}`}>
      <div className={`${m.color} flex items-center gap-2 px-3 py-2`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <span className="text-xs font-bold text-white truncate">{data.label}</span>
      </div>
      <div className="bg-gray-900/90 px-3 py-1.5">
        <span className={`text-[10px] font-semibold ${m.text} uppercase tracking-wider`}>Input · {m.label}</span>
      </div>
      <Handle type="source" position={Position.Right}
        className="!w-3.5 !h-3.5 !bg-gray-400 !border-2 !border-gray-700 hover:!bg-white transition-colors" />
    </div>
  );
}

function ProcessingNode({ data, selected }: { data: PipelineNodeData; selected?: boolean }) {
  const m = getMeta("processing", data.subType);
  return (
    <div className={`rounded-xl border-2 min-w-[170px] shadow-xl overflow-hidden transition-all
      ${selected ? `${m.border} ring-2 ring-white/25` : `${m.border} opacity-85 hover:opacity-100`}`}>
      <Handle type="target" position={Position.Left}
        className="!w-3.5 !h-3.5 !bg-gray-400 !border-2 !border-gray-700 hover:!bg-white transition-colors" />
      <div className={`${m.color} flex items-center gap-2 px-3 py-2`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <span className="text-xs font-bold text-white truncate">{data.label}</span>
      </div>
      <div className="bg-gray-900/90 px-3 py-1.5">
        <span className={`text-[10px] font-semibold ${m.text} uppercase tracking-wider`}>Process · {m.label}</span>
        {data.prompt && (
          <p className="text-[10px] text-gray-500 mt-0.5 truncate max-w-[150px]">{data.prompt as string}</p>
        )}
      </div>
      <Handle type="source" position={Position.Right}
        className="!w-3.5 !h-3.5 !bg-gray-400 !border-2 !border-gray-700 hover:!bg-white transition-colors" />
    </div>
  );
}

function OutputNode({ data, selected }: { data: PipelineNodeData; selected?: boolean }) {
  const m = getMeta("output", data.subType);
  return (
    <div className={`rounded-xl border-2 min-w-[170px] shadow-xl overflow-hidden transition-all
      ${selected ? `${m.border} ring-2 ring-white/25` : `${m.border} opacity-85 hover:opacity-100`}`}>
      <Handle type="target" position={Position.Left}
        className="!w-3.5 !h-3.5 !bg-gray-400 !border-2 !border-gray-700 hover:!bg-white transition-colors" />
      <div className={`${m.color} flex items-center gap-2 px-3 py-2`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <span className="text-xs font-bold text-white truncate">{data.label}</span>
      </div>
      <div className="bg-gray-900/90 px-3 py-1.5">
        <span className={`text-[10px] font-semibold ${m.text} uppercase tracking-wider`}>Output · {m.label}</span>
      </div>
    </div>
  );
}

// Defined outside component — prevents React re-creating on every render
const NODE_TYPES: NodeTypes = {
  input:      InputNode,
  processing: ProcessingNode,
  output:     OutputNode,
};

// ── Palette groups ────────────────────────────────────────────────────────────

const PALETTE_GROUPS: Array<{
  kind: NodeKind;
  label: string;
  items: Array<{ subType: string; meta: Meta }>;
}> = [
  {
    kind: "input",
    label: "Inputs",
    items: (Object.entries(INPUT_META) as [InputSubType, Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
  {
    kind: "processing",
    label: "Processing",
    items: (Object.entries(PROCESS_META) as [ProcessSubType, Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
  {
    kind: "output",
    label: "Outputs",
    items: (Object.entries(OUTPUT_META) as [OutputSubType, Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
];

// ── Connection validation ─────────────────────────────────────────────────────
// input → processing  ✓
// processing → processing ✓
// processing → output ✓
// output → processing ✓ (feedback loops ok)
// input → output ✗ (must pass through processing)
// * → input ✗ (input nodes have no target handle)
// output → output ✗

function checkConnectionValid(conn: Connection | Edge, nodes: Node[]): boolean {
  const src = nodes.find(n => n.id === conn.source);
  const tgt = nodes.find(n => n.id === conn.target);
  if (!src || !tgt) return false;
  const sk = src.type as NodeKind;
  const tk = tgt.type as NodeKind;
  if (tk === "input")                         return false; // nothing flows into input
  if (sk === "input"  && tk === "output")     return false; // must pass through processing
  if (sk === "output" && tk === "output")     return false; // two outputs can't connect
  return true;
}

// ── Pipeline completeness check ───────────────────────────────────────────────

function validatePipeline(nodes: Node[], edges: Edge[]): string | null {
  if (nodes.length === 0) return "Canvas is empty.";
  if (!nodes.some(n => n.type === "input"))      return "Add at least one Input node.";
  if (!nodes.some(n => n.type === "processing")) return "Add at least one Processing node.";
  if (!nodes.some(n => n.type === "output"))     return "Pipeline must end with an Output node.";

  const edgeMap: Record<string, string[]> = {};
  edges.forEach(e => { (edgeMap[e.source] ??= []).push(e.target); });

  function canReach(id: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const n = nodes.find(x => x.id === id);
    if (n?.type === "output") return true;
    return (edgeMap[id] ?? []).some(nxt => canReach(nxt, seen));
  }

  for (const inp of nodes.filter(n => n.type === "input")) {
    if (!canReach(inp.id)) {
      const d = inp.data as PipelineNodeData;
      return `"${d.label}" does not have a path to any Output.`;
    }
  }
  return null;
}

// ── Inner canvas (needs useReactFlow so must live inside Provider) ────────────

let nodeSeq = 1;
function nextId() { return `pn${nodeSeq++}`; }

function PipelineCanvas() {
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  // Keep a ref so validation callback always sees latest nodes without re-creating
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;

  function showToast(msg: string, ok = false) {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Drag from palette → drop onto canvas ──────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const kind    = e.dataTransfer.getData("application/nodeKind")    as NodeKind | "";
    const subType = e.dataTransfer.getData("application/nodeSubType") as string   | "";
    if (!kind || !subType) return;

    const meta     = getMeta(kind, subType);
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id       = nextId();

    const newNode: Node = {
      id,
      type: kind,
      position,
      data: {
        label:   `${meta.label} ${nodeSeq - 1}`,
        subType,
        prompt:  "",
      } satisfies PipelineNodeData,
    };

    setNodes(ns => [...ns, newNode]);
    setSelectedNodeId(id);
  }, [screenToFlowPosition, setNodes]);

  // ── Connect with validation ───────────────────────────────────────────────

  // Passed as prop to ReactFlow — gives visual feedback while dragging edge
  const isValidConnection = useCallback((conn: Connection | Edge): boolean => {
    return checkConnectionValid(conn, nodesRef.current);
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    setEdges(eds => addEdge(
      {
        ...conn,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
        style:     { stroke: "#818cf8", strokeWidth: 2 },
      },
      eds
    ));
  }, [setEdges]);

  // ── Node click → show in right panel ─────────────────────────────────────

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  function handleSave() {
    const err = validatePipeline(nodes, edges);
    if (err) { showToast(err, false); } else { showToast(`Pipeline valid — ${nodes.length} nodes, ${edges.length} edges.`, true); }
  }

  function handleClear() {
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
  }

  // ── Right panel ───────────────────────────────────────────────────────────

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const selData      = selectedNode ? (selectedNode.data as PipelineNodeData) : null;
  const selKind      = selectedNode?.type as NodeKind | undefined;
  const selMeta      = selData && selKind ? getMeta(selKind, selData.subType) : null;

  function renderPanel() {
    if (!selectedNode || !selData || !selKind || !selMeta) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center text-gray-600">
          <div className="w-12 h-12 rounded-xl border-2 border-dashed border-gray-700 flex items-center justify-center">
            <span className="text-2xl text-gray-700">→</span>
          </div>
          <p className="text-sm">Click a node on the canvas to edit its settings</p>
        </div>
      );
    }

    const subTypeOptions =
      selKind === "input"      ? Object.entries(INPUT_META)   as [string, Meta][] :
      selKind === "processing" ? Object.entries(PROCESS_META) as [string, Meta][] :
                                  Object.entries(OUTPUT_META)  as [string, Meta][];

    return (
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className={`flex items-center gap-2.5 p-2.5 rounded-lg ${selMeta.color}`}>
          <span className="text-white shrink-0">{selMeta.icon}</span>
          <div className="min-w-0">
            <p className="text-[10px] text-white/60 uppercase tracking-wider">{selKind}</p>
            <p className="text-sm font-bold text-white truncate">{selData.label}</p>
          </div>
        </div>

        {/* Label */}
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Name</label>
          <input
            value={selData.label}
            onChange={e => updateNodeData(selectedNode.id, { label: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
          />
        </div>

        {/* Sub-type picker */}
        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            {selKind === "input" ? "Source" : selKind === "processing" ? "Agent Type" : "Format"}
          </label>
          <select
            value={selData.subType}
            onChange={e => updateNodeData(selectedNode.id, { subType: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
          >
            {subTypeOptions.map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-gray-600">{selMeta.desc}</p>
        </div>

        {/* Prompt — only for processing nodes */}
        {selKind === "processing" && (
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">System Prompt</label>
            <textarea
              rows={5}
              value={selData.prompt}
              onChange={e => updateNodeData(selectedNode.id, { prompt: e.target.value })}
              placeholder="Describe what this agent should do…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>
        )}

        {/* Delete */}
        <button
          onClick={() => deleteNode(selectedNode.id)}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-gray-700 text-red-500 hover:bg-red-950/30 hover:border-red-700 text-sm transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete node
        </button>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full w-full">

      {/* ── Left palette ──────────────────────────────────────────────── */}
      <aside className="w-52 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-800">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Elements</p>
          <p className="text-[10px] text-gray-600 mt-0.5">Drag onto canvas</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
          {PALETTE_GROUPS.map(group => (
            <div key={group.kind}>
              <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest px-1 mb-1">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map(({ subType, meta }) => (
                  <div
                    key={subType}
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData("application/nodeKind",    group.kind);
                      e.dataTransfer.setData("application/nodeSubType", subType);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border cursor-grab active:cursor-grabbing select-none transition-all hover:scale-[1.02] ${meta.border} bg-gray-900/60 hover:bg-gray-800`}
                  >
                    <span className={`p-1 rounded-md ${meta.color} text-white shrink-0`}>{meta.icon}</span>
                    <span className={`text-xs font-semibold ${meta.text}`}>{meta.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Connection rules reference */}
        <div className="p-3 border-t border-gray-800">
          <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-1.5">Flow rules</p>
          <div className="space-y-0.5 text-[10px] text-gray-600">
            <div><span className="text-blue-400">Input</span> → <span className="text-indigo-400">Processing</span></div>
            <div><span className="text-indigo-400">Processing</span> → <span className="text-indigo-400">Processing</span></div>
            <div><span className="text-indigo-400">Processing</span> → <span className="text-yellow-400">Output</span></div>
            <div><span className="text-yellow-400">Output</span> → <span className="text-indigo-400">Processing</span></div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-2.5 space-y-2 border-t border-gray-800">
          <button
            onClick={handleSave}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wider transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
            Validate &amp; Save
          </button>
          <button
            onClick={handleClear}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-800 text-xs transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Clear canvas
          </button>
        </div>
      </aside>

      {/* ── Canvas ────────────────────────────────────────────────────── */}
      <div className="flex-1 relative" onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          isValidConnection={isValidConnection}
          fitView
          deleteKeyCode="Delete"
          proOptions={{ hideAttribution: true }}
          className="bg-gray-950"
        >
          <Background color="#1f2937" gap={24} size={1.5} />
          <Controls
            className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-300 [&>button:hover]:bg-gray-700 [&>button:hover]:text-white"
          />
          <MiniMap
            nodeColor={n => {
              const d = n.data as PipelineNodeData;
              const m = getMeta(n.type as NodeKind, d?.subType ?? "");
              return m.color.replace("bg-", "").replace("-700", "").replace("-600", "");
            }}
            maskColor="rgba(0,0,0,0.7)"
            className="!bg-gray-900 !border !border-gray-700 !rounded-lg"
          />
        </ReactFlow>

        {/* Empty state */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
            <div className="text-center text-gray-700">
              <p className="text-5xl mb-4 tracking-widest">· · ·</p>
              <p className="text-base font-semibold">Drag elements from the left panel</p>
              <p className="text-sm mt-1">Input → Processing → Output</p>
            </div>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium shadow-2xl
            ${toast.ok
              ? "bg-emerald-950 border-emerald-600 text-emerald-200"
              : "bg-red-950 border-red-700 text-red-200"}`}>
            {toast.msg}
            <button onClick={() => setToast(null)}><X className="w-3.5 h-3.5 opacity-60" /></button>
          </div>
        )}
      </div>

      {/* ── Right panel ───────────────────────────────────────────────── */}
      <aside className="w-60 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Properties</p>
          {selectedNodeId && (
            <button onClick={() => setSelectedNodeId(null)} className="text-gray-600 hover:text-gray-400 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {renderPanel()}
        </div>
      </aside>

    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PipelinePage() {
  return (
    <div className="-m-6 h-[calc(100vh-5rem)] flex flex-col">
      <div className="px-5 py-2.5 border-b border-gray-800 bg-gray-900/80 flex items-center gap-3 shrink-0">
        <h1 className="text-sm font-bold text-white">Pipeline Workflow</h1>
        <span className="text-xs text-gray-600">
          Drag nodes · Connect via edge handles · Click node to edit · Delete key removes selection
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <ReactFlowProvider>
          <PipelineCanvas />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
