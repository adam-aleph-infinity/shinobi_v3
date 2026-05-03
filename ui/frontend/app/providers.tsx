"use client";
import { SWRConfig } from "swr";
import { AppContextProvider } from "@/lib/app-context";
import { logClientExecutionEvent } from "@/lib/execution-log";

export function Providers({ children }: { children: React.ReactNode }) {
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
