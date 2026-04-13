"use client";
import { useState, useMemo, useEffect } from "react";
import useSWR from "swr";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { BarChart3, X, Search, Plus, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Persona } from "@/lib/types";
import {
  SectionCard, SectionNav, parsePersonaSections, MD,
} from "@/components/personas/PersonaSections";

// ── Constants ──────────────────────────────────────────────────────────────────

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316"];

const SECTION_SHORT_MAP: Record<string, string> = {
  "Sales Techniques & Tactics":        "Sales",
  "Sales Techniques & Approach":       "Sales",
  "Compliance & Risk":                 "Compliance",
  "Compliance & Risk Flags":           "Compliance",
  "Communication Style & Tone":        "Communication",
  "Communication Style & Rapport":     "Communication",
  "Customer Handling & Approach":      "Handling",
  "Customer Relationship Dynamics":    "Handling",
  "Key Patterns & Summary":            "Patterns",
  "Key Patterns & Tendencies":         "Patterns",
  "Strengths & Weaknesses":            "Strengths",
  "Strengths & Weaknesses Assessment": "Strengths",
  "Recommended Actions":               "Coaching",
  "Recommended Coaching Actions":      "Coaching",
  "Financial Overview & Goals":        "Financial",
  "Objections & Resistance Patterns":  "Objections",
  "Relationship Dynamics & Approach":  "Relationship",
  "Risk Assessment & Vulnerabilities": "Risk",
};

function sectionShortLabel(title: string): string {
  if (SECTION_SHORT_MAP[title]) return SECTION_SHORT_MAP[title];
  return title
    .replace(/^[\d]+\.\s+/, "")
    .replace(/^[A-Z]+\.\s+/, "")
    .replace(/\s*[&–]\s*.+$/, "")
    .split(/\s+/).slice(0, 2).join(" ");
}

function scoreColor(s: number) {
  if (s >= 75) return "text-emerald-400";
  if (s >= 50) return "text-amber-400";
  return "text-red-400";
}

const TYPE_COLOR: Record<string, string> = {
  agent_overall: "text-violet-400 border-violet-500/30 bg-violet-500/10",
  pair:          "text-indigo-400 border-indigo-500/30 bg-indigo-500/10",
  customer:      "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
};
function typeLabel(t: string) {
  return t === "agent_overall" ? "Agent" : t === "pair" ? "Pair" : "Customer";
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface PersonaAgent {
  id: string;
  name: string;
  persona_type?: string;
  is_default?: boolean;
  sections?: unknown[];
}

interface PersonaScores {
  _overall: number;
  _summary: string;
  [section: string]: number | string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then(r => r.json());

function slotChartKey(p: Persona, idx: number): string {
  // Use customer name as the differentiator (all compared personas share the same agent/preset).
  // Fall back to agent name if customer is absent.
  const base = (p.customer || p.agent).slice(0, 20);
  return `${base} (${idx + 1})`;
}

function fmtDate(s: string) {
  try { return new Date(s).toLocaleDateString(); } catch { return s; }
}

// ── Score table ────────────────────────────────────────────────────────────────

function ScoreTable({
  sections, personas, scoreMap, chartKeys,
}: {
  sections: [string, string][];
  personas: Persona[];
  scoreMap: Record<string, PersonaScores>;
  chartKeys: string[];
}) {
  const hasAnyScores = personas.some(p => scoreMap[p.id]);
  if (!sections.length || !hasAnyScores) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Section</th>
            {personas.map((p, i) => (
              <th key={p.id} className="px-4 py-2.5 text-center text-xs font-semibold" style={{ color: COLORS[i % 7] }}>
                {chartKeys[i]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map(([full]) => (
            <tr key={full} className="border-b border-gray-800/50 hover:bg-gray-800/30">
              <td className="px-4 py-2 text-xs text-gray-400">{full}</td>
              {personas.map((p, i) => {
                const sc = scoreMap[p.id];
                const val = sc ? (sc[full] as number | null | undefined) : undefined;
                return (
                  <td key={p.id} className={cn("px-4 py-2 text-center text-sm font-mono tabular-nums", val != null ? scoreColor(val) : "text-gray-700")}>
                    {val != null ? Math.round(val) : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-t border-gray-700 bg-gray-800/30">
            <td className="px-4 py-2.5 text-xs font-semibold text-gray-300">Overall</td>
            {personas.map((p, i) => {
              const sc = scoreMap[p.id];
              return (
                <td key={p.id} className={cn("px-4 py-2.5 text-center text-sm font-bold tabular-nums", sc ? scoreColor(sc._overall) : "text-gray-700")}>
                  {sc ? Math.round(sc._overall) : "—"}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Persona column ─────────────────────────────────────────────────────────────

function PersonaColumn({ persona, color, chartKey, scores }: {
  persona: Persona;
  color: string;
  chartKey: string;
  scores?: PersonaScores;
}) {
  const sections = parsePersonaSections(persona.content_md);
  const sectionScores: Record<string, number> = {};
  if (scores) {
    for (const [k, v] of Object.entries(scores)) {
      if (!k.startsWith("_") && typeof v === "number") sectionScores[k] = v;
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col min-h-0">
      {/* Header */}
      <div className="p-4 border-b border-gray-800 shrink-0" style={{ borderLeftColor: color, borderLeftWidth: 3 }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-white text-sm truncate">{persona.agent}</p>
            {persona.label && <p className="text-xs text-gray-400 truncate mt-0.5">{persona.label}</p>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", TYPE_COLOR[persona.type] ?? "text-gray-400 border-gray-700")}>
              {typeLabel(persona.type)}
            </span>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
          <span className="font-mono truncate">{persona.model}</span>
          {persona.customer && <span>{persona.customer}</span>}
          {persona.version > 1 && <span className="text-indigo-400">v{persona.version}</span>}
          <span>{fmtDate(persona.created_at)}</span>
        </div>
        <p className="text-[10px] font-mono mt-1" style={{ color }}>{chartKey}</p>
        {scores && (
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <span className={cn("text-sm font-bold tabular-nums", scoreColor(scores._overall))}>
                {Math.round(scores._overall)}/100
              </span>
              <div className="flex-1 bg-gray-800 rounded-full h-1">
                <div className="h-1 rounded-full" style={{ width: `${scores._overall}%`, backgroundColor: color }} />
              </div>
            </div>
            {scores._summary && (
              <p className="text-[11px] text-gray-500 italic mt-1 line-clamp-2">{scores._summary}</p>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="overflow-y-auto flex-1 p-4">
        {sections.length > 0 ? (
          <div className="space-y-3">
            <SectionNav sections={sections} />
            {sections.map(s => (
              <SectionCard key={s.title} section={s} score={sectionScores[s.title]} />
            ))}
          </div>
        ) : (
          <div className="prose prose-invert max-w-none text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
              {persona.content_md}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ComparisonPage() {
  const { data: personas } = useSWR<Persona[]>("/api/personas", fetcher);
  const { data: personaAgentsRaw } = useSWR<PersonaAgent[]>("/api/persona-agents", fetcher);
  const personaAgents = Array.isArray(personaAgentsRaw) ? personaAgentsRaw : [];

  const [slots, setSlots] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [filterPersonaAgent, setFilterPersonaAgent] = useState<string | null>(null);

  const removeSlot = (idx: number) => setSlots(s => s.filter((_, i) => i !== idx));

  // Once the first persona is added, lock to its persona_agent_id.
  // This prevents comparing personas from different scoring rubrics.
  const lockedPreset = useMemo(() => {
    if (!slots.length) return null;
    const first = (personas ?? []).find(p => p.id === slots[0]);
    return first?.persona_agent_id || "__untagged__";
  }, [slots, personas]);

  // The effective filter: locked preset takes priority over sidebar selection
  const activeFilter = lockedPreset ?? filterPersonaAgent;

  const addSlot = (id: string) => {
    const persona = (personas ?? []).find(p => p.id === id);
    if (!persona) return;
    // Enforce same-preset constraint: block if locked preset doesn't match
    if (lockedPreset && persona.persona_agent_id !== lockedPreset) return;
    if (!slots.includes(id)) setSlots(s => [...s, id]);
  };

  // Personas filtered by active preset
  const filteredByPersonaAgent = useMemo(() => {
    const all = personas ?? [];
    if (!activeFilter) return all;
    return all.filter(p => p.persona_agent_id === activeFilter);
  }, [personas, activeFilter]);

  // Personas matching search
  const browseable = useMemo(() => {
    if (!search) return filteredByPersonaAgent;
    const q = search.toLowerCase();
    return filteredByPersonaAgent.filter(p =>
      p.agent.toLowerCase().includes(q) ||
      (p.label ?? "").toLowerCase().includes(q) ||
      (p.customer ?? "").toLowerCase().includes(q)
    );
  }, [filteredByPersonaAgent, search]);

  // Group browseable by agent
  const byAgent = useMemo(() => {
    const m = new Map<string, Persona[]>();
    for (const p of browseable) {
      if (!m.has(p.agent)) m.set(p.agent, []);
      m.get(p.agent)!.push(p);
    }
    return m;
  }, [browseable]);

  const selectedPersonas = useMemo(
    () => slots.map(id => (personas ?? []).find(p => p.id === id)).filter(Boolean) as Persona[],
    [slots, personas]
  );

  const chartKeys = selectedPersonas.map((p, i) => slotChartKey(p, i));

  // Build score map from persona.score_json
  const scoreMap = useMemo(() => {
    const map: Record<string, PersonaScores> = {};
    for (const p of selectedPersonas) {
      if (!p.score_json) continue;
      try {
        const raw = JSON.parse(p.score_json);
        const entry: PersonaScores = { _overall: raw._overall ?? 0, _summary: raw._summary ?? "" };
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith("_")) continue;
          if (typeof (v as any)?.score === "number") entry[k] = (v as any).score;
        }
        map[p.id] = entry;
      } catch {}
    }
    return map;
  }, [selectedPersonas]);

  // Collect all section names present in any selected persona
  const allSectionNames: [string, string][] = useMemo(() => {
    const seen = new Set<string>();
    const result: [string, string][] = [];
    for (const p of selectedPersonas) {
      const sc = scoreMap[p.id];
      if (!sc) continue;
      for (const k of Object.keys(sc)) {
        if (k.startsWith("_")) continue;
        if (!seen.has(k)) { seen.add(k); result.push([k, sectionShortLabel(k)]); }
      }
    }
    return result;
  }, [selectedPersonas, scoreMap]);

  // Chart data
  const radarData = useMemo(() =>
    allSectionNames.map(([full, short]) => {
      const entry: Record<string, string | number> = { dim: short };
      selectedPersonas.forEach((p, i) => { entry[chartKeys[i]] = (scoreMap[p.id]?.[full] as number) ?? 0; });
      return entry;
    }), [allSectionNames, selectedPersonas, chartKeys, scoreMap]);

  const barData = useMemo(() =>
    allSectionNames.map(([full, short]) => {
      const entry: Record<string, string | number> = { name: short };
      selectedPersonas.forEach((p, i) => { entry[chartKeys[i]] = (scoreMap[p.id]?.[full] as number) ?? 0; });
      return entry;
    }), [allSectionNames, selectedPersonas, chartKeys, scoreMap]);

  // Count per persona-agent
  const paCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of personas ?? []) {
      if (p.persona_agent_id) m[p.persona_agent_id] = (m[p.persona_agent_id] ?? 0) + 1;
    }
    return m;
  }, [personas]);

  const showCharts = selectedPersonas.length >= 2 && allSectionNames.length > 0;

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">

      {/* ── Persona Agents sidebar ── */}
      <div className="w-44 shrink-0 border-r border-gray-800 flex flex-col overflow-hidden">
        <div className="px-3 pt-4 pb-2 shrink-0">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Persona Agents</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          {/* All — disabled while locked */}
          <button
            onClick={() => { if (!lockedPreset) { setFilterPersonaAgent(null); setShowPicker(true); } }}
            disabled={!!lockedPreset}
            className={cn(
              "w-full text-left px-2 py-1.5 rounded text-xs border transition-colors",
              lockedPreset ? "border-transparent text-gray-700 cursor-not-allowed" :
              filterPersonaAgent === null
                ? "bg-indigo-600/20 border-indigo-500/30 text-white"
                : "border-transparent text-gray-400 hover:bg-gray-800"
            )}
          >
            All
            <span className="ml-1 text-gray-600">({personas?.length ?? 0})</span>
          </button>

          {/* Per-preset */}
          {!personaAgents.length && <p className="text-xs text-gray-600 px-2 py-1">Loading…</p>}
          {personaAgents.map(pa => {
            const typeColor = pa.persona_type === "agent_overall" ? "text-violet-400"
              : pa.persona_type === "pair" ? "text-indigo-400"
              : "text-emerald-400";
            const count = paCounts[pa.name] ?? 0;
            const sections = Array.isArray(pa.sections) ? pa.sections.length : 0;
            const isLocked = !!lockedPreset && lockedPreset !== pa.name;
            const isActive = activeFilter === pa.name;
            return (
              <button
                key={pa.id}
                disabled={isLocked}
                onClick={() => { if (!isLocked) { setFilterPersonaAgent(pa.name); setShowPicker(true); } }}
                className={cn(
                  "w-full text-left px-2 py-1.5 rounded text-xs border transition-colors",
                  isLocked ? "border-transparent text-gray-700 cursor-not-allowed opacity-40" :
                  isActive
                    ? "bg-indigo-600/20 border-indigo-500/30 text-white"
                    : "border-transparent text-gray-400 hover:bg-gray-800"
                )}
              >
                <span className="flex items-center gap-1 min-w-0">
                  {pa.is_default && <span className="text-yellow-400 shrink-0">★</span>}
                  {lockedPreset === pa.name && <span className="text-amber-400 shrink-0">🔒</span>}
                  <span className="truncate">{pa.name}</span>
                </span>
                <span className={cn("text-[10px] flex items-center gap-1.5 mt-0.5", isLocked ? "text-gray-700" : typeColor)}>
                  {pa.persona_type ? typeLabel(pa.persona_type) : ""}
                  <span className="text-gray-600">{count}p</span>
                  {sections > 0 && <span className="text-gray-600">{sections}§</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6 max-w-full">

          {/* Header */}
          <div className="flex items-center gap-3">
            <BarChart3 className="w-6 h-6 text-indigo-400" />
            <div>
              <h1 className="text-xl font-bold">Compare Personas</h1>
              <p className="text-xs text-gray-500">Select a persona agent preset, then add personas to compare side by side</p>
            </div>
          </div>

          {/* Picker panel */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">

            {/* Selected chips */}
            {slots.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedPersonas.map((p, i) => {
                  const sc = scoreMap[p.id];
                  return (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs"
                      style={{ borderColor: COLORS[i % 7] + "60", backgroundColor: COLORS[i % 7] + "10" }}
                    >
                      <span className="font-medium text-white">{chartKeys[i]}</span>
                      {p.customer && <span className="text-gray-400">{p.customer}</span>}
                      {sc && (
                        <span className={cn("tabular-nums font-mono", scoreColor(sc._overall))}>
                          {Math.round(sc._overall)}
                        </span>
                      )}
                      <button onClick={() => removeSlot(i)} className="text-gray-600 hover:text-red-400 ml-1 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty hint */}
            {!activeFilter && slots.length === 0 && (
              <p className="text-xs text-gray-600 italic">← Select a persona agent to browse</p>
            )}

            {/* Lock badge */}
            {lockedPreset && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400">
                  🔒 Locked to: {lockedPreset}
                </span>
                <span className="text-[10px] text-gray-600">Remove all personas to unlock</span>
              </div>
            )}

            {/* Browse toggle */}
            {activeFilter !== null && (
              <button
                onClick={() => setShowPicker(v => !v)}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
              >
                {showPicker ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Browse {filteredByPersonaAgent.length} personas
                {activeFilter && <span className="text-indigo-400 ml-1">({activeFilter})</span>}
              </button>
            )}

            {/* Browser */}
            {showPicker && (
              <div className="border border-gray-700 rounded-lg overflow-hidden">
                <div className="p-2 border-b border-gray-700 flex items-center gap-2">
                  <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search personas…"
                    className="flex-1 bg-transparent text-xs text-white placeholder-gray-600 focus:outline-none"
                  />
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {browseable.length === 0 && (
                    <p className="text-xs text-gray-600 px-4 py-3">No personas match</p>
                  )}
                  {Array.from(byAgent.entries()).map(([agentName, agentPersonas]) => (
                    <div key={agentName}>
                      <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/50">
                        {agentName}
                      </p>
                      {agentPersonas.map(p => {
                        const alreadyAdded = slots.includes(p.id);
                        return (
                          <div
                            key={p.id}
                            className="flex items-center gap-2 px-3 py-2 hover:bg-gray-800/60 group border-b border-gray-800/40"
                          >
                            <span className={cn("text-[10px] px-1 py-0.5 rounded border shrink-0", TYPE_COLOR[p.type] ?? "text-gray-400 border-gray-700")}>
                              {typeLabel(p.type)}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white truncate">{p.agent}</p>
                              <p className="text-[10px] text-gray-500 truncate">
                                {p.customer && <span className="text-gray-400">{p.customer} · </span>}
                                {p.model.split("/").pop()} · {fmtDate(p.created_at)}
                                {p.version > 1 ? ` · v${p.version}` : ""}
                              </p>
                            </div>
                            <button
                              onClick={() => addSlot(p.id)}
                              disabled={alreadyAdded}
                              className={cn(
                                "flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors shrink-0",
                                alreadyAdded
                                  ? "text-gray-700 cursor-default"
                                  : "text-indigo-400 hover:bg-indigo-600/20 opacity-0 group-hover:opacity-100"
                              )}
                            >
                              <Plus className="w-3 h-3" />
                              {alreadyAdded ? "Added" : "Add"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Single-slot hint */}
            {slots.length === 1 && (
              <p className="text-xs text-amber-400/70">Add at least one more persona to compare</p>
            )}
          </div>

          {/* Empty state */}
          {slots.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-gray-700">
              <BarChart3 className="w-12 h-12 mb-4 opacity-20" />
              <p className="text-sm">Select a preset and agent, then add personas</p>
              <p className="text-xs mt-1 opacity-70">Only compare personas created by the same preset</p>
            </div>
          )}

          {/* Charts */}
          {showCharts && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Radar */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Radar</p>
                <ResponsiveContainer width="100%" height={280}>
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="#374151" />
                    <PolarAngleAxis dataKey="dim" tick={{ fill: "#9ca3af", fontSize: 11 }} />
                    {selectedPersonas.map((p, i) => (
                      <Radar
                        key={p.id}
                        name={chartKeys[i]}
                        dataKey={chartKeys[i]}
                        stroke={COLORS[i % 7]}
                        fill={COLORS[i % 7]}
                        fillOpacity={0.15}
                      />
                    ))}
                  </RadarChart>
                </ResponsiveContainer>
              </div>

              {/* Bar */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Bar</p>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={barData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 10 }} />
                    <YAxis domain={[0, 100]} tick={{ fill: "#9ca3af", fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: 6 }}
                      labelStyle={{ color: "#d1d5db", fontSize: 11 }}
                      itemStyle={{ fontSize: 11 }}
                    />
                    {selectedPersonas.map((p, i) => (
                      <Bar key={p.id} name={chartKeys[i]} dataKey={chartKeys[i]} fill={COLORS[i % 7]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Section scores table */}
          {selectedPersonas.length >= 2 && (
            <ScoreTable
              sections={allSectionNames}
              personas={selectedPersonas}
              scoreMap={scoreMap}
              chartKeys={chartKeys}
            />
          )}

          {/* Persona columns */}
          {selectedPersonas.length >= 1 && (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: `repeat(${selectedPersonas.length}, minmax(0, 1fr))` }}
            >
              {selectedPersonas.map((p, i) => (
                <PersonaColumn
                  key={p.id}
                  persona={p}
                  color={COLORS[i % 7]}
                  chartKey={chartKeys[i]}
                  scores={scoreMap[p.id]}
                />
              ))}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
