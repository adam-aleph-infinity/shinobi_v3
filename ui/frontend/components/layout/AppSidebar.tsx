"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { VERSION } from "@/lib/version";
import {
  Users, FileText, BarChart3, Terminal,
  FolderOpen, Bot, PanelLeftClose, Settings, StickyNote, DatabaseZap, GitBranch, History, Archive,
} from "lucide-react";
import { SyncButton } from "./SyncButton";

// ── Nav structure ─────────────────────────────────────────────────────────────

const GROUPS = [
  {
    label: "Browse",
    items: [
      { href: "/crm",       icon: Users,    label: "CRM Browser" },
      { href: "/calls",     icon: FileText, label: "Calls" },
      { href: "/artifacts", icon: Archive,  label: "Artifacts" },
    ],
  },
  {
    label: "Agents",
    items: [
      { href: "/agents",   icon: Bot,       label: "Agents" },
      { href: "/pipeline", icon: GitBranch, label: "Pipeline Workflow" },
      { href: "/history",  icon: History,   label: "Run History" },
    ],
  },
  {
    label: "Analyze",
    items: [
      { href: "/agent-deep-dive",  icon: BarChart3,  label: "Agent Deep Dive" },
      { href: "/agent-dashboard",  icon: BarChart3,  label: "Agent Dashboard" },
      { href: "/personas",         icon: FileText,   label: "Personas" },
      { href: "/comparison",       icon: BarChart3,  label: "Compare Personas" },
      { href: "/agent-comparison", icon: BarChart3,  label: "Compare Agents" },
    ],
  },
];

const FOOTER_ITEMS = [
  { href: "/populate",  icon: DatabaseZap, label: "Populate" },
  { href: "/logs",      icon: Terminal,    label: "Logs" },
  { href: "/workspace", icon: FolderOpen,  label: "Workspace" },
  { href: "/settings",  icon: Settings,    label: "Settings" },
];

// ── Backend status dot ────────────────────────────────────────────────────────

function BackendStatus() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/health", { signal: AbortSignal.timeout(8000) })
        .then(r => { if (!cancelled) setOk(r.ok); })
        .catch(() => { if (!cancelled) setOk(false); });
    };
    check();
    const id = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      <span className={cn(
        "w-2 h-2 rounded-full shrink-0",
        ok === null ? "bg-gray-600 animate-pulse" :
        ok ? "bg-emerald-500" : "bg-red-500 animate-pulse"
      )} />
      <span className={cn(
        "text-xs",
        ok === null ? "text-gray-600" :
        ok ? "text-gray-500" : "text-red-400"
      )}>
        {ok === null ? "connecting…" : ok ? "backend online" : "backend offline"}
      </span>
    </div>
  );
}

function SidebarClock() {
  const [localNow, setLocalNow] = useState<Date>(new Date());

  useEffect(() => {
    const id = setInterval(() => setLocalNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const localTime = localNow.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <div className="text-[10px] font-mono text-gray-500 text-right leading-none">{localTime}</div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function AppSidebar({ onToggle }: { onToggle?: () => void }) {
  const pathname = usePathname();
  const isCallsPage = pathname === "/calls";

  const isActive = (href: string) => {
    // Exact match for paths that share a prefix with others
    if (href === "/personas" || href === "/calls" || href === "/agents") return pathname === href;
    return pathname.startsWith(href);
  };

  return (
    <aside className="fixed left-0 top-0 h-screen w-56 bg-gray-900 border-r border-gray-800 flex flex-col z-40">
      {/* Logo */}
      <div className="p-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <Image src="/shinobilookintothefuture.png" alt="Shinobi" width={120} height={32}
            className="object-contain" style={{ maxHeight: 32 }} />
          {onToggle && (
            <button onClick={onToggle}
              className="ml-auto p-1 rounded text-gray-600 hover:text-gray-400 transition-colors"
              title="Collapse sidebar">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-4">
        {GROUPS.map(group => (
          <div key={group.label}>
            <p className="px-2 mb-1 text-[10px] font-semibold text-gray-600 uppercase tracking-widest">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map(({ href, icon: Icon, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                    isActive(href)
                      ? "bg-indigo-600 text-white"
                      : "text-gray-400 hover:text-white hover:bg-gray-800"
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-gray-800 shrink-0 space-y-2">
        {isCallsPage && (
          <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-2 py-2">
            <p className="text-[9px] font-semibold text-gray-600 uppercase tracking-widest mb-1">Calls badge map</p>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-[10px] text-gray-500">
                <span className="inline-flex items-center px-1 py-0.5 rounded border text-[9px] font-semibold leading-none bg-teal-900/40 text-teal-300 border-teal-700/50">Tx</span>
                <span>Transcript (per call)</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-500">
                <span className="inline-flex items-center px-1 py-0.5 rounded border text-[9px] font-semibold leading-none bg-cyan-900/40 text-cyan-300 border-cyan-700/50">Mg</span>
                <span>Merged transcript (pair)</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-500">
                <span className="inline-flex items-center px-1 py-0.5 rounded border text-[9px] font-semibold leading-none bg-emerald-900/40 text-emerald-300 border-emerald-700/50">Ag</span>
                <span>Agent output steps (pipeline)</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-gray-500">
                <span className="inline-flex items-center px-1 py-0.5 rounded border text-[9px] font-semibold leading-none bg-blue-900/40 text-blue-300 border-blue-700/50">Ar</span>
                <span>Artifact output type(s)</span>
              </div>
            </div>
          </div>
        )}
        <BackendStatus />
        <SidebarClock />
        <SyncButton />
        <div className="space-y-0.5">
          {FOOTER_ITEMS.map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors",
                isActive(href)
                  ? "bg-indigo-600 text-white"
                  : "text-gray-500 hover:text-white hover:bg-gray-800"
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {label}
            </Link>
          ))}
        </div>
        <p className="text-xs text-gray-700">© 2026 Shinobi · v{VERSION}</p>
      </div>
    </aside>
  );
}
