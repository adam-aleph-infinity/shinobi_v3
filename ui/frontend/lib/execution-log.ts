import { withClientMetaHeaders, getClientLocalTimeIso, getClientTimezone } from "./request-meta";

type ClientExecutionEvent = {
  session_id?: string;
  action: string;
  source?: string;
  status?: string;
  level?: string;
  message?: string;
  context?: Record<string, unknown>;
  data?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string;
  finish?: boolean;
};

export async function logClientExecutionEvent(evt: ClientExecutionEvent): Promise<void> {
  try {
    await fetch(
      "/api/execution-logs/client-event",
      withClientMetaHeaders({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: evt.session_id || "",
          action: evt.action,
          source: evt.source || "frontend",
          status: evt.status || "running",
          level: evt.level || "info",
          message: evt.message || "",
          context: evt.context || {},
          data: evt.data || {},
          report: evt.report || {},
          error: evt.error || "",
          client_local_time: getClientLocalTimeIso(),
          client_timezone: getClientTimezone(),
          finish: Boolean(evt.finish),
        }),
      }),
    );
  } catch {
    // Never block UX if telemetry/logging endpoint fails.
  }
}

