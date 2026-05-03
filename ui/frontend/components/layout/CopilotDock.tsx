"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Bot, Loader2, Plus, Send, Trash2, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

type SessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | string;
  content: string;
  created_at: string;
  meta?: Record<string, unknown>;
};

type SessionDetail = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
};

type StreamEvent = {
  type: string;
  data: any;
};

type ModelOption = {
  id: string;
  label: string;
  provider: string;
  description?: string;
  ready?: boolean;
  supports_tools?: boolean;
};

const FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.4", label: "OpenAI Best (gpt-5.4)", provider: "openai", supports_tools: true },
  { id: "claude-opus-4-7", label: "Anthropic Best (Claude Opus 4.7)", provider: "anthropic", supports_tools: true },
  { id: "claude-sonnet-4-7", label: "Claude Sonnet 4.7 (compat alias)", provider: "anthropic", supports_tools: true },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (stable)", provider: "anthropic", supports_tools: true },
  { id: "gpt-5.3-codex", label: "OpenAI Codex Fast (fallback)", provider: "openai", supports_tools: true },
];

function fmtTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function CopilotDock() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sending, setSending] = useState(false);
  const [liveAssistant, setLiveAssistant] = useState("");
  const [statusLine, setStatusLine] = useState("");
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("gpt-5.4");

  const canSend = useMemo(() => !!input.trim() && !sending, [input, sending]);

  async function fetchSessions(selectFirst = false) {
    setLoadingSessions(true);
    try {
      const res = await fetch("/api/assistant/sessions");
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SessionSummary[];
      setSessions(data);
      if (selectFirst && data.length > 0 && !activeSessionId) {
        await openSession(data[0].id);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load sessions");
    } finally {
      setLoadingSessions(false);
    }
  }

  async function openSession(sessionId: string) {
    setLoadingSession(true);
    setError("");
    try {
      const res = await fetch(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SessionDetail;
      setActiveSessionId(data.id);
      setMessages(data.messages || []);
      setLiveAssistant("");
      setStatusLine("");
    } catch (e: any) {
      setError(e?.message || "Failed to open session");
    } finally {
      setLoadingSession(false);
    }
  }

  async function createSession(): Promise<string> {
    const res = await fetch("/api/assistant/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Copilot Chat" }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as SessionDetail;
    await fetchSessions(false);
    await openSession(data.id);
    return data.id;
  }

  async function deleteSession(sessionId: string) {
    if (!confirm("Delete this chat session?")) return;
    try {
      const res = await fetch(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());

      if (activeSessionId === sessionId) {
        setActiveSessionId("");
        setMessages([]);
        setLiveAssistant("");
        setStatusLine("");
      }
      await fetchSessions(true);
    } catch (e: any) {
      setError(e?.message || "Failed to delete session");
    }
  }

  async function fetchModels() {
    const applyRows = (rowsIn: ModelOption[]) => {
      const rows = rowsIn.filter((m) => !!m?.id);
      setModels(rows);
      const local = typeof window !== "undefined" ? localStorage.getItem("copilot-model") || "" : "";
      const preferred = local && rows.some((m) => m.id === local) ? local : "";
      const fallback = rows.find((m) => m.ready !== false)?.id || rows[0]?.id || "gpt-5.4";
      const next = preferred || fallback;
      setSelectedModel(next);
      if (typeof window !== "undefined") localStorage.setItem("copilot-model", next);
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch("/api/assistant/models", { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as ModelOption[];
        const rows = Array.isArray(data) ? data.filter((m) => !!m?.id) : [];
        applyRows(rows.length ? rows : FALLBACK_MODELS);
        return;
      } catch {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
      }
    }

    applyRows(FALLBACK_MODELS);
    setError((prev) => prev || "Models list unavailable right now. Using fallback options.");
  }

  useEffect(() => {
    fetchSessions(true);
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;

    const prompt = input.trim();
    setInput("");
    setError("");
    setSending(true);
    setLiveAssistant("");
    setStatusLine("Starting assistant…");

    const optimisticUser: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: prompt,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);

    let sid = activeSessionId;
    try {
      if (!sid) sid = await createSession();

      const res = await fetch(`/api/assistant/sessions/${encodeURIComponent(sid)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, model: selectedModel }),
      });
      if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const idx = buffer.indexOf("\n\n");
          if (idx < 0) break;

          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const dataLines = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;

          let parsed: StreamEvent | null = null;
          try {
            parsed = JSON.parse(dataLines.join("\n"));
          } catch {
            parsed = null;
          }
          if (!parsed) continue;

          const typ = parsed.type;
          const payload = parsed.data;

          if (typ === "progress") {
            setStatusLine(String(payload?.msg || "Working…"));
          } else if (typ === "tool_call") {
            setStatusLine(`Tool: ${String(payload?.name || "unknown")}`);
          } else if (typ === "tool_result") {
            const ok = payload?.ok ? "ok" : "error";
            setStatusLine(`Tool result (${ok}): ${String(payload?.name || "unknown")}`);
          } else if (typ === "stream") {
            setLiveAssistant((prev) => prev + String(payload?.text || ""));
          } else if (typ === "done") {
            const content = String(payload?.content || "");
            setLiveAssistant((prev) => content || prev);
            setStatusLine("Done");
          } else if (typ === "error") {
            throw new Error(String(payload?.msg || "Assistant error"));
          }
        }
      }

      await openSession(sid);
      await fetchSessions(false);
    } catch (e: any) {
      setError(e?.message || "Failed to send message");
    } finally {
      setSending(false);
      setStatusLine("");
      setLiveAssistant("");
    }
  }

  return (
    <aside className="h-full w-full bg-gray-900 flex flex-col">
      <div className="px-3 py-2.5 border-b border-gray-800 flex items-start gap-2">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-white leading-tight">AI Copilot</h1>
          <p className="text-[11px] text-gray-500 truncate">Pipeline builder + run debugger</p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <select
            value={selectedModel}
            onChange={(e) => {
              const next = e.target.value;
              setSelectedModel(next);
              localStorage.setItem("copilot-model", next);
            }}
            className="max-w-[148px] bg-gray-800 border border-gray-700 text-gray-200 text-[10px] rounded px-1.5 py-1 outline-none focus:border-indigo-500"
            title="Copilot model/provider"
          >
            {(models.length ? models : FALLBACK_MODELS).map((m) => (
              <option key={m.id} value={m.id} disabled={m.ready === false}>
                {m.label}{m.ready === false ? " (missing key)" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => createSession().catch((e) => setError(e?.message || "Failed to create session"))}
            className="p-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            title="New chat"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="px-2 py-2 border-b border-gray-800">
        <div className="flex items-center justify-between mb-1 px-1">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Sessions</p>
          {loadingSessions && <p className="text-[10px] text-gray-500">Loading…</p>}
        </div>
        <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
          {!loadingSessions && sessions.length === 0 && (
            <p className="text-xs text-gray-600 px-2 py-1.5">No sessions yet. Start a new chat.</p>
          )}

          {sessions.map((s) => {
            const active = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                className={cn(
                  "group rounded-lg border px-2 py-1.5 cursor-pointer transition-colors",
                  active
                    ? "border-indigo-500/60 bg-indigo-600/15"
                    : "border-gray-800 bg-gray-900 hover:bg-gray-800/60"
                )}
                onClick={() => openSession(s.id)}
              >
                <div className="flex items-start gap-1.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-white truncate">{s.title || "Untitled"}</p>
                    <p className="text-[10px] text-gray-500 truncate">{s.last_message || "No messages yet"}</p>
                    <p className="text-[9px] text-gray-600 mt-0.5 truncate">{fmtTime(s.updated_at)}</p>
                  </div>
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      deleteSession(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800 transition-all"
                    title="Delete session"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="px-3 py-2 border-b border-gray-800">
        <h2 className="text-xs font-semibold text-white">Conversation</h2>
        <p className="text-[11px] text-gray-500 leading-snug mt-0.5">
          Ask to build pipelines or explain failed runs.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
        {loadingSession && <p className="text-xs text-gray-500">Loading chat…</p>}

        {!loadingSession && messages.length === 0 && !sending && (
          <div className="h-full min-h-[120px] flex items-center justify-center text-center text-gray-500 text-xs px-2">
            Start chatting to generate pipelines or diagnose runs.
          </div>
        )}

        {messages.map((m) => {
          const isUser = m.role === "user";
          const isTool = m.role === "tool";
          return (
            <div key={m.id} className={cn("flex gap-1.5", isUser ? "justify-end" : "justify-start")}>
              {!isUser && (
                <div
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                    isTool ? "bg-amber-900/50" : "bg-indigo-900/60"
                  )}
                >
                  {isTool ? (
                    <Wrench className="w-3 h-3 text-amber-300" />
                  ) : (
                    <Bot className="w-3 h-3 text-indigo-300" />
                  )}
                </div>
              )}

              <div
                className={cn(
                  "max-w-[90%] rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words border leading-relaxed",
                  isUser
                    ? "bg-indigo-600 text-white border-indigo-500"
                    : isTool
                      ? "bg-amber-900/20 text-amber-200 border-amber-700/40"
                      : "bg-gray-800 text-gray-100 border-gray-700"
                )}
              >
                {m.content}
              </div>

              {isUser && (
                <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                  <User className="w-3 h-3 text-gray-200" />
                </div>
              )}
            </div>
          );
        })}

        {sending && (
          <div className="flex gap-1.5">
            <div className="w-6 h-6 rounded-full bg-indigo-900/60 flex items-center justify-center shrink-0">
              <Bot className="w-3 h-3 text-indigo-300" />
            </div>
            <div className="max-w-[90%] rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-wrap break-words border bg-gray-800 text-gray-100 border-gray-700 leading-relaxed">
              {liveAssistant || statusLine || "Thinking…"}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 p-2 space-y-1.5">
        {statusLine && (
          <div className="text-[11px] text-indigo-300 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="truncate">{statusLine}</span>
          </div>
        )}
        {error && <div className="text-[11px] text-red-400">{error}</div>}

        <form onSubmit={handleSend} className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            placeholder="Ask Copilot…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-indigo-500 resize-none"
          />
          <button
            type="submit"
            disabled={!canSend}
            className={cn(
              "h-9 px-2.5 rounded-lg text-xs font-medium flex items-center gap-1 transition-colors shrink-0",
              canSend ? "bg-indigo-600 hover:bg-indigo-500 text-white" : "bg-gray-800 text-gray-500 cursor-not-allowed"
            )}
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
        </form>
      </div>
    </aside>
  );
}
