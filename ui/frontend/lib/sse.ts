import { useEffect, useRef, useState } from "react";
import type { ProgressEvent } from "./types";
import { API } from "./utils";

export function useJobStream(jobId: string | null) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!jobId) return;
    setEvents([]);
    setIsComplete(false);

    const es = new EventSource(`${API}/jobs/${jobId}/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data: ProgressEvent = JSON.parse(e.data);
        if (data.heartbeat) return;
        setEvents((prev) => [...prev, data]);
        if (data.done) {
          setIsComplete(true);
          es.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setIsComplete(true);
      es.close();
    };

    return () => {
      es.close();
    };
  }, [jobId]);

  const latestPct = events.length > 0 ? events[events.length - 1].pct : 0;
  const latestStage = events.length > 0 ? events[events.length - 1].stage : 0;
  const hasError = events.some((e) => e.error);

  return { events, isComplete, latestPct, latestStage, hasError };
}
