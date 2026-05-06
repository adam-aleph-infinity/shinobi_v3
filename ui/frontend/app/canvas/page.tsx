"use client";

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
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
import type { CanvasNode, CanvasEdge }  from "./hooks/useCanvasState";
import type { CanvasNodeData, RunLaunchOptions, RuntimeStatus } from "./types";
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
    nodeId: string, status: RuntimeStatus,
    durationS?: number, preview?: string, noteId?: string,
  ) => {
    updateNodeData(nodeId, {
      runtimeStatus: status,
      ...(durationS  != null && { lastRunDurationS: durationS }),
      ...(preview    != null && { lastOutputPreview: preview }),
      ...(noteId     != null && { lastNoteId: noteId }),
    });
  }, [updateNodeData]);

  const { running, runError: _runError, logLines, launch, cancel: _cancel, clearLogs } =
    useRunExecution(handleNodeStatusChange);

  const [activeFolderId,  setActiveFolderId]  = useState("");
  const [showRunModal,    setShowRunModal]     = useState(false);
  const [saving,          setSaving]           = useState(false);
  const [showNodePicker,  setShowNodePicker]   = useState(false);

  // Load pipeline when activePipelineId changes

  useEffect(() => {
    if (!activePipelineId) return;
    loadPipeline(activePipelineId).then(pl => {
      const raw = pl.canvas;
      if (raw?.nodes?.length) {
        loadFromPipeline(
          raw.nodes as CanvasNode[],
          raw.edges as CanvasEdge[],
        );
      } else {
        loadFromPipeline([], []);
      }
    }).catch(console.error);
  }, [activePipelineId, loadPipeline, loadFromPipeline]);

  // Save

  const handleSave = useCallback(async () => {
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
  }, [activePipelineId, pipelines, nodes, edges, savePipeline, setIsDirty]);

  // Run

  const handleRun = useCallback(() => {
    if (!activePipelineId) return;
    setShowRunModal(true);
  }, [activePipelineId]);

  const handleLaunch = useCallback((opts: RunLaunchOptions) => {
    const agentNodes = nodes
      .filter(n => n.data.kind === "agent" && n.data.agentId)
      .sort((a, b) => a.position.x - b.position.x);
    void launch(activePipelineId, salesAgent, customer, callId, agentNodes, opts);
  }, [activePipelineId, salesAgent, customer, callId, nodes, launch]);

  // Keyboard shortcuts

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "c") { e.preventDefault(); copySelected(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") { e.preventDefault(); pasteNodes(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void handleSave(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, copySelected, pasteNodes, handleSave]);

  // Node interactions

  const handleNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_evt, node) => {
    setSelectedNodeId(node.id);
  }, [setSelectedNodeId]);

  const handleAddNode = useCallback(() => { setShowNodePicker(true); }, []);

  const handleExport = useCallback(async () => {
    if (!activePipelineId) return;
    try {
      const res = await fetch(`/api/pipelines/${encodeURIComponent(activePipelineId)}/bundle`);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const data = await res.json();
      const url  = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `${activePipelineId}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
    }
  }, [activePipelineId]);

  const handleDuplicateNode = useCallback((id: string) => {
    const src = nodes.find(n => n.id === id);
    if (!src) return;
    const newNode: CanvasNode = {
      ...src,
      id: `node-${Date.now()}`,
      position: { x: src.position.x + 30, y: src.position.y + 30 },
      selected: false,
    };
    addNode(newNode);
  }, [nodes, addNode]);

  const handleDeleteNode = useCallback((id: string) => {
    setNodes(prev => prev.filter(n => n.id !== id));
    setEdges(prev => prev.filter(e => e.source !== id && e.target !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
    setIsDirty(true);
  }, [selectedNodeId, setNodes, setEdges, setSelectedNodeId, setIsDirty]);

  const handleSendNote = useCallback(async (noteId: string) => {
    const res = await fetch(`/api/notes/${encodeURIComponent(noteId)}/send-to-crm`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sales_agent: salesAgent, customer }),
    });
    if (!res.ok) throw new Error(`Send note failed (${res.status})`);
  }, [salesAgent, customer]);

  const handleCreatePipeline = useCallback(async () => {
    const pl = await savePipeline({
      name: "New Pipeline",
      description: "",
      folder_id: activeFolderId || undefined,
      steps: [],
    });
    setActivePipeline(pl.id, pl.name);
  }, [activeFolderId, savePipeline, setActivePipeline]);

  const handleRenamePipeline = useCallback(async (id: string, name: string) => {
    const pl = pipelines.find(p => p.id === id);
    if (!pl) return;
    await savePipeline({ ...pl, name });
    if (id === activePipelineId) setActivePipeline(id, name);
  }, [pipelines, savePipeline, activePipelineId, setActivePipeline]);

  const handleDeletePipeline = useCallback(async (id: string) => {
    await deletePipeline(id);
    if (id === activePipelineId) setActivePipeline("", "");
  }, [deletePipeline, activePipelineId, setActivePipeline]);

  const handleDuplicatePipeline = useCallback(async (id: string) => {
    const pl = await loadPipeline(id);
    const { id: _id, ...restPl } = pl;
    await savePipeline({ ...restPl, name: `${pl.name} (copy)` });
  }, [loadPipeline, savePipeline]);

  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null;

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-white overflow-hidden">
      {/* Context top bar */}
      <ContextTopBar
        salesAgent={salesAgent}
        customer={customer}
        callId={callId}
        onOpenCrm={() => {}}
        onOpenCalls={() => {}}
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
          onExport={handleExport}
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
            callId={callId}
            salesAgent={salesAgent}
            customer={customer}
          />
        )}
      </div>

      {/* Bottom log */}
      <BottomLogPanel lines={logLines} running={running} onClear={clearLogs} />

      {/* Node picker modal */}
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
