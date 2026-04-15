"use client";
import { SWRConfig } from "swr";
import { AppContextProvider } from "@/lib/app-context";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppContextProvider>
      <SWRConfig
        value={{
          onErrorRetry: (_err, _key, _cfg, revalidate, { retryCount }) => {
            if (retryCount >= 20) return;
            setTimeout(() => revalidate({ retryCount }), 3000);
          },
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
    </AppContextProvider>
  );
}
