import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AttentionSessionList, type AttentionSnapshot } from "../lib/api";
import { DEFAULT_POLL_MS } from "../lib/useLive";
import { validSessionId } from "./model";
import { startAttentionPoll } from "./poll";

export function useAttention(sessionId: string | null) {
  const [query, setQuery] = useState<{ session: string | null; through: number | null; before: number | null }>({ session: sessionId, through: null, before: null });
  const through = query.session === sessionId ? query.through : null;
  const before = query.session === sessionId ? query.before : null;
  const [response, setResponse] = useState<{ session: string; through: number | null; before: number | null; snapshot: AttentionSnapshot | null; error: string | null } | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const [sessions, setSessions] = useState<AttentionSessionList | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [listBefore, setListBefore] = useState<string | null>(null);
  const [listNonce, setListNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void api.attentionSessions(listBefore, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setSessions(value);
      setSessionsError(null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setSessionsError(String(error));
    });
    return () => controller.abort();
  }, [listBefore, listNonce]);

  useEffect(() => {
    refreshRef.current = () => undefined;
    if (sessionId === null || !validSessionId(sessionId)) return;
    const loop = startAttentionPoll({
      sessionId, replay: through !== null, intervalMs: DEFAULT_POLL_MS,
      read: (signal) => api.attentionSnapshot(sessionId, through, before, signal),
      accept: (snapshot) => setResponse({ session: sessionId, through, before, snapshot, error: null }),
      reject: (error) => setResponse((previous) => ({ session: sessionId, through, before,
        snapshot: previous?.session === sessionId && previous.through === through && previous.before === before ? previous.snapshot : null, error })),
      hidden: () => document.hidden,
      subscribe: (listener) => { document.addEventListener("visibilitychange", listener); return () => document.removeEventListener("visibilitychange", listener); },
    });
    refreshRef.current = loop.refresh;
    return loop.stop;
  }, [sessionId, through, before]);

  const current = response?.session === sessionId && response.through === through && response.before === before ? response : null;
  const malformed = sessionId !== null && !validSessionId(sessionId);
  const replay = useCallback((sequence: number | null) => setQuery({ session: sessionId, through: sequence, before: null }), [sessionId]);
  const page = useCallback((sequence: number | null) => setQuery({ session: sessionId, through, before: sequence }), [sessionId, through]);
  return {
    snapshot: current?.snapshot ?? null,
    error: malformed ? "Invalid session ID. Open a session link produced by boot or choose a recording." : current?.error ?? null,
    loading: sessionId !== null && !malformed && current === null,
    through, before, replay, page, refresh: () => refreshRef.current(),
    sessions, sessionsError, listBefore,
    pageSessions: setListBefore,
    refreshSessions: () => { setListBefore(null); setListNonce((n) => n + 1); },
  };
}
