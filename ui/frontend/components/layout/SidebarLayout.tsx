"use client";
import { useState, useEffect } from "react";
import AppSidebar from "./AppSidebar";
import { ContextBar } from "./ContextBar";
import { PanelLeftOpen } from "lucide-react";

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (localStorage.getItem("sidebar-collapsed") === "true") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed(c => {
      const next = !c;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

  const ml = mounted ? (collapsed ? "ml-0" : "ml-56") : "ml-56";

  return (
    <>
      {/* Sidebar — hidden until mounted to avoid hydration mismatch */}
      {!mounted && <div className="fixed left-0 top-0 h-screen w-56 bg-gray-900 border-r border-gray-800 z-40" />}
      {mounted && collapsed && (
        <button
          onClick={toggle}
          className="fixed top-4 left-4 z-50 p-1.5 rounded-md bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          title="Show sidebar"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}
      {mounted && !collapsed && <AppSidebar onToggle={toggle} />}

      {/* Main content — always same structure so React doesn't remount children */}
      <div className={`${ml} transition-all duration-200`}>
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
