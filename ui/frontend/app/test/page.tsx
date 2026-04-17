"use client";

import { useCallback, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FileInput, Cpu, FileOutput, Trash2 } from "lucide-react";

// ── Node types ────────────────────────────────────────────────────────────────

type NodeKind = "input" | "processing" | "output";

// Input node — only has a source handle (emits)
function InputNode({ data, selected }: { data: { label: string }; selected: boolean }) {
  return (
    <div className={`px-4 py-3 rounded-xl border-2 min-w-[140px] bg-blue-950 shadow-lg transition-all
      ${selected ? "border-blue-400 shadow-blue-900/50" : "border-blue-600 hover:border-blue-500"}`}>
      <div className="flex items-center gap-2">
        <FileInput className="w-4 h-4 text-blue-400 shrink-0" />
        <span className="text-sm font-semibold text-blue-200">{data.label}</span>
      </div>
      <p className="text-[10px] text-blue-500 mt-1">Source</p>
      {/* Only a source handle on the right */}
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 !bg-blue-400 !border-2 !border-blue-900"
      />
    </div>
  );
}

// Processing node — has both target (receives) and source (emits)
function ProcessingNode({ data, selected }: { data: { label: string }; selected: boolean }) {
  return (
    <div className={`px-4 py-3 rounded-xl border-2 min-w-[140px] bg-violet-950 shadow-lg transition-all
      ${selected ? "border-violet-400 shadow-violet-900/50" : "border-violet-600 hover:border-violet-500"}`}>
      {/* Receives from left */}
      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 !bg-violet-400 !border-2 !border-violet-900"
      />
      <div className="flex items-center gap-2">
        <Cpu className="w-4 h-4 text-violet-400 shrink-0" />
        <span className="text-sm font-semibold text-violet-200">{data.label}</span>
      </div>
      <p className="text-[10px] text-violet-500 mt-1">Processing</p>
      {/* Emits from right */}
      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 !bg-violet-400 !border-2 !border-violet-900"
      />
    </div>
  );
}

// Output node — only has a target handle (receives)
function OutputNode({ data, selected }: { data: { label: string }; selected: boolean }) {
  return (
    <div className={`px-4 py-3 rounded-xl border-2 min-w-[140px] bg-emerald-950 shadow-lg transition-all
      ${selected ? "border-emerald-400 shadow-emerald-900/50" : "border-emerald-600 hover:border-emerald-500"}`}>
      {/* Receives from left */}
      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 !bg-emerald-400 !border-2 !border-emerald-900"
      />
      <div className="flex items-center gap-2">
        <FileOutput className="w-4 h-4 text-emerald-400 shrink-0" />
        <span className="text-sm font-semibold text-emerald-200">{data.label}</span>
      </div>
      <p className="text-[10px] text-emerald-500 mt-1">Destination</p>
    </div>
  );
}

// Defined outside component to prevent re-render issues
const NODE_TYPES: NodeTypes = {
  input:      InputNode,
  processing: ProcessingNode,
  output:     OutputNode,
};

// ── Palette item ──────────────────────────────────────────────────────────────

const PALETTE: Array<{
  kind: NodeKind;
  label: string;
  desc: string;
  color: string;
  icon: React.ReactNode;
}> = [
  {
    kind:  "input",
    label: "Input",
    desc:  "Data source — transcripts, recordings, CRM",
    color: "border-blue-600 bg-blue-950 text-blue-300",
    icon:  <FileInput className="w-4 h-4" />,
  },
  {
    kind:  "processing",
    label: "Processing",
    desc:  "Transforms or analyses the data",
    color: "border-violet-600 bg-violet-950 text-violet-300",
    icon:  <Cpu className="w-4 h-4" />,
  },
  {
    kind:  "output",
    label: "Output",
    desc:  "Final result — JSON, text, report",
    color: "border-emerald-600 bg-emerald-950 text-emerald-300",
    icon:  <FileOutput className="w-4 h-4" />,
  },
];

// ── Connection validation ─────────────────────────────────────────────────────
// Rules: input→processing  ✓
//        processing→processing ✓
//        processing→output ✓
//        output→processing ✓  (loop back allowed)
//        input→output ✗  (must go through processing)
//        anything→input ✗  (input is source-only)
//        output→output ✗

function isValidConnection(
  conn: Connection,
  nodes: Node[]
): boolean {
  const src = nodes.find(n => n.id === conn.source);
  const tgt = nodes.find(n => n.id === conn.target);
  if (!src || !tgt) return false;

  const sk = src.type as NodeKind;
  const tk = tgt.type as NodeKind;

  if (tk === "input") return false;        // nothing flows INTO input
  if (sk === "input" && tk === "output") return false; // must pass through processing
  if (sk === "output" && tk === "output") return false;
  return true;
}

// ── Inner canvas component (needs useReactFlow so must be inside Provider) ────

let nodeSeq = 1;
function nextId() { return `n${nodeSeq++}`; }

function FlowCanvas() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // ── Drag-from-sidebar ──────────────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData("application/nodeKind") as NodeKind | "";
    if (!kind) return;

    const palette = PALETTE.find(p => p.kind === kind);
    if (!palette) return;

    // Convert screen coords to flow canvas coords
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });

    const newNode: Node = {
      id:       nextId(),
      type:     kind,
      position,
      data:     { label: `${palette.label} ${nodeSeq - 1}` },
    };

    setNodes(ns => [...ns, newNode]);
  }, [screenToFlowPosition, setNodes]);

  // ── Edge creation with validation ─────────────────────────────────────────

  const onConnect = useCallback((conn: Connection) => {
    setNodes(currentNodes => {
      if (!isValidConnection(conn, currentNodes)) {
        setValidationError("Invalid connection — check the allowed flow rules.");
        setTimeout(() => setValidationError(null), 3000);
        return currentNodes;
      }
      setEdges(eds => addEdge(
        {
          ...conn,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: "#6366f1" },
          style:     { stroke: "#6366f1", strokeWidth: 2 },
        },
        eds
      ));
      return currentNodes;
    });
  }, [setNodes, setEdges]);

  // ── Validate pipeline completeness ────────────────────────────────────────

  function validatePipeline(): string | null {
    if (nodes.length === 0) return "Canvas is empty.";
    const hasInput    = nodes.some(n => n.type === "input");
    const hasOutput   = nodes.some(n => n.type === "output");
    const hasProc     = nodes.some(n => n.type === "processing");
    if (!hasInput)  return "Pipeline needs at least one Input node.";
    if (!hasProc)   return "Pipeline needs at least one Processing node.";
    if (!hasOutput) return "Pipeline must end with an Output node.";

    // Every input must reach an output via edges
    const edgeMap: Record<string, string[]> = {};
    edges.forEach(e => {
      if (!edgeMap[e.source]) edgeMap[e.source] = [];
      edgeMap[e.source].push(e.target);
    });

    function canReachOutput(id: string, visited = new Set<string>()): boolean {
      if (visited.has(id)) return false;
      visited.add(id);
      const node = nodes.find(n => n.id === id);
      if (node?.type === "output") return true;
      return (edgeMap[id] ?? []).some(next => canReachOutput(next, visited));
    }

    const inputs = nodes.filter(n => n.type === "input");
    for (const inp of inputs) {
      if (!canReachOutput(inp.id)) return `Input "${inp.data.label}" does not reach any Output.`;
    }
    return null;
  }

  const [saveResult, setSaveResult] = useState<{ ok: boolean; msg: string } | null>(null);

  function handleSave() {
    const err = validatePipeline();
    if (err) {
      setSaveResult({ ok: false, msg: err });
    } else {
      setSaveResult({ ok: true, msg: `Pipeline saved — ${nodes.length} nodes, ${edges.length} edges.` });
    }
    setTimeout(() => setSaveResult(null), 4000);
  }

  function handleClear() {
    setNodes([]);
    setEdges([]);
    setSaveResult(null);
  }

  return (
    <div className="flex h-full w-full">

      {/* ── Left palette ──────────────────────────────────────────────── */}
      <aside className="w-52 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Elements</h2>
          <p className="text-xs text-gray-600 mt-1">Drag onto the canvas</p>
        </div>

        <div className="p-3 space-y-2 flex-1">
          {PALETTE.map(item => (
            <div
              key={item.kind}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData("application/nodeKind", item.kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-grab active:cursor-grabbing select-none transition-all hover:scale-[1.02] ${item.color}`}
            >
              <span className="mt-0.5 shrink-0">{item.icon}</span>
              <div>
                <p className="text-sm font-semibold">{item.label}</p>
                <p className="text-[10px] opacity-60 mt-0.5 leading-tight">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Rules */}
        <div className="p-3 border-t border-gray-800">
          <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-2">Connection rules</p>
          <div className="space-y-1 text-[10px] text-gray-600">
            <div className="flex items-center gap-1"><span className="text-blue-500">Input</span><span>→</span><span className="text-violet-500">Processing</span></div>
            <div className="flex items-center gap-1"><span className="text-violet-500">Processing</span><span>→</span><span className="text-violet-500">Processing</span></div>
            <div className="flex items-center gap-1"><span className="text-violet-500">Processing</span><span>→</span><span className="text-emerald-500">Output</span></div>
            <div className="flex items-center gap-1"><span className="text-emerald-500">Output</span><span>→</span><span className="text-violet-500">Processing</span></div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-3 space-y-2 border-t border-gray-800">
          <button
            onClick={handleSave}
            className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
          >
            Validate &amp; Save
          </button>
          <button
            onClick={handleClear}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-700 text-sm transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </aside>

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <div className="flex-1 relative" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
          deleteKeyCode="Delete"
          className="bg-gray-950"
        >
          <Background color="#374151" gap={20} />
          <Controls className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-300 [&>button:hover]:bg-gray-700" />
          <MiniMap
            nodeColor={n => {
              if (n.type === "input")      return "#1d4ed8";
              if (n.type === "processing") return "#7c3aed";
              return "#059669";
            }}
            className="!bg-gray-900 !border-gray-700"
          />
        </ReactFlow>

        {/* Empty state hint */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-gray-700 select-none">
              <div className="text-6xl mb-4">⟶</div>
              <p className="text-lg font-semibold">Drag elements here to build your pipeline</p>
              <p className="text-sm mt-1">Input → Processing → Output</p>
            </div>
          </div>
        )}

        {/* Toast notifications */}
        {validationError && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-red-900/90 border border-red-600 rounded-lg text-red-200 text-sm shadow-xl">
            {validationError}
          </div>
        )}
        {saveResult && (
          <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-xl border
            ${saveResult.ok
              ? "bg-emerald-900/90 border-emerald-600 text-emerald-200"
              : "bg-red-900/90 border-red-600 text-red-200"}`}>
            {saveResult.msg}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page wrapper (ReactFlowProvider required for useReactFlow hook) ────────────

export default function TestPage() {
  return (
    <div className="-m-6 h-[calc(100vh-5rem)]">
      <div className="h-full border-b border-gray-800 flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 bg-gray-900 flex items-center gap-3 shrink-0">
          <h1 className="text-sm font-bold text-white">Pipeline Builder — Test</h1>
          <span className="text-xs text-gray-500">Drag nodes from the left panel onto the canvas, then connect them by dragging from a node&apos;s edge handle. Press Delete to remove a selected node or edge.</span>
        </div>
        <div className="flex-1 min-h-0">
          <ReactFlowProvider>
            <FlowCanvas />
          </ReactFlowProvider>
        </div>
      </div>
    </div>
  );
}
