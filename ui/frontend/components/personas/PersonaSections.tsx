"use client";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  TrendingUp, Shield, MessageCircle, Users, Star,
  Activity, Brain, Zap, Copy, Check, ChevronDown, ChevronUp,
} from "lucide-react";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Category metadata ────────────────────────────────────────────────────────

export const CATEGORIES = [
  {
    test: (t: string) => /sales|tactic|technique|closing|objection|upsell|pitch|persuasion|pressure/i.test(t),
    meta: { icon: TrendingUp, label: "Sales", border: "border-l-amber-500", bg: "bg-amber-500/5", title: "text-amber-400", badge: "bg-amber-500/10 text-amber-300 border-amber-500/20" },
  },
  {
    test: (t: string) => /compliance|risk|legal|disclosure|flag|warning|regulation|script/i.test(t),
    meta: { icon: Shield, label: "Compliance", border: "border-l-red-500", bg: "bg-red-500/5", title: "text-red-400", badge: "bg-red-500/10 text-red-300 border-red-500/20" },
  },
  {
    test: (t: string) => /communication|style|tone|language|vocabulary|empathy|rapport|conversation/i.test(t),
    meta: { icon: MessageCircle, label: "Communication", border: "border-l-blue-500", bg: "bg-blue-500/5", title: "text-blue-400", badge: "bg-blue-500/10 text-blue-300 border-blue-500/20" },
  },
  {
    test: (t: string) => /customer|relationship|adapt|behavior|client|individual|specific|approach/i.test(t),
    meta: { icon: Users, label: "Customer", border: "border-l-emerald-500", bg: "bg-emerald-500/5", title: "text-emerald-400", badge: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20" },
  },
  {
    test: (t: string) => /strength|weakness|improvement|area|performance|assessment|evaluation/i.test(t),
    meta: { icon: Star, label: "Assessment", border: "border-l-yellow-500", bg: "bg-yellow-500/5", title: "text-yellow-400", badge: "bg-yellow-500/10 text-yellow-300 border-yellow-500/20" },
  },
  {
    test: (t: string) => /pattern|habit|recurring|tendency|consistent|key|summary|overview/i.test(t),
    meta: { icon: Activity, label: "Patterns", border: "border-l-indigo-500", bg: "bg-indigo-500/5", title: "text-indigo-400", badge: "bg-indigo-500/10 text-indigo-300 border-indigo-500/20" },
  },
  {
    test: (t: string) => /recommend|action|improve|next|step|coaching/i.test(t),
    meta: { icon: Zap, label: "Actions", border: "border-l-violet-500", bg: "bg-violet-500/5", title: "text-violet-400", badge: "bg-violet-500/10 text-violet-300 border-violet-500/20" },
  },
];

export const DEFAULT_META = {
  icon: Brain, label: "Overview",
  border: "border-l-gray-600", bg: "bg-gray-800/30",
  title: "text-gray-300", badge: "bg-gray-700/60 text-gray-400 border-gray-600",
};

export function getCategoryMeta(title: string) {
  return CATEGORIES.find(c => c.test(title))?.meta ?? DEFAULT_META;
}

// ── Markdown section parser ──────────────────────────────────────────────────

export interface Section { title: string; content: string }

export function parsePersonaSections(md: string): Section[] {
  const lines = md.split("\n");

  // Does this persona use proper markdown headers?
  const hasMarkdownHeaders = lines.some(l => /^#{1,2}\s+/.test(l));

  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);

    // Fallback: plain numbered headings ("1. General Process Flow") only when
    // the LLM produced no ## headers (e.g. some custom presets use numbered text).
    // Trim each line first to handle trailing spaces and CRLF.
    const trimmed = line.trimEnd();
    const numbered =
      !hasMarkdownHeaders &&
      !h1 &&
      !h2 &&
      !trimmed.endsWith(":") &&
      trimmed.match(/^(\d{1,2})\.\s+([A-Z].{3,})$/);

    if (h2 || h1 || numbered) {
      if (current?.content.trim()) sections.push(current);
      const title = h2
        ? h2[1].trim()
        : h1
        ? h1[1].trim()
        : (numbered as RegExpMatchArray)[2].trim();
      current = { title, content: "" };
    } else {
      if (!current) current = { title: "Overview", content: "" };
      current.content += line + "\n";
    }
  }
  if (current?.content.trim()) sections.push(current);
  return sections.filter(s => s.content.trim());
}

// ── Markdown component overrides ─────────────────────────────────────────────

export const MD: Record<string, React.ElementType> = {
  p:      ({ children }) => <p className="text-[13px] text-gray-300 leading-relaxed mb-2 last:mb-0">{children}</p>,
  ul:     ({ children }) => <ul className="space-y-1 mb-2 last:mb-0">{children}</ul>,
  ol:     ({ children }) => <ol className="list-decimal list-inside space-y-1 mb-2 text-[13px] text-gray-300 last:mb-0">{children}</ol>,
  li:     ({ children }) => (
    <li className="flex items-start gap-2 text-[13px] text-gray-300 leading-relaxed">
      <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
      <span>{children}</span>
    </li>
  ),
  strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
  em:     ({ children }) => <em className="text-gray-400 not-italic">{children}</em>,
  h3:     ({ children }) => <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mt-3 mb-1.5 first:mt-0">{children}</h3>,
  h4:     ({ children }) => <h4 className="text-[11px] font-medium text-gray-500 mt-2 mb-1">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-700 pl-3 my-2 text-gray-400 text-[13px] italic">{children}</blockquote>
  ),
  hr: () => <hr className="border-gray-800 my-3" />,
};

// ── Section card ─────────────────────────────────────────────────────────────

export function SectionCard({ section, fullWidth, score }: { section: Section; fullWidth?: boolean; score?: number }) {
  const meta = getCategoryMeta(section.title);
  const Icon = meta.icon;
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(`## ${section.title}\n\n${section.content}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div id={slugify(section.title)} className={`border border-gray-800 border-l-4 ${meta.border} ${meta.bg} rounded-xl overflow-hidden flex flex-col${fullWidth ? " col-span-2" : ""}`}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-800/60 shrink-0">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${meta.title}`} />
        <h3 className={`text-sm font-semibold flex-1 ${meta.title}`}>{section.title}</h3>
        {score != null && (
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold tabular-nums shrink-0 ${
            score >= 75 ? "bg-emerald-500/15 text-emerald-400" :
            score >= 50 ? "bg-amber-500/15 text-amber-400" :
                          "bg-red-500/15 text-red-400"
          }`}>
            {score}%
          </span>
        )}
        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wide shrink-0 ${meta.badge}`}>
          {meta.label}
        </span>
        <button onClick={copy} className="p-1 text-gray-700 hover:text-gray-400 transition-colors shrink-0">
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
        </button>
        <button onClick={() => setCollapsed(c => !c)} className="p-1 text-gray-700 hover:text-gray-400 transition-colors shrink-0">
          {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </button>
      </div>
      {!collapsed && (
        <div className="px-4 py-3 flex-1">
          <ReactMarkdown components={MD as never}>{section.content.trim()}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ── Section nav (one button per section) ─────────────────────────────────────

function shortSectionTitle(title: string): string {
  return title
    .replace(/^[\d]+\.\s+/, "")   // "1. Sales..." → "Sales..."
    .replace(/^[A-Z]+\.\s+/, "")  // "A. Relationship..." → "Relationship..."
    .replace(/\s*[&–]\s*.+$/, "") // "Sales & Tactics" → "Sales"
    .split(/\s+/).slice(0, 3).join(" ");
}

export function SectionNav({ sections }: { sections: Section[] }) {
  if (sections.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-3 pb-3 border-b border-gray-800/60">
      {sections.map((s, i) => {
        const meta = getCategoryMeta(s.title);
        const Icon = meta.icon;
        return (
          <button
            key={i}
            title={s.title}
            onClick={() => {
              const el = document.getElementById(slugify(s.title));
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-medium transition-opacity hover:opacity-70 ${meta.badge}`}
          >
            <Icon className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate max-w-[72px]">{shortSectionTitle(s.title)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Category legend (kept for backward compat) ────────────────────────────────

export function CategoryLegend({ sections }: { sections: Section[] }) {
  const seen = new Map<string, typeof DEFAULT_META>();
  for (const s of sections) {
    const meta = getCategoryMeta(s.title);
    if (!seen.has(meta.label)) seen.set(meta.label, meta);
  }
  if (seen.size <= 1) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-4">
      {Array.from(seen.entries()).map(([label, meta]) => {
        const Icon = meta.icon;
        const targetSection = sections.find(s => getCategoryMeta(s.title).label === label);
        return (
          <span
            key={label}
            onClick={() => {
              if (!targetSection) return;
              const el = document.getElementById(slugify(targetSection.title));
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium cursor-pointer hover:opacity-70 transition-opacity ${meta.badge}`}
          >
            <Icon className="w-2.5 h-2.5" /> {label}
          </span>
        );
      })}
    </div>
  );
}
