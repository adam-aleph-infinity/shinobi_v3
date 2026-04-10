"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { Bookmark, Trash2, X, Check } from "lucide-react";

const API = "/api";

export interface PresetSettings {
  name: string;
  system_prompt: string;
  user_prompt: string;
  model: string;
  temperature: number;
  created_at: string;
}

interface Props {
  /** Called when the user clicks a preset — apply its values to form state */
  onLoad: (preset: PresetSettings) => void;
  /** Return the current form values to be saved */
  currentSettings: () => Omit<PresetSettings, "name" | "created_at">;
}

export function PersonaPresetsBar({ onLoad, currentSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(false);
  const [presets, setPresets] = useState<PresetSettings[]>([]);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    fetch(`${API}/persona-presets`)
      .then(r => r.json())
      .then((data: PresetSettings[]) => setPresets(data))
      .catch(() => {});
  }, [tick]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (showSaveForm) inputRef.current?.focus();
  }, [showSaveForm]);

  const savePreset = async () => {
    const name = saveName.trim();
    if (!name) return;
    await fetch(`${API}/persona-presets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...currentSettings() }),
    });
    setSaveName("");
    setShowSaveForm(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    reload();
  };

  const deletePreset = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    await fetch(`${API}/persona-presets/${encodeURIComponent(name)}`, { method: "DELETE" });
    reload();
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Presets dropdown trigger */}
        <button
          onClick={() => { setOpen(v => !v); setShowSaveForm(false); }}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          <Bookmark className="w-3.5 h-3.5" />
          Presets
          {(presets?.length ?? 0) > 0 && (
            <span className="text-indigo-400 font-mono">({presets!.length})</span>
          )}
        </button>

        {/* Inline divider */}
        <span className="text-gray-700 text-xs">·</span>

        {/* Save current */}
        {saved ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <Check className="w-3 h-3" /> Saved
          </span>
        ) : (
          <button
            onClick={() => { setShowSaveForm(v => !v); setOpen(false); }}
            className="text-xs text-indigo-500 hover:text-indigo-300 transition-colors"
          >
            Save as preset
          </button>
        )}
      </div>

      {/* Save form */}
      {showSaveForm && (
        <div className="mt-2 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") savePreset();
              if (e.key === "Escape") setShowSaveForm(false);
            }}
            placeholder="Preset name…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={savePreset}
            disabled={!saveName.trim()}
            className="text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
          >
            Save
          </button>
          <button onClick={() => setShowSaveForm(false)}>
            <X className="w-3.5 h-3.5 text-gray-500 hover:text-gray-300" />
          </button>
        </div>
      )}

      {/* Dropdown list */}
      {open && (
        <div className="absolute left-0 top-7 z-50 min-w-[260px] max-w-sm bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
          {!presets?.length ? (
            <p className="text-xs text-gray-600 px-3 py-4 text-center">No saved presets yet</p>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {presets.map(p => (
                <button
                  key={p.name}
                  onClick={() => { onLoad(p); setOpen(false); }}
                  className="w-full text-left flex items-start justify-between gap-2 px-3 py-2.5 hover:bg-gray-800 transition-colors group"
                >
                  <div className="min-w-0">
                    <span className="block text-xs font-medium text-white group-hover:text-indigo-300 truncate">
                      {p.name}
                    </span>
                    <span className="text-[10px] text-gray-500">
                      {p.model} · temp {p.temperature} · {formatDate(p.created_at)}
                    </span>
                  </div>
                  <span
                    role="button"
                    onClick={e => deletePreset(e, p.name)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
                  >
                    <Trash2 className="w-3 h-3 text-red-400 hover:text-red-300" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
