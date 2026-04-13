"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown, ChevronUp, Play, Eye, Save, Trash2, Check,
  ArrowUpDown, ArrowUp, ArrowDown, Loader2, CheckCircle2, XCircle, Bot,
  FileText, Search, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionCard } from "@/components/personas/PersonaSections";

const API = "/api";

const ALL_MODELS = [
  "gpt-5.4", "gpt-4.1", "gpt-4.1-mini",
  "claude-opus-4-6", "claude-sonnet-4-6",
  "gemini-2.5-pro", "gemini-2.5-flash",
  "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
];

const DEFAULT_GEN_SYSTEM = `You are a senior behavioral researcher producing a comprehensive persona profile of the interaction between a sales agent and a customer across all their calls.

Produce a persona document with EXACTLY these sections in this order (each preceded by ##):

## Sales Techniques & Tactics
Cover: specific tactics, objection handling, closing techniques, persuasion methods, pressure patterns. Quote transcripts directly.

## Compliance & Risk
Cover: required disclosures given or missed, regulatory red flags, misleading statements, risk rating (Low / Medium / High) with justification.

## Communication Style & Tone
Cover: vocabulary, tone, active listening, empathy, pace, framing, rapport-building.

## Customer Handling & Approach
Cover: how the agent adapts to this specific customer, handles pushback, personalises, manages emotional state.

## Key Patterns & Summary
Cover: the 3–5 most consistent behaviours across all calls — what defines this agent-customer dynamic.

## Strengths & Weaknesses
Cover: top strengths with evidence, improvement areas, overall performance score (1–10).

## Recommended Actions
Cover: specific, actionable next steps ranked by priority.

Rules:
- Use the exact ## headings above — do not rename, add, or remove sections.
- Be specific; cite call IDs and direct quotes.
- Use bullet points within each section.
- Do not add a title or preamble before the first ## heading.`;

const DEFAULT_GEN_PROMPT = "Analyse all the calls in this transcript and produce a comprehensive persona document:";

const DEFAULT_SCORER_SYSTEM = `You are a persona scoring agent. Given a persona document, score each section and return ONLY a valid JSON object — no markdown, no explanation, no code fences.

The JSON must have this exact structure:
{
  "Section Name": {"score": 75, "reasoning": "one sentence"},
  ...
  "_overall": 72,
  "_summary": "One sentence overall summary"
}

IMPORTANT: All scores — both per-section and _overall — are integers on a 0–100 scale. Do NOT use a 0–10 scale. Score every ## section in the persona document.`;

const DEFAULT_SCORER_PROMPT = "Score this persona document:";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AgentStat {
  agent: string;
  customers: number;
  customers_with_data: number;
  total_calls: number;
  total_transcripts: number;
  net_deposits: number;
}

interface CustomerStat {
  customer: string;
  total_calls: number;
  transcripts: number;
  net_deposits: number;
}

interface Preset {
  name: string;
  model: string;
  temperature: number;
  system_prompt: string;
  user_prompt: string;
  is_default: boolean;
}

interface AnalyzerPreset {
  name: string;
  provider: string;
  gen_model: string;
  gen_temperature: number;
  gen_system_prompt: string;
  gen_user_prompt: string;
  score_model: string;
  score_temperature: number;
  score_system_prompt: string;
  score_user_prompt: string;
  is_default: boolean;
  created_at?: string;
}

interface SSEProgress { step: number; total: number; msg: string; }
interface FileIdEntry { file_id: string; content_hash: string; uploaded_at: string; }
interface SSEDone {
  persona_id: string;
  overall_score: number;
  content_md: string;
  score_json: Record<string, any>;
  content_raw: string;
  score_raw: string;
  sections?: Array<{ title: string; content: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function StatPill({ value, total, color }: { value: number; total: number; color?: string }) {
  const pct = total > 0 ? value / total : 0;
  const c = color ?? (pct === 1 ? "text-emerald-400" : pct > 0 ? "text-amber-400" : "text-gray-600");
  return (
    <span className={cn("text-xs tabular-nums", c)}>
      {value}<span className="text-gray-600">/{total}</span>
    </span>
  );
}

// ── Sortable table ─────────────────────────────────────────────────────────────

function SortableTable({ children }: { children: React.ReactNode }) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const arr = Array.isArray(children) ? children : [children];
  const thead = arr.find((c: any) => c?.type === "thead");
  const tbody = arr.find((c: any) => c?.type === "tbody");
  const headerCells: string[] = [];
  if (thead) {
    const rows = (thead as any).props.children;
    const row = Array.isArray(rows) ? rows[0] : rows;
    (Array.isArray(row?.props?.children) ? row.props.children : [row?.props?.children])
      .forEach((th: any) => headerCells.push(th?.props?.children ?? ""));
  }
  let bodyRows: any[] = [];
  if (tbody) {
    const rows = (tbody as any).props.children;
    bodyRows = Array.isArray(rows) ? rows : [rows];
  }
  const sortedRows = [...bodyRows].sort((a, b) => {
    if (sortCol === null) return 0;
    const getVal = (r: any) => {
      const cells = Array.isArray(r?.props?.children) ? r.props.children : [r?.props?.children];
      const c = cells[sortCol];
      const txt = String(c?.props?.children ?? "");
      const n = parseFloat(txt.replace(/[^0-9.\-]/g, ""));
      return isNaN(n) ? txt.toLowerCase() : n;
    };
    const av = getVal(a), bv = getVal(b);
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });
  return (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-sm border-collapse">
        {thead && (
          <thead>
            <tr className="border-b border-gray-700">
              {headerCells.map((h, i) => (
                <th key={i} onClick={() => { if (sortCol === i) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortCol(i); setSortDir("asc"); } }}
                  className="text-left px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide cursor-pointer select-none hover:text-white whitespace-nowrap">
                  <span className="flex items-center gap-1">{h}
                    {sortCol === i ? (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 opacity-40" />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {sortedRows.map((row, ri) => {
            const cells = Array.isArray(row?.props?.children) ? row.props.children : [row?.props?.children];
            return (
              <tr key={ri} className={ri % 2 === 0 ? "bg-gray-800/30" : ""}>
                {cells.map((cell: any, ci: number) => (
                  <td key={ci} className="px-3 py-1.5 text-gray-300 border-b border-gray-800/50">{cell?.props?.children}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const MD: any = {
  h1: ({ children }: any) => <h1 className="text-xl font-bold text-white mt-4 mb-2">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-lg font-semibold text-indigo-300 mt-4 mb-1.5 border-b border-gray-700 pb-1">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-base font-semibold text-gray-200 mt-3 mb-1">{children}</h3>,
  p:  ({ children }: any) => <p className="text-gray-300 mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc list-inside text-gray-300 mb-2 space-y-0.5 pl-2">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal list-inside text-gray-300 mb-2 space-y-0.5 pl-2">{children}</ol>,
  li: ({ children }: any) => <li className="text-gray-300">{children}</li>,
  strong: ({ children }: any) => <strong className="text-white font-semibold">{children}</strong>,
  em: ({ children }: any) => <em className="text-gray-200 italic">{children}</em>,
  code: ({ inline, children }: any) => inline
    ? <code className="bg-gray-800 text-indigo-300 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
    : <pre className="bg-gray-900 border border-gray-700 rounded p-3 overflow-x-auto my-2"><code className="text-green-300 text-xs font-mono">{children}</code></pre>,
  blockquote: ({ children }: any) => <blockquote className="border-l-4 border-indigo-500 pl-3 my-2 text-gray-400 italic">{children}</blockquote>,
  table: ({ children }: any) => <SortableTable>{children}</SortableTable>,
  thead: ({ children }: any) => <thead>{children}</thead>,
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr:   ({ children }: any) => <tr>{children}</tr>,
  th:   ({ children }: any) => <th>{children}</th>,
  td:   ({ children }: any) => <td>{children}</td>,
};

// ── Temperature selector (4 fixed steps: 0, 0.25, 0.5, 0.75) ─────────────────

const TEMP_OPTIONS = [0, 0.25, 0.5, 0.75] as const;

function TempSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1">
      {TEMP_OPTIONS.map(t => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={cn(
            "flex-1 py-1.5 rounded text-xs font-mono transition-colors",
            Math.abs(value - t) < 0.001
              ? "bg-indigo-600 text-white font-semibold"
              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
          )}
        >
          {t.toFixed(2)}
        </button>
      ))}
    </div>
  );
}

// ── Persona Agent panel ───────────────────────────────────────────────────────

function providerFor(model: string): string {
  if (model.startsWith("claude-")) return "Anthropic";
  if (model.startsWith("gemini"))  return "Google";
  if (model.startsWith("grok"))    return "xAI";
  return "OpenAI";
}

function PersonaAgentPanel({
  name, onNameChange, onNameEdit,
  genModel, genTemp, genSystem, genPrompt,
  scoreModel, scoreTemp, scoreSystem, scorePrompt,
  onLoad,
  children,
}: {
  name: string; onNameChange: (v: string) => void; onNameEdit: () => void;
  genModel: string; genTemp: number; genSystem: string; genPrompt: string;
  scoreModel: string; scoreTemp: number; scoreSystem: string; scorePrompt: string;
  onLoad: (p: AnalyzerPreset) => void;
  children: React.ReactNode;
}) {
  const [agents, setAgents] = useState<AnalyzerPreset[]>([]);
  const [showList, setShowList] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  // Snapshot of the config at the moment a preset was loaded, used to detect changes
  const [loadedSnapshot, setLoadedSnapshot] = useState<AnalyzerPreset | null>(null);
  // True only when the user manually typed in the name input (stops auto-rename)
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);

  const reload = useCallback(async () => {
    const r = await fetch(`${API}/full-persona-agent/presets/analyzer`);
    if (r.ok) setAgents(await r.json());
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // When any config field changes after a preset was loaded, and the user hasn't
  // manually renamed it, auto-append " (copy)" to signal a new agent is forming.
  useEffect(() => {
    if (!loadedSnapshot || nameManuallyEdited) return;
    const changed =
      genModel   !== loadedSnapshot.gen_model   ||
      genSystem  !== loadedSnapshot.gen_system_prompt ||
      genPrompt  !== loadedSnapshot.gen_user_prompt   ||
      scoreModel !== loadedSnapshot.score_model  ||
      scoreSystem !== loadedSnapshot.score_system_prompt ||
      scorePrompt !== loadedSnapshot.score_user_prompt  ||
      Math.abs(genTemp   - loadedSnapshot.gen_temperature)   > 0.001 ||
      Math.abs(scoreTemp - loadedSnapshot.score_temperature) > 0.001;
    if (changed) {
      onNameChange(`${loadedSnapshot.name} (copy)`);
      setLoadedFrom(null); // hide the "loaded from" hint — user is now diverging
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genModel, genTemp, genSystem, genPrompt, scoreModel, scoreTemp, scoreSystem, scorePrompt]);

  // Auto-suggest name based on provider when no name set
  const autoSuggest = `${providerFor(genModel)} Analyzer`;
  const isAutoSuggested = !name;

  const save = async () => {
    const saveName = (name.trim() || autoSuggest).trim();
    if (!saveName) return;
    await fetch(`${API}/full-persona-agent/presets/analyzer`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: saveName,
        gen_model: genModel, gen_temperature: genTemp,
        gen_system_prompt: genSystem, gen_user_prompt: genPrompt,
        score_model: scoreModel, score_temperature: scoreTemp,
        score_system_prompt: scoreSystem, score_user_prompt: scorePrompt,
        is_default: false,
      }),
    });
    onNameChange(saveName); onNameEdit();
    setLoadedFrom(null); setLoadedSnapshot(null); setNameManuallyEdited(false);
    reload();
  };

  const loadAgent = (p: AnalyzerPreset) => {
    onLoad(p);
    // Keep the original name — only rename to (copy) if config actually changes
    onNameChange(p.name);
    onNameEdit();
    setLoadedFrom(p.name);
    setLoadedSnapshot(p);
    setNameManuallyEdited(false);
    setShowList(false);
  };

  const genProvider   = providerFor(genModel);
  const scoreProvider = providerFor(scoreModel);
  const sameProvider  = genProvider === scoreProvider;

  return (
    <div className="border-2 border-indigo-900/50 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-gray-900 px-4 pt-4 pb-4 space-y-3">

        <div>
          <p className="text-xs font-semibold text-indigo-300 uppercase tracking-widest mb-0.5">Persona Agent</p>
          <p className="text-[11px] text-gray-500">Name this analysis configuration — groups all personas it creates</p>
        </div>

        {/* Name input */}
        <div>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={e => { onNameChange(e.target.value); onNameEdit(); setNameManuallyEdited(true); setLoadedFrom(null); }}
              placeholder={autoSuggest}
              onKeyDown={e => e.key === "Enter" && save()}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              onClick={save}
              className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors shrink-0"
            >
              <Save className="w-3.5 h-3.5" /> Save
            </button>
            <button
              onClick={() => setShowList(v => !v)}
              className="flex items-center gap-1 px-2.5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white text-xs rounded-lg transition-colors shrink-0"
              title="Browse saved agents"
            >
              {showList ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{agents.length > 0 ? `${agents.length}` : "0"}</span>
            </button>
          </div>
          <div className="mt-1 min-h-[16px]">
            {isAutoSuggested && (
              <p className="text-[11px] text-gray-600">Auto-suggested · type to override</p>
            )}
            {loadedFrom && (
              <p className="text-[11px] text-emerald-700">Loaded: <span className="text-emerald-600">{loadedFrom}</span> · change any setting to create a copy</p>
            )}
          </div>
        </div>

        {/* Saved agents list */}
        {showList && (
          <div className="border border-gray-700 rounded-lg overflow-hidden">
            {agents.length === 0 && (
              <p className="text-xs text-gray-600 px-3 py-2">No saved persona agents yet</p>
            )}
            {agents.map(p => (
              <div key={p.name} className="flex items-center gap-1.5 px-3 py-2 hover:bg-gray-800/60 border-b border-gray-800/50 last:border-0">
                <button onClick={() => loadAgent(p)} className="flex-1 text-left min-w-0 group">
                  <span className="text-xs font-medium text-gray-200 group-hover:text-white">
                    {p.is_default && <span className="text-yellow-400 mr-1">★</span>}{p.name}
                  </span>
                  <span className="text-[10px] text-gray-600 ml-2">
                    {p.provider} · {p.gen_model} / {p.score_model} · {p.gen_temperature.toFixed(2)} / {p.score_temperature.toFixed(2)}
                  </span>
                </button>
                <button
                  onClick={async () => { await fetch(`${API}/full-persona-agent/presets/analyzer/${encodeURIComponent(p.name)}/default`, { method: "PATCH" }); reload(); }}
                  className="text-gray-600 hover:text-yellow-400 shrink-0 p-1" title="Set as default"
                ><Check className="w-3 h-3" /></button>
                <button
                  onClick={async () => { await fetch(`${API}/full-persona-agent/presets/analyzer/${encodeURIComponent(p.name)}`, { method: "DELETE" }); if (loadedFrom === p.name) setLoadedFrom(null); reload(); }}
                  className="text-gray-600 hover:text-red-400 shrink-0 p-1" title="Delete"
                ><Trash2 className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        )}

        {/* Config summary */}
        <div className="flex items-center gap-2 text-[11px] text-gray-600 flex-wrap pt-0.5">
          <span className="text-indigo-400/70 font-medium">{sameProvider ? genProvider : `${genProvider} / ${scoreProvider}`}</span>
          <span>·</span>
          <span>Generator: {genModel} · {genTemp.toFixed(2)}</span>
          <span>·</span>
          <span>Scorer: {scoreModel} · {scoreTemp.toFixed(2)}</span>
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-2 bg-indigo-950/30 px-4 py-1.5 border-t border-b border-indigo-900/40">
        <div className="flex-1 h-px bg-indigo-900/40" />
        <span className="text-[10px] font-semibold text-indigo-800 uppercase tracking-widest">Includes</span>
        <div className="flex-1 h-px bg-indigo-900/40" />
      </div>

      {/* Sub-modules */}
      <div className="bg-gray-950/30 p-4">
        {children}
      </div>
    </div>
  );
}

// ── Config panel ───────────────────────────────────────────────────────────────

function ConfigPanel({ title, color, model, onModel, temperature, onTemp, systemPrompt, onSystem, userPrompt, onUser }: {
  title: string; color: string;
  model: string; onModel: (v: string) => void;
  temperature: number; onTemp: (v: number) => void;
  systemPrompt: string; onSystem: (v: string) => void;
  userPrompt: string; onUser: (v: string) => void;
}) {
  return (
    <div className={cn("bg-gray-900 border rounded-xl p-4 flex flex-col gap-3", color)}>
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Model</label>
        <select value={model} onChange={e => onModel(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500">
          {ALL_MODELS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">
          Temperature · <span className="text-indigo-400 font-mono">{temperature.toFixed(2)}</span>
          <span className="text-gray-600 ml-2 text-[10px]">{temperature === 0 ? "deterministic" : temperature <= 0.25 ? "focused" : temperature <= 0.5 ? "balanced" : "creative"}</span>
        </label>
        <TempSelector value={temperature} onChange={onTemp} />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">System Prompt</label>
        <textarea value={systemPrompt} onChange={e => onSystem(e.target.value)} rows={6}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 font-mono resize-y focus:outline-none focus:border-indigo-500" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">User Prompt</label>
        <textarea value={userPrompt} onChange={e => onUser(e.target.value)} rows={2}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 font-mono resize-y focus:outline-none focus:border-indigo-500" />
      </div>
    </div>
  );
}

// ── Score display ──────────────────────────────────────────────────────────────

function ScoreDisplay({ scoreJson }: { scoreJson: Record<string, any> }) {
  const overall = scoreJson._overall as number | undefined;
  const summary = scoreJson._summary as string | undefined;
  const rawText = scoreJson._raw_text as string | undefined;
  const sections = Object.entries(scoreJson).filter(([k]) => !k.startsWith("_"));
  const color = (s: number) => s >= 75 ? "text-emerald-400" : s >= 50 ? "text-yellow-400" : "text-red-400";

  // Scorer returned plain text instead of JSON — render as markdown
  if (rawText) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-amber-400/70 mb-2">Score output (text format)</p>
        <div className="prose prose-invert max-w-none text-sm overflow-y-auto max-h-[600px] pr-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{rawText}</ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {overall !== undefined && (
        <div className="flex items-center gap-3 mb-3">
          <span className={cn("text-3xl font-bold", color(overall))}>{Math.round(overall)}</span>
          <span className="text-gray-500 text-sm">/100 overall</span>
          {summary && <p className="text-gray-400 text-xs flex-1">{summary}</p>}
        </div>
      )}
      <div className="space-y-1.5">
        {sections.map(([name, val]) => {
          const score = typeof val === "object" ? val.score : val;
          const reasoning = typeof val === "object" ? val.reasoning : "";
          return (
            <div key={name} className="flex items-start gap-3 bg-gray-800/50 rounded px-3 py-2">
              <span className={cn("text-sm font-bold tabular-nums w-8 shrink-0", color(score))}>{typeof score === "number" ? Math.round(score) : score}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-300">{name}</p>
                {reasoning && <p className="text-xs text-gray-500 mt-0.5">{reasoning}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Customer Card ─────────────────────────────────────────────────────────────

function CustomerCard({
  stat, isSelected, onSelect, onQuickRun, quickRunning,
}: {
  stat: CustomerStat; isSelected: boolean;
  onSelect: () => void; onQuickRun: () => void; quickRunning: boolean;
}) {
  const hasTranscripts = stat.transcripts > 0;
  const allDone = stat.total_calls > 0 && stat.transcripts === stat.total_calls;

  return (
    <div
      onClick={onSelect}
      className={cn(
        "rounded-lg border p-3 cursor-pointer transition-colors",
        isSelected ? "border-indigo-500/60 bg-indigo-900/20" : "border-gray-700 bg-gray-800/30 hover:border-gray-600",
      )}
    >
      <div className="flex items-start gap-2">
        <div className={cn(
          "mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center",
          isSelected ? "border-indigo-500 bg-indigo-600" : "border-gray-600"
        )}>
          {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-white font-medium truncate flex-1 min-w-0">{stat.customer}</p>
            <div className="flex items-center gap-2 flex-shrink-0">
              {stat.total_calls > 0 && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <FileText className="w-3 h-3" />
                  <StatPill value={stat.transcripts} total={stat.total_calls} />
                </span>
              )}
              {stat.net_deposits !== 0 && (
                <span className={cn("text-xs font-medium tabular-nums", stat.net_deposits > 0 ? "text-emerald-400" : "text-red-400")}>
                  {fmt(stat.net_deposits)}
                </span>
              )}
            </div>
          </div>
          {!hasTranscripts && stat.total_calls > 0 && (
            <button
              onClick={e => { e.stopPropagation(); onQuickRun(); }}
              disabled={quickRunning}
              className="mt-1.5 flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-amber-800/40 border border-amber-600/40 text-amber-300 hover:bg-amber-800/60 disabled:opacity-50 transition-colors"
            >
              {quickRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {quickRunning ? "Running…" : "Quick Run"}
            </button>
          )}
          {allDone && (
            <p className="mt-0.5 text-xs text-emerald-500/60 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> All transcripts ready
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Module-level analysis store ────────────────────────────────────────────────
// The runAnalysis fetch-stream loop continues running after the component unmounts
// (JS closures aren't tied to React lifecycle). We keep the live state here so that
// when the user navigates back, the freshly mounted component can restore it and
// continue receiving updates.

interface _AStore {
  running: boolean;
  progress: SSEProgress[];
  result: SSEDone | null;
  error: string | null;
}
const _astore: _AStore = { running: false, progress: [], result: null, error: null };
// Registered setters from the currently-mounted component (null when unmounted)
let _setRunning_:   ((v: boolean) => void)             | null = null;
let _setProgress_:  ((v: SSEProgress[]) => void)       | null = null;
let _setResult_:    ((v: SSEDone | null) => void)      | null = null;
let _setError_:     ((v: string | null) => void)       | null = null;
let _setGenView_:   ((v: "rendered"|"raw"|"sections") => void) | null = null;

function _astorePush(partial: Partial<_AStore>) {
  Object.assign(_astore, partial);
  if (partial.running !== undefined) _setRunning_?.(partial.running);
  if (partial.progress !== undefined) _setProgress_?.(partial.progress);
  if (partial.result   !== undefined) _setResult_?.(partial.result);
  if (partial.error    !== undefined) _setError_?.(partial.error);
}

// sessionStorage helpers (FPA prefix)
function _fpaSS(key: string): string { try { return sessionStorage.getItem(`fpa_${key}`) ?? ""; } catch { return ""; } }
function _fpaSSSet(key: string, v: string) { try { sessionStorage.setItem(`fpa_${key}`, v); } catch {} }
function _fpaSSClear(key: string) { try { sessionStorage.removeItem(`fpa_${key}`); } catch {} }

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function FullPersonaAgentPage() {
  const router = useRouter();

  // Data
  const [agents, setAgents] = useState<string[]>([]);
  const [agentStats, setAgentStats] = useState<AgentStat[]>([]);
  const [customerStats, setCustomerStats] = useState<CustomerStat[]>([]);

  // Selection — start from "" to match SSR; restored from sessionStorage post-mount
  const [agent, _setAgent] = useState("");
  const [customer, _setCustomer] = useState("");
  const setAgent = (v: string) => { _setAgent(v); _fpaSSSet("agent", v); };
  const setCustomer = (v: string) => { _setCustomer(v); _fpaSSSet("customer", v); };
  // Ref so the customer-stats effect can re-apply the saved customer after stats load
  const _restoreCustomerRef = useRef("");

  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [search, setSearch] = useState("");

  // Quick run (quickRunId persisted for resume-on-return)
  const [quickRunId, setQuickRunId] = useState<string | null>(null);
  const [quickRunDone, setQuickRunDone] = useState(false);
  const [quickRunning, setQuickRunning] = useState(false);
  const quickPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Generator config
  const [genModel, setGenModel] = useState("gpt-5.4");
  const [genTemp, setGenTemp] = useState(0.0);
  const [genSystem, setGenSystem] = useState(DEFAULT_GEN_SYSTEM);
  const [genPrompt, setGenPrompt] = useState(DEFAULT_GEN_PROMPT);

  // Persona agent name (single name for the whole preset)
  const [presetName, setPresetName] = useState("");
  const [presetNameEdited, setPresetNameEdited] = useState(false);

  // Scorer config
  const [scoreModel, setScoreModel] = useState("gpt-5.4");
  const [scoreTemp, setScoreTemp] = useState(0.0);
  const [scoreSystem, setScoreSystem] = useState(DEFAULT_SCORER_SYSTEM);
  const [scorePrompt, setScorePrompt] = useState(DEFAULT_SCORER_PROMPT);

  // File upload toggle (default on — toggle disables to text-paste)
  const [useFileUpload, setUseFileUpload] = useState(true);

  // Cached file IDs for the selected pair (provider → {file_id, content_hash, uploaded_at})
  const [fileIds, setFileIds] = useState<Record<string, FileIdEntry>>({});

  // Run state — start from safe defaults to match SSR, then sync from _astore on mount
  // (using _astore as a lazy initializer causes SSR/client hydration mismatch)
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SSEProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SSEDone | null>(null);

  // View mode toggles
  const [genView, setGenView] = useState<"rendered" | "raw" | "sections">("rendered");
  const [showScoreRaw, setShowScoreRaw] = useState(false);

  // Transcript modal
  const [showTx, setShowTx] = useState(false);
  const [txContent, setTxContent] = useState("");
  const [loadingTx, setLoadingTx] = useState(false);

  // Register this component's setters so the background loop can push updates to it.
  // Also sync from _astore here (post-hydration) to restore state from a previous run.
  useEffect(() => {
    _setRunning_  = setRunning;
    _setProgress_ = setProgress;
    _setResult_   = setResult;
    _setError_    = setError;
    _setGenView_  = setGenView;
    // Restore live state from module store (survives navigation away + back)
    if (_astore.running || _astore.progress.length || _astore.result || _astore.error) {
      setRunning(_astore.running);
      setProgress(_astore.progress);
      setResult(_astore.result);
      setError(_astore.error);
      if (_astore.result?.sections?.length) setGenView("sections");
    }
    return () => {
      _setRunning_ = null; _setProgress_ = null;
      _setResult_  = null; _setError_    = null; _setGenView_ = null;
    };
  }, []); // setters are stable refs

  // Resume quickRun polling if we navigated away mid-run
  useEffect(() => {
    const savedId = _fpaSS("quickRunId");
    const savedAgent = _fpaSS("agent");
    if (!savedId) return;
    setQuickRunId(savedId);
    fetch(`${API}/full-persona-agent/quick-run/status?run_id=${savedId}`)
      .then(r => r.json())
      .then(s => {
        if (s.complete) {
          _fpaSSClear("quickRunId");
          setQuickRunDone(true);
        } else {
          setQuickRunning(true);
          quickPollRef.current = setInterval(async () => {
            const st = await fetch(`${API}/full-persona-agent/quick-run/status?run_id=${savedId}`).then(r => r.json());
            if (st.complete) {
              clearInterval(quickPollRef.current!);
              setQuickRunning(false); setQuickRunDone(true);
              _fpaSSClear("quickRunId");
              if (savedAgent) {
                fetch(`${API}/full-persona-agent/customer-stats?agent=${encodeURIComponent(savedAgent)}`)
                  .then(r => r.json()).then(setCustomerStats);
              }
            }
          }, 3000);
        }
      })
      .catch(() => _fpaSSClear("quickRunId"));
  }, []); // run once on mount

  // Load agents + stats; auto-apply default analyzer preset on mount
  useEffect(() => {
    fetch(`${API}/full-persona-agent/agents`).then(r => r.json()).then(setAgents);
    fetch(`${API}/full-persona-agent/agent-stats`).then(r => r.json()).then(setAgentStats);
    fetch(`${API}/full-persona-agent/presets/analyzer`).then(r => r.json()).then((presets: AnalyzerPreset[]) => {
      const def = presets.find(p => p.is_default) ?? presets[0];
      if (def) {
        setGenModel(def.gen_model);
        setGenTemp(def.gen_temperature);
        setGenSystem(def.gen_system_prompt);
        setGenPrompt(def.gen_user_prompt);
        setScoreModel(def.score_model);
        setScoreTemp(def.score_temperature);
        setScoreSystem(def.score_system_prompt);
        setScorePrompt(def.score_user_prompt);
        setPresetName(def.name);
      }
    }).catch(() => {});
  }, []);

  // Restore agent (and pending customer) from sessionStorage after mount
  useEffect(() => {
    const savedAgent = _fpaSS("agent");
    if (savedAgent) {
      _restoreCustomerRef.current = _fpaSS("customer");
      _setAgent(savedAgent);
    }
  }, []); // run once on mount

  // Load customer stats when agent changes
  useEffect(() => {
    if (!agent) { setCustomerStats([]); _setCustomer(""); return; }
    const pendingCustomer = _restoreCustomerRef.current;
    _restoreCustomerRef.current = "";
    fetch(`${API}/full-persona-agent/customer-stats?agent=${encodeURIComponent(agent)}`)
      .then(r => r.json())
      .then(d => {
        setCustomerStats(d);
        // Re-apply saved customer (restoration path) or clear on manual agent change
        if (pendingCustomer) _setCustomer(pendingCustomer);
        else _setCustomer("");
      });
  }, [agent]);

  // Load cached file IDs when pair is fully selected
  useEffect(() => {
    if (!agent || !customer) { setFileIds({}); return; }
    fetch(`${API}/full-persona-agent/file-ids?agent=${encodeURIComponent(agent)}&customer=${encodeURIComponent(customer)}`)
      .then(r => r.json())
      .then(d => setFileIds(d && typeof d === "object" && !d.detail ? d : {}))
      .catch(() => setFileIds({}));
  }, [agent, customer]);

  const agentStat = agentStats.find(s => s.agent === agent);
  const customerStat = customerStats.find(s => s.customer === customer);

  // Sort customers: most transcripts first
  const sortedCustomers = [...customerStats]
    .sort((a, b) => b.transcripts - a.transcripts)
    .filter(s => !search || s.customer.toLowerCase().includes(search.toLowerCase()));

  // Quick run
  const startQuickRun = async (cust: string) => {
    setQuickRunning(true); setQuickRunDone(false);
    try {
      const r = await fetch(`${API}/full-persona-agent/quick-run`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, customer: cust, smooth_model: "gpt-5.4", force: false }),
      });
      const d = await r.json();
      setQuickRunId(d.run_id);
      _fpaSSSet("quickRunId", d.run_id); // persist so we can resume if user navigates away
      quickPollRef.current = setInterval(async () => {
        const s = await fetch(`${API}/full-persona-agent/quick-run/status?run_id=${d.run_id}`).then(r => r.json());
        if (s.complete) {
          clearInterval(quickPollRef.current!);
          setQuickRunning(false); setQuickRunDone(true);
          _fpaSSClear("quickRunId");
          fetch(`${API}/full-persona-agent/customer-stats?agent=${encodeURIComponent(agent)}`)
            .then(r => r.json()).then(setCustomerStats);
        }
      }, 3000);
    } catch { setQuickRunning(false); }
  };

  useEffect(() => () => { if (quickPollRef.current) clearInterval(quickPollRef.current); }, []);

  // Reset label auto-suggest when selection changes
  useEffect(() => { setLabelEdited(false); }, [agent, customer]);

  // Auto-suggest persona name: presetName · agent · customer  (or agent · customer · model · date if no preset)
  useEffect(() => {
    if (labelEdited) return;
    if (!agent || !customer) { setLabel(""); return; }
    if (presetName) {
      setLabel(`${presetName} · ${agent} · ${customer}`);
      return;
    }
    const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const modelShort = genModel.startsWith("gpt-5.4") ? "GPT-5.4"
      : genModel.startsWith("gpt-4.1-mini") ? "GPT-4.1 Mini"
      : genModel.startsWith("gpt-4.1") ? "GPT-4.1"
      : genModel.startsWith("claude-opus") ? "Claude Opus"
      : genModel.startsWith("claude-sonnet") ? "Claude Sonnet"
      : genModel.startsWith("gemini-2.5-pro") ? "Gemini 2.5 Pro"
      : genModel.startsWith("gemini-2.5-flash") ? "Gemini 2.5 Flash"
      : genModel.startsWith("grok") ? "Grok"
      : genModel;
    setLabel(`${agent} · ${customer} · ${modelShort} · ${date}`);
  }, [agent, customer, genModel, presetName, labelEdited]);

  const loadTranscript = async () => {
    setLoadingTx(true); setShowTx(true);
    try {
      const r = await fetch(`${API}/full-persona-agent/transcript?agent=${encodeURIComponent(agent)}&customer=${encodeURIComponent(customer)}`);
      setTxContent(await r.text());
    } finally { setLoadingTx(false); }
  };

  // Helper: update both the module-level store AND React state (via closure setters).
  // Closure setters are used so this component always gets updates while mounted.
  // Module setters (_setX_) are used so a remounted component also gets updates.
  const _upd = (updates: Partial<_AStore>) => {
    Object.assign(_astore, updates);
    if ("running"  in updates) { setRunning(updates.running!);   _setRunning_?.(updates.running!);  }
    if ("progress" in updates) { setProgress(updates.progress!); _setProgress_?.(updates.progress!); }
    if ("result"   in updates) { setResult(updates.result!);     _setResult_?.(updates.result!);    }
    if ("error"    in updates) { setError(updates.error!);       _setError_?.(updates.error!);      }
  };

  const runAnalysis = async () => {
    if (!agent || !customer) return;
    _upd({ running: true, progress: [], error: null, result: null });
    const body = {
      agent, customer, label,
      generator_model: genModel, generator_temperature: genTemp,
      generator_system: genSystem, generator_prompt: genPrompt,
      generator_preset_name: presetName,
      scorer_model: scoreModel, scorer_temperature: scoreTemp,
      scorer_system: scoreSystem, scorer_prompt: scorePrompt,
      use_file_upload: useFileUpload,
    };
    try {
      const r = await fetch(`${API}/full-persona-agent/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok || !r.body) throw new Error(await r.text());
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const eventLine = chunk.split("\n").find(l => l.startsWith("event:"));
          const dataLine = chunk.split("\n").find(l => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.replace("event:", "").trim();
          const data = JSON.parse(dataLine.replace("data:", "").trim());
          if (event === "progress") {
            _upd({ progress: [..._astore.progress, data] });
          } else if (event === "error") {
            _upd({ error: data.msg, running: false });
            return;
          } else if (event === "done") {
            _upd({ result: data, running: false });
            const view = data.sections?.length ? "sections" : "rendered";
            setGenView(view); _setGenView_?.(view);
            return;
          }
        }
      }
    } catch (e: any) { _upd({ error: (e as Error).message || "Unknown error" }); }
    finally { _upd({ running: false }); }
  };

  const canRun = !!(agent && customer && customerStat && customerStat.transcripts > 0 && !running);

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <Bot className="w-6 h-6 text-indigo-400" />
          <div>
            <h1 className="text-xl font-bold">Full Persona Agent</h1>
            <p className="text-xs text-gray-500">Generate + score a persona from merged transcripts in one flow</p>
          </div>
        </div>

        {/* Selection row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Agent column */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-500 tracking-widest mb-2">AGENT</p>
            <select
              value={agent}
              onChange={e => setAgent(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white mb-1 focus:outline-none focus:border-indigo-500"
            >
              <option value="">— select agent —</option>
              {(agentStats.length ? agentStats.map(s => s.agent) : agents).map(a => {
                const s = agentStats.find(x => x.agent === a);
                const nd = s?.net_deposits ? `  ·  $${s.net_deposits.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "";
                const label = s
                  ? `${a}  (${s.customers_with_data}/${s.customers} ready · ${s.total_transcripts} transcripts${nd})`
                  : a;
                return <option key={a} value={a}>{label}</option>;
              })}
            </select>
            {agentStat && (
              <div className="flex items-center gap-3 px-1 mt-1 text-xs text-gray-500">
                <span>{agentStat.customers} customers</span>
                <span className="flex items-center gap-1"><FileText className="w-3 h-3" />
                  <StatPill value={agentStat.total_transcripts} total={agentStat.total_calls} /></span>
                <span>{agentStat.customers_with_data} with data</span>
              </div>
            )}
          </div>

          {/* Customer column */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col">
            <p className="text-xs font-semibold text-gray-500 tracking-widest mb-2">CUSTOMER</p>
            {agent ? (
              <>
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={`Search ${customerStats.length} customers…`}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-gray-600"
                  />
                </div>
                <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                  {sortedCustomers.map(stat => (
                    <CustomerCard
                      key={stat.customer}
                      stat={stat}
                      isSelected={customer === stat.customer}
                      onSelect={() => setCustomer(stat.customer)}
                      onQuickRun={() => startQuickRun(stat.customer)}
                      quickRunning={quickRunning && customer === stat.customer}
                    />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-600">Select an agent first</p>
            )}
          </div>
        </div>

        {/* Selected pair info row */}
        {agent && customer && customerStat && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{agent} <span className="text-gray-500">↔</span> {customer}</p>
              <div className="flex items-center gap-3 mt-1 text-xs">
                {customerStat.transcripts > 0 ? (
                  <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{customerStat.transcripts}/{customerStat.total_calls} transcripts</span>
                ) : (
                  <span className="text-red-400 flex items-center gap-1"><XCircle className="w-3 h-3" />No transcripts</span>
                )}
                {customerStat.net_deposits !== 0 && (
                  <span className={cn("font-medium", customerStat.net_deposits > 0 ? "text-emerald-400" : "text-red-400")}>
                    Net: {fmt(customerStat.net_deposits)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {customerStat.transcripts > 0 && (
                <button onClick={loadTranscript}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs rounded-lg transition-colors">
                  <Eye className="w-3.5 h-3.5" /> View Transcript
                </button>
              )}
              {customerStat.transcripts === 0 && (
                <button onClick={() => startQuickRun(customer)} disabled={quickRunning}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs rounded-lg transition-colors">
                  {quickRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Quick Run
                </button>
              )}
            </div>
          </div>
        )}

        {/* Quick run status */}
        {quickRunDone && (
          <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-800 rounded-xl px-4 py-2">
            <CheckCircle2 className="w-3.5 h-3.5" /> Quick Run complete — transcripts updated
          </div>
        )}

        {/* Persona Name */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Persona Name
          </label>
          <input
            type="text"
            value={label}
            onChange={e => { setLabel(e.target.value); setLabelEdited(true); }}
            placeholder="Auto-generated from agent · customer · model · date"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          {!labelEdited && label && (
            <p className="text-[11px] text-gray-600 mt-1">Auto-suggested · type to override</p>
          )}
        </div>

        {/* Persona Agent — wraps both config modules */}
        <PersonaAgentPanel
          name={presetName} onNameChange={setPresetName} onNameEdit={() => setPresetNameEdited(true)}
          genModel={genModel} genTemp={genTemp} genSystem={genSystem} genPrompt={genPrompt}
          scoreModel={scoreModel} scoreTemp={scoreTemp} scoreSystem={scoreSystem} scorePrompt={scorePrompt}
          onLoad={p => {
            setGenModel(p.gen_model); setGenTemp(p.gen_temperature);
            setGenSystem(p.gen_system_prompt); setGenPrompt(p.gen_user_prompt);
            setScoreModel(p.score_model); setScoreTemp(p.score_temperature);
            setScoreSystem(p.score_system_prompt); setScorePrompt(p.score_user_prompt);
          }}
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ConfigPanel title="Persona Generator" color="border-indigo-900/50"
              model={genModel} onModel={setGenModel} temperature={genTemp} onTemp={setGenTemp}
              systemPrompt={genSystem} onSystem={setGenSystem} userPrompt={genPrompt} onUser={setGenPrompt} />
            <ConfigPanel title="Persona Scorer" color="border-purple-900/50"
              model={scoreModel} onModel={setScoreModel} temperature={scoreTemp} onTemp={setScoreTemp}
              systemPrompt={scoreSystem} onSystem={setScoreSystem} userPrompt={scorePrompt} onUser={setScorePrompt} />
          </div>
        </PersonaAgentPanel>

        {/* Cached file IDs */}
        {Object.keys(fileIds).length > 0 && (
          <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-3">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Cached file uploads</p>
            <div className="space-y-1">
              {Object.entries(fileIds).map(([provider, entry]) => (
                <div key={provider} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400 w-16 shrink-0 capitalize">{provider}</span>
                  <code className="text-indigo-300 font-mono truncate flex-1">{entry.file_id}</code>
                  <span className="text-gray-600 shrink-0">{entry.uploaded_at ? new Date(entry.uploaded_at).toLocaleDateString() : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Analyze button + file upload toggle */}
        <div className="flex flex-col items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div
              onClick={() => setUseFileUpload(v => !v)}
              className={`relative w-9 h-5 rounded-full transition-colors ${useFileUpload ? "bg-indigo-600" : "bg-gray-700"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${useFileUpload ? "translate-x-4" : "translate-x-0"}`} />
            </div>
            <span className="text-xs text-gray-400">{useFileUpload ? "Transcript uploaded as file" : <span className="text-amber-400">Pasting transcript in prompt</span>}</span>
          </label>
          <button onClick={runAnalysis} disabled={!canRun}
            className="flex items-center gap-2 px-8 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-colors text-sm shadow-lg">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? "Analysing…" : "Analyse"}
          </button>
        </div>

        {/* Progress */}
        {(running || progress.length > 0) && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Progress</h3>
            {progress.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="text-gray-600 text-xs tabular-nums w-12 shrink-0">{p.step}/{p.total}</span>
                <div className="flex-1 bg-gray-800 rounded-full h-1.5">
                  <div className="bg-indigo-500 h-1.5 rounded-full transition-all" style={{ width: `${(p.step / p.total) * 100}%` }} />
                </div>
                <span className="text-gray-400 text-xs flex-shrink-0">{p.msg}</span>
              </div>
            ))}
            {running && <div className="flex items-center gap-2 text-xs text-gray-600"><Loader2 className="w-3 h-3 animate-spin" /> Working…</div>}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-950/40 border border-red-800 rounded-xl p-4">
            <p className="text-red-400 text-sm font-medium">Error</p>
            <p className="text-red-300 text-sm mt-1">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            <div className="bg-emerald-950/40 border border-emerald-800 rounded-xl p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <div>
                  <p className="text-emerald-300 font-medium text-sm">Persona generated and saved</p>
                  <p className="text-emerald-600 text-xs">Overall score: {Math.round(result.overall_score)}/100</p>
                </div>
              </div>
              <button onClick={() => router.push(`/personas/${result.persona_id}`)}
                className="px-4 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs rounded-lg transition-colors">
                View Persona →
              </button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-indigo-300">
                    Persona Document
                    {result.sections && result.sections.length > 0 && (
                      <span className="ml-2 text-[10px] text-indigo-500 font-normal">{result.sections.length} sections</span>
                    )}
                  </h3>
                  <div className="flex items-center gap-1">
                    {result.sections && result.sections.length > 0 && (
                      <button onClick={() => setGenView("sections")}
                        className={cn("text-xs px-2 py-0.5 rounded border transition-colors",
                          genView === "sections"
                            ? "border-indigo-500 text-indigo-300 bg-indigo-900/30"
                            : "border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500")}>
                        Sections
                      </button>
                    )}
                    <button onClick={() => setGenView(v => v === "rendered" ? "raw" : "rendered")}
                      className={cn("text-xs px-2 py-0.5 rounded border transition-colors",
                        genView === "raw"
                          ? "border-gray-500 text-gray-300"
                          : "border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500")}>
                      {genView === "raw" ? "Show Rendered" : "Show Raw"}
                    </button>
                  </div>
                </div>
                {genView === "raw" ? (
                  <pre className="text-xs text-gray-300 whitespace-pre-wrap overflow-y-auto max-h-[600px] font-mono bg-gray-950 rounded p-3">{result.content_raw || "(empty)"}</pre>
                ) : genView === "sections" && result.sections && result.sections.length > 0 ? (
                  <div className="space-y-3 overflow-y-auto max-h-[600px] pr-1">
                    {result.sections.map((s, i) => {
                      const scoreEntry = Object.entries(result.score_json).find(
                        ([k]) => !k.startsWith("_") && k.toLowerCase() === s.title.toLowerCase()
                      );
                      const scoreVal = scoreEntry?.[1];
                      const score = typeof scoreVal === "object" ? scoreVal?.score : (typeof scoreVal === "number" ? scoreVal : undefined);
                      return <SectionCard key={i} section={s} fullWidth score={typeof score === "number" ? score : undefined} />;
                    })}
                  </div>
                ) : (
                  <div className="prose prose-invert max-w-none text-sm overflow-y-auto max-h-[600px] pr-1">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{result.content_md}</ReactMarkdown>
                  </div>
                )}
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-purple-300">Section Scores</h3>
                  <button onClick={() => setShowScoreRaw(v => !v)}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-0.5 rounded border border-gray-700 hover:border-gray-500">
                    {showScoreRaw ? "Show Rendered" : "Show Raw"}
                  </button>
                </div>
                {showScoreRaw ? (
                  <pre className="text-xs text-gray-300 whitespace-pre-wrap overflow-y-auto max-h-[600px] font-mono bg-gray-950 rounded p-3">{result.score_raw || "(empty)"}</pre>
                ) : (
                  <ScoreDisplay scoreJson={result.score_json} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Transcript modal */}
      {showTx && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-white">Merged Transcript — {agent} / {customer}</h3>
              <button onClick={() => setShowTx(false)} className="text-gray-500 hover:text-white transition-colors text-sm">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loadingTx
                ? <div className="flex items-center gap-2 text-gray-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
                : <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">{txContent}</pre>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
