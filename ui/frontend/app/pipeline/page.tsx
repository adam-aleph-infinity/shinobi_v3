"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  useNodesState, useEdgesState, useReactFlow,
  addEdge,
  Handle, Position, MarkerType,
  type Node, type Edge, type Connection, type NodeChange, type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  FileText, Mic, Database, StickyNote, Info,
  AlignLeft, List, Code2, Zap, LayoutTemplate,
  FileJson, Trash2, ChevronRight, X,
} from "lucide-react";

// ── Sub-type metadata ─────────────────────────────────────────────────────────

type NodeKind       = "input" | "processing" | "output";
type InputSubType   = "transcript" | "recording" | "crm_data" | "notes" | "metadata";
type ProcessSubType = "summarizer" | "classifier" | "extractor" | "analyzer" | "scorer";
type OutputSubType  = "json" | "text" | "markdown" | "structured";

interface Meta {
  label:  string;
  icon:   React.ReactNode;
  color:  string;
  border: string;
  text:   string;
  desc:   string;
}

const INPUT_META: Record<InputSubType, Meta> = {
  transcript: { label: "Transcript", icon: <FileText    className="w-4 h-4" />, color: "bg-blue-700",   border: "border-blue-600",   text: "text-blue-400",   desc: "Call transcript text" },
  recording:  { label: "Recording",  icon: <Mic         className="w-4 h-4" />, color: "bg-cyan-700",   border: "border-cyan-600",   text: "text-cyan-400",   desc: "Audio recording file" },
  crm_data:   { label: "CRM Data",   icon: <Database    className="w-4 h-4" />, color: "bg-green-700",  border: "border-green-600",  text: "text-green-400",  desc: "CRM contact & account data" },
  notes:      { label: "Notes",      icon: <StickyNote  className="w-4 h-4" />, color: "bg-amber-700",  border: "border-amber-600",  text: "text-amber-400",  desc: "Agent or customer notes" },
  metadata:   { label: "Metadata",   icon: <Info        className="w-4 h-4" />, color: "bg-slate-600",  border: "border-slate-500",  text: "text-slate-400",  desc: "Call metadata & attributes" },
};

const PROCESS_META: Record<ProcessSubType, Meta> = {
  summarizer: { label: "Summarizer", icon: <AlignLeft      className="w-4 h-4" />, color: "bg-indigo-700", border: "border-indigo-500", text: "text-indigo-400", desc: "Condenses content into a summary" },
  classifier: { label: "Classifier", icon: <List           className="w-4 h-4" />, color: "bg-violet-700", border: "border-violet-500", text: "text-violet-400", desc: "Categorises into predefined classes" },
  extractor:  { label: "Extractor",  icon: <Code2          className="w-4 h-4" />, color: "bg-blue-700",   border: "border-blue-500",   text: "text-blue-400",   desc: "Pulls structured data from text" },
  analyzer:   { label: "Analyzer",   icon: <Zap            className="w-4 h-4" />, color: "bg-cyan-700",   border: "border-cyan-500",   text: "text-cyan-400",   desc: "Deep analysis and insights" },
  scorer:     { label: "Scorer",     icon: <LayoutTemplate className="w-4 h-4" />, color: "bg-teal-700",   border: "border-teal-500",   text: "text-teal-400",   desc: "Assigns numeric or categorical scores" },
};

const OUTPUT_META: Record<OutputSubType, Meta> = {
  json:       { label: "JSON",       icon: <FileJson  className="w-4 h-4" />, color: "bg-yellow-700", border: "border-yellow-600", text: "text-yellow-400", desc: "Structured JSON output" },
  text:       { label: "Plain Text", icon: <AlignLeft className="w-4 h-4" />, color: "bg-slate-600",  border: "border-slate-500",  text: "text-slate-400",  desc: "Unformatted plain text" },
  markdown:   { label: "Markdown",   icon: <Code2     className="w-4 h-4" />, color: "bg-indigo-700", border: "border-indigo-600", text: "text-indigo-400", desc: "Markdown formatted output" },
  structured: { label: "Structured", icon: <List      className="w-4 h-4" />, color: "bg-purple-700", border: "border-purple-600", text: "text-purple-400", desc: "Structured report format" },
};

function getMeta(kind: NodeKind, subType: string): Meta {
  if (kind === "input")      return (INPUT_META   as Record<string, Meta>)[subType] ?? INPUT_META.transcript;
  if (kind === "processing") return (PROCESS_META as Record<string, Meta>)[subType] ?? PROCESS_META.summarizer;
  return (OUTPUT_META as Record<string, Meta>)[subType] ?? OUTPUT_META.json;
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
}

// ── Layout constants & helpers ────────────────────────────────────────────────

const NODE_W         = 200;   // node width
const X_GAP          = 40;    // horizontal gap between nodes in same stage
const SLEEVE_H       = 160;   // vertical height per lane
const SLEEVE_INNER   = 45;    // top padding within lane for node placement
const LANE_WIDTH     = 2400;  // width of sleeve background strip
const SLEEVE_START_X = -60;   // left edge of sleeve strip
const Y_INIT         = 20;    // top offset

function laneY(si: number): number {
  return Y_INIT + si * SLEEVE_H;
}

function nodeXY(si: number, idx: number): { x: number; y: number } {
  return { x: 60 + idx * (NODE_W + X_GAP), y: laneY(si) + SLEEVE_INNER };
}

// ── Sleeve background node ────────────────────────────────────────────────────

function SleeveNode({ data }: { data: Record<string, unknown> }) {
  const d = data as SleeveData;
  const colors: Record<NodeKind, string> = {
    input:      "border-blue-900/40 bg-blue-950/20 text-blue-700",
    processing: "border-indigo-900/40 bg-indigo-950/20 text-indigo-700",
    output:     "border-yellow-900/40 bg-yellow-950/20 text-yellow-700",
  };
  const cls = colors[d.kind as NodeKind] ?? colors.input;
  return (
    <div
      style={{ width: LANE_WIDTH, height: SLEEVE_H - 25, pointerEvents: "none" }}
      className={`rounded-2xl border ${cls} flex items-center pl-5 gap-3`}
    >
      <span className="text-[11px] font-bold opacity-50">Step {d.step}</span>
      <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">{d.label}</span>
    </div>
  );
}

function makeSleeves(stages: NodeKind[]): Node[] {
  const labelMap: Record<NodeKind, string> = {
    input: "Inputs", processing: "Processing", output: "Output",
  };
  return stages.map((kind, i) => ({
    id:         `sleeve_${i}`,
    type:       "sleeve",
    position:   { x: SLEEVE_START_X, y: laneY(i) },
    draggable:  false,
    selectable: false,
    focusable:  false,
    zIndex:     -10,
    style:      { background: "transparent", padding: 0, border: "none", boxShadow: "none" },
    data:       { step: i + 1, label: labelMap[kind], kind } satisfies SleeveData,
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

  if (kind === "input") {
    const procs = realNodes
      .filter(n => n.type === "processing")
      .sort((a, b) => (a.data as PipelineNodeData).stageIndex - (b.data as PipelineNodeData).stageIndex);
    const noInputYet = procs.filter(n => !edges.some(e => e.target === n.id));
    const target = noInputYet[0] ?? procs[0];
    if (target) return { source: newNode.id, target: target.id };
    return null;
  }

  if (kind === "processing") {
    const openInputs = realNodes.filter(n => n.type === "input" && !edges.some(e => e.source === n.id));
    if (openInputs.length > 0) return { source: openInputs[0].id, target: newNode.id };
    const openOutputs = realNodes
      .filter(n => n.type === "output" && !edges.some(e => e.source === n.id))
      .sort((a, b) => (b.data as PipelineNodeData).stageIndex - (a.data as PipelineNodeData).stageIndex);
    if (openOutputs.length > 0) return { source: openOutputs[0].id, target: newNode.id };
    const anyInput = realNodes.filter(n => n.type === "input");
    if (anyInput.length > 0) return { source: anyInput[0].id, target: newNode.id };
    return null;
  }

  if (kind === "output") {
    const openProcs = realNodes
      .filter(n => {
        if (n.type !== "processing") return false;
        return !edges.some(e => e.source === n.id && realNodes.find(x => x.id === e.target)?.type === "output");
      })
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
    <div className={`w-[200px] rounded-xl border-2 shadow-2xl overflow-hidden transition-all duration-150
      ${meta.border} bg-gray-900
      ${selected ? `ring-2 ${ringColor} shadow-indigo-900/40 scale-105` : "opacity-90 hover:opacity-100 hover:scale-[1.02]"}`}>
      {children}
    </div>
  );
}

function InputNode({ data, selected }: { data: PipelineNodeData; selected?: boolean }) {
  const m = getMeta("input", data.subType);
  return (
    <NodeCard meta={m} selected={!!selected} kind="input">
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <span className="text-sm font-bold text-white truncate">{data.label}</span>
      </div>
      <div className="px-4 py-1.5 bg-gray-900">
        <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide`}>
          ⬤ Input · {m.label}
        </span>
      </div>
      {/* Top-to-bottom: source exits from the bottom */}
      <Handle type="source" position={Position.Bottom}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-gray-700" />
    </NodeCard>
  );
}

function ProcessingNode({ data, selected }: { data: PipelineNodeData; selected?: boolean }) {
  const m = getMeta("processing", data.subType);
  return (
    <NodeCard meta={m} selected={!!selected} kind="processing">
      {/* Receives from top */}
      <Handle type="target" position={Position.Top}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-gray-700" />
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <span className="text-sm font-bold text-white truncate">{data.label}</span>
      </div>
      <div className="px-4 py-1.5 bg-gray-900">
        <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide`}>
          ⬡ Process · {m.label}
        </span>
        {data.prompt && (
          <p className="text-[10px] text-gray-600 mt-0.5 truncate">{data.prompt as string}</p>
        )}
      </div>
      {/* Emits from bottom */}
      <Handle type="source" position={Position.Bottom}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-gray-700" />
    </NodeCard>
  );
}

function OutputNode({ data, selected }: { data: PipelineNodeData; selected?: boolean }) {
  const m = getMeta("output", data.subType);
  return (
    <NodeCard meta={m} selected={!!selected} kind="output">
      {/* Receives from top */}
      <Handle type="target" position={Position.Top}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-gray-700" />
      <div className={`${m.color} flex items-center gap-2.5 px-4 py-2.5`}>
        <span className="text-white/90 shrink-0">{m.icon}</span>
        <span className="text-sm font-bold text-white truncate">{data.label}</span>
      </div>
      <div className="px-4 py-1.5 bg-gray-900">
        <span className={`text-[11px] font-semibold ${m.text} uppercase tracking-wide`}>
          ■ Output · {m.label}
        </span>
      </div>
      {/* Can also feed back into a processing node */}
      <Handle type="source" position={Position.Bottom}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-gray-700" />
    </NodeCard>
  );
}

// Defined outside the component to prevent NodeTypes recreation on every render
const NODE_TYPES: NodeTypes = {
  input:      InputNode      as NodeTypes[string],
  processing: ProcessingNode as NodeTypes[string],
  output:     OutputNode     as NodeTypes[string],
  sleeve:     SleeveNode     as NodeTypes[string],
};

// ── Palette groups ────────────────────────────────────────────────────────────

const PALETTE_GROUPS: Array<{
  kind:  NodeKind;
  label: string;
  items: Array<{ subType: string; meta: Meta }>;
}> = [
  {
    kind:  "input",
    label: "Inputs",
    items: (Object.entries(INPUT_META)   as [InputSubType,   Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
  {
    kind:  "processing",
    label: "Processing",
    items: (Object.entries(PROCESS_META) as [ProcessSubType, Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
  {
    kind:  "output",
    label: "Outputs",
    items: (Object.entries(OUTPUT_META)  as [OutputSubType,  Meta][]).map(([k, m]) => ({ subType: k, meta: m })),
  },
];

// ── Pipeline validation ───────────────────────────────────────────────────────

function validatePipeline(nodes: Node[], edges: Edge[]): string | null {
  if (nodes.length === 0) return "Canvas is empty.";
  if (!nodes.some(n => n.type === "input"))      return "Add at least one Input node.";
  if (!nodes.some(n => n.type === "processing")) return "Add at least one Processing node.";
  if (!nodes.some(n => n.type === "output"))     return "Pipeline must end with an Output node.";

  const edgeMap: Record<string, string[]> = {};
  edges.forEach(e => { (edgeMap[e.source] ??= []).push(e.target); });

  for (const proc of nodes.filter(n => n.type === "processing")) {
    const hasOutput = edges.some(
      e => e.source === proc.id && nodes.find(x => x.id === e.target)?.type === "output"
    );
    if (!hasOutput)
      return `Processing "${(proc.data as PipelineNodeData).label}" has no Output connected.`;
  }

  for (const inp of nodes.filter(n => n.type === "input")) {
    if (!canReach(inp.id, nodes, edgeMap))
      return `"${(inp.data as PipelineNodeData).label}" has no path to any Output.`;
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
    animated:  true,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 20, height: 20 },
    style:     { stroke: "#818cf8", strokeWidth: 2.5 },
  };
}

function PipelineCanvas() {
  const { screenToFlowPosition, fitView } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [stages, setStages]              = useState<NodeKind[]>(["input"]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  // Refs for fresh state in callbacks (avoid stale closures)
  const nodesRef  = useRef<Node[]>([]);
  const edgesRef  = useRef<Edge[]>([]);
  const stagesRef = useRef<NodeKind[]>(["input"]);
  nodesRef.current  = nodes;
  edgesRef.current  = edges;
  stagesRef.current = stages;

  // Combine sleeve backgrounds with real nodes for rendering
  const allNodes = useMemo(() => [...makeSleeves(stages), ...nodes], [stages, nodes]);

  // Prevent keyboard Delete from removing sleeve nodes
  const onNodesChangeFiltered = useCallback((changes: NodeChange[]) => {
    const filtered = changes.filter(c => {
      if (c.type === "remove") return !c.id.startsWith("sleeve_");
      return true;
    });
    onNodesChange(filtered);
  }, [onNodesChange]);

  // Validates connections drawn manually by the user
  const isValidConnectionFn = useCallback((conn: Connection | Edge): boolean => {
    const src = String(conn.source ?? "");
    const tgt = String(conn.target ?? "");
    if (src.startsWith("sleeve_") || tgt.startsWith("sleeve_")) return false;
    if (edgesRef.current.some(e => e.source === src && e.target === tgt)) return false;
    const sn = nodesRef.current.find(n => n.id === src);
    const tn = nodesRef.current.find(n => n.id === tgt);
    if (!sn || !tn) return false;
    const sk = sn.type as NodeKind;
    const tk = tn.type as NodeKind;
    if (tk === "input") return false;
    if (sk === "input" && tk === "output") return false;
    if (sk === "processing" && tk === "processing") return false;
    if (sk === "output" && tk === "output") return false;
    return true;
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    setEdges(es => addEdge({
      ...conn,
      animated:  true,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8", width: 20, height: 20 },
      style:     { stroke: "#818cf8", strokeWidth: 2.5 },
    }, es));
  }, [setEdges]);

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

    // ── Determine stageIndex and whether stages array grows ─────────────────
    let stageIndex: number;
    const newStages = [...currentStages];

    if (kind === "input") {
      // All inputs always go in the top sleeve (stage 0)
      stageIndex = 0;
    } else if (kind === "processing") {
      const lastStage = newStages[newStages.length - 1];
      if (lastStage === "processing") {
        // Add to existing processing sleeve (parallel agents)
        stageIndex = newStages.length - 1;
      } else {
        // Start a new processing sleeve after input or output
        newStages.push("processing");
        stageIndex = newStages.length - 1;
      }
    } else { // output
      const lastStage = newStages[newStages.length - 1];
      if (lastStage === "output") {
        // Add to existing output sleeve (multiple outputs)
        stageIndex = newStages.length - 1;
      } else {
        // Start a new output sleeve after processing
        newStages.push("output");
        stageIndex = newStages.length - 1;
      }
    }

    // ── Position: X from drop or auto-computed, Y always snaps to lane ──────
    const indexInStage = currentNodes.filter(
      n => (n.data as PipelineNodeData).stageIndex === stageIndex
    ).length;
    const position = dropPos
      ? { x: dropPos.x, y: laneY(stageIndex) + SLEEVE_INNER }
      : nodeXY(stageIndex, indexInStage);

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
      } satisfies PipelineNodeData,
    };

    const conn = findAutoConnect(newNode, currentNodes, currentEdges);

    // Commit stage change synchronously so rapid adds stay consistent
    if (newStages.length !== currentStages.length) {
      setStages(newStages);
      stagesRef.current = newStages;
    }

    setNodes(ns => [...ns, newNode]);
    if (conn) setEdges(es => [...es, makeEdge(conn.source, conn.target)]);
    setSelectedNodeId(id);

    setTimeout(() => fitView({ padding: 0.25, duration: 350 }), 60);
  }, [setNodes, setEdges, setStages, fitView]);

  // ── Drag from palette ─────────────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const kind    = e.dataTransfer.getData("application/nodeKind")    as NodeKind | "";
    const subType = e.dataTransfer.getData("application/nodeSubType") as string   | "";
    if (!kind || !subType) return;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeToCanvas(kind, subType, pos);
  }, [screenToFlowPosition, addNodeToCanvas]);

  // ── Node interactions ─────────────────────────────────────────────────────

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (!String(node.id).startsWith("sleeve_")) setSelectedNodeId(node.id);
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

  function handleClear() {
    setNodes([]);
    setEdges([]);
    setStages(["input"]);
    stagesRef.current = ["input"];
    setSelectedNodeId(null);
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

    const subTypeOptions =
      selKind === "input"      ? Object.entries(INPUT_META)   as [string, Meta][] :
      selKind === "processing" ? Object.entries(PROCESS_META) as [string, Meta][] :
                                  Object.entries(OUTPUT_META)  as [string, Meta][];

    return (
      <div className="p-4 space-y-4">
        <div className={`flex items-center gap-3 px-3.5 py-3 rounded-xl ${selMeta.color}`}>
          <span className="text-white text-lg shrink-0">{selMeta.icon}</span>
          <div className="min-w-0">
            <p className="text-[10px] text-white/60 uppercase tracking-widest font-bold">{selKind}</p>
            <p className="text-sm font-bold text-white truncate">{selData.label}</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Name</label>
          <input
            value={selData.label}
            onChange={e => updateNodeData(selectedNode.id, { label: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
            {selKind === "input" ? "Data Source" : selKind === "processing" ? "Agent Type" : "Output Format"}
          </label>
          <select
            value={selData.subType}
            onChange={e => updateNodeData(selectedNode.id, { subType: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
          >
            {subTypeOptions.map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-gray-600">{selMeta.desc}</p>
        </div>

        {selKind === "processing" && (
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">System Prompt</label>
            <textarea
              rows={5}
              value={selData.prompt}
              onChange={e => updateNodeData(selectedNode.id, { prompt: e.target.value })}
              placeholder="Describe what this agent should do…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none transition-colors"
            />
          </div>
        )}

        <button
          onClick={() => deleteNode(selectedNode.id)}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-gray-800 text-red-500 hover:bg-red-950/40 hover:border-red-800 text-sm transition-colors"
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
          <p className="text-[10px] text-gray-600 mt-0.5">Click to add · Drag to position</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
          {PALETTE_GROUPS.map(group => (
            <div key={group.kind}>
              <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest px-1 mb-1.5">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map(({ subType, meta }) => (
                  <div
                    key={subType}
                    draggable
                    onClick={() => addNodeToCanvas(group.kind, subType)}
                    onDragStart={e => {
                      e.dataTransfer.setData("application/nodeKind",    group.kind);
                      e.dataTransfer.setData("application/nodeSubType", subType);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer select-none transition-all
                      hover:scale-[1.02] active:scale-[0.98] ${meta.border} bg-gray-900/60 hover:bg-gray-800`}
                  >
                    <span className={`p-1 rounded-md ${meta.color} text-white shrink-0`}>{meta.icon}</span>
                    <span className={`text-xs font-semibold ${meta.text}`}>{meta.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Flow rules */}
        <div className="p-3 border-t border-gray-800">
          <p className="text-[10px] font-bold text-gray-600 uppercase tracking-widest mb-2">Flow rules</p>
          <div className="space-y-0.5 text-[10px]">
            <p className="text-gray-500"><span className="text-blue-400">Input</span> → <span className="text-indigo-400">Processing</span> ✓</p>
            <p className="text-gray-500"><span className="text-yellow-400">Output</span> → <span className="text-indigo-400">Processing</span> ✓</p>
            <p className="text-gray-500"><span className="text-indigo-400">Processing</span> → <span className="text-yellow-400">Output</span> ✓</p>
            <p className="text-gray-700 line-through"><span>Processing</span> → <span>Processing</span></p>
            <p className="text-gray-600 mt-1 text-[9px]">Each processing must have an output</p>
            <p className="text-gray-600 text-[9px]">Multiple inputs per processing allowed</p>
          </div>
        </div>

        {/* Actions */}
        <div className="p-2.5 space-y-2 border-t border-gray-800">
          <button
            onClick={handleSave}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-wide transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
            Validate &amp; Save
          </button>
          <button
            onClick={handleClear}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-gray-800 text-gray-600 hover:text-red-400 hover:border-red-900 text-xs transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Clear canvas
          </button>
        </div>
      </aside>

      {/* ── Canvas ────────────────────────────────────────────────────── */}
      <div className="flex-1 relative" onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={allNodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChangeFiltered}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onConnect={onConnect}
          isValidConnection={isValidConnectionFn}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          deleteKeyCode="Delete"
          proOptions={{ hideAttribution: true }}
          className="bg-gray-950"
        >
          <Background color="#1f2937" gap={28} size={1.5} />
          <Controls
            className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-400 [&>button:hover]:bg-gray-700 [&>button:hover]:text-white"
          />
          <MiniMap
            nodeColor={n => {
              if (String(n.id).startsWith("sleeve_")) return "transparent";
              const d = n.data as PipelineNodeData;
              const m = getMeta(n.type as NodeKind, d?.subType ?? "");
              return m.color.includes("cyan")    ? "#0e7490" :
                     m.color.includes("green")   ? "#15803d" :
                     m.color.includes("amber")   ? "#b45309" :
                     m.color.includes("indigo")  ? "#4338ca" :
                     m.color.includes("violet")  ? "#6d28d9" :
                     m.color.includes("teal")    ? "#0f766e" :
                     m.color.includes("yellow")  ? "#a16207" :
                     m.color.includes("purple")  ? "#7e22ce" :
                     m.color.includes("blue")    ? "#1d4ed8" :
                                                    "#374151";
            }}
            maskColor="rgba(0,0,0,0.75)"
            className="!bg-gray-900 !border !border-gray-700 !rounded-xl"
          />
        </ReactFlow>

        {/* Empty state hint */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
            <div className="text-center space-y-3">
              <div className="flex flex-col items-center gap-1 text-gray-800">
                <div className="w-32 h-8 rounded border border-dashed border-gray-800 flex items-center justify-center text-xs">Inputs</div>
                <span className="text-xl">↓</span>
                <div className="w-32 h-8 rounded border border-dashed border-gray-800 flex items-center justify-center text-xs">Processing</div>
                <span className="text-xl">↓</span>
                <div className="w-32 h-8 rounded border border-dashed border-gray-800 flex items-center justify-center text-xs">Output</div>
              </div>
              <p className="text-sm font-semibold text-gray-700">Click elements on the left to build your pipeline</p>
              <p className="text-xs text-gray-800">Nodes auto-connect · Drag a handle to connect manually</p>
            </div>
          </div>
        )}

        {/* Toast */}
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

      {/* ── Right properties panel ─────────────────────────────────────── */}
      <aside className="w-60 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Properties</p>
          {selectedNodeId && (
            <button onClick={() => setSelectedNodeId(null)}
              className="text-gray-600 hover:text-gray-400 transition-colors">
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

// ── Page wrapper ──────────────────────────────────────────────────────────────

export default function PipelinePage() {
  return (
    <div className="-m-6 h-[calc(100vh-5rem)] flex flex-col">
      <div className="px-5 py-2.5 border-b border-gray-800 bg-gray-900/80 flex items-center gap-3 shrink-0">
        <h1 className="text-sm font-bold text-white">Pipeline Workflow</h1>
        <span className="text-xs text-gray-600">
          Click or drag elements · Auto-connects as you add · Drag handles to connect manually · Delete removes selection
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
