"use client";
import { useState, useEffect } from "react";
import AppSidebar from "./AppSidebar";
import CopilotDock from "./CopilotDock";
import { ContextBar } from "./ContextBar";
import { PanelLeftOpen } from "lucide-react";

const SIDEBAR_WIDTH = 224;
const COPILOT_WIDTH = 304;

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [copilotCollapsed, setCopilotCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (localStorage.getItem("sidebar-collapsed") === "true") setCollapsed(true);
    if (localStorage.getItem("copilot-collapsed") === "true") setCopilotCollapsed(true);
  }, []);

  const toggleSidebar = () => {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem("sidebar-collapsed", String(next));
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

  const sidebarOffset = mounted ? (collapsed ? 0 : SIDEBAR_WIDTH) : SIDEBAR_WIDTH;
  const copilotOffset = mounted ? (copilotCollapsed ? 0 : COPILOT_WIDTH) : COPILOT_WIDTH;
  const contentOffset = sidebarOffset + copilotOffset;

  return (
    <>
      {/* Sidebar — hidden until mounted to avoid hydration mismatch */}
      {!mounted && <div className="fixed left-0 top-0 h-screen w-56 bg-gray-900 border-r border-gray-800 z-40" />}
      {!mounted && (
        <div
          className="fixed top-0 h-screen bg-gray-900 border-r border-gray-800 z-30"
          style={{ left: SIDEBAR_WIDTH, width: COPILOT_WIDTH }}
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
        <div className="fixed top-0 h-screen z-30" style={{ left: collapsed ? 0 : SIDEBAR_WIDTH, width: COPILOT_WIDTH }}>
          <CopilotDock onToggle={toggleCopilot} />
        </div>
      )}

      {/* Main content — always same structure so React doesn't remount children */}
      <div className="transition-[margin] duration-200" style={{ marginLeft: contentOffset }}>
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
