export interface AgentCustomerPair {
  id: string;
  crm_url: string;
  account_id: string;
  agent: string;
  customer: string;
  call_count: number;
  total_duration: number;
  net_deposits?: number | null;
  ftd_at?: string | null;
}

export interface TxStats {
  [pairSlug: string]: { transcribed: number; total: number };
}

export interface CallRecord {
  call_id: string;
  date: string;
  duration: number;
  downloaded: boolean;
  local_path?: string;
}

export interface Job {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  audio_path: string;
  pair_slug: string;
  call_id: string;
  speaker_a: string;
  speaker_b: string;
  stage: number;
  pct: number;
  message: string;
  manifest_path?: string;
  error?: string;
  batch_id?: string;
  created_at: string;
  completed_at?: string;
  duration_s?: number | null;
  started_at?: string | null;
}

export interface ProgressEvent {
  stage: number;
  pct: number;
  message: string;
  done: boolean;
  error?: boolean;
  heartbeat?: boolean;
}

export interface TranscriptSource {
  engine: string;
  word_count: number;
  segment_count: number;
  text_preview: string;
  path: string;
}

export interface Persona {
  id: string;
  type: "agent_overall" | "customer" | "pair";
  agent: string;
  customer?: string;
  label?: string;
  content_md: string;
  prompt_used: string;
  model: string;
  temperature?: number;
  transcript_paths: string;
  script_path?: string;
  version: number;
  parent_id?: string;
  persona_agent_id?: string;
  sections_json?: string;  // JSON-encoded PersonaSection[]
  score_json?: string;     // JSON-encoded {[section]: {score, reasoning}, _overall, _summary}
  created_at: string;
}

export interface SessionAnalysis {
  id: string;
  job_id: string;
  pair_slug: string;
  call_id: string;
  agent: string;
  customer: string;
  score: number;
  analysis_md: string;
  improvement_items: string[];
  model: string;
  created_at: string;
}
