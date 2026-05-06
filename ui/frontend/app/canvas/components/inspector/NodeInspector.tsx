"use client";

import React, { useState, useEffect } from "react";
import { X, Eye, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CanvasNode } from "../../hooks/useCanvasState";
import type { UniversalAgent, CanvasNodeData } from "../../types";
import { INPUT_SOURCES, MODEL_GROUPS, OUTPUT_SUBTYPES, RUNTIME_BADGE } from "../../types";
import { TranscriptViewer } from "@/components/shared/TranscriptViewer";

interface Props {
  node:        CanvasNode | null;
  agents:      UniversalAgent[];
  onClose:     () => void;
  onUpdate:    (id: string, patch: Partial<CanvasNodeData>) => void;
  onSendNote:  (noteId: string) => void;
  callId?:     string;
  salesAgent?: string;
  customer?:   string;
}

export function NodeInspector({ node, agents, onClose, onUpdate, onSendNote, callId, salesAgent, customer }: Props) {
  const [viewingOutput,   setViewingOutput]   = useState(false);
  const [showTranscript,  setShowTranscript]  = useState(false);
  const [transcriptText,  setTranscriptText]  = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  useEffect(() => {
    setTranscriptText(null);
    setShowTranscript(false);
    setTranscriptLoading(false);
  }, [node?.id, callId]);

  async function openTranscript() {
    setShowTranscript(true);
    if (transcriptText !== null) return; // already fetched
    if (!callId || !salesAgent || !customer) {
      setTranscriptText("No call context available.");
      return;
    }
    setTranscriptLoading(true);
    try {
      const res = await fetch(
        `/api/notes/transcript?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(callId)}`
      );
      if (!res.ok) { setTranscriptText("Transcript not found."); return; }
      const data = await res.json() as { text: string };
      setTranscriptText(data.text);
    } catch {
      setTranscriptText("Error loading transcript.");
    } finally {
      setTranscriptLoading(false);
    }
  }

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
          <>
            {field("Input Source",
              <select value={String(data.inputSource || "transcript")}
                onChange={e => onUpdate(node.id, { inputSource: e.target.value })}
                className={selectCls}>
                {INPUT_SOURCES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            )}
            {(data.inputSource === "transcript" || data.inputSource === "merged_transcript" || !data.inputSource) && (
              <button onClick={() => void openTranscript()}
                className="w-full flex items-center justify-center gap-1.5 bg-blue-700/20 border border-blue-600/40 rounded-lg py-1.5 text-[10px] text-blue-300 hover:bg-blue-700/30 transition-colors mt-2">
                <Eye className="w-3 h-3" /> View Transcript
              </button>
            )}
          </>
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

      {/* Transcript modal */}
      {showTranscript && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowTranscript(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
              <span className="text-sm font-bold text-white">Transcript</span>
              <button onClick={() => setShowTranscript(false)}>
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {transcriptLoading ? (
                <p className="text-xs text-gray-500 italic">Loading…</p>
              ) : transcriptText ? (
                <TranscriptViewer content={transcriptText} externalScroll />
              ) : (
                <p className="text-xs text-gray-600 italic">No transcript loaded.</p>
              )}
            </div>
          </div>
        </div>
      )}

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
