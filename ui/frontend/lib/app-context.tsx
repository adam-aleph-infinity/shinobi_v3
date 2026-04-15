"use client";
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

export type LLMAgentType = "notes" | "persona" | "";

export interface AppCtxType {
  salesAgent: string;
  customer: string;
  callId: string;
  // Notes agent (legacy — kept for backward compat)
  llmAgentName: string;
  llmAgentType: LLMAgentType;
  // Persona agent (legacy — kept for backward compat)
  personaAgentId: string;
  personaAgentName: string;
  // Active universal agent
  activeAgentId: string;
  activeAgentName: string;
  activeAgentClass: string;

  setSalesAgent: (v: string) => void;
  setCustomer: (v: string, agentOverride?: string) => void;
  setCallId: (v: string) => void;
  setLlmAgent: (name: string, type: LLMAgentType) => void;
  setPersonaAgent: (id: string, name: string) => void;
  setActiveAgent: (id: string, name: string, cls: string) => void;
  clearAll: () => void;
}

const AppCtx = createContext<AppCtxType>({
  salesAgent: "", customer: "", callId: "",
  llmAgentName: "", llmAgentType: "",
  personaAgentId: "", personaAgentName: "",
  activeAgentId: "", activeAgentName: "", activeAgentClass: "",
  setSalesAgent: () => {}, setCustomer: () => {}, setCallId: () => {},
  setLlmAgent: () => {}, setPersonaAgent: () => {}, setActiveAgent: () => {}, clearAll: () => {},
});

function ss(k: string) { try { return sessionStorage.getItem(k) ?? ""; } catch { return ""; } }
function ssSet(k: string, v: string) {
  try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch {}
}

export function AppContextProvider({ children }: { children: React.ReactNode }) {
  const [salesAgent,      _setSA] = useState("");
  const [customer,        _setCu] = useState("");
  const [callId,          _setCa] = useState("");
  const [llmName,         _setLN] = useState("");
  const [llmType,         _setLT] = useState<LLMAgentType>("");
  const [personaId,       _setPI] = useState("");
  const [personaNm,       _setPN] = useState("");
  const [activeAgentId,   _setAAI] = useState("");
  const [activeAgentName, _setAAN] = useState("");
  const [activeAgentClass,_setAAC] = useState("");

  useEffect(() => {
    _setSA(ss("ctx_agent"));
    _setCu(ss("ctx_customer"));
    _setCa(ss("ctx_call"));
    _setLN(ss("ctx_llm_name"));
    _setLT((ss("ctx_llm_type") || "") as LLMAgentType);
    _setPI(ss("ctx_persona_id"));
    _setPN(ss("ctx_persona_name"));
    _setAAI(ss("ctx_active_agent_id"));
    _setAAN(ss("ctx_active_agent_name"));
    _setAAC(ss("ctx_active_agent_class"));
  }, []);

  const setSalesAgent = useCallback((v: string) => {
    _setSA(v);  ssSet("ctx_agent", v);
    _setCu(""); ssSet("ctx_customer", "");
    _setCa(""); ssSet("ctx_call", "");
  }, []);

  const setCustomer = useCallback((v: string, agentOverride?: string) => {
    if (agentOverride !== undefined) { _setSA(agentOverride); ssSet("ctx_agent", agentOverride); }
    _setCu(v); ssSet("ctx_customer", v);
    _setCa(""); ssSet("ctx_call", "");
  }, []);

  const setCallId = useCallback((v: string) => {
    _setCa(v); ssSet("ctx_call", v);
  }, []);

  const setLlmAgent = useCallback((name: string, type: LLMAgentType) => {
    _setLN(name); ssSet("ctx_llm_name", name);
    _setLT(type); ssSet("ctx_llm_type", type);
  }, []);

  const setPersonaAgent = useCallback((id: string, name: string) => {
    _setPI(id);   ssSet("ctx_persona_id", id);
    _setPN(name); ssSet("ctx_persona_name", name);
  }, []);

  const setActiveAgent = useCallback((id: string, name: string, cls: string) => {
    _setAAI(id);   ssSet("ctx_active_agent_id",    id);
    _setAAN(name); ssSet("ctx_active_agent_name",  name);
    _setAAC(cls);  ssSet("ctx_active_agent_class", cls);
  }, []);

  const clearAll = useCallback(() => {
    _setSA(""); _setCu(""); _setCa(""); _setLN(""); _setLT(""); _setPI(""); _setPN("");
    _setAAI(""); _setAAN(""); _setAAC("");
    [
      "ctx_agent","ctx_customer","ctx_call","ctx_llm_name","ctx_llm_type",
      "ctx_persona_id","ctx_persona_name",
      "ctx_active_agent_id","ctx_active_agent_name","ctx_active_agent_class",
    ].forEach(k => ssSet(k, ""));
  }, []);

  return (
    <AppCtx.Provider value={{
      salesAgent, customer, callId,
      llmAgentName: llmName, llmAgentType: llmType,
      personaAgentId: personaId, personaAgentName: personaNm,
      activeAgentId, activeAgentName, activeAgentClass,
      setSalesAgent, setCustomer, setCallId, setLlmAgent, setPersonaAgent, setActiveAgent, clearAll,
    }}>
      {children}
    </AppCtx.Provider>
  );
}

export function useAppCtx() { return useContext(AppCtx); }
