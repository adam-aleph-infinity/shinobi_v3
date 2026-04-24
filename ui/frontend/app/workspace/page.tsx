"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import { formatDate } from "@/lib/utils";
import {
  Folder, FolderOpen, FileText, FileAudio, File, ChevronRight,
  ChevronDown, HardDrive, Users, RefreshCw, X, Play, Download,
  Mic2, Wand2, FileCode2, CheckCircle2,
} from "lucide-react";
import { TranscriptContent } from "@/components/shared/TranscriptViewer";

const API = "/api";

function fmt(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

function FileIcon({ type, ext }: { type: string; ext: string }) {
  if (type === "audio") return <FileAudio className="w-4 h-4 text-emerald-400 shrink-0" />;
  if (type === "text")  return <FileText  className="w-4 h-4 text-indigo-400 shrink-0" />;
  if (type === "dir")   return <Folder    className="w-4 h-4 text-yellow-400 shrink-0" />;
  return <File className="w-4 h-4 text-gray-500 shrink-0" />;
}

type Entry = {
  name: string; path: string; type: string; ext: string;
  size: number | null; modified: string; is_dir: boolean;
  file_count?: number;
  // agent dir
  kind?: string; customer_count?: number;
  // pair dir
  agent?: string; customer?: string; crm?: string;
  // call dir
  has_original?: boolean; orig_size?: number | null;
  processed_variants?: string[];
  transcript_engines?: string[];
  transcript_sources?: string[];
  has_final_transcript?: boolean;
};

type BrowseResult = { path: string; parent: string | null; entries: Entry[] };

// ── Content badges for call_id directories ─────────────────────────────────

const VARIANT_COLORS: Record<string, string> = {
  enhanced:  "bg-blue-900/50 text-blue-300 border-blue-700/40",
  converted: "bg-violet-900/50 text-violet-300 border-violet-700/40",
};

const ENGINE_LABELS: Record<string, string> = {
  elevenlabs: "ElevenLabs", mlx_whisper: "Whisper", gemini: "Gemini",
  openai_gpt4o: "GPT-4o", openai_diarize: "OpenAI",
};
const SOURCE_SHORT: Record<string, string> = {
  full: "Full", speaker_0: "Spk0", speaker_1: "Spk1", merged: "Merged",
};

function CallBadges({ entry }: { entry: Entry }) {
  const hasAnyTranscript = (entry.transcript_engines?.length ?? 0) > 0 || entry.has_final_transcript;
  return (
    <div className="flex flex-wrap items-center gap-1 mt-0.5">
      {/* Audio */}
      {entry.has_original && (
        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium border bg-gray-800 text-gray-300 border-gray-600">
          <Mic2 className="w-2.5 h-2.5" /> Original
        </span>
      )}
      {entry.processed_variants?.map(v => (
        <span key={v} className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium border ${VARIANT_COLORS[v] ?? "bg-gray-800 text-gray-300 border-gray-600"}`}>
          <Wand2 className="w-2.5 h-2.5" /> {v}
        </span>
      ))}
      {/* Transcripts */}
      {entry.has_final_transcript && (
        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium border bg-emerald-900/40 text-emerald-300 border-emerald-700/40">
          <CheckCircle2 className="w-2.5 h-2.5" /> Final SRT
        </span>
      )}
      {hasAnyTranscript && entry.transcript_engines?.map(e => (
        <span key={e} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium border bg-yellow-900/40 text-yellow-300 border-yellow-700/40">
          <FileCode2 className="w-2.5 h-2.5" />
          {ENGINE_LABELS[e] ?? e.replace(/_/g, " ")}
        </span>
      ))}
      {(entry.transcript_sources?.length ?? 0) > 0 && (
        <span className="text-[9px] text-gray-600 ml-0.5">
          [{entry.transcript_sources!.map(s => SOURCE_SHORT[s] ?? s).join(" · ")}]
        </span>
      )}
    </div>
  );
}

function _wss(k: string) { try { return sessionStorage.getItem(`ws_${k}`) ?? ""; } catch { return ""; } }
function _wssSet(k: string, v: string) { try { sessionStorage.setItem(`ws_${k}`, v); } catch {} }

export default function WorkspacePage() {
  // Start from safe default; restored from sessionStorage post-mount
  const [browsePath, _setBrowsePath] = useState("");
  const setBrowsePath = (v: string) => { _setBrowsePath(v); _wssSet("browsePath", v); };

  useEffect(() => { _setBrowsePath(_wss("browsePath")); }, []);
  const [preview, setPreview] = useState<{ path: string; content: string; format: string } | null>(null);
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);

  const { data: roots, mutate: mutateRoots } = useSWR<Entry[]>(
    "/workspace-root",
    () => fetch(`${API}/workspace`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const { data: dir, isLoading } = useSWR<BrowseResult>(
    `/workspace-browse?${browsePath}`,
    () => fetch(`${API}/workspace/browse?path=${encodeURIComponent(browsePath)}`).then(r => r.json()),
    { revalidateOnFocus: false },
  );

  const navigate = (path: string) => { setBrowsePath(path); setPreview(null); };

  const openPreview = async (path: string) => {
    const res = await fetch(`${API}/workspace/preview?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const d = await res.json();
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const format = ext === "srt" ? "srt" : ext === "json" ? "json" : "text";
      setPreview({ path, content: d.content, format });
    }
  };

  const playAudio = (path: string) => {
    if (audio) { audio.pause(); }
    if (playingPath === path) { setPlayingPath(null); setAudio(null); return; }
    const a = new Audio(`${API}/workspace/download?path=${encodeURIComponent(path)}`);
    a.play();
    a.onended = () => { setPlayingPath(null); setAudio(null); };
    setPlayingPath(path);
    setAudio(a);
  };

  const handleClick = (entry: Entry) => {
    if (entry.is_dir) navigate(entry.path);
    else if (entry.type === "audio") playAudio(entry.path);
    else if (entry.type === "text") openPreview(entry.path);
  };

  const breadcrumbs = browsePath ? browsePath.split("/").filter(Boolean) : [];

  return (
    <div className="h-[calc(100vh-3rem)] flex gap-4">

      {/* ── Left: folder tree ── */}
      <div className="w-64 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
        <div className="px-3 py-2.5 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
            <HardDrive className="w-4 h-4 text-indigo-400" /> ui/data/
          </div>
          <button onClick={() => { mutateRoots(); navigate(""); }}
            className="p-1 hover:bg-gray-800 rounded text-gray-500 hover:text-gray-300">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {roots?.map(entry => (
            <button key={entry.path} onClick={() => navigate(entry.path)}
              className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-left transition-colors text-xs ${
                browsePath.startsWith(entry.path)
                  ? "bg-indigo-600/20 border border-indigo-500/30 text-white"
                  : "text-gray-400 hover:bg-gray-800 hover:text-white"
              }`}>
              {browsePath.startsWith(entry.path)
                ? <FolderOpen className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${entry.kind === "system" ? "text-indigo-400" : "text-yellow-400"}`} />
                : <Folder     className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${entry.kind === "system" ? "text-indigo-400" : "text-yellow-400"}`} />
              }
              <div className="min-w-0">
                <p className="truncate font-medium">{entry.name}</p>
                {entry.kind === "system" ? (
                  <p className="text-gray-600">
                    {entry.file_count ?? 0} item{(entry.file_count ?? 0) !== 1 ? "s" : ""}
                  </p>
                ) : (
                  <p className="text-gray-600">
                    {entry.customer_count} customer{entry.customer_count !== 1 ? "s" : ""}
                    {entry.file_count ? ` · ${entry.file_count} calls` : ""}
                  </p>
                )}
              </div>
            </button>
          ))}
          {!roots?.length && (
            <p className="text-xs text-gray-600 p-3 text-center">No data yet</p>
          )}
        </div>
      </div>

      {/* ── Right: file browser + preview ── */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-sm text-gray-400">
          <button onClick={() => navigate("")} className="hover:text-white transition-colors">ui/data/</button>
          {breadcrumbs.map((crumb, i) => {
            const path = breadcrumbs.slice(0, i + 1).join("/");
            return (
              <span key={path} className="flex items-center gap-1.5">
                <ChevronRight className="w-3.5 h-3.5 text-gray-600" />
                <button onClick={() => navigate(path)}
                  className="hover:text-white transition-colors truncate max-w-[160px]">
                  {crumb}
                </button>
              </span>
            );
          })}
        </div>

        <div className="flex gap-3 flex-1 min-h-0">
          {/* File list */}
          <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
            <div className="grid text-xs text-gray-500 font-medium border-b border-gray-800 px-4 py-2"
              style={{ gridTemplateColumns: "1fr 80px 140px 64px" }}>
              <span>Name</span>
              <span className="text-right">Size</span>
              <span className="text-right">Modified</span>
              <span />
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoading && <p className="text-center py-12 text-gray-600 text-sm">Loading...</p>}

              {/* Back button */}
              {dir?.parent != null && (
                <button onClick={() => navigate(dir.parent!)}
                  className="w-full grid px-4 py-2 hover:bg-gray-800/50 transition-colors text-left text-sm text-gray-500"
                  style={{ gridTemplateColumns: "1fr 80px 140px 64px" }}>
                  <span className="flex items-center gap-2">
                    <ChevronDown className="w-4 h-4 rotate-90" /> ..
                  </span>
                </button>
              )}

              {dir?.entries.map(entry => {
                const isCall = entry.kind === "call";
                return (
                  <div key={entry.path}
                    className={`px-4 py-2 hover:bg-gray-800/50 transition-colors cursor-pointer group items-center ${
                      playingPath === entry.path ? "bg-emerald-900/20" : ""
                    } ${isCall ? "py-2.5" : "py-1.5"}`}
                    onClick={() => handleClick(entry)}>

                    {isCall ? (
                      /* ── Call ID row ── */
                      <div className="grid items-start" style={{ gridTemplateColumns: "1fr 80px 140px 64px" }}>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
                            <span className="text-sm font-mono font-semibold text-white">{entry.name}</span>
                            {!entry.has_original && !entry.processed_variants?.length && !entry.transcript_engines?.length && (
                              <span className="text-xs text-gray-600">empty</span>
                            )}
                          </div>
                          <div className="pl-6">
                            <CallBadges entry={entry} />
                          </div>
                        </div>
                        <span className="text-right text-xs text-gray-500 pt-0.5">{fmt(entry.orig_size)}</span>
                        <span className="text-right text-xs text-gray-600 pt-0.5">{formatDate(entry.modified)}</span>
                        <span className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
                          <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
                        </span>
                      </div>
                    ) : (
                      /* ── Regular row ── */
                      <div className="grid items-center" style={{ gridTemplateColumns: "1fr 80px 140px 64px" }}>
                        <span className="flex items-center gap-2 text-sm min-w-0">
                          {entry.is_dir
                            ? entry.kind === "pair"
                              ? <Users className="w-4 h-4 text-indigo-400 shrink-0" />
                              : <Folder className="w-4 h-4 text-yellow-400 shrink-0" />
                            : <FileIcon type={entry.type} ext={entry.ext} />
                          }
                          <span className={`truncate ${entry.is_dir ? "text-white font-medium" : "text-gray-300"}`}>
                            {entry.name}
                          </span>
                          {entry.is_dir && entry.file_count != null && (
                            <span className="text-xs text-gray-600 shrink-0">
                              {entry.kind === "pair"
                                ? `${entry.file_count} call${entry.file_count !== 1 ? "s" : ""}`
                                : entry.kind === "agent"
                                  ? `${entry.customer_count} customer${entry.customer_count !== 1 ? "s" : ""}`
                                  : `${entry.file_count} items`
                              }
                            </span>
                          )}
                        </span>
                        <span className="text-right text-xs text-gray-500">{fmt(entry.size)}</span>
                        <span className="text-right text-xs text-gray-600">{formatDate(entry.modified)}</span>
                        <span className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {entry.type === "audio" && (
                            <button onClick={e => { e.stopPropagation(); playAudio(entry.path); }}
                              className="p-1 hover:bg-gray-700 rounded text-emerald-400">
                              <Play className="w-3 h-3" />
                            </button>
                          )}
                          {!entry.is_dir && (
                            <a href={`${API}/workspace/download?path=${encodeURIComponent(entry.path)}`}
                              download={entry.name} onClick={e => e.stopPropagation()}
                              className="p-1 hover:bg-gray-700 rounded text-gray-400">
                              <Download className="w-3 h-3" />
                            </a>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}

              {dir?.entries.length === 0 && !isLoading && (
                <p className="text-center py-12 text-gray-600 text-sm">Empty folder</p>
              )}
            </div>

            <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex items-center gap-3">
              <span>{dir?.entries.length ?? 0} items</span>
              {playingPath && (
                <span className="text-emerald-400 flex items-center gap-1.5">
                  <Play className="w-3 h-3" />
                  {playingPath.split("/").pop()}
                  <button onClick={() => { audio?.pause(); setPlayingPath(null); setAudio(null); }}
                    className="hover:text-white ml-1">✕</button>
                </span>
              )}
            </div>
          </div>

          {/* Preview panel */}
          {preview && (
            <div className="w-[480px] shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col">
              <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                  <span className="text-xs text-gray-300 font-mono truncate">{preview.path.split("/").pop()}</span>
                  <span className="text-[10px] text-gray-600 shrink-0 uppercase">{preview.format}</span>
                </div>
                <button onClick={() => setPreview(null)} className="text-gray-600 hover:text-gray-300 shrink-0 ml-2">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <TranscriptContent content={preview.content} format={preview.format} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
