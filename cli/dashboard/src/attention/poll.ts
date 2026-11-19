import type { AttentionSnapshot } from "../lib/api";

export interface AttentionPollOptions {
  sessionId: string;
  replay: boolean;
  read: (signal: AbortSignal) => Promise<AttentionSnapshot>;
  accept: (snapshot: AttentionSnapshot) => void;
  reject: (error: string) => void;
  hidden: () => boolean;
  subscribe: (listener: () => void) => () => void;
  intervalMs: number;
}

/** A bounded read loop. A disposed/session-replaced request can never publish. */
export function startAttentionPoll(options: AttentionPollOptions): { refresh: () => void; stop: () => void } {
  let disposed = false;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const refresh = (): void => {
    if (disposed || options.hidden()) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    void options.read(controller.signal).then((snapshot) => {
      if (disposed || controller.signal.aborted || request !== controller) return;
      if (snapshot.session !== null && snapshot.session.id !== options.sessionId) {
        options.reject("Session identity mismatch. This response was not displayed.");
        return;
      }
      options.accept(snapshot);
    }).catch((error: unknown) => {
      if (!disposed && !controller.signal.aborted && request === controller) {
        options.reject(error instanceof Error ? error.message : String(error));
      }
    });
  };
  const pause = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    request?.abort();
  };
  const resume = (): void => {
    pause();
    if (options.hidden()) return;
    refresh();
    if (!options.replay) timer = setInterval(refresh, options.intervalMs);
  };
  const unsubscribe = options.subscribe(resume);
  resume();
  return { refresh, stop: () => { disposed = true; pause(); unsubscribe(); } };
}
