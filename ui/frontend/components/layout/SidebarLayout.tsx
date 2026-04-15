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

  if (!mounted) {
    return (
      <>
        <div className="fixed left-0 top-0 h-screen w-56 bg-gray-900 border-r border-gray-800 z-40" />
        <main className="ml-56 min-h-screen p-6">{children}</main>
      </>
    );
  }

  return (
    <>
      {collapsed ? (
        <button
          onClick={toggle}
          className="fixed top-4 left-4 z-50 p-1.5 rounded-md bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          title="Show sidebar"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      ) : (
        <AppSidebar onToggle={toggle} />
      )}
      <div className={`flex flex-col h-screen transition-all duration-200 ${collapsed ? "ml-0" : "ml-56"}`}>
        <ContextBar />
        <main className="flex-1 min-h-0 overflow-auto p-6">
          {children}
        </main>
      </div>
    </>
  );
}
