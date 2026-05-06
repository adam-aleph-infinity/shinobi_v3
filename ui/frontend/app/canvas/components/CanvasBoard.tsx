"use client";

import { useCallback, useState } from "react";
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  useReactFlow,
  type NodeTypes, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { InputNode }  from "./node-types/InputNode";
import { AgentNode }  from "./node-types/AgentNode";
import { OutputNode } from "./node-types/OutputNode";
import { CanvasToolbar } from "./CanvasToolbar";
import type { CanvasNode, CanvasEdge } from "../hooks/useCanvasState";
import type { NodeChange, EdgeChange, Connection } from "@xyflow/react";
import type { CanvasNodeData } from "../types";

// NodeMouseHandler generic expects the full Node type, not just the data type.
type CanvasNodeMouseHandler = NodeMouseHandler<CanvasNode>;

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
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect:     (connection: Connection) => void;
  onNodeClick:   CanvasNodeMouseHandler;
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
  const { fitView } = useReactFlow();
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const handlePaneContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, type: "canvas" });
  }, []);

  const handleNodeContextMenu: CanvasNodeMouseHandler = useCallback((e, node) => {
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
        onPaneContextMenu={handlePaneContextMenu as unknown as (e: MouseEvent | React.MouseEvent) => void}
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
              <button onClick={() => { fitView({ padding: 0.15, duration: 300 }); closeCtx(); }}
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
