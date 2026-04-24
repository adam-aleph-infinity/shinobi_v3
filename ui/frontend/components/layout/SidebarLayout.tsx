"use client";
import { useState, useEffect } from "react";
import AppSidebar from "./AppSidebar";
import CopilotDock from "./CopilotDock";
import { ContextBar } from "./ContextBar";
import { PanelLeftOpen } from "lucide-react";
import { DragHandle } from "@/components/shared/DragHandle";
import { cn } from "@/lib/utils";

const SIDEBAR_WIDTH = 224;
const COPILOT_DEFAULT_WIDTH = 304;
const COPILOT_MIN_WIDTH = 280;
const COPILOT_MAX_WIDTH = 520;
const MIN_CONTENT_WIDTH = 560;

function clampCopilotWidth(raw: number, sidebarCollapsed: boolean): number {
  const hardClamped = Math.min(COPILOT_MAX_WIDTH, Math.max(COPILOT_MIN_WIDTH, raw));
  if (typeof window === "undefined") return hardClamped;
  const sidebarSpace = sidebarCollapsed ? 0 : SIDEBAR_WIDTH;
  const viewportMax = Math.max(COPILOT_MIN_WIDTH, window.innerWidth - sidebarSpace - MIN_CONTENT_WIDTH);
  return Math.min(hardClamped, viewportMax);
}

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [copilotCollapsed, setCopilotCollapsed] = useState(false);
  const [copilotWidth, setCopilotWidth] = useState(COPILOT_DEFAULT_WIDTH);
  const [resizingCopilot, setResizingCopilot] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const savedSidebarCollapsed = localStorage.getItem("sidebar-collapsed") === "true";
    const savedCopilotCollapsed = localStorage.getItem("copilot-collapsed") === "true";
    const rawSavedWidth = Number(localStorage.getItem("copilot-width"));

    setCollapsed(savedSidebarCollapsed);
    setCopilotCollapsed(savedCopilotCollapsed);
    if (Number.isFinite(rawSavedWidth) && rawSavedWidth > 0) {
      setCopilotWidth(clampCopilotWidth(rawSavedWidth, savedSidebarCollapsed));
    }

    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem("copilot-width", String(copilotWidth));
  }, [copilotWidth, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const onResize = () => {
      setCopilotWidth((current) => clampCopilotWidth(current, collapsed));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [collapsed, mounted]);

  const toggleSidebar = () => {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem("sidebar-collapsed", String(next));
      setCopilotWidth((current) => clampCopilotWidth(current, next));
      return next;
    });
  };

  const toggleCopilot = () => {
    setCopilotCollapsed(c => {
      const next = !c;
      localStorage.setItem("copilot-collapsed", String(next));
      return next;
    });
  };

  const startCopilotResize = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const panelLeft = collapsed ? 0 : SIDEBAR_WIDTH;
    setResizingCopilot(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const next = clampCopilotWidth(ev.clientX - panelLeft, collapsed);
      setCopilotWidth(next);
    };
    const onUp = () => {
      setResizingCopilot(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const sidebarOffset = mounted ? (collapsed ? 0 : SIDEBAR_WIDTH) : SIDEBAR_WIDTH;
  const copilotOffset = mounted ? (copilotCollapsed ? 0 : copilotWidth) : COPILOT_DEFAULT_WIDTH;
  const contentOffset = sidebarOffset + copilotOffset;

  return (
    <>
      {/* Sidebar — hidden until mounted to avoid hydration mismatch */}
      {!mounted && <div className="fixed left-0 top-0 h-screen w-56 bg-gray-900 border-r border-gray-800 z-40" />}
      {!mounted && (
        <div
          className="fixed top-0 h-screen bg-gray-900 border-r border-gray-800 z-30"
          style={{ left: SIDEBAR_WIDTH, width: COPILOT_DEFAULT_WIDTH }}
        />
      )}
      {mounted && collapsed && (
        <button
          onClick={toggleSidebar}
          className="fixed top-4 left-4 z-50 p-1.5 rounded-md bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          title="Show sidebar"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}
      {mounted && !collapsed && <AppSidebar onToggle={toggleSidebar} />}

      {mounted && copilotCollapsed && (
        <button
          onClick={toggleCopilot}
          className="fixed top-4 z-50 p-1.5 rounded-md bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          style={{ left: collapsed ? 56 : SIDEBAR_WIDTH + 8 }}
          title="Show copilot panel"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}
      {mounted && !copilotCollapsed && (
        <div className="fixed top-0 h-screen z-30" style={{ left: collapsed ? 0 : SIDEBAR_WIDTH, width: copilotWidth }}>
          <CopilotDock onToggle={toggleCopilot} />
          <div className={cn("absolute top-0 right-0 h-full translate-x-1/2 z-40", resizingCopilot && "bg-indigo-500/20")}>
            <DragHandle onMouseDown={startCopilotResize} />
          </div>
        </div>
      )}

      {/* Main content — always same structure so React doesn't remount children */}
      <div className={cn("transition-[margin] duration-200", resizingCopilot && "transition-none")} style={{ marginLeft: contentOffset }}>
        <div className="sticky top-0 z-30">
          {mounted && <ContextBar />}
        </div>
        <main className="min-h-screen p-6">
          {children}
        </main>
      </div>
    </>
  );
}
