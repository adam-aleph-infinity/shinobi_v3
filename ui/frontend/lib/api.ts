import { API } from "./utils";

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, options);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }
  return res.json();
}

// CRM
export const getPairs = (params = "") => req(`/crm/pairs${params ? "?" + params : ""}`);
export const getAgents = (crm = "") => req(`/crm/agents?crm=${crm}`);
export const getCalls = (accountId: string, crmUrl: string, agent = "", customer = "") =>
  req(`/crm/calls/${accountId}?crm_url=${encodeURIComponent(crmUrl)}&agent=${encodeURIComponent(agent)}&customer=${encodeURIComponent(customer)}`);
export const downloadAudio = (body: object) =>
  req("/crm/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const refreshCache = () => req("/crm/refresh", { method: "POST" });
export const refreshCalls = (accountId: string, crmUrl: string, agent = "", customer = "") =>
  req(`/crm/calls/${accountId}/refresh?crm_url=${encodeURIComponent(crmUrl)}&agent=${encodeURIComponent(agent)}&customer=${encodeURIComponent(customer)}`, { method: "POST" });
export const getAudioPairs = () => req("/audio/pairs");
export const getAudioFiles = (slug: string) => req(`/audio/files?slug=${encodeURIComponent(slug)}`);
export const getVoiceProfiles = () => req("/audio/voice-profiles");

// Jobs
export const createJob = (body: object) =>
  req("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const getJobs = (pairSlug = "") => req(`/jobs${pairSlug ? "?pair_slug=" + pairSlug : ""}`);
export const getJob = (id: string) => req(`/jobs/${id}`);
export const cancelJob = (id: string) => req(`/jobs/${id}`, { method: "DELETE" });

// Transcripts
export const getTranscriptSources = (jobId: string) => req(`/transcripts/${jobId}/sources`);
export const getFinalSrt = (jobId: string, variant = "final") =>
  req(`/transcripts/${jobId}/final?variant=${variant}`);
export const getSrtVariants = (jobId: string) => req(`/transcripts/${jobId}/variants`);
export const runEnsembleMerge = (jobId: string, body: object) =>
  req(`/transcripts/${jobId}/ensemble-merge`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

// Personas
export const getPersonas = (params = "") => req(`/personas${params ? "?" + params : ""}`);
export const getPersona = (id: string) => req(`/personas/${id}`);
export const getPersonaVersions = (id: string) => req(`/personas/${id}/versions`);
export const createPersona = (body: object) =>
  req("/personas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const regeneratePersona = (id: string, body: object) =>
  req(`/personas/${id}/regenerate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
export const getDefaultPrompts = () => req("/personas/prompts");
export const deletePersona = (id: string) =>
  req(`/personas/${id}`, { method: "DELETE" });

// Session
export const analyzeSession = (body: object) =>
  req("/session/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const personaMatchSession = (body: object) =>
  req("/session/persona-match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const getTranscriptStatus = (jobId: string) => req(`/session/transcript-status/${jobId}`);
export const getTranscriptStatusBatch = (jobIds: string[]) =>
  req(`/session/transcript-status-batch?job_ids=${jobIds.join(",")}`);
export const listSessions = (params = "") => req(`/session/list${params ? "?" + params : ""}`);
export const getSessionAnalysis = (id: string) => req(`/session/${id}`);
export const getDefaultAnalysisPrompt = () => req("/session/prompts/default");
