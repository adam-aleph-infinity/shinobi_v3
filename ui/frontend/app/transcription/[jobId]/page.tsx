"use client";
import { useState } from "react";
import useSWR from "swr";
import { getJob, getTranscriptSources, getSrtVariants, getFinalSrt, runEnsembleMerge } from "@/lib/api";
import { Job, TranscriptSource } from "@/lib/types";
import { useJobStream } from "@/lib/sse";
import StatusBadge from "@/components/shared/StatusBadge";
import { CheckCircle2, Circle, Loader2, ChevronLeft, Wand2 } from "lucide-react";
import Link from "next/link";

const STAGES = [
  { num: 1, label: "Audio Preprocessing" },
  { num: 2, label: "Transcription (6 engines)" },
  { num: 4, label: "LLM Merge & Voting" },
  { num: 5, label: "Analysis & Report" },
];

export default function JobDetailPage({ params }: { params: { jobId: string } }) {
  const { jobId } = params;
  const [activeEngine, setActiveEngine] = useState("final");
  const [merging, setMerging] = useState(false);

  const { data: job } = useSWR<Job>(`/jobs/${jobId}`, () => getJob(jobId) as Promise<Job>, {
    refreshInterval: (j) => (j?.status === "running" ? 2000 : 0),
  });

  const { events, isComplete, latestPct, latestStage } = useJobStream(
    job?.status === "running" ? jobId : null
  );

  const isDone = job?.status === "complete" || job?.status === "failed";

  const { data: sources } = useSWR(
    isDone ? `/transcripts/${jobId}/sources` : null,
    () => getTranscriptSources(jobId) as Promise<Record<string, TranscriptSource>>
  );

  const { data: variants } = useSWR(
    isDone ? `/transcripts/${jobId}/variants` : null,
    () => getSrtVariants(jobId) as Promise<string[]>
  );

  const { data: srtData, mutate: mutateSrt } = useSWR(
    isDone ? `/transcripts/${jobId}/final?variant=${activeEngine}` : null,
    () => getFinalSrt(jobId, activeEngine) as Promise<{ srt_content: string; entry_count: number }>
  );

  const handleMerge = async () => {
    setMerging(true);
    try {
      await runEnsembleMerge(jobId, { model: "gpt-4o", prompt_version: 1, speaker_a: job?.speaker_a, speaker_b: job?.speaker_b });
      mutateSrt();
    } finally {
      setMerging(false);
    }
  };

  const currentStage = job?.status === "running" ? latestStage : (isDone ? 5 : 0);
  const displayPct = job?.status === "running" ? latestPct : (isDone ? 100 : 0);

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Link href="/transcription" className="hover:text-gray-300">Transcription</Link>
        <span>/</span>
        <span className="text-white font-mono text-xs">{jobId.slice(0, 8)}…</span>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">{job?.call_id || "Job"}</h1>
        {job && <StatusBadge status={job.status} />}
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Left: Progress */}
        <div className="col-span-1 space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-4">Pipeline Progress</h2>
            <div className="space-y-3">
              {STAGES.map((stage, idx) => {
                const done = isDone || currentStage > stage.num;
                const active = currentStage === stage.num && job?.status === "running";
                return (
                  <div key={stage.num} className="flex items-start gap-3">
                    <div className="mt-0.5">
                      {done ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : active ? (
                        <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                      ) : (
                        <Circle className="w-4 h-4 text-gray-700" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-medium ${done ? "text-green-400" : active ? "text-indigo-300" : "text-gray-600"}`}>
                        Stage {stage.num}
                      </p>
                      <p className="text-xs text-gray-500 truncate">{stage.label}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            {job?.status === "running" && (
              <div className="mt-4">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span className="truncate">{events[events.length - 1]?.message?.slice(0, 40) || "..."}</span>
                  <span>{displayPct}%</span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${displayPct}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Engine sources */}
          {sources && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-gray-300 mb-3">Engine Sources</h2>
              <div className="space-y-1.5">
                {Object.entries(sources).map(([name, src]) => (
                  <div key={name} className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">{name}</span>
                    <span className="text-gray-600">{src.word_count.toLocaleString()} words</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Transcript viewer */}
        <div className="col-span-2">
          {isDone && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden h-full flex flex-col">
              {/* Tabs */}
              <div className="flex items-center gap-0 border-b border-gray-800 px-2 pt-2 overflow-x-auto">
                {(variants || ["final"]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setActiveEngine(v)}
                    className={`px-3 py-1.5 text-xs rounded-t font-medium whitespace-nowrap transition-colors ${
                      activeEngine === v
                        ? "bg-gray-800 text-white"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>

              {/* LLM merge button */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/50">
                <span className="text-xs text-gray-500">
                  {srtData?.entry_count} segments
                </span>
                <button
                  onClick={handleMerge}
                  disabled={merging}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-50"
                >
                  {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                  LLM Merge (gpt-4o)
                </button>
              </div>

              {/* SRT content */}
              <div className="flex-1 overflow-y-auto p-4 font-mono text-xs text-gray-300 leading-relaxed space-y-3 max-h-[60vh]">
                {srtData?.srt_content.split("\n\n").map((block, i) => {
                  const lines = block.trim().split("\n");
                  if (lines.length < 3) return null;
                  const ts = lines[1];
                  const text = lines.slice(2).join(" ");
                  const isRon = text.startsWith("[Ron]");
                  return (
                    <div key={i} className="space-y-0.5">
                      <p className="text-gray-600 text-[10px]">{ts}</p>
                      <p className={isRon ? "text-blue-300" : "text-emerald-300"}>{text}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!isDone && job?.status !== "running" && (
            <div className="flex items-center justify-center h-48 text-gray-600">
              Waiting for pipeline to start...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
