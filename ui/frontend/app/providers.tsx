"use client";
import { useEffect } from "react";
import { SWRConfig } from "swr";
import { AppContextProvider } from "@/lib/app-context";
import { logClientExecutionEvent } from "@/lib/execution-log";

const CHUNK_RECOVERY_KEY = "shinobi.chunk_reload_last_ts";
const CHUNK_RECOVERY_COOLDOWN_MS = 60_000;

function _extractErrorMessage(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.message === "string") return value.message;
  try {
    return String(value);
  } catch {
    return "";
  }
}

function _isChunkLoadFailure(message: string): boolean {
  const msg = String(message || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("chunkloaderror")
    || msg.includes("loading chunk")
    || msg.includes("failed to fetch dynamically imported module")
    || msg.includes("css_chunk_load_failed")
    || (msg.includes("/_next/static/chunks/") && msg.includes("failed"))
  );
}

function _isChunkScriptEvent(evt: Event): boolean {
  const target = evt?.target as HTMLScriptElement | null;
  if (!target) return false;
  if (target.tagName !== "SCRIPT") return false;
  const src = String(target.src || "");
  return src.includes("/_next/static/chunks/");
}

function _reloadAfterChunkFailure(reason: string): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  let lastTs = 0;
  try {
    lastTs = Number(window.sessionStorage.getItem(CHUNK_RECOVERY_KEY) || 0);
  } catch {
    lastTs = 0;
  }
  if (Number.isFinite(lastTs) && now - lastTs < CHUNK_RECOVERY_COOLDOWN_MS) {
    console.error(`[chunk-recovery] repeated chunk failure; skipped reload (${reason})`);
    return;
  }
  try {
    window.sessionStorage.setItem(CHUNK_RECOVERY_KEY, String(now));
  } catch {
    // Ignore storage failures; still try reload.
  }
  void logClientExecutionEvent({
    action: "chunk_recovery_reload",
    status: "failed",
    level: "error",
    message: "Chunk load mismatch detected; forcing reload.",
    context: { reason },
    error: reason,
    finish: true,
  });
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("__chunk_reload", String(now));
  window.location.replace(nextUrl.toString());
}

function _logFrontendError(action: string, message: string, context: Record<string, unknown>, error: string): void {
  void logClientExecutionEvent({
    action,
    status: "failed",
    level: "error",
    message: message || action,
    context,
    error: error || message || action,
    finish: true,
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const onWindowError = (evt: ErrorEvent) => {
      const msg = _extractErrorMessage(evt?.error) || _extractErrorMessage(evt?.message);
      _logFrontendError(
        "window_error",
        msg || "Unhandled window error",
        {
          filename: String(evt?.filename || ""),
          lineno: Number(evt?.lineno || 0),
          colno: Number(evt?.colno || 0),
        },
        msg || "Unhandled window error",
      );
      if (_isChunkLoadFailure(msg) || _isChunkScriptEvent(evt)) {
        _reloadAfterChunkFailure(msg || "script chunk load error");
      }
    };
    const onUnhandledRejection = (evt: PromiseRejectionEvent) => {
      const msg = _extractErrorMessage(evt?.reason);
      _logFrontendError(
        "unhandled_rejection",
        msg || "Unhandled promise rejection",
        {},
        msg || "Unhandled promise rejection",
      );
      if (_isChunkLoadFailure(msg)) {
        _reloadAfterChunkFailure(msg || "unhandled chunk load rejection");
      }
    };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return (
    <AppContextProvider>
      <SWRConfig
        value={{
          dedupingInterval: 10000,
          revalidateOnMount: true,
          focusThrottleInterval: 30000,
          onErrorRetry: (_err, _key, _cfg, revalidate, { retryCount }) => {
            if (retryCount >= 20) return;
            setTimeout(() => revalidate({ retryCount }), 3000);
          },
          onError: (err, key) => {
            const msg: string = err?.message ?? "";
            void logClientExecutionEvent({
              action: "swr_fetch_error",
              status: "failed",
              level: "error",
              message: msg || "SWR fetch error",
              context: { key: String(key || "") },
              error: msg,
              finish: true,
            });
            if (
              msg.includes("ECONNRESET") ||
              msg.includes("fetch failed") ||
              msg.includes("Failed to fetch") ||
              msg.includes("NetworkError") ||
              err?.status === undefined
            ) return;
            console.error("[SWR]", err);
          },
          revalidateOnFocus: false,
        }}
      >
        {children}
      </SWRConfig>
    </AppContextProvider>
  );
}
