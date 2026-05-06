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
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const undoStack = useRef<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>>([]);
  const redoStack = useRef<Array<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>>([]);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const clipboard = useRef<CanvasNode[]>([]);
  const nodesRef = useRef<CanvasNode[]>([]);
  const edgesRef = useRef<CanvasEdge[]>([]);

  nodesRef.current = nodes;
  edgesRef.current = edges;

  const snapshot = useCallback((currentNodes: CanvasNode[], currentEdges: CanvasEdge[]) => {
    undoStack.current = [...undoStack.current.slice(-MAX_UNDO), cloneState(currentNodes, currentEdges)];
    redoStack.current = [];
    setUndoLen(undoStack.current.length);
    setRedoLen(0);
    setIsDirty(true);
  }, []);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const hasMeaningfulChange = changes.some(c =>
      c.type === "remove" || c.type === "add" ||
      (c.type === "position" && !c.dragging),
    );
    if (hasMeaningfulChange) {
      snapshot(nodes, edges);
    }
    onNodesChange(changes);
  }, [nodes, edges, onNodesChange, snapshot]);

  const handleEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    const hasMeaningfulChange = changes.some(c => c.type === "remove" || c.type === "add");
    if (hasMeaningfulChange) snapshot(nodes, edges);
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
    redoStack.current.push(cloneState(nodesRef.current, edgesRef.current));
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setUndoLen(undoStack.current.length);
    setRedoLen(redoStack.current.length);
  }, [setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(cloneState(nodesRef.current, edgesRef.current));
    setNodes(next.nodes);
    setEdges(next.edges);
    setUndoLen(undoStack.current.length);
    setRedoLen(redoStack.current.length);
  }, [setNodes, setEdges]);

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
    const now = Date.now();
    const pasted = clipboard.current.map((n, i) => ({
      ...n,
      id: `${n.id}-copy-${now}-${i}`,
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
