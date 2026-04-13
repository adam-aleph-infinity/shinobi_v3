"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Users, FileText, BarChart3, Terminal,
  FolderOpen, Bot, PanelLeftClose, Settings,
} from "lucide-react";
import { SyncButton } from "./SyncButton";

interface NavItem {
  href: string;
  icon: React.ElementType;
  label: string;
  sub?: boolean;
}

const navItems: NavItem[] = [
  { href: "/crm",               icon: Users,     label: "CRM Browser" },
  { href: "/full-persona-agent",icon: Bot,       label: "Full Persona Agent" },
  { href: "/personas",          icon: FileText,  label: "Personas" },
  { href: "/agent-comparison",  icon: BarChart3, label: "Compare Agents" },
  { href: "/agent-dashboard",   icon: BarChart3, label: "Agent Dashboard" },
  { href: "/calls",             icon: FileText,  label: "Calls" },
];

function BackendStatus() {
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/health", { signal: AbortSignal.timeout(2000) })
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
        "w-2 h-2 rounded-full flex-shrink-0",
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

export default function AppSidebar({ onToggle, extraFooter }: {
  onToggle?: () => void;
  extraFooter?: React.ReactNode;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/personas" || href === "/calls"
      ? pathname === href
      : pathname.startsWith(href);

  const NavLink = ({ href, icon: Icon, label }: NavItem) => (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
        isActive(href)
          ? "bg-indigo-600 text-white"
          : "text-gray-400 hover:text-white hover:bg-gray-800"
      )}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      {label}
    </Link>
  );

  return (
    <aside className="fixed left-0 top-0 h-screen w-56 bg-gray-900 border-r border-gray-800 flex flex-col z-40">
      {/* Logo */}
      <div className="p-4 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Image src="/shinobilookintothefuture.png" alt="Shinobi" width={120} height={32} className="object-contain" style={{ maxHeight: 32 }} />
          {onToggle && (
            <button onClick={onToggle} className="ml-auto p-1 rounded text-gray-600 hover:text-gray-400 transition-colors" title="Collapse sidebar">
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {navItems.map(item => <NavLink key={item.href} {...item} />)}
      </nav>

      <div className="p-3 border-t border-gray-800 space-y-1.5">
        <BackendStatus />
        <SyncButton />
        <div className="flex gap-1.5">
          {([
            { href: "/logs",      icon: Terminal,   label: "Logs" },
            { href: "/workspace", icon: FolderOpen, label: "Workspace" },
            { href: "/settings",  icon: Settings,   label: "Settings" },
          ] as NavItem[]).map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors",
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
        {extraFooter}
        <p className="text-xs text-gray-700">© 2026 Shinobi · v1.0.0</p>
      </div>
    </aside>
  );
}
