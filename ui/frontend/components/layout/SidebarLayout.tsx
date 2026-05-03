"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import AppSidebar from "./AppSidebar";
import CopilotDock from "./CopilotDock";
import { ContextBar } from "./ContextBar";

const SIDEBAR_WIDTH = 224;
const RAIL_WIDTH = 32;
const COPILOT_DEFAULT_WIDTH = 304;
const COPILOT_MIN_WIDTH = 260;
const COPILOT_MAX_WIDTH = 560;
const MIN_CONTENT_WIDTH = 560;

function clampCopilotWidth(raw: number, sidebarCollapsed: boolean): number {
  const hardClamped = Math.min(COPILOT_MAX_WIDTH, Math.max(COPILOT_MIN_WIDTH, raw));
  if (typeof window === "undefined") return hardClamped;
  const sidebarSpace = sidebarCollapsed ? 0 : SIDEBAR_WIDTH;
  const chromeSpace = sidebarSpace + RAIL_WIDTH + RAIL_WIDTH;
  const viewportMax = Math.max(220, window.innerWidth - chromeSpace - MIN_CONTENT_WIDTH);
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
    const onResize = () => setCopilotWidth((current) => clampCopilotWidth(current, collapsed));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [collapsed, mounted]);

  const toggleSidebar = () => {
    setCollapsed((curr) => {
      const next = !curr;
      localStorage.setItem("sidebar-collapsed", String(next));
      setCopilotWidth((current) => clampCopilotWidth(current, next));
      return next;
    });
  };

  const toggleCopilot = () => {
    setCopilotCollapsed((curr) => {
      const next = !curr;
      localStorage.setItem("copilot-collapsed", String(next));
      return next;
    });
  };

  const startCopilotResize = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = copilotWidth;

    setResizingCopilot(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = clampCopilotWidth(startWidth + delta, collapsed);
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

  const path = String(pathname || "");
  const isPipelinePage =
    path === "/pipeline" || path.startsWith("/pipeline/");
  const isJobsPage =
    path === "/jobs" ||
    path.startsWith("/jobs/") ||
    path === "/live" ||
    path.startsWith("/live/");
  const isAgentDeepDivePage =
    path === "/agent-deep-dive" ||
    path.startsWith("/agent-deep-dive/");
  const isAgentDashboardPage =
    path === "/agent-dashboard" ||
    path.startsWith("/agent-dashboard/");
  // ContextBar (pipeline selector + context) only on the two analyze screens.
  const showContextBar = isAgentDashboardPage || isAgentDeepDivePage;
  const sidebarPanelWidth = mounted && collapsed ? 0 : SIDEBAR_WIDTH;
  const copilotPanelWidth = mounted && copilotCollapsed ? 0 : copilotWidth;

  if (embeddedMode) {
    return (
      <main className="h-screen w-screen overflow-hidden bg-gray-950">
        {children}
      </main>
    );
  }

  return (
    <main className="fixed inset-0 flex overflow-hidden bg-gray-950">
      <div
        className={cn(
          "h-full shrink-0 overflow-hidden bg-gray-900 transition-[width] duration-200",
          sidebarPanelWidth > 0 && "border-r border-gray-800",
          resizingCopilot && "transition-none",
        )}
        style={{ width: sidebarPanelWidth }}
      >
        {sidebarPanelWidth > 0 && <AppSidebar />}
      </div>

      <button
        type="button"
        onClick={toggleSidebar}
        title={collapsed ? "Show toolbar" : "Hide toolbar"}
        aria-label={collapsed ? "Show toolbar" : "Hide toolbar"}
        className={cn(
          "h-full shrink-0 border-r border-gray-800 bg-gray-900/95 w-8",
          "flex items-center justify-center text-gray-500 hover:text-white transition-colors",
          !collapsed && "text-indigo-300",
        )}
      >
        <Home className="h-4 w-4" />
      </button>

      <div
        className={cn(
          "h-full shrink-0 overflow-hidden bg-gray-900 transition-[width] duration-200 relative",
          copilotPanelWidth > 0 && "border-r border-gray-800",
          resizingCopilot && "transition-none",
        )}
        style={{ width: copilotPanelWidth }}
      >
        {copilotPanelWidth > 0 && (
          <>
            <CopilotDock />
            <div className="absolute top-0 -right-1 h-full w-3 z-30">
              <button
                type="button"
                aria-label="Resize copilot panel"
                onMouseDown={startCopilotResize}
                className="group h-full w-full cursor-col-resize flex items-center justify-center"
              >
                <span
                  className={cn(
                    "h-24 w-[2px] rounded bg-gray-700/70 group-hover:bg-indigo-400 transition-colors",
                    resizingCopilot && "h-full bg-indigo-400"
                  )}
                />
              </button>
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={toggleCopilot}
        title={copilotCollapsed ? "Show copilot" : "Hide copilot"}
        aria-label={copilotCollapsed ? "Show copilot" : "Hide copilot"}
        className={cn(
          "h-full shrink-0 border-r border-gray-800 bg-gray-900/95 w-8",
          "flex items-center justify-center text-gray-500 hover:text-white transition-colors",
          !copilotCollapsed && "text-indigo-300",
        )}
      >
        <Bot className="h-4 w-4" />
      </button>

      <section className="min-w-0 flex-1 h-full flex flex-col">
        {mounted && showContextBar && (
          <div className="shrink-0 z-20">
            <ContextBar />
          </div>
        )}
        <main
          className={cn(
            "flex-1 min-h-0",
            isPipelinePage ? "p-0 overflow-hidden" : "p-6 overflow-y-auto",
          )}
        >
          {children}
        </main>
      </section>
    </main>
  );
}
