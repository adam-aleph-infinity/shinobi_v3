"use client";
import { SWRConfig } from "swr";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        // Silent retry every 3 s when the backend is down / restarting
        onErrorRetry: (_err, _key, _cfg, revalidate, { retryCount }) => {
          if (retryCount >= 20) return;          // give up after ~1 min
          setTimeout(() => revalidate({ retryCount }), 3000);
        },
        // Don't log connection-reset / network errors to the console
        onError: (err) => {
          const msg: string = err?.message ?? "";
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
  );
}
