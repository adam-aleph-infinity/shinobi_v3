"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Bookmark, Star, Trash2, Pencil, Check, X, ChevronLeft, ChevronRight, Plus,
} from "lucide-react";

const API = "/api";

export interface ScorePresetSettings {
  name: string;
  prompt: string;
  user_prompt: string;
  model: string;
  temperature: number;
  is_default?: boolean;
  created_at: string;
}

interface Props {
  onLoad: (preset: ScorePresetSettings) => void;
  currentSettings: () => Omit<ScorePresetSettings, "name" | "created_at" | "is_default">;
  onDefaultApplied?: () => void;
}

export function ScorePresetsPanel({ onLoad, currentSettings, onDefaultApplied }: Props) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("score-presets-panel-open") !== "false"; } catch { return true; }
  });
  const [presets, setPresets] = useState<ScorePresetSettings[]>([]);
  const [tick, setTick] = useState(0);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingName, setSavingName] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const defaultApplied = useRef(false);
  const saveInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    fetch(`${API}/score-presets`)
      .then(r => r.json())
      .then((data: ScorePresetSettings[]) => {
        setPresets(data);
        if (!defaultApplied.current) {
          const def = data.find(p => p.is_default);
          if (def) {
            onLoad(def);
            onDefaultApplied?.();
          }
          defaultApplied.current = true;
        }
      })
      .catch(() => {});
  }, [tick]);

  useEffect(() => {
    try { localStorage.setItem("score-presets-panel-open", String(open)); } catch {}
  }, [open]);

  useEffect(() => {
    if (showSaveForm) saveInputRef.current?.focus();
  }, [showSaveForm]);

  const savePreset = async () => {
    const name = savingName.trim();
    if (!name) return;
    await fetch(`${API}/score-presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...currentSettings() }),
    });
    setSavingName("");
    setShowSaveForm(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    reload();
  };

  const deletePreset = async (name: string) => {
    await fetch(`${API}/score-presets/${encodeURIComponent(name)}`, { method: "DELETE" });
    reload();
  };

  const setDefault = async (name: string) => {
    const preset = presets.find(p => p.name === name);
    if (preset?.is_default) {
      await fetch(`${API}/score-presets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...currentSettings(), is_default: false }),
      });
    } else {
      await fetch(`${API}/score-presets/${encodeURIComponent(name)}/default`, { method: "PATCH" });
    }
    reload();
  };

  const startEdit = (preset: ScorePresetSettings) => {
    setEditingName(preset.name);
    setEditValue(preset.name);
  };

  const saveEdit = async (oldName: string) => {
    const newName = editValue.trim();
    if (!newName || newName === oldName) { setEditingName(null); return; }
    const preset = presets.find(p => p.name === oldName);
    if (!preset) { setEditingName(null); return; }
    await fetch(`${API}/score-presets/${encodeURIComponent(oldName)}`, { method: "DELETE" });
    await fetch(`${API}/score-presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...preset, name: newName }),
    });
    setEditingName(null);
    reload();
  };

  const filtered = presets.filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  if (!open) {
    return (
      <div className="flex flex-col items-center py-4 w-8 shrink-0">
        <button
          onClick={() => setOpen(true)}
          className="flex flex-col items-center gap-1 text-gray-600 hover:text-gray-300 transition-colors"
          title="Open presets panel"
        >
          <Bookmark className="w-4 h-4" />
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 shrink-0 flex flex-col bg-gray-900 border border-gray-800 rounded-xl overflow-hidden self-start sticky top-4">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-800">
        <Bookmark className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
        <span className="text-xs font-semibold text-gray-300 flex-1">Score Presets</span>
        <button
          onClick={() => setShowSaveForm(v => !v)}
          className="p-1 text-gray-600 hover:text-indigo-400 transition-colors"
          title="Save current settings as preset"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setOpen(false)}
          className="p-1 text-gray-600 hover:text-gray-300 transition-colors"
          title="Collapse panel"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      {showSaveForm && (
        <div className="px-3 py-2 border-b border-gray-800 flex items-center gap-2">
          <input
            ref={saveInputRef}
            type="text"
            value={savingName}
            onChange={e => setSavingName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") savePreset();
              if (e.key === "Escape") setShowSaveForm(false);
            }}
            placeholder="Preset name…"
            className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          {saved ? (
            <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          ) : (
            <button
              onClick={savePreset}
              disabled={!savingName.trim()}
              className="text-[10px] px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors shrink-0"
            >
              Save
            </button>
          )}
          <button onClick={() => setShowSaveForm(false)}>
            <X className="w-3 h-3 text-gray-500 hover:text-gray-300 shrink-0" />
          </button>
        </div>
      )}

      {presets.length > 4 && (
        <div className="px-3 py-2 border-b border-gray-800">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search presets…"
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto max-h-[60vh]">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-600 px-3 py-4 text-center">
            {presets.length === 0 ? "No presets yet — save one above" : "No matches"}
          </p>
        ) : (
          filtered.map(p => (
            <div
              key={p.name}
              className={`group border-b border-gray-800/60 last:border-0 px-3 py-2.5 hover:bg-gray-800/50 transition-colors ${p.is_default ? "bg-indigo-900/10" : ""}`}
            >
              {editingName === p.name ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") saveEdit(p.name);
                      if (e.key === "Escape") setEditingName(null);
                    }}
                    className="flex-1 min-w-0 bg-gray-800 border border-indigo-600 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                  />
                  <button onClick={() => saveEdit(p.name)}>
                    <Check className="w-3 h-3 text-emerald-400" />
                  </button>
                  <button onClick={() => setEditingName(null)}>
                    <X className="w-3 h-3 text-gray-500" />
                  </button>
                </div>
              ) : (
                <>
                  <button onClick={() => onLoad(p)} className="w-full text-left mb-0.5">
                    <span className={`block text-xs font-medium truncate ${p.is_default ? "text-indigo-300" : "text-white"}`}>
                      {p.is_default && <span className="text-yellow-400 mr-1">★</span>}
                      {p.name}
                    </span>
                    <span className="text-[10px] text-gray-500">
                      {p.model} · {formatDate(p.created_at)}
                    </span>
                  </button>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
                    <button
                      onClick={() => setDefault(p.name)}
                      className={`p-0.5 transition-colors ${p.is_default ? "text-yellow-400 hover:text-yellow-300" : "text-gray-600 hover:text-yellow-400"}`}
                      title={p.is_default ? "Remove default" : "Set as default"}
                    >
                      <Star className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => startEdit(p)}
                      className="p-0.5 text-gray-600 hover:text-gray-300 transition-colors"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => deletePreset(p.name)}
                      className="p-0.5 text-gray-600 hover:text-red-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
