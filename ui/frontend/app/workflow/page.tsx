"use client";

import { useRef, useState } from "react";
import {
  Bot, FileText, Mic, Database, StickyNote, Info,
  Code2, AlignLeft, List, FileJson, Plus, Trash2,
  ChevronRight, ArrowRight, Zap, LayoutTemplate,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type AgentType   = "summarizer" | "classifier" | "extractor" | "analyzer" | "scorer";
type InputType   = "transcript" | "recording" | "crm_data" | "notes" | "metadata";
type OutputType  = "json" | "text" | "markdown" | "structured";

interface DragAgent  { kind: "agent";  agentType: AgentType  }
interface DragInput  { kind: "input";  inputType: InputType  }
interface DragOutput { kind: "output"; outputType: OutputType }
type DragItem = DragAgent | DragInput | DragOutput;

interface WfInput { id: string; type: InputType }
interface WfStep  { id: string; agentType: AgentType; name: string; prompt: string; inputs: WfInput[]; outputType: OutputType | null }

type Selection =
  | { kind: "step";   stepId: string }
  | { kind: "input";  stepId: string; inputId: string }
  | { kind: "output"; stepId: string }
  | null;

// ── Metadata ──────────────────────────────────────────────────────────────────

const AGENT_META: Record<AgentType, { label: string; color: string; icon: React.ReactNode; desc: string }> = {
  summarizer: { label: "Summarizer", color: "bg-indigo-600",  icon: <AlignLeft className="w-4 h-4" />, desc: "Condenses content into a concise summary" },
  classifier: { label: "Classifier", color: "bg-violet-600",  icon: <List      className="w-4 h-4" />, desc: "Categorises input into predefined classes" },
  extractor:  { label: "Extractor",  color: "bg-blue-600",    icon: <Code2     className="w-4 h-4" />, desc: "Pulls structured data from unstructured text" },
  analyzer:   { label: "Analyzer",   color: "bg-cyan-600",    icon: <Zap       className="w-4 h-4" />, desc: "Performs deep analysis and insight generation" },
  scorer:     { label: "Scorer",     color: "bg-teal-600",    icon: <LayoutTemplate className="w-4 h-4" />, desc: "Assigns numeric or categorical scores" },
};

const INPUT_META: Record<InputType, { label: string; color: string; icon: React.ReactNode }> = {
  transcript: { label: "Transcript",    color: "bg-blue-700",   icon: <FileText className="w-3 h-3" /> },
  recording:  { label: "Recording",     color: "bg-cyan-700",   icon: <Mic      className="w-3 h-3" /> },
  crm_data:   { label: "CRM Data",      color: "bg-green-700",  icon: <Database className="w-3 h-3" /> },
  notes:      { label: "Notes",         color: "bg-amber-700",  icon: <StickyNote className="w-3 h-3" /> },
  metadata:   { label: "Metadata",      color: "bg-gray-600",   icon: <Info     className="w-3 h-3" /> },
};

const OUTPUT_META: Record<OutputType, { label: string; color: string; icon: React.ReactNode }> = {
  json:       { label: "JSON",          color: "bg-yellow-700", icon: <FileJson className="w-3 h-3" /> },
  text:       { label: "Plain Text",    color: "bg-gray-600",   icon: <AlignLeft className="w-3 h-3" /> },
  markdown:   { label: "Markdown",      color: "bg-indigo-700", icon: <Code2    className="w-3 h-3" /> },
  structured: { label: "Structured",    color: "bg-purple-700", icon: <List     className="w-3 h-3" /> },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let _seq = 1;
function uid() { return `id_${_seq++}_${Math.random().toString(36).slice(2, 6)}`; }

// ── Components ────────────────────────────────────────────────────────────────

function PaletteItem({
  label, icon, colorClass, onDragStart, onDragEnd, onClick,
}: {
  label: string; icon: React.ReactNode; colorClass: string;
  onDragStart: () => void; onDragEnd: () => void; onClick?: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-700 bg-gray-800 hover:bg-gray-700 cursor-grab active:cursor-grabbing select-none transition-colors"
    >
      <span className={`p-1 rounded ${colorClass} text-white shrink-0`}>{icon}</span>
      <span className="text-sm text-gray-200">{label}</span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function WorkflowPage() {
  const dragRef  = useRef<DragItem | null>(null);
  const [steps,     setSteps]     = useState<WfStep[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // stepId or "canvas"
  const [savedJson,  setSavedJson]  = useState<string | null>(null);

  // ── Drag helpers ────────────────────────────────────────────────────────────

  function startDrag(item: DragItem) {
    dragRef.current = item;
  }
  function endDrag() {
    dragRef.current = null;
    setDropTarget(null);
  }

  // ── Step mutations ──────────────────────────────────────────────────────────

  function addStep(agentType: AgentType) {
    const m = AGENT_META[agentType];
    const s: WfStep = { id: uid(), agentType, name: `${m.label} ${steps.length + 1}`, prompt: "", inputs: [], outputType: null };
    setSteps(prev => [...prev, s]);
    setSelection({ kind: "step", stepId: s.id });
  }

  function deleteStep(stepId: string) {
    setSteps(prev => prev.filter(s => s.id !== stepId));
    if (selection && "stepId" in selection && selection.stepId === stepId) setSelection(null);
  }

  function addInputToStep(stepId: string, inputType: InputType) {
    const inp: WfInput = { id: uid(), type: inputType };
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, inputs: [...s.inputs, inp] } : s));
    setSelection({ kind: "input", stepId, inputId: inp.id });
  }

  function removeInputFromStep(stepId: string, inputId: string) {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, inputs: s.inputs.filter(i => i.id !== inputId) } : s));
    if (selection?.kind === "input" && selection.inputId === inputId) setSelection({ kind: "step", stepId });
  }

  function setStepOutput(stepId: string, outputType: OutputType) {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, outputType } : s));
    setSelection({ kind: "output", stepId });
  }

  function updateStep(stepId: string, patch: Partial<WfStep>) {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, ...patch } : s));
  }

  // ── Drop handlers ───────────────────────────────────────────────────────────

  function handleCanvasDrop(e: React.DragEvent) {
    e.preventDefault();
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "agent") addStep(d.agentType);
    dragRef.current = null;
    setDropTarget(null);
  }

  function handleStepDrop(e: React.DragEvent, stepId: string) {
    e.preventDefault();
    e.stopPropagation();
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "input")  addInputToStep(stepId, d.inputType);
    if (d.kind === "output") setStepOutput(stepId, d.outputType);
    dragRef.current = null;
    setDropTarget(null);
  }

  // ── Right panel ─────────────────────────────────────────────────────────────

  function renderPanel() {
    if (!selection) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-gray-600 gap-3 p-6 text-center">
          <Bot className="w-10 h-10 opacity-30" />
          <p className="text-sm">Click any element on the canvas to edit its settings</p>
        </div>
      );
    }

    if (selection.kind === "step") {
      const step = steps.find(s => s.id === selection.stepId);
      if (!step) return null;
      const m = AGENT_META[step.agentType];
      return (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <span className={`p-1.5 rounded-lg ${m.color} text-white`}>{m.icon}</span>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Agent</p>
              <p className="font-semibold text-white">{m.label}</p>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wider">Name</label>
            <input
              value={step.name}
              onChange={e => updateStep(step.id, { name: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wider">System Prompt</label>
            <textarea
              rows={6}
              value={step.prompt}
              onChange={e => updateStep(step.id, { prompt: e.target.value })}
              placeholder="Describe what this agent should do…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wider">Agent Type</label>
            <select
              value={step.agentType}
              onChange={e => updateStep(step.id, { agentType: e.target.value as AgentType })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              {(Object.keys(AGENT_META) as AgentType[]).map(t => (
                <option key={t} value={t}>{AGENT_META[t].label}</option>
              ))}
            </select>
          </div>

          <p className="text-xs text-gray-600">{m.desc}</p>
        </div>
      );
    }

    if (selection.kind === "input") {
      const step = steps.find(s => s.id === selection.stepId);
      const inp  = step?.inputs.find(i => i.id === selection.inputId);
      if (!step || !inp) return null;
      const m = INPUT_META[inp.type];
      return (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <span className={`p-1.5 rounded-lg ${m.color} text-white`}>{m.icon}</span>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Input Source</p>
              <p className="font-semibold text-white">{m.label}</p>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wider">Source Type</label>
            <select
              value={inp.type}
              onChange={e => {
                const newType = e.target.value as InputType;
                setSteps(prev => prev.map(s => s.id === step.id
                  ? { ...s, inputs: s.inputs.map(i => i.id === inp.id ? { ...i, type: newType } : i) }
                  : s
                ));
              }}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              {(Object.keys(INPUT_META) as InputType[]).map(t => (
                <option key={t} value={t}>{INPUT_META[t].label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={() => removeInputFromStep(step.id, inp.id)}
            className="flex items-center gap-2 text-sm text-red-400 hover:text-red-300 transition-colors mt-2"
          >
            <Trash2 className="w-4 h-4" />
            Remove this input
          </button>
        </div>
      );
    }

    if (selection.kind === "output") {
      const step = steps.find(s => s.id === selection.stepId);
      if (!step || !step.outputType) return null;
      const m = OUTPUT_META[step.outputType];
      return (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <span className={`p-1.5 rounded-lg ${m.color} text-white`}>{m.icon}</span>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Output Format</p>
              <p className="font-semibold text-white">{m.label}</p>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wider">Format</label>
            <select
              value={step.outputType}
              onChange={e => setStepOutput(step.id, e.target.value as OutputType)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              {(Object.keys(OUTPUT_META) as OutputType[]).map(t => (
                <option key={t} value={t}>{OUTPUT_META[t].label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={() => {
              setSteps(prev => prev.map(s => s.id === step.id ? { ...s, outputType: null } : s));
              setSelection({ kind: "step", stepId: step.id });
            }}
            className="flex items-center gap-2 text-sm text-red-400 hover:text-red-300 transition-colors mt-2"
          >
            <Trash2 className="w-4 h-4" />
            Remove output
          </button>
        </div>
      );
    }

    return null;
  }

  // ── Canvas nodes ─────────────────────────────────────────────────────────────

  function renderStep(step: WfStep, idx: number) {
    const isTarget     = dropTarget === step.id;
    const agentMeta    = AGENT_META[step.agentType];
    const isSelected   = selection?.kind === "step" && selection.stepId === step.id;

    return (
      <div key={step.id} className="flex items-center shrink-0">
        {/* Column */}
        <div
          className={`flex flex-col items-center gap-2 transition-all duration-150 ${isTarget ? "scale-105" : ""}`}
          onDragOver={e => {
            const d = dragRef.current;
            if (d && (d.kind === "input" || d.kind === "output")) {
              e.preventDefault();
              e.stopPropagation();
              setDropTarget(step.id);
            }
          }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDropTarget(null);
            }
          }}
          onDrop={e => handleStepDrop(e, step.id)}
        >
          {/* Input chips */}
          <div className="flex flex-col gap-1 w-36 min-h-[2rem]">
            {step.inputs.map(inp => {
              const im = INPUT_META[inp.type];
              const isSel = selection?.kind === "input" && selection.inputId === inp.id;
              return (
                <button
                  key={inp.id}
                  onClick={e => { e.stopPropagation(); setSelection({ kind: "input", stepId: step.id, inputId: inp.id }); }}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-white ${im.color} ${isSel ? "ring-2 ring-white/60" : "hover:brightness-110"} transition-all`}
                >
                  {im.icon}
                  {im.label}
                </button>
              );
            })}
            {/* Drop hint for inputs */}
            {isTarget && dragRef.current?.kind === "input" && (
              <div className="flex items-center justify-center h-7 rounded-md border-2 border-dashed border-blue-400/60 text-blue-400 text-xs gap-1">
                <Plus className="w-3 h-3" /> Drop input
              </div>
            )}
          </div>

          {/* Agent box */}
          <div
            onClick={() => setSelection(isSelected ? null : { kind: "step", stepId: step.id })}
            className={`w-36 rounded-xl border-2 transition-all cursor-pointer overflow-hidden
              ${isSelected
                ? "border-indigo-400 bg-gray-800 shadow-lg shadow-indigo-900/40"
                : "border-gray-700 bg-gray-800 hover:border-gray-600"}
              ${isTarget && dragRef.current?.kind === "input" ? "border-blue-500/60" : ""}
              ${isTarget && dragRef.current?.kind === "output" ? "border-yellow-500/60" : ""}
            `}
          >
            <div className={`${agentMeta.color} flex items-center gap-2 px-3 py-2`}>
              <span className="text-white">{agentMeta.icon}</span>
              <span className="text-xs font-semibold text-white truncate">{step.name}</span>
            </div>
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-xs text-gray-500">{agentMeta.label}</span>
              <button
                onClick={e => { e.stopPropagation(); deleteStep(step.id); }}
                className="text-gray-600 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Output chip */}
          <div className="w-36 min-h-[1.75rem]">
            {step.outputType ? (
              <button
                onClick={e => { e.stopPropagation(); setSelection({ kind: "output", stepId: step.id }); }}
                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-white ${OUTPUT_META[step.outputType].color}
                  ${selection?.kind === "output" && selection.stepId === step.id ? "ring-2 ring-white/60" : "hover:brightness-110"}
                  transition-all`}
              >
                {OUTPUT_META[step.outputType].icon}
                {OUTPUT_META[step.outputType].label}
              </button>
            ) : (
              isTarget && dragRef.current?.kind === "output" && (
                <div className="flex items-center justify-center h-7 rounded-md border-2 border-dashed border-yellow-400/60 text-yellow-400 text-xs gap-1">
                  <Plus className="w-3 h-3" /> Drop output
                </div>
              )
            )}
          </div>
        </div>

        {/* Arrow connector */}
        {idx < steps.length - 1 && (
          <div className="flex items-center mx-2 text-gray-600">
            <ArrowRight className="w-5 h-5" />
          </div>
        )}
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const isAnyDrag = dragRef.current !== null;

  return (
    <div className="flex h-[calc(100vh-5rem)] -m-6 overflow-hidden">

      {/* ── Left palette ────────────────────────────────────────────── */}
      <aside className="w-52 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-800">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Elements</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-4">

          {/* Agents */}
          <div>
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">Agents</p>
            <div className="space-y-1">
              {(Object.keys(AGENT_META) as AgentType[]).map(t => {
                const m = AGENT_META[t];
                return (
                  <PaletteItem
                    key={t}
                    label={m.label}
                    icon={m.icon}
                    colorClass={m.color}
                    onDragStart={() => startDrag({ kind: "agent", agentType: t })}
                    onDragEnd={endDrag}
                    onClick={() => addStep(t)}
                  />
                );
              })}
            </div>
          </div>

          {/* Inputs */}
          <div>
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">Inputs</p>
            <div className="space-y-1">
              {(Object.keys(INPUT_META) as InputType[]).map(t => {
                const m = INPUT_META[t];
                return (
                  <PaletteItem
                    key={t}
                    label={m.label}
                    icon={m.icon}
                    colorClass={m.color}
                    onDragStart={() => startDrag({ kind: "input", inputType: t })}
                    onDragEnd={endDrag}
                    onClick={() => {
                      // Add to the currently selected step if one is selected
                      const selStepId = selection && "stepId" in selection ? selection.stepId : null;
                      if (selStepId) addInputToStep(selStepId, t);
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Outputs */}
          <div>
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">Outputs</p>
            <div className="space-y-1">
              {(Object.keys(OUTPUT_META) as OutputType[]).map(t => {
                const m = OUTPUT_META[t];
                return (
                  <PaletteItem
                    key={t}
                    label={m.label}
                    icon={m.icon}
                    colorClass={m.color}
                    onDragStart={() => startDrag({ kind: "output", outputType: t })}
                    onDragEnd={endDrag}
                    onClick={() => {
                      const selStepId = selection && "stepId" in selection ? selection.stepId : null;
                      if (selStepId) setStepOutput(selStepId, t);
                    }}
                  />
                );
              })}
            </div>
          </div>

        </div>
      </aside>

      {/* ── Canvas ──────────────────────────────────────────────────── */}
      <div
        className={`flex-1 overflow-auto flex items-center justify-center transition-colors
          ${dropTarget === "canvas" ? "bg-indigo-950/30" : "bg-gray-950"}
          ${isAnyDrag && dragRef.current?.kind === "agent" ? "cursor-copy" : ""}
        `}
        onDragOver={e => {
          const d = dragRef.current;
          if (d?.kind === "agent") { e.preventDefault(); setDropTarget("canvas"); }
        }}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
        onDrop={handleCanvasDrop}
      >
        {steps.length === 0 ? (
          <div className={`flex flex-col items-center gap-3 text-gray-700 pointer-events-none select-none transition-opacity ${dropTarget === "canvas" ? "opacity-100" : "opacity-60"}`}>
            <div className={`w-24 h-24 rounded-2xl border-2 border-dashed flex items-center justify-center transition-colors ${dropTarget === "canvas" ? "border-indigo-500 text-indigo-500" : "border-gray-700"}`}>
              <Plus className="w-10 h-10" />
            </div>
            <p className="text-sm text-center max-w-[200px]">
              {dropTarget === "canvas" ? "Release to add agent" : "Drag an agent here or click one in the panel"}
            </p>
          </div>
        ) : (
          <div className="flex items-center px-12 py-16">
            {steps.map((s, i) => renderStep(s, i))}

            {/* Drop zone to append a new step */}
            <div
              className={`ml-4 flex items-center justify-center w-28 h-20 rounded-xl border-2 border-dashed transition-colors
                ${dropTarget === "canvas" ? "border-indigo-500 bg-indigo-950/30 text-indigo-400" : "border-gray-700 text-gray-700"}
              `}
            >
              <div className="flex flex-col items-center gap-1">
                <Plus className="w-5 h-5" />
                <span className="text-xs">Add step</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Right panel ─────────────────────────────────────────────── */}
      <aside className="w-64 shrink-0 bg-gray-900 border-l border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Properties</h2>
          {selection && (
            <button onClick={() => setSelection(null)} className="text-gray-600 hover:text-gray-400 text-xs">
              ✕
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {renderPanel()}
        </div>

        {/* Save / view */}
        <div className="p-3 border-t border-gray-800 space-y-2">
          <button
            onClick={() => setSavedJson(JSON.stringify(steps, null, 2))}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
            Save Pipeline
          </button>
          {savedJson && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-300 transition-colors">View JSON</summary>
              <pre className="mt-2 bg-gray-950 rounded-lg p-2 text-gray-400 overflow-auto max-h-64 text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                {savedJson}
              </pre>
            </details>
          )}
        </div>
      </aside>

    </div>
  );
}
