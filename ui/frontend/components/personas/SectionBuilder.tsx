"use client";
import { useState, useRef, useEffect } from "react";
import { Plus, Trash2, ChevronUp, ChevronDown, Pencil, Check, X, Wand2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PersonaSection {
  id: string;
  name: string;
  instruction: string;           // what to cover / analyze
  scoring_instruction: string;   // how to assign the score for this section
  scoring_direction: "higher_better" | "lower_better" | "neutral";
  weight: number; // 1–5
}

function SectionCard({
  section, index, total, allSections, onChange, onRemove, onMoveUp, onMoveDown,
}: {
  section: PersonaSection;
  index: number;
  total: number;
  allSections: PersonaSection[];
  onChange: (s: PersonaSection) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(section.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [wandLoading, setWandLoading] = useState<string | null>(null); // field being suggested

  async function suggest(field: "name" | "cover" | "score" | "all") {
    setWandLoading(field);
    try {
      const others = allSections
        .filter(s => s.id !== section.id)
        .map(s => ({ name: s.name, instruction: s.instruction, scoring_instruction: s.scoring_instruction }));
      const res = await fetch("/api/persona-agents/suggest-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field,
          name: section.name,
          instruction: section.instruction,
          scoring_instruction: section.scoring_instruction ?? "",
          other_sections: others,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const updated = { ...section };
      if (data.name) { updated.name = data.name; setNameDraft(data.name); }
      if (data.instruction !== undefined) updated.instruction = data.instruction;
      if (data.scoring_instruction !== undefined) updated.scoring_instruction = data.scoring_instruction;
      onChange(updated);
    } catch { /* silent */ }
    finally { setWandLoading(null); }
  }

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  function commitName() {
    onChange({ ...section, name: nameDraft });
    setEditingName(false);
  }

  function cancelName() {
    setNameDraft(section.name);
    setEditingName(false);
  }

  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-800">
        <span className="text-[10px] text-gray-600 font-mono w-4 shrink-0 text-center">{index + 1}</span>
        {editingName ? (
          <>
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commitName(); if (e.key === "Escape") cancelName(); }}
              placeholder="Section name…"
              className="flex-1 bg-gray-700 text-sm text-white font-medium placeholder-gray-600 focus:outline-none min-w-0 rounded px-1.5"
            />
            <button onClick={commitName} className="p-0.5 text-emerald-400 hover:text-emerald-300 transition-colors shrink-0" title="Save name">
              <Check className="w-3.5 h-3.5" />
            </button>
            <button onClick={cancelName} className="p-0.5 text-gray-500 hover:text-gray-300 transition-colors shrink-0" title="Cancel">
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        ) : (
          <>
            <span
              onClick={() => { setNameDraft(section.name); setEditingName(true); }}
              className="flex-1 text-sm text-white font-medium cursor-pointer hover:text-indigo-300 transition-colors min-w-0 truncate"
              title="Click to edit name"
            >
              {section.name || <span className="text-gray-600 italic">Section name…</span>}
            </span>
            <button onClick={() => { setNameDraft(section.name); setEditingName(true); }}
              className="p-0.5 text-gray-600 hover:text-indigo-400 transition-colors shrink-0" title="Edit name">
              <Pencil className="w-3 h-3" />
            </button>
          </>
        )}
        {/* controls */}
        <div className="flex items-center gap-0.5 shrink-0 ml-1">
          <button onClick={onMoveUp} disabled={index === 0}
            className="p-0.5 text-gray-600 hover:text-gray-300 disabled:opacity-20 transition-colors" title="Move up">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button onClick={onMoveDown} disabled={index === total - 1}
            className="p-0.5 text-gray-600 hover:text-gray-300 disabled:opacity-20 transition-colors" title="Move down">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setExpanded(v => !v)}
            className="px-1.5 py-0.5 text-[9px] text-gray-600 hover:text-gray-300 transition-colors select-none">
            {expanded ? "▲" : "▼"}
          </button>
          <button onClick={onRemove}
            className="p-0.5 text-gray-600 hover:text-red-400 transition-colors ml-0.5" title="Remove section">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-gray-700/40">
          {/* What to Cover */}
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mt-2 mb-1">
              What to Cover <span className="normal-case font-normal text-gray-600">— what the LLM should analyze and quote</span>
            </label>
            <textarea
              value={section.instruction}
              onChange={e => onChange({ ...section, instruction: e.target.value })}
              placeholder="Describe what patterns, behaviors, quotes or dimensions to look for…"
              rows={3}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
            />
          </div>

          {/* How to Score */}
          <div>
            <label className="text-[9px] text-gray-500 uppercase tracking-wider block mb-1">
              How to Score <span className="normal-case font-normal text-gray-600">— scoring criteria (high score = high research flag intensity)</span>
            </label>
            <textarea
              value={section.scoring_instruction ?? ""}
              onChange={e => onChange({ ...section, scoring_instruction: e.target.value })}
              placeholder="e.g. Score 80-100 if multiple clear violations detected. Score 40-70 if ambiguous. Score 0-39 if none found…"
              rows={3}
              className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
            />
          </div>

          {/* Weight + Wand row */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-[9px] text-gray-500 uppercase tracking-wider">Weight</label>
              <select
                value={section.weight}
                onChange={e => onChange({ ...section, weight: parseInt(e.target.value) })}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-indigo-500 w-16"
              >
                {[1, 2, 3, 4, 5].map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1 ml-auto">
              <span className="text-[9px] text-gray-600 mr-1">Auto-fill:</span>
              {([
                { field: "name" as const,  label: "Name"  },
                { field: "cover" as const, label: "Cover" },
                { field: "score" as const, label: "Score" },
                { field: "all" as const,   label: "All"   },
              ]).map(({ field, label }) => (
                <button
                  key={field}
                  onClick={() => suggest(field)}
                  disabled={wandLoading !== null}
                  title={`Auto-fill ${label} with AI`}
                  className={cn(
                    "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] border transition-colors disabled:opacity-40",
                    field === "all"
                      ? "border-violet-600/40 text-violet-400 hover:bg-violet-900/30"
                      : "border-gray-700 text-gray-500 hover:text-indigo-400 hover:border-indigo-600/40 hover:bg-indigo-900/20"
                  )}
                >
                  {wandLoading === field
                    ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    : <Wand2 className="w-2.5 h-2.5" />
                  }
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  sections: PersonaSection[];
  onChange: (sections: PersonaSection[]) => void;
  className?: string;
  readOnly?: boolean;
}

export function SectionBuilder({ sections, onChange, className, readOnly }: Props) {
  function add() {
    onChange([...sections, {
      id: typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2),
      name: "",
      instruction: "",
      scoring_instruction: "",
      scoring_direction: "higher_better",
      weight: 2,
    }]);
  }

  function remove(idx: number) {
    onChange(sections.filter((_, i) => i !== idx));
  }

  function update(idx: number, s: PersonaSection) {
    const next = [...sections];
    next[idx] = s;
    onChange(next);
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    const next = [...sections];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  }

  function moveDown(idx: number) {
    if (idx === sections.length - 1) return;
    const next = [...sections];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  }

  return (
    <div className={cn("space-y-2", className)}>
      {sections.length === 0 && (
        <div className="border border-dashed border-gray-700 rounded-lg px-4 py-6 text-center text-xs text-gray-600">
          No sections defined — add one below or load a persona agent preset.
        </div>
      )}
      {sections.map((s, i) => (
        <SectionCard
          key={s.id}
          section={s}
          index={i}
          total={sections.length}
          allSections={sections}
          onChange={s => update(i, s)}
          onRemove={() => remove(i)}
          onMoveUp={() => moveUp(i)}
          onMoveDown={() => moveDown(i)}
        />
      ))}
      {!readOnly && (
        <button
          onClick={add}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-dashed border-gray-700 hover:border-indigo-500 hover:bg-indigo-900/10 text-gray-500 hover:text-indigo-400 text-xs rounded-lg transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Section
        </button>
      )}
    </div>
  );
}
