/**
 * FR-266 — the diagnostics read state machine. FOUR settle paths, none a spinner.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AC-5 NAMES THREE FAILURE MODES; ITS OWN PHRASE IMPLIES A FOURTH
 * ─────────────────────────────────────────────────────────────────────────────
 * *"...rather than an empty panel or a spinner that never resolves."* Three of
 * the states are server-reported and arrive as a payload. The fourth — a wait
 * that never ends — has no payload by definition, so it needs a mechanism rather
 * than a branch:
 *
 *   | state              | driven by                        | how it settles     |
 *   |--------------------|----------------------------------|--------------------|
 *   | brain unavailable  | `payload.cognition.degraded`     | the digest's own   |
 *   |                    |                                  | reason, verbatim   |
 *   | producer failed    | `payload.degraded !== null`      | the envelope's     |
 *   |                    |                                  | reason, verbatim   |
 *   | malformed output   | `api.cognition()` throws         | `error`            |
 *   |                    | `ApiError(path,"malformed JSON")`|                    |
 *   | NEVER SETTLES      | a hung socket, an abort with no  | THE DEADLINE below |
 *   |                    | successor                        |                    |
 *
 * TD-405 is the recorded failure this must not repeat: an eternal loader. A page
 * that renders a spinner forever has said nothing, and the operator cannot tell
 * it from a page that is still thinking.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO RULES COPIED FROM `layers/useLayerList.ts`, BECAUSE THEY WERE LEARNED THE
 * HARD WAY THERE
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. **The fetcher is not in a dep list.** There is no caller-supplied fetcher
 *     here at all — this hook owns its one call — which removes the failure mode
 *     rather than managing it. The effect keys on `tick` and nothing else.
 *  2. **`loading` is `busy && payload === null`.** The panel follows the shell's
 *     5-second beat, and a refetch on the beat must never blank a panel the
 *     operator is mid-read of.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT FOLLOWS THE BEAT AT ALL (D7, MEASURED)
 * ─────────────────────────────────────────────────────────────────────────────
 * A diagnostics surface whose whole premise is CONTINUOUS visibility should not
 * need a button pressed to be true. The cost was measured rather than assumed —
 * p50 13.0 ms / p95 14.6 ms on the operator's real brain — against a
 * pre-declared 250 ms threshold above which this would have become a
 * once-per-scope read with an `AS OF` stamp and a REFRESH control. The figure and
 * its derivation live in `cli/src/lib/dashboard/cognition-read.ts`'s header,
 * beside the reader it measures.
 *
 * @module diagnostics/useCognition
 */

import { useEffect, useState } from "react";
import { ApiError, api, type CognitionPayload } from "../lib/api";

/**
 * How long a single read may take before the WAIT becomes a STATED failure.
 *
 * Deliberately generous against a p95 of ~15 ms: this is not a performance
 * budget, it is the fence that converts "never settles" into a sentence. Set
 * near the measured cost it would fire on an ordinary slow moment and turn a
 * working page into a flapping error.
 *
 * It is longer than the 5-second beat ON PURPOSE. A shorter deadline would abort
 * a request the next tick was about to replace anyway, so every slow read would
 * report a timeout that the beat had already recovered from.
 */
export const READ_DEADLINE_MS = 15_000;

export interface CognitionState {
  payload: CognitionPayload | null;
  /** True only while there is NOTHING on screen. Never true on a beat refetch. */
  loading: boolean;
  /**
   * A TRANSPORT failure — the server stopped answering, sent unparseable JSON,
   * or did not answer inside {@link READ_DEADLINE_MS}. Distinct from
   * `payload.degraded`, which is the server REPORTING a degraded brain: one
   * means the page cannot reach its data, the other means the data says
   * something is wrong. Collapsing them would send the operator to the wrong
   * remedy.
   */
  error: string | null;
}

export function useCognition(tick: number): CognitionState {
  const [payload, setPayload] = useState<CognitionPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    let timedOut = false;

    /*
     * THE DEADLINE. An `AbortController` fired by a timer, so a socket that
     * never answers becomes an abort this effect can attribute — rather than a
     * promise that is still pending when the component unmounts, which is
     * indistinguishable from a slow read and renders as a spinner forever.
     *
     * `timedOut` is set BEFORE `abort()` so the rejection handler can tell this
     * abort from an unmount/beat abort. Reading `ctrl.signal.reason` would work
     * too, but it is not the same value across the environments this bundle
     * runs in, and a wrong sentence is worse here than no sentence.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, READ_DEADLINE_MS);

    setBusy(true);
    api
      .cognition(ctrl.signal)
      .then((p) => {
        if (ctrl.signal.aborted) return;
        setPayload(p);
        setError(null);
      })
      .catch((err: unknown) => {
        if (timedOut) {
          // The fourth state, STATED. Not a spinner, not an empty panel.
          setError(`read timed out after ${READ_DEADLINE_MS / 1000}s`);
          return;
        }
        // An unmount or a superseding beat. The successor owns the outcome.
        if (ctrl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        clearTimeout(timer);
        // A TIMED-OUT read must leave `busy` false even though the signal is
        // aborted: it has no successor, so leaving it busy is precisely the
        // eternal loader this deadline exists to prevent.
        if (!ctrl.signal.aborted || timedOut) setBusy(false);
      });

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [tick]);

  return {
    payload,
    // See header rule 2. Only "loading" while there is nothing on screen.
    loading: busy && payload === null,
    error,
  };
}
