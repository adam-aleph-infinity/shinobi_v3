"use client";

import { useState } from "react";
import { X, Play, Loader2 } from "lucide-react";
import type { RunLaunchOptions } from "../types";

interface Props {
  open:      boolean;
  running:   boolean;
  onClose:   () => void;
  onLaunch:  (opts: RunLaunchOptions) => void;
}

export function RunLaunchModal({ open, running, onClose, onLaunch }: Props) {
  const [force,       setForce]      = useState(false);
  const [failedOnly,  setFailedOnly] = useState(false);
  const [resumeRunId, setResumeRunId]= useState("");

  if (!open) return null;

  function handleLaunch() {
    onLaunch({ force, failedOnly, resumeRunId: resumeRunId.trim() });
    onClose();
  }

  const toggleCls = (on: boolean) =>
    `w-8 h-4 rounded-full transition-colors flex items-center px-0.5 ${on ? "bg-indigo-600" : "bg-gray-700"}`;
  const thumbCls  = (on: boolean) =>
    `w-3 h-3 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0"}`;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-80 shadow-2xl"
        onClick={e => e.stopPropagation()}>

        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <div className="text-sm font-bold text-white">Run Pipeline</div>
            <div className="text-xs text-gray-500 mt-0.5">Choose execution options</div>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-500" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Force re-run */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-white font-medium">Force re-run</div>
              <div className="text-[10px] text-gray-500 mt-0.5">Bypass cache for all steps</div>
            </div>
            <button onClick={() => { setForce(f => !f); setFailedOnly(false); }}
              className={toggleCls(force)}>
              <div className={thumbCls(force)} />
            </button>
          </div>

          {/* Failed steps only */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-white font-medium">Failed steps only</div>
              <div className="text-[10px] text-gray-500 mt-0.5">Re-run only errored steps</div>
            </div>
            <button onClick={() => { setFailedOnly(f => !f); setForce(false); }}
              className={toggleCls(failedOnly)}>
              <div className={thumbCls(failedOnly)} />
            </button>
          </div>

          {/* Resume run ID */}
          <div className="space-y-1.5">
            <div className="text-xs text-white font-medium">Resume run ID <span className="text-gray-600">(optional)</span></div>
            <input
              value={resumeRunId}
              onChange={e => setResumeRunId(e.target.value)}
              placeholder="run-id to continue from…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
            />
          </div>
        </div>

        <div className="px-5 pb-5 flex gap-2">
          <button onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl py-2 text-xs text-gray-300 transition-colors">
            Cancel
          </button>
          <button onClick={handleLaunch} disabled={running}
            className="flex-1 bg-emerald-700/40 hover:bg-emerald-700/60 border border-emerald-600/50 rounded-xl py-2 text-xs text-emerald-300 font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50">
            {running
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</>
              : <><Play className="w-3.5 h-3.5" /> Launch</>}
          </button>
        </div>
      </div>
    </div>
  );
}
