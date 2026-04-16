"use client";
import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronUp, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Section parsing ────────────────────────────────────────────────────────────

export interface Section { heading: string; level: number; body: string; children: Section[]; }

export function parseSections(content: string): Section[] {
  const flat: Section[] = [];

  // Strategy 1: markdown headings (## Title)
  const mdParts = content.split(/^(#{1,6}\s+.+)$/m);
  if (mdParts.length > 1) {
    for (let i = 1; i < mdParts.length; i += 2) {
      const m = mdParts[i].match(/^(#{1,6})\s+(.*)/);
      if (m) flat.push({ level: m[1].length, heading: m[2].trim(), body: (mdParts[i + 1] ?? "").trim(), children: [] });
    }
  } else {
    // Strategy 2: numbered sections + titled blocks (no # syntax)
    const lines = content.split("\n");
    let h = "", lv = 0, buf: string[] = [], open = false;
    const flush = () => { if (open) flat.push({ heading: h, level: lv, body: buf.join("\n").trim(), children: [] }); };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const t = raw.trim();
      const prev = (lines[i - 1] ?? "").trim();
      const next = (lines[i + 1] ?? "").trim();
      if (!t) { if (open) buf.push(raw); continue; }

      let head = false, headTxt = t, headLv = 2;
      const numM = raw.match(/^(\d+)\.\s+(.+)/);
      if (numM && t.length < 120) {
        head = true; headTxt = numM[2].trim(); headLv = 1;
      } else if (/^Call \d+$/.test(raw)) {
        head = true; headTxt = t; headLv = 2;
      } else if (
        !raw.match(/^\s/) &&
        !t.startsWith("-") && !t.startsWith("*") &&
        t.length < 120 && !t.endsWith(".") && !t.endsWith(",") &&
        (prev === "" || next.startsWith("-") || next.startsWith("*"))
      ) {
        head = true; headTxt = t; headLv = 2;
      }
      if (head) { flush(); h = headTxt; lv = headLv; buf = []; open = true; }
      else if (open) buf.push(raw);
    }
    flush();
  }

  if (flat.length === 0) return [];

  // Build tree — nest each section under the nearest ancestor with a lower level
  const roots: Section[] = [];
  const stack: Section[] = [];
  for (const s of flat) {
    while (stack.length > 0 && stack[stack.length - 1].level >= s.level) stack.pop();
    if (stack.length === 0) roots.push(s);
    else stack[stack.length - 1].children.push(s);
    stack.push(s);
  }
  return roots;
}

// ── Colors ────────────────────────────────────────────────────────────────────

export const SECTION_COLORS = [
  { border: "border-teal-700/40",   header: "bg-teal-900/25",   text: "text-teal-300",   badge: "bg-teal-800/40 border-teal-600/40" },
  { border: "border-violet-700/40", header: "bg-violet-900/25", text: "text-violet-300", badge: "bg-violet-800/40 border-violet-600/40" },
  { border: "border-sky-700/40",    header: "bg-sky-900/25",    text: "text-sky-300",    badge: "bg-sky-800/40 border-sky-600/40" },
  { border: "border-amber-700/40",  header: "bg-amber-900/25",  text: "text-amber-300",  badge: "bg-amber-800/40 border-amber-600/40" },
  { border: "border-rose-700/40",   header: "bg-rose-900/25",   text: "text-rose-300",   badge: "bg-rose-800/40 border-rose-600/40" },
  { border: "border-indigo-700/40", header: "bg-indigo-900/25", text: "text-indigo-300", badge: "bg-indigo-800/40 border-indigo-600/40" },
];

// ── SectionCard ───────────────────────────────────────────────────────────────

export function SectionCard({ section, colorIdx, depth, expandTick = 0, collapseTick = 0 }: {
  section: Section; colorIdx: number; depth: number; expandTick?: number; collapseTick?: number;
}) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const color = SECTION_COLORS[colorIdx % SECTION_COLORS.length];
  const isRoot = depth === 0;
  const hasContent = !!(section.body || section.children.length > 0);

  useEffect(() => { if (expandTick > 0) setOpen(true); }, [expandTick]);
  useEffect(() => { if (collapseTick > 0) setOpen(false); }, [collapseTick]);

  function copy() {
    navigator.clipboard.writeText(`${"#".repeat(Math.max(1, section.level))} ${section.heading}\n\n${section.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={cn(
      isRoot ? cn("border rounded-xl overflow-hidden", color.border) : cn("border-l-2", color.border),
    )}>
      {/* Header */}
      <div className={cn("flex items-center gap-2 px-3 py-1.5", isRoot ? color.header : "")}>
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
          <span className={cn("text-[10px] font-bold font-mono tabular-nums shrink-0", color.text)}>§{colorIdx + 1}</span>
          <span className={cn("flex-1 truncate font-semibold", isRoot ? "text-[11px]" : "text-[10px]", color.text)}>{section.heading}</span>
        </button>
        <span className={cn("text-[9px] px-1 py-0.5 rounded border font-mono shrink-0", color.text, color.badge)}>h{section.level}</span>
        <button onClick={copy} className={cn("p-1 rounded transition-colors hover:bg-gray-700/40 shrink-0", copied ? color.text : "text-gray-600")} title="Copy section">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
        {hasContent && (
          <button onClick={() => setOpen(o => !o)} className="text-gray-600 hover:text-gray-400 transition-colors shrink-0">
            {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}
      </div>
      {/* Body + nested children */}
      {open && hasContent && (
        <div className={cn(isRoot && "bg-gray-950")}>
          {section.body && (
            <div className={cn("px-3 text-xs text-gray-300", isRoot ? "pt-2 pb-2" : "pt-1 pb-1")}>
              <div className="prose prose-invert prose-xs max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body}</ReactMarkdown>
              </div>
            </div>
          )}
          {section.children.length > 0 && (
            <div className={cn("space-y-1.5", isRoot ? "px-3 pb-3" : "pl-3 pb-2")}>
              {section.children.map((child, ci) => (
                <SectionCard
                  key={ci}
                  section={child}
                  colorIdx={colorIdx + ci + 1}
                  depth={depth + 1}
                  expandTick={expandTick}
                  collapseTick={collapseTick}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── SectionContent ────────────────────────────────────────────────────────────
// Drop-in renderer: uses section cards when parseable, falls back to markdown.

export function SectionContent({ content, format = "markdown", expandTick = 0, collapseTick = 0 }: {
  content: string;
  format?: string;
  expandTick?: number;
  collapseTick?: number;
}) {
  if (format === "json") {
    return (
      <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-green-300 overflow-x-auto">
        {content}
      </pre>
    );
  }

  const sections = parseSections(content);

  if (sections.length > 0) {
    return (
      <div className="space-y-2">
        {sections.map((s, i) => (
          <SectionCard key={i} section={s} colorIdx={i} depth={0} expandTick={expandTick} collapseTick={collapseTick} />
        ))}
      </div>
    );
  }

  return (
    <div className="prose prose-invert prose-xs max-w-none text-xs text-gray-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
