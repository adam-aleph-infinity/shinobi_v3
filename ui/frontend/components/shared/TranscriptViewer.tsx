"use client";

// Shared transcript rendering — used by /transcription, /transcription/final, /workspace, etc.
//
// ALL formats (SRT, JSON words, plain text) are normalised to the same "Turn" structure
// and rendered with the same left-border bubble layout.
// Timestamps come from the source when available; plain-text turns show "#N" instead.

// ── Turn colors (2 speakers = teal/violet, more = orange/blue/pink) ──────────

const TURN_COLORS = [
  { border: "border-l-teal-500",   name: "text-teal-400",   bg: "bg-teal-950/40"   },
  { border: "border-l-violet-500", name: "text-violet-400", bg: "bg-violet-950/40" },
  { border: "border-l-orange-500", name: "text-orange-400", bg: "bg-orange-950/30" },
  { border: "border-l-blue-500",   name: "text-blue-400",   bg: "bg-blue-950/30"   },
  { border: "border-l-pink-500",   name: "text-pink-400",   bg: "bg-pink-950/30"   },
];

// ── Shared Turn type ──────────────────────────────────────────────────────────

interface Turn {
  speaker: string;
  text: string;
  time?: string;          // "M:SS" or "HH:MM:SS" string — undefined if not available
  lowConf?: boolean;      // true if any word in this turn has low confidence
}

// ── Time formatters ───────────────────────────────────────────────────────────

function secsToTs(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Strip SRT timestamp to "HH:MM:SS" (drop milliseconds)
function srtTs(raw: string): string {
  return raw.split(",")[0].replace(/^0:/, "").replace(/^00:/, "") || raw;
}

// ── Format-specific parsers → Turn[] ─────────────────────────────────────────

function parseSrtTurns(content: string): Turn[] {
  const raw = content.trim().split(/\n\n+/).map(block => {
    const lines = block.split("\n");
    const timeStr = lines[1] || "";
    const startRaw = timeStr.split(" --> ")[0] || "";
    const text = lines.slice(2).join(" ").trim();
    const m = text.match(/^\[([^\]]+)\]:\s*([\s\S]*)/) ?? text.match(/^([^\n:]{1,60}):\s+([\s\S]+)/);
    return {
      speaker: m?.[1]?.trim() ?? "",
      text: m ? m[2].trim() : text,
      time: startRaw ? srtTs(startRaw) : undefined,
    };
  }).filter(b => b.text);

  // Merge consecutive same-speaker turns
  const merged: Turn[] = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === b.speaker) {
      last.text += " " + b.text;
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}

function parsePlainTurns(content: string): Turn[] {
  const turns: Turn[] = [];
  const blocks = content.trim().split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // smoothed.txt: **Speaker (Role):** text
    const mb = trimmed.match(/^\*\*([^*]+?)(?:\s*\([^)]+\))?\*\*:\s+([\s\S]+)/);
    if (mb) { turns.push({ speaker: mb[1].trim(), text: mb[2].trim() }); continue; }
    // [M:SS] or [H:MM:SS] Speaker: text  (timestamps preserved from SRT source)
    const mt = trimmed.match(/^\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s+([^\n:]{1,60}):\s+([\s\S]+)/);
    if (mt) { turns.push({ speaker: mt[2].trim(), text: mt[3].trim(), time: mt[1] }); continue; }
    const m = trimmed.match(/^([^\n:]{1,60}):\s+([\s\S]+)/);
    if (m) {
      turns.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (turns.length) {
      turns[turns.length - 1].text += "\n" + trimmed;
    } else {
      turns.push({ speaker: "", text: trimmed });
    }
  }
  return turns;
}

interface Word { word: string; start?: number; end?: number; speaker?: string; confidence?: number; }
interface Seg  { start: number; end: number; text: string; speaker?: string; }

function confOk(c: number | undefined) { return c === undefined || c >= 0.75; }

// "speaker_0" → "Speaker 0", "A" → "Speaker A", etc.
function normSpk(raw: string): string {
  return raw
    .replace(/^speaker_(\d+)$/i, (_, n) => `Speaker ${n}`)
    .replace(/^([A-Z])$/, "Speaker $1")
    .replace(/_/g, " ");
}

function parseJsonTurns(content: string): Turn[] | null {
  try {
    const parsed = JSON.parse(content);
    const words: Word[] | undefined = Array.isArray(parsed?.words) ? parsed.words : undefined;

    // ── ElevenLabs / any engine: per-word speaker labels ──────────────────
    if (words && words.length > 0 && words[0].speaker !== undefined) {
      const turns: Turn[] = [];
      for (const w of words) {
        if (!w.word?.trim()) continue;
        const spk = normSpk(w.speaker ?? "unknown");
        const last = turns[turns.length - 1];
        if (last && last.speaker === spk) {
          last.text += " " + w.word.trim();
          if (!confOk(w.confidence)) last.lowConf = true;
        } else {
          turns.push({
            speaker: spk,
            text: w.word.trim(),
            time: w.start !== undefined ? secsToTs(w.start) : undefined,
            lowConf: !confOk(w.confidence),
          });
        }
      }
      return turns.map(t => ({ ...t, text: t.text.trim() }));
    }

    // ── GPT-4o / confidence-only words (no speaker) ───────────────────────
    if (words && words.length > 0 && words[0].confidence !== undefined) {
      // Suppress timestamps if ALL words have start=0,end=0 (GPT-4o returns zeros)
      const hasRealTs = words.some(w => (w.start ?? 0) > 0 || (w.end ?? 0) > 0);
      const makeTime = (w: Word) => (hasRealTs && w.start !== undefined) ? secsToTs(w.start) : undefined;
      const turns: Turn[] = [];
      let cur: Turn = { speaker: "", text: "", time: makeTime(words[0]) };
      for (const w of words) {
        if (!w.word) continue;
        if (w.word.includes("\n\n") && cur.text.trim()) {
          turns.push({ ...cur, text: cur.text.trim() });
          cur = { speaker: "", text: "", time: makeTime(w) };
        } else {
          cur.text += w.word + " ";
        }
      }
      if (cur.text.trim()) turns.push({ ...cur, text: cur.text.trim() });
      return turns;
    }

    // ── Segment-based diarization ─────────────────────────────────────────
    if (Array.isArray(parsed?.segments) && parsed.segments.length > 0) {
      const turns: Turn[] = [];
      for (const s of parsed.segments as Seg[]) {
        const spk = normSpk(s.speaker ?? "");
        const last = turns[turns.length - 1];
        if (last && last.speaker === spk && s.start - (last as any)._end < 1.5) {
          last.text += " " + s.text.trim();
          (last as any)._end = s.end;
        } else {
          const t: any = { speaker: spk, text: s.text.trim(), time: secsToTs(s.start), _end: s.end };
          turns.push(t);
        }
      }
      return turns;
    }

    // ── Voted words top-level array ───────────────────────────────────────
    if (Array.isArray(parsed) && parsed[0]?.word !== undefined) {
      const turns: Turn[] = [];
      for (const w of parsed as Word[]) {
        if (!w.word?.trim()) continue;
        const spk = normSpk(w.speaker ?? "unknown");
        const last = turns[turns.length - 1];
        if (last && last.speaker === spk) {
          last.text += " " + w.word.trim();
        } else {
          turns.push({ speaker: spk, text: w.word.trim(), time: w.start !== undefined ? secsToTs(w.start) : undefined });
        }
      }
      return turns.map(t => ({ ...t, text: t.text.trim() }));
    }

    // ── Plain text field (Gemini / fallback) ──────────────────────────────
    const text: string = parsed?.text ?? "";
    if (text) {
      const lines = text.split("\n").filter(Boolean);
      const turns: Turn[] = [];
      for (const line of lines) {
        // "[M:SS] or [HH:MM:SS] Speaker: text" format
        const m = line.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+([^:]+):\s*(.*)/);
        if (m) {
          turns.push({ speaker: m[2].trim(), text: m[3], time: m[1] });
        } else {
          const m2 = line.match(/^([^\n:]{1,60}):\s+([\s\S]+)/);
          if (m2) turns.push({ speaker: m2[1].trim(), text: m2[2].trim() });
          else if (turns.length) turns[turns.length - 1].text += " " + line;
          else turns.push({ speaker: "", text: line });
        }
      }
      return turns;
    }
  } catch { /* fall through */ }
  return null;
}

// ── Universal turn bubble renderer ────────────────────────────────────────────

function TurnBubbleList({ turns }: { turns: Turn[] }) {
  const speakers: string[] = [];
  for (const t of turns) {
    if (t.speaker && !speakers.includes(t.speaker)) speakers.push(t.speaker);
  }
  return (
    <div className="space-y-2">
      {turns.map((t, i) => {
        const ci = speakers.indexOf(t.speaker);
        const col = TURN_COLORS[Math.max(0, ci) % TURN_COLORS.length];
        const timeLabel = t.time ?? `#${i + 1}`;
        return (
          <div key={i} className={`border-l-2 pl-3 py-2 rounded-r-md ${col.border} ${col.bg}`}>
            <div className="flex items-center gap-2 mb-1">
              {t.speaker && (
                <span className={`text-[10px] font-bold uppercase tracking-wider ${col.name}`}>
                  {t.speaker}
                </span>
              )}
              <span className="text-[9px] font-mono text-gray-600">{timeLabel}</span>
            </div>
            <p className="text-xs text-gray-200 leading-relaxed whitespace-pre-wrap">{t.text}</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Public components ─────────────────────────────────────────────────────────

/** Renders any transcript (SRT / JSON / plain Speaker: text / raw) in a unified bubble format. */
export function TranscriptViewer({
  content,
  format,
  className = "max-h-96",
}: {
  content: string;
  format?: string;
  className?: string;
}) {
  if (!content.trim()) return <p className="text-xs text-gray-600 italic">Empty</p>;

  const trimmed = content.trimStart();
  const fmt = format ?? (
    content.includes("-->") ? "srt" :
    (trimmed.startsWith("{") || trimmed.startsWith("[")) ? "json" :
    "plain"
  );

  let turns: Turn[] | null = null;

  if (fmt === "srt") {
    turns = parseSrtTurns(content);
  } else if (fmt === "json") {
    turns = parseJsonTurns(content);
  }

  if (!turns) {
    // Plain text or JSON fallback
    turns = parsePlainTurns(content);
  }

  if (turns.length === 0) {
    return (
      <pre className={`text-xs text-gray-300 font-mono leading-relaxed whitespace-pre-wrap overflow-y-auto overscroll-contain h-full min-h-0 ${className}`}>
        {content}
      </pre>
    );
  }

  // If no speaker info at all, render as raw pre
  if (!turns.some(t => t.speaker)) {
    return (
      <pre className={`text-xs text-gray-300 font-mono leading-relaxed whitespace-pre-wrap overflow-y-auto overscroll-contain h-full min-h-0 ${className}`}>
        {content}
      </pre>
    );
  }

  return (
    <div className={`overflow-y-auto overscroll-contain h-full min-h-0 pr-1 ${className}`}>
      <TurnBubbleList turns={turns} />
    </div>
  );
}

/** Legacy export — wraps TranscriptViewer for backwards compatibility. */
export function TranscriptContent({ content, format }: { content: string; format: string }) {
  return <TranscriptViewer content={content} format={format} className="" />;
}
