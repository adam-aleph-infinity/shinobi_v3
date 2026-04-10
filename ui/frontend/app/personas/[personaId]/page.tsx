"use client";
import { useState } from "react";
import useSWR from "swr";
import { getPersona, getPersonaVersions, regeneratePersona, deletePersona } from "@/lib/api";
import { Persona } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import {
  Loader2, ChevronLeft, RefreshCw, Clock, Brain,
  Copy, Check, EyeOff, Eye, AlertCircle,
  FileText, Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SectionCard, CategoryLegend, parsePersonaSections, MD } from "@/components/personas/PersonaSections";

// ── Page ────────────────────────────────────────────────────────────────────

export default function PersonaDetailPage({ params }: { params: { personaId: string } }) {
  const { personaId } = params;
  const router = useRouter();
  const [promptEdit, setPromptEdit]       = useState("");
  const [regenerating, setRegenating]     = useState(false);
  const [showPrompt, setShowPrompt]       = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]           = useState(false);

  const { data: persona, mutate } = useSWR<Persona>(
    `/personas/${personaId}`,
    () => getPersona(personaId) as Promise<Persona>,
  );

  const { data: versions } = useSWR<Persona[]>(
    `/personas/${personaId}/versions`,
    () => getPersonaVersions(personaId) as Promise<Persona[]>,
  );

  const handleRegenerate = async () => {
    setRegenating(true);
    try {
      const result = await regeneratePersona(personaId, {
        prompt_override: promptEdit || undefined,
      }) as Persona;
      mutate(result);
    } finally {
      setRegenating(false);
    }
  };

  if (!persona) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-600">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  const sections = (() => {
    if (persona.sections_json) {
      try { return JSON.parse(persona.sections_json) as { title: string; content: string }[]; } catch {}
    }
    return parsePersonaSections(persona.content_md);
  })();
  const callCount = (() => {
    try { return JSON.parse(persona.transcript_paths)?.length ?? 0; }
    catch { return persona.transcript_paths ? 1 : 0; }
  })();

  const TYPE_COLOR: Record<string, string> = {
    agent_overall: "text-violet-400 bg-violet-500/10 border-violet-500/30",
    pair:          "text-indigo-400 bg-indigo-500/10 border-indigo-500/30",
    customer:      "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  };

  return (
    <div className="h-[calc(100vh-3rem)] flex flex-col overflow-hidden">

      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Link href="/personas" className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors">
          <ChevronLeft className="w-4 h-4" /> Personas
        </Link>
        <span className="text-gray-800">·</span>
        <h1 className="text-sm font-bold text-white flex-1 truncate">
          {persona.agent}{persona.customer ? <span className="text-gray-500"> / {persona.customer}</span> : ""}
        </h1>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${TYPE_COLOR[persona.type] ?? TYPE_COLOR.agent_overall}`}>
          {persona.type.replace(/_/g, " ")}
        </span>
        {persona.version > 1 && (
          <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">v{persona.version}</span>
        )}
        <button onClick={() => setShowPrompt(p => !p)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-lg transition-colors">
          {showPrompt ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          Prompt
        </button>
        <button onClick={handleRegenerate} disabled={regenerating}
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-violet-700 hover:bg-violet-600 text-white text-xs rounded-lg transition-colors disabled:opacity-50">
          {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Regenerate
        </button>
        <button
          onClick={async () => {
            if (!confirmDelete) { setConfirmDelete(true); return; }
            setDeleting(true);
            try { await deletePersona(personaId); router.push("/personas"); }
            finally { setDeleting(false); setConfirmDelete(false); }
          }}
          onBlur={() => setConfirmDelete(false)}
          disabled={deleting}
          title={confirmDelete ? "Click again to confirm delete" : "Delete persona"}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-50 ${
            confirmDelete
              ? "bg-red-600 hover:bg-red-500 text-white"
              : "bg-gray-800 hover:bg-red-900/60 text-gray-400 hover:text-red-300"
          }`}>
          {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
          {confirmDelete ? "Confirm" : "Delete"}
        </button>
      </div>

      {/* ── Prompt editor (collapsible) ── */}
      {showPrompt && (
        <div className="mb-4 shrink-0">
          <label className="block text-[10px] text-gray-500 uppercase tracking-wider mb-1">System Prompt</label>
          <textarea
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-xs text-gray-300 focus:outline-none focus:border-violet-500 h-32 resize-none font-mono"
            value={promptEdit || persona.prompt_used}
            onChange={e => setPromptEdit(e.target.value)}
          />
        </div>
      )}

      {/* ── Body: sidebar + section grid ── */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* Sidebar */}
        <div className="w-44 flex-shrink-0 flex flex-col gap-3 overflow-y-auto">

          {/* Meta card */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-2 text-[11px]">
            <p className="text-[9px] font-semibold text-gray-600 uppercase tracking-wider">Details</p>
            <div className="flex items-center gap-1.5 text-gray-400">
              <Brain className="w-3 h-3 text-gray-600 shrink-0" />
              <span className="truncate">{persona.model}</span>
            </div>
            <div className="flex items-center gap-1.5 text-gray-400">
              <Clock className="w-3 h-3 text-gray-600 shrink-0" />
              <span>{formatDate(persona.created_at)}</span>
            </div>
            {callCount > 0 && (
              <div className="flex items-center gap-1.5 text-gray-400">
                <FileText className="w-3 h-3 text-gray-600 shrink-0" />
                <span>{callCount} call{callCount !== 1 ? "s" : ""}</span>
              </div>
            )}
            {sections.length > 0 && (
              <div className="flex items-center gap-1.5 text-gray-400">
                <AlertCircle className="w-3 h-3 text-gray-600 shrink-0" />
                <span>{sections.length} sections</span>
              </div>
            )}
          </div>

          {/* Versions */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <p className="text-[9px] font-semibold text-gray-600 uppercase tracking-wider mb-2">Versions</p>
            <div className="space-y-1">
              {versions?.map(v => (
                <Link key={v.id} href={`/personas/${v.id}`}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
                    v.id === personaId
                      ? "bg-violet-900/40 text-white border border-violet-800"
                      : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
                  }`}>
                  <Clock className="w-3 h-3 flex-shrink-0" />
                  <div>
                    <p className="font-medium">v{v.version}</p>
                    <p className="text-gray-600 text-[10px]">{formatDate(v.created_at)}</p>
                  </div>
                </Link>
              ))}
              {!versions && (
                <div className="flex items-center gap-1.5 py-1 text-gray-700 text-xs">
                  <Loader2 className="w-3 h-3 animate-spin" />
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Section grid + score */}
        <div className="flex-1 overflow-y-auto min-h-0 pr-0.5 space-y-4">
          {/* Score banner (from stored score_json) */}
          {(() => {
            const scoreData: Record<string, any> = (() => {
              try { return JSON.parse((persona as any).score_json || "{}"); } catch { return {}; }
            })();
            const overall = scoreData._overall as number | undefined;
            const summary = scoreData._summary as string | undefined;
            const rawText = scoreData._raw_text as string | undefined;
            const sectionEntries = Object.entries(scoreData).filter(([k]) => !k.startsWith("_"));
            if (!overall && !rawText && sectionEntries.length === 0) return null;
            const color = (s: number) => s >= 75 ? "text-emerald-400" : s >= 50 ? "text-yellow-400" : "text-red-400";
            return (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Score</p>
                {overall !== undefined && (
                  <div className="flex items-center gap-3 mb-3">
                    <span className={`text-2xl font-bold tabular-nums ${color(overall)}`}>{Math.round(overall)}</span>
                    <span className="text-gray-600 text-xs">/100</span>
                    {summary && <p className="text-gray-400 text-xs flex-1">{summary}</p>}
                  </div>
                )}
                {sectionEntries.length > 0 && (
                  <div className="space-y-1.5">
                    {sectionEntries.map(([name, val]) => {
                      const score = typeof val === "object" ? val?.score : val;
                      const reasoning = typeof val === "object" ? val?.reasoning : "";
                      return (
                        <div key={name} className="flex items-start gap-3 bg-gray-800/50 rounded px-3 py-2">
                          <span className={`text-sm font-bold tabular-nums w-8 shrink-0 ${color(typeof score === "number" ? score : 0)}`}>
                            {typeof score === "number" ? score : "—"}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-gray-300">{name}</p>
                            {reasoning && <p className="text-xs text-gray-500 mt-0.5">{reasoning}</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {rawText && sectionEntries.length === 0 && (
                  <div className="text-xs text-gray-400 whitespace-pre-wrap font-mono bg-gray-950 rounded p-3 max-h-48 overflow-y-auto">{rawText}</div>
                )}
              </div>
            );
          })()}

          {/* Persona content */}
          {sections.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <ReactMarkdown components={MD as never}>{persona.content_md}</ReactMarkdown>
            </div>
          ) : (
            <>
              <CategoryLegend sections={sections} />
              <div className="grid grid-cols-2 gap-3">
                {sections.map((section, i) => (
                  <SectionCard
                    key={i}
                    section={section}
                    fullWidth={section.content.length > 600}
                  />
                ))}
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
