"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import useSWR from "swr";
import { useAppCtx } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { parseServerDate, utcHmsToLocal } from "@/lib/time";
import { SectionContent } from "@/components/shared/SectionCards";
import {
  History, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp,
  X, Copy, Check, Clock, Cpu, Zap, Bot, FileText, Layers, Mic2,
  BookOpen, GitBranch, PenLine, StickyNote, ChevronRight,
} from "lucide-react";

const fetcher = (url: string) => fetch(url).then(r => r.json());

// ── Types ─────────────────────────────────────────────────────────────────────

type StepStatus = "pending" | "loading" | "cached" | "done" | "error";

interface CanvasNode {
  id: string; type: string;
  position: { x: number; y: number };
  data: {
    label: string; subType: string; stageIndex: number;
    agentId?: string; agentName?: string; inputSource?: string;
  };
}

interface RunStep {
  agent_id: string; agent_name: string; model: string;
  status: string; content: string; error_msg: string;
  execution_time_s: number | null;
  input_token_est: number; output_token_est: number;
  thinking: string;
  input_sources: { key: string; source: string }[];
}

interface PipelineRunRecord {
  id: string; pipeline_id: string; pipeline_name: string;
  sales_agent: string; customer: string; call_id: string;
  started_at: string; finished_at: string | null;
  status: string;
  canvas_json: string; steps_json: string; log_json: string;
}

interface StepState {
  agentName: string; status: StepStatus;
  content: string; stream: string; expanded: boolean;
}

// ── Source metadata ───────────────────────────────────────────────────────────

const SOURCE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  transcript:        { label: "Transcript",        icon: Mic2,      color: "text-blue-400" },
  merged_transcript: { label: "Merged Transcript", icon: Layers,    color: "text-cyan-400" },
  notes:             { label: "Notes",             icon: StickyNote, color: "text-green-400" },
  merged_notes:      { label: "Merged Notes",      icon: BookOpen,  color: "text-teal-400" },
  agent_output:      { label: "Agent Output",      icon: Bot,       color: "text-purple-400" },
  artifact_output:   { label: "Artifact Output",   icon: GitBranch, color: "text-amber-400" },
  chain_previous:    { label: "Artifact Output",   icon: GitBranch, color: "text-amber-400" },
  manual:            { label: "Manual Input",      icon: PenLine,   color: "text-gray-400" },
};

const ARTIFACT_META: Record<string, { color: string; bg: string; border: string }> = {
  persona:          { color: "text-violet-400", bg: "bg-violet-950/20",  border: "border-violet-700/40" },
  persona_score:    { color: "text-violet-300", bg: "bg-violet-950/15",  border: "border-violet-800/40" },
  notes:            { color: "text-amber-400",  bg: "bg-amber-950/20",   border: "border-amber-700/40" },
  notes_compliance: { color: "text-emerald-400",bg: "bg-emerald-950/20", border: "border-emerald-700/40" },
};
const DEFAULT_ARTIFACT = { color: "text-gray-400", bg: "bg-gray-800/40", border: "border-gray-700/50" };

// ── Utility helpers ───────────────────────────────────────────────────────────

function relativeTime(isoStr: string): string {
  const dt = parseServerDate(isoStr);
  if (!dt) return "—";
  const d = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function durationStr(s: string, e: string | null): string {
  if (!e) return "…";
  const start = parseServerDate(s);
  const end = parseServerDate(e);
  if (!start || !end) return "—";
  const ms = end.getTime() - start.getTime();
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function buildCanvasMaps(canvas: { nodes: CanvasNode[]; edges: { id: string; source: string; target: string }[] }) {
  const sorted = [...canvas.nodes].sort((a, b) => {
    const si = (a.data?.stageIndex ?? 0) - (b.data?.stageIndex ?? 0);
    return si !== 0 ? si : (a.position?.x ?? 0) - (b.position?.x ?? 0);
  });
  const procStepIdx = new Map<string, number>();
  let idx = 0;
  for (const n of sorted) { if (n.type === "processing") procStepIdx.set(n.id, idx++); }
  const outputProcId = new Map<string, string>();
  const procSet = new Set(sorted.filter(n => n.type === "processing").map(n => n.id));
  for (const e of canvas.edges) { if (procSet.has(e.source)) outputProcId.set(e.target, e.source); }
  const inputProcIds = new Map<string, string[]>();
  const inputSet = new Set(sorted.filter(n => n.type === "input").map(n => n.id));
  for (const e of canvas.edges) {
    if (inputSet.has(e.source)) {
      const list = inputProcIds.get(e.source) ?? []; list.push(e.target); inputProcIds.set(e.source, list);
    }
  }
  return { procStepIdx, outputProcId, inputProcIds, canvasNodes: sorted };
}

// ── Mini canvas ───────────────────────────────────────────────────────────────

function MiniCanvas({
  stages, nodes, edges, procStepIdx, outputProcId, inputProcIds, flowSteps, selectedKey, onNodeClick,
}: {
  stages: string[];
  nodes: CanvasNode[];
  edges: { id: string; source: string; target: string }[];
  procStepIdx: Map<string, number>;
  outputProcId: Map<string, string>;
  inputProcIds: Map<string, string[]>;
  flowSteps: StepState[];
  selectedKey: string | null;
  onNodeClick: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(500);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const fn = () => setCw(el.getBoundingClientRect().width || 500);
    fn();
    const ro = new ResizeObserver(fn); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!nodes.length) return null;

  const SLEEVE_H = 180, Y_INIT = 20, NW = 200, NH = 52;
  const minX = Math.min(...nodes.map(n => n.position.x));
  const maxX = Math.max(...nodes.map(n => n.position.x)) + NW;
  const totalH_u = Y_INIT + stages.length * SLEEVE_H;
  const scaleByW = (cw - 8) / (maxX - minX);
  const scaleByH = 240 / totalH_u;
  const scale    = Math.max(0.14, Math.min(scaleByW, scaleByH));
  const totalH   = totalH_u * scale;
  const nw = NW * scale, nh = NH * scale;
  const fs = Math.max(8, Math.round(11 * scale));
  const nx = (n: CanvasNode) => (n.position.x - minX) * scale;
  const ny = (n: CanvasNode) => n.position.y * scale;

  function stepSt(cn: CanvasNode): StepStatus {
    if (cn.type === "processing") {
      const i = procStepIdx.get(cn.id); return i != null ? (flowSteps[i]?.status ?? "pending") : "pending";
    }
    if (cn.type === "output") {
      const pid = outputProcId.get(cn.id);
      const i = pid ? procStepIdx.get(pid) : undefined;
      if (i == null) return "pending";
      const st = flowSteps[i]?.status ?? "pending";
      return st === "loading" ? "pending" : st;
    }
    if (cn.type === "input") {
      const procIds = inputProcIds.get(cn.id) ?? [];
      if (!procIds.length) return "pending";
      const statuses = procIds.map(pid => { const i = procStepIdx.get(pid); return (i != null ? (flowSteps[i]?.status ?? "pending") : "pending") as StepStatus; });
      if (statuses.some(s => s === "error"))   return "error";
      if (statuses.some(s => s === "loading")) return "loading";
      if (statuses.some(s => s === "done" || s === "cached")) {
        const src = cn.data.inputSource ?? "";
        const isVirtual = (
          src === "agent_output" ||
          src === "chain_previous" ||
          src === "artifact_output" ||
          src.startsWith("artifact_")
        );
        return !isVirtual ? "cached" : (statuses.some(s => s === "done") ? "done" : "cached");
      }
    }
    return "pending";
  }

  function nstyle(n: CanvasNode, st: StepStatus) {
    if (st === "done")    return { bg: "#052e16", border: "#16a34a", text: "#86efac", glow: "0 0 10px rgba(34,197,94,0.35)" };
    if (st === "cached")  return { bg: "#1c1400", border: "#ca8a04", text: "#fde68a", glow: "0 0 10px rgba(234,179,8,0.30)" };
    if (st === "loading") return { bg: "#1c0a00", border: "#ea580c", text: "#fed7aa", glow: "0 0 12px rgba(249,115,22,0.45)" };
    if (st === "error")   return { bg: "#2d0a0a", border: "#b91c1c", text: "#fca5a5", glow: "0 0 10px rgba(239,68,68,0.30)" };
    if (n.type === "input")      return { bg: "#0d1f3c", border: "#1e40af", text: "#93c5fd", glow: "" };
    if (n.type === "processing") return { bg: "#0f0e1f", border: "#3730a3", text: "#a5b4fc", glow: "" };
    return                              { bg: "#150b2e", border: "#6d28d9", text: "#c4b5fd", glow: "" };
  }

  function nkey(n: CanvasNode) {
    return n.type === "processing" ? `proc:${n.id}` : n.type === "output" ? `out:${n.id}` : `input:${n.id}`;
  }

  return (
    <div ref={ref} className="w-full px-2 py-2">
      <div className="relative overflow-hidden rounded-xl border border-gray-800/60 bg-gray-950" style={{ height: totalH }}>
        {stages.map((kind, i) => (
          <div key={i} className="absolute left-0 right-0" style={{
            top: (Y_INIT + i * SLEEVE_H) * scale, height: SLEEVE_H * scale,
            backgroundColor: kind === "input" ? "rgba(30,58,138,0.10)" : kind === "processing" ? "rgba(30,27,75,0.13)" : "rgba(46,16,101,0.10)",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
          }}>
            <span style={{ position: "absolute", left: 4, top: 2, fontSize: Math.max(6, 7 * scale), fontWeight: 700, opacity: 0.22, letterSpacing: "0.08em", textTransform: "uppercase", color: kind === "input" ? "#60a5fa" : kind === "processing" ? "#818cf8" : "#a78bfa" }}>{kind}</span>
          </div>
        ))}
        <svg className="absolute inset-0 pointer-events-none" width="100%" height={totalH} style={{ overflow: "visible" }}>
          {edges.map(e => {
            const s = nodes.find(n => n.id === e.source), t = nodes.find(n => n.id === e.target);
            if (!s || !t) return null;
            const sx = nx(s) + nw / 2, sy = ny(s) + nh, tx = nx(t) + nw / 2, ty = ny(t), cy = (sy + ty) / 2;
            const st = stepSt(s);
            const stroke = st === "done" ? "#22c55e" : st === "cached" ? "#ca8a04" : st === "loading" ? "#ea580c" : st === "error" ? "#b91c1c" : "#374151";
            const aw = Math.max(3, 4.5 * scale);
            return (
              <g key={e.id}>
                <path d={`M${sx},${sy} C${sx},${cy} ${tx},${cy} ${tx},${ty}`} fill="none" stroke={stroke} strokeWidth={Math.max(1, 1.5 * scale)} opacity={0.55} />
                <polygon points={`${tx},${ty} ${tx - aw},${ty - aw * 1.5} ${tx + aw},${ty - aw * 1.5}`} fill={stroke} opacity={0.6} />
              </g>
            );
          })}
        </svg>
        {nodes.map(n => {
          const st = stepSt(n), c = nstyle(n, st), k = nkey(n), sel = selectedKey === k;
          const lbl = n.type === "input"
            ? (SOURCE_META[n.data.inputSource ?? ""]?.label ?? n.data.label)
            : n.type === "output" ? "Output"
            : (n.data.agentName || n.data.label);
          return (
            <div key={n.id} onClick={() => onNodeClick(k)}
              className="absolute cursor-pointer rounded-md transition-colors select-none"
              style={{ left: nx(n), top: ny(n), width: nw, height: nh, background: c.bg, border: `${st !== "pending" ? Math.max(1.5, 2 * scale) : Math.max(1, 1.2 * scale)}px solid ${c.border}`, outline: sel ? `2px solid ${c.border}` : undefined, outlineOffset: sel ? 2 : undefined, boxShadow: c.glow || undefined }}
            >
              <div className="flex items-center h-full overflow-hidden" style={{ padding: `2px ${Math.max(3, 7 * scale)}px`, gap: Math.max(2, 4 * scale) }}>
                {(n.type !== "input" || st !== "pending") && (
                  <span className="shrink-0" style={{ fontSize: fs, lineHeight: 1 }}>
                    {st === "done" ? <span style={{ color: "#22c55e" }}>✓</span> : st === "cached" ? <span style={{ color: "#eab308" }}>◎</span> : st === "loading" ? <span style={{ color: "#f97316" }}>⟳</span> : st === "error" ? <span style={{ color: "#ef4444" }}>✕</span> : <span style={{ color: c.border, opacity: 0.5 }}>●</span>}
                  </span>
                )}
                <span className="truncate" style={{ fontSize: fs, color: c.text, fontWeight: 600, lineHeight: 1.2 }}>{lbl}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 text-gray-600 hover:text-gray-300 transition-colors rounded">
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

// ── Collapsible ───────────────────────────────────────────────────────────────

function Collapsible({ label, children, defaultOpen = false, accent = "text-gray-400" }: { label: string; children: React.ReactNode; defaultOpen?: boolean; accent?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-800/60 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900/60 hover:bg-gray-800/60 transition-colors text-left">
        {open ? <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" /> : <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />}
        <span className={cn("text-[11px] font-semibold", accent)}>{label}</span>
      </button>
      {open && <div className="border-t border-gray-800/60">{children}</div>}
    </div>
  );
}

// ── Node Detail Panel ─────────────────────────────────────────────────────────

function NodeDetail({
  selectedKey,
  canvasNodes,
  procStepIdx,
  outputProcId,
  parsedSteps,
  salesAgent,
  customer,
  callId,
  onDismiss,
}: {
  selectedKey: string;
  canvasNodes: CanvasNode[];
  procStepIdx: Map<string, number>;
  outputProcId: Map<string, string>;
  parsedSteps: RunStep[];
  salesAgent: string;
  customer: string;
  callId: string;
  onDismiss: () => void;
}) {
  const colonIdx  = selectedKey.indexOf(":");
  const prefix    = selectedKey.slice(0, colonIdx);
  const nodeId    = selectedKey.slice(colonIdx + 1);
  const node      = canvasNodes.find(n => n.id === nodeId);
  const [preview, setPreview] = useState<{ loading: boolean; content: string; error: string }>({ loading: false, content: "", error: "" });

  if (!node) return null;

  // ── Input node ───────────────────────────────────────────────────────────────
  if (prefix === "input") {
    const src  = node.data.inputSource ?? "";
    const meta = SOURCE_META[src] ?? { label: src, icon: FileText, color: "text-gray-400" };
    const Icon = meta.icon;

    async function loadPreview() {
      setPreview({ loading: true, content: "", error: "" });
      try {
        let content = "";
        if (src === "transcript") {
          const r = await fetch(`/api/notes/transcript?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}&call_id=${encodeURIComponent(callId)}`);
          const d = await r.json(); content = d.transcript ?? d.text ?? JSON.stringify(d, null, 2);
        } else if (src === "merged_transcript") {
          const r = await fetch(`/api/full-persona-agent/transcript?agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}`);
          content = await r.text();
        } else {
          content = `Source "${src}" is resolved at pipeline execution time.`;
        }
        setPreview({ loading: false, content, error: "" });
      } catch (e: any) {
        setPreview({ loading: false, content: "", error: e.message });
      }
    }

    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
          <Icon className={cn("w-4 h-4 shrink-0", meta.color)} />
          <span className={cn("text-sm font-semibold flex-1", meta.color)}>{meta.label}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber-400 border border-amber-700/30">provided</span>
          <button onClick={onDismiss} className="text-gray-600 hover:text-gray-400 ml-1"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <div className="text-[11px] text-gray-500 space-y-1">
            <p><span className="text-gray-600">source</span> <span className="text-cyan-400 font-mono">{src}</span></p>
          </div>
          {!preview.content && !preview.loading && !preview.error && (
            <button onClick={loadPreview}
              className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs rounded-lg transition-colors">
              <FileText className="w-3 h-3" /> Preview content
            </button>
          )}
          {preview.loading && <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>}
          {preview.error && <p className="text-xs text-amber-500">{preview.error}</p>}
          {preview.content && <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed bg-gray-900/60 rounded-lg p-3 border border-gray-800">{preview.content.slice(0, 4000)}{preview.content.length > 4000 ? "\n\n[…truncated]" : ""}</pre>}
        </div>
      </div>
    );
  }

  // ── Processing node ──────────────────────────────────────────────────────────
  if (prefix === "proc") {
    const stepIdx = procStepIdx.get(nodeId) ?? 0;
    const step    = parsedSteps[stepIdx];
    if (!step) return <div className="p-4 text-sm text-gray-600">No step data</div>;

    const statusColor = step.status === "done" ? "text-green-400" : step.status === "cached" ? "text-amber-400" : step.status === "error" ? "text-red-400" : "text-gray-500";

    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
          <Bot className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-sm font-semibold text-gray-100 flex-1 truncate">{step.agent_name || node.data.agentName || node.data.label}</span>
          <span className={cn("text-[10px] font-medium shrink-0", statusColor)}>{step.status}</span>
          <button onClick={onDismiss} className="text-gray-600 hover:text-gray-400 ml-1"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-gray-900/60 rounded-lg p-2.5 border border-gray-800/60">
              <div className="flex items-center gap-1.5 mb-1"><Cpu className="w-3 h-3 text-indigo-400" /><span className="text-gray-500">Model</span></div>
              <code className="text-indigo-300 font-mono text-[10px] break-all">{step.model || "—"}</code>
            </div>
            <div className="bg-gray-900/60 rounded-lg p-2.5 border border-gray-800/60">
              <div className="flex items-center gap-1.5 mb-1"><Clock className="w-3 h-3 text-cyan-400" /><span className="text-gray-500">Time</span></div>
              <span className="text-cyan-300 font-mono">{step.execution_time_s != null ? `${step.execution_time_s}s` : step.status === "cached" ? "cached" : "—"}</span>
            </div>
            {(step.input_token_est > 0 || step.output_token_est > 0) && (
              <>
                <div className="bg-gray-900/60 rounded-lg p-2.5 border border-gray-800/60">
                  <div className="flex items-center gap-1.5 mb-1"><Zap className="w-3 h-3 text-amber-400" /><span className="text-gray-500">Input ~tokens</span></div>
                  <span className="text-amber-300 font-mono">{step.input_token_est.toLocaleString()}</span>
                </div>
                <div className="bg-gray-900/60 rounded-lg p-2.5 border border-gray-800/60">
                  <div className="flex items-center gap-1.5 mb-1"><Zap className="w-3 h-3 text-green-400" /><span className="text-gray-500">Output ~tokens</span></div>
                  <span className="text-green-300 font-mono">{step.output_token_est.toLocaleString()}</span>
                </div>
              </>
            )}
          </div>

          {/* Input sources */}
          {step.input_sources?.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-gray-600 uppercase tracking-widest font-semibold">Inputs</p>
              {step.input_sources.map((inp, i) => {
                const sm = SOURCE_META[inp.source];
                const Icon2 = sm?.icon ?? FileText;
                return (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <Icon2 className={cn("w-3 h-3 shrink-0", sm?.color ?? "text-gray-500")} />
                    <span className="text-gray-600 shrink-0 font-mono">{inp.key}</span>
                    <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />
                    <span className={cn("font-mono", sm?.color ?? "text-gray-400")}>{inp.source}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Error */}
          {step.status === "error" && step.error_msg && (
            <pre className="text-[10px] text-red-400 font-mono whitespace-pre-wrap break-words bg-red-950/20 rounded-lg p-3 border border-red-900/40">{step.error_msg}</pre>
          )}

          {/* Thinking */}
          {step.thinking && (
            <Collapsible label="Extended thinking" accent="text-purple-400">
              <pre className="p-3 text-[10px] text-purple-300/80 font-mono whitespace-pre-wrap break-words leading-relaxed bg-purple-950/10">{step.thinking}</pre>
            </Collapsible>
          )}

          {/* Raw response */}
          {step.content && (
            <>
              {step.status === "cached" && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-400/80 bg-amber-950/20 rounded-lg px-3 py-2 border border-amber-900/30">
                  <span>◎</span> Using cached result
                </div>
              )}
              <Collapsible label="Raw response" accent="text-gray-400">
                <pre className="p-3 text-[10px] text-gray-400 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-96 overflow-y-auto">{step.content}</pre>
              </Collapsible>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Output node ──────────────────────────────────────────────────────────────
  if (prefix === "out") {
    const procId  = outputProcId.get(nodeId);
    const stepIdx = procId != null ? procStepIdx.get(procId) : undefined;
    const step    = stepIdx != null ? parsedSteps[stepIdx] : undefined;
    const subType = node.data.subType ?? "";
    const art     = ARTIFACT_META[subType] ?? DEFAULT_ARTIFACT;
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2 shrink-0">
          <FileText className={cn("w-4 h-4 shrink-0", art.color)} />
          <span className={cn("text-sm font-semibold flex-1 truncate", art.color)}>{node.data.label}</span>
          {subType && <span className={cn("text-[10px] px-1.5 py-0.5 rounded border shrink-0", art.color, art.bg, art.border)}>{subType}</span>}
          <button onClick={onDismiss} className="text-gray-600 hover:text-gray-400 ml-1"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {step?.content
            ? <SectionContent content={step.content} />
            : <p className="text-sm text-gray-600 text-center mt-8">No output</p>
          }
        </div>
      </div>
    );
  }

  return null;
}

// ── Run Detail view ───────────────────────────────────────────────────────────

function RunDetail({ run, onBack }: { run: PipelineRunRecord; onBack: () => void }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const parsedSteps: RunStep[] = useMemo(() => {
    try { return JSON.parse(run.steps_json || "[]"); } catch { return []; }
  }, [run.steps_json]);

  const parsedLogs: { ts: string; text: string; level: string }[] = useMemo(() => {
    try { return JSON.parse(run.log_json || "[]"); } catch { return []; }
  }, [run.log_json]);

  const parsedCanvas = useMemo(() => {
    try { return run.canvas_json ? JSON.parse(run.canvas_json) : null; } catch { return null; }
  }, [run.canvas_json]);

  const maps = useMemo(() => parsedCanvas?.nodes?.length ? buildCanvasMaps(parsedCanvas) : null, [parsedCanvas]);

  const flowSteps: StepState[] = parsedSteps.map(s => ({
    agentName: s.agent_name,
    status: s.status as StepStatus,
    content: s.content,
    stream: "",
    expanded: false,
  }));

  const doneCount  = parsedSteps.filter(s => s.status === "done" || s.status === "cached").length;
  const errorCount = parsedSteps.filter(s => s.status === "error").length;

  return (
    <div className="flex flex-col h-full">
      {/* Run header */}
      <div className="px-4 py-3 border-b border-gray-800 shrink-0 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-600 hover:text-gray-300 transition-colors p-1 rounded hover:bg-gray-800">
          ← <span className="text-xs ml-1">Back</span>
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-teal-400 bg-teal-950/30 px-2 py-0.5 rounded border border-teal-800/40">{run.id.slice(0, 8)}</span>
            <CopyBtn text={run.id} />
            <span className="text-xs text-gray-300 font-medium">{run.pipeline_name}</span>
            {run.call_id && <span className="text-[10px] text-gray-600 font-mono">…{run.call_id.slice(-8)}</span>}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-gray-600 flex-wrap">
            <span>{run.sales_agent} · {run.customer}</span>
            <span>{relativeTime(run.started_at)}</span>
            <span>{durationStr(run.started_at, run.finished_at)}</span>
            <span className={cn("font-medium", run.status === "done" ? "text-green-400" : run.status === "error" ? "text-red-400" : "text-orange-400")}>{run.status}</span>
            <span>{doneCount}/{parsedSteps.length} steps{errorCount > 0 ? ` · ${errorCount} error${errorCount > 1 ? "s" : ""}` : ""}</span>
          </div>
        </div>
      </div>

      {/* Main content: canvas + detail */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: canvas + logs */}
        <div className={cn("flex flex-col min-h-0 overflow-hidden transition-all", selectedKey ? "w-[55%] border-r border-gray-800" : "flex-1")}>
          {maps && parsedCanvas ? (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <MiniCanvas
                  stages={parsedCanvas.stages ?? []}
                  nodes={maps.canvasNodes}
                  edges={parsedCanvas.edges}
                  procStepIdx={maps.procStepIdx}
                  outputProcId={maps.outputProcId}
                  inputProcIds={maps.inputProcIds}
                  flowSteps={flowSteps}
                  selectedKey={selectedKey}
                  onNodeClick={key => setSelectedKey(key === selectedKey ? null : key)}
                />
                {!selectedKey && (
                  <p className="text-center text-[11px] text-gray-600 pb-2">Click any node to inspect</p>
                )}
              </div>
              {parsedLogs.length > 0 && (
                <div className="shrink-0 border-t border-gray-800 bg-black/50 max-h-40 overflow-y-auto">
                  <p className="px-3 py-1 text-[9px] text-gray-600 uppercase tracking-widest font-semibold border-b border-gray-800/60">Execution log</p>
                  {parsedLogs.map((l, i) => (
                    <div key={i} className={cn("px-3 py-px font-mono text-[9px] leading-relaxed whitespace-pre-wrap break-all",
                      l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-amber-400" :
                      l.level === "stage" ? "text-teal-400" : l.level === "llm" ? "text-indigo-300" : "text-gray-600")}>
                      <span className="text-gray-700 mr-1">{utcHmsToLocal(l.ts)}</span>{l.text}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-600">
              <p className="text-sm">No canvas saved for this run</p>
            </div>
          )}
        </div>

        {/* Right: node detail */}
        {selectedKey && maps && (
          <div className="w-[45%] min-h-0 overflow-hidden flex flex-col bg-gray-950">
            <NodeDetail
              selectedKey={selectedKey}
              canvasNodes={maps.canvasNodes}
              procStepIdx={maps.procStepIdx}
              outputProcId={maps.outputProcId}
              parsedSteps={parsedSteps}
              salesAgent={run.sales_agent}
              customer={run.customer}
              callId={run.call_id}
              onDismiss={() => setSelectedKey(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main History Page ─────────────────────────────────────────────────────────

export default function HistoryPage() {
  const { salesAgent, customer } = useAppCtx();
  const [selectedRun, setSelectedRun] = useState<PipelineRunRecord | null>(null);
  const [filterPipeline, setFilterPipeline] = useState("");

  const hasPair = !!(salesAgent && customer);
  const runsUrl = hasPair
    ? `/api/history/runs?sales_agent=${encodeURIComponent(salesAgent)}&customer=${encodeURIComponent(customer)}${filterPipeline ? `&pipeline_id=${filterPipeline}` : ""}`
    : null;
  const { data: runs, isLoading } = useSWR<PipelineRunRecord[]>(runsUrl, fetcher, { refreshInterval: 15000 });

  // Unique pipeline names for filter
  const pipelineOptions = useMemo(() => {
    if (!runs) return [];
    const seen = new Map<string, string>();
    for (const r of runs) { if (!seen.has(r.pipeline_id)) seen.set(r.pipeline_id, r.pipeline_name); }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [runs]);

  if (selectedRun) {
    return (
      <div className="h-full overflow-hidden">
        <RunDetail run={selectedRun} onBack={() => setSelectedRun(null)} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Page header */}
      <div className="px-6 py-4 border-b border-gray-800 shrink-0 flex items-center gap-3">
        <History className="w-5 h-5 text-teal-400" />
        <h1 className="text-lg font-semibold text-white">Run History</h1>
        {hasPair && (
          <span className="text-sm text-gray-500">{salesAgent} · {customer}</span>
        )}
        {pipelineOptions.length > 1 && (
          <select
            value={filterPipeline}
            onChange={e => setFilterPipeline(e.target.value)}
            className="ml-auto text-xs bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-2 py-1 focus:outline-none"
          >
            <option value="">All pipelines</option>
            {pipelineOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!hasPair && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600">
            <AlertCircle className="w-10 h-10 opacity-20" />
            <p className="text-sm">Select an agent and customer in the context bar</p>
          </div>
        )}

        {hasPair && isLoading && (
          <div className="flex items-center justify-center h-full gap-2 text-gray-600">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading history…</span>
          </div>
        )}

        {hasPair && !isLoading && runs?.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600">
            <History className="w-10 h-10 opacity-20" />
            <p className="text-sm">No runs yet for this context</p>
          </div>
        )}

        {runs && runs.length > 0 && (
          <div className="p-4 space-y-2 max-w-4xl">
            {runs.map(run => {
              const parsedSteps: RunStep[] = (() => { try { return JSON.parse(run.steps_json || "[]"); } catch { return []; } })();
              const doneCount  = parsedSteps.filter(s => s.status === "done" || s.status === "cached").length;
              const errorCount = parsedSteps.filter(s => s.status === "error").length;

              return (
                <button
                  key={run.id}
                  onClick={() => setSelectedRun(run)}
                  className="w-full text-left border border-gray-700/60 rounded-xl bg-gray-900 hover:bg-gray-800 hover:border-gray-600 transition-colors p-4 flex items-start gap-4"
                >
                  {/* Status icon */}
                  <div className="shrink-0 mt-0.5">
                    {run.status === "done"    && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                    {run.status === "error"   && <AlertCircle  className="w-4 h-4 text-red-400" />}
                    {run.status === "running" && <Loader2 className="w-4 h-4 text-orange-400 animate-spin" />}
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] text-teal-400 bg-teal-950/30 px-2 py-0.5 rounded border border-teal-800/40">{run.id.slice(0, 8)}</span>
                      <span className="text-sm font-semibold text-gray-200">{run.pipeline_name}</span>
                      {run.call_id && <span className="text-[10px] text-gray-600 font-mono">call …{run.call_id.slice(-8)}</span>}
                    </div>
                    <div className="flex items-center gap-4 text-[11px] text-gray-500 flex-wrap">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{relativeTime(run.started_at)}</span>
                      <span>{durationStr(run.started_at, run.finished_at)}</span>
                      <span className={errorCount > 0 ? "text-red-400" : "text-green-400"}>{doneCount}/{parsedSteps.length} steps{errorCount > 0 ? ` · ${errorCount} error` : ""}</span>
                    </div>
                    {/* Step pills */}
                    {parsedSteps.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {parsedSteps.map((s, i) => (
                          <span key={i} className={cn("text-[9px] px-1.5 py-0.5 rounded-full border font-medium",
                            s.status === "done"    ? "bg-green-950/40 text-green-400 border-green-800/40" :
                            s.status === "cached"  ? "bg-amber-950/40 text-amber-400 border-amber-800/40" :
                            s.status === "error"   ? "bg-red-950/40 text-red-400 border-red-800/40" :
                                                     "bg-gray-800/40 text-gray-600 border-gray-700/40"
                          )}>
                            {s.agent_name || `step ${i + 1}`}
                            {s.execution_time_s != null ? ` ${s.execution_time_s}s` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <ChevronRight className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
