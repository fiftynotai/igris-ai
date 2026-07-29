/**
 * FR-238 — the live-data beat.
 *
 * Polls `/api/health` on an interval and exposes the last refresh time. This is
 * what makes "data is live — restarting a hunt and reloading shows new state
 * with no regeneration step" visible rather than merely true: the shell shows a
 * `// LOOP` pulse and a mono timestamp, so staleness is legible.
 *
 * NOT websockets. A lens does not need push, and a socket would add a
 * reconnect/backoff state machine to a personal tool for no gain.
 *
 * Polling PAUSES on `document.hidden` and fires an immediate refresh when the
 * tab comes back, so a backgrounded lens costs nothing and a foregrounded one
 * is never stale by more than a tick.
 *
 * dataviz.md permits `// LOOP` motion in CHROME (live dot, ticker) and forbids
 * it on the canvas — this hook drives chrome only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type HealthPayload } from "./api";

export const DEFAULT_POLL_MS = 5_000;

export type LiveState = "live" | "degraded" | "offline" | "connecting";

export interface Live {
  state: LiveState;
  health: HealthPayload | null;
  /** Bumped on every successful poll — consumers key data refetches off it. */
  tick: number;
  lastRefresh: Date | null;
  error: string | null;
  refresh: () => void;
}

export function useLive(intervalMs: number = DEFAULT_POLL_MS): Live {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const payload = await api.health(ctrl.signal);
      setHealth(payload);
      setError(null);
      setLastRefresh(new Date());
      setTick((t) => t + 1);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void poll();
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer === null) timer = setInterval(() => void poll(), intervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
      } else {
        void poll();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      inflight.current?.abort();
    };
  }, [poll, intervalMs]);

  let state: LiveState = "connecting";
  if (error !== null) state = "offline";
  else if (health !== null) {
    state =
      health.degraded !== null || !health.bridge.available ? "degraded" : "live";
  }

  return {
    state,
    health,
    tick,
    lastRefresh,
    error,
    refresh: () => void poll(),
  };
}
