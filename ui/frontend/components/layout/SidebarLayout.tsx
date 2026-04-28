"use client";
import { useState, useEffect } from "react";
import AppSidebar from "./AppSidebar";
import CopilotDock from "./CopilotDock";
import { ContextBar } from "./ContextBar";
import { PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";

const SIDEBAR_WIDTH = 224;
const TONGUE_BAR_WIDTH = 24;
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
  const pathname = usePathname();
  const [embeddedMode, setEmbeddedMode] = useState(false);
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
    if (typeof window === "undefined") return;
    const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
    setEmbeddedMode(embedded);
  }, [pathname]);

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
  const contentWidth = `calc(100vw - ${contentOffset}px)`;
  const isPipelinePage = pathname === "/pipeline";
  const showContextBar = pathname !== "/pipeline";

  if (embeddedMode) {
    return (
      <main className="h-screen w-screen overflow-hidden bg-gray-950">
        {children}
      </main>
    );
  }

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
        <div className="fixed top-0 left-0 z-50 h-screen w-6 bg-gray-900/95 border-r border-gray-800 text-gray-500 flex items-center justify-center pointer-events-none">
          <button
            onClick={toggleSidebar}
            className="pointer-events-auto p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
            title="Show sidebar"
            aria-label="Show sidebar"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
      )}
      {mounted && !collapsed && <AppSidebar onToggle={toggleSidebar} />}

      {mounted && copilotCollapsed && (
        <div
          className="fixed top-0 z-50 h-screen w-6 bg-gray-900/95 border-r border-gray-800 text-gray-500 flex items-center justify-center pointer-events-none"
          style={{ left: collapsed ? TONGUE_BAR_WIDTH : SIDEBAR_WIDTH }}
        >
          <button
            onClick={toggleCopilot}
            className="pointer-events-auto p-1 rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
            title="Show copilot panel"
            aria-label="Show copilot panel"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
      )}
      {mounted && !copilotCollapsed && (
        <div className="fixed top-0 h-screen z-30" style={{ left: collapsed ? 0 : SIDEBAR_WIDTH, width: copilotWidth }}>
          <CopilotDock onToggle={toggleCopilot} />
          <div className="absolute top-0 -right-1 h-full w-3 z-40">
            <button
              type="button"
              aria-label="Resize copilot panel"
              onMouseDown={startCopilotResize}
              className="group h-full w-full cursor-col-resize flex items-center justify-center"
            >
              <span
                className={cn(
                  "h-20 w-[2px] rounded bg-gray-700/70 group-hover:bg-indigo-400 transition-colors",
                  resizingCopilot && "h-full bg-indigo-400"
                )}
              />
            </button>
          </div>
        </div>
      )}

      {/* Main content — always same structure so React doesn't remount children */}
      <div
        className={cn(
          "h-screen transition-[margin,width] duration-200 overflow-x-hidden",
          resizingCopilot && "transition-none",
        )}
        style={{ marginLeft: contentOffset, width: contentWidth }}
      >
        <div className="h-full flex flex-col">
          {mounted && showContextBar && (
            <div className="shrink-0 z-30">
              <ContextBar />
            </div>
          )}
          <main
            className={cn(
              "flex-1 min-h-0",
              isPipelinePage
                ? "p-0 overflow-hidden"
                : "p-6 overflow-y-auto",
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
