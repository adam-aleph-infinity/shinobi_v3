"use client";
import React, { createContext, useContext } from "react";

export interface CitationCall {
  call_id: string;
  date: string;
  duration: number;
  smoothed_path?: string;
  voted_path?: string;
}

interface CallCitationCtxType {
  active: boolean;                        // true only inside a CallCitationProvider
  onCitation: (callN: number) => void;
}

const CallCitationCtx = createContext<CallCitationCtxType>({
  active: false,
  onCitation: () => {},
});

export function CallCitationProvider({
  onCitation,
  children,
}: {
  onCitation: (callN: number) => void;
  children: React.ReactNode;
}) {
  return (
    <CallCitationCtx.Provider value={{ active: true, onCitation }}>
      {children}
    </CallCitationCtx.Provider>
  );
}

export function useCallCitation() {
  return useContext(CallCitationCtx);
}
