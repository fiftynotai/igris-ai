/**
 * FR-241 — the MUTATE half of the triage surface.
 *
 * The READ half is `layers/useLayerList.ts`, unchanged and reused: the triage
 * lists need exactly the state machine four layer views already share (filters,
 * an offset, a payload, a refetch on the beat, an abort on unmount). Writing a
 * second one would be the fork AC #5 exists to prevent, one layer below where
 * the AC looks. So this hook does one thing the list hook cannot: apply.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO OPTIMISTIC STATE. NOT AS A SIMPLIFICATION — AS A CORRECTNESS RULE
 * ─────────────────────────────────────────────────────────────────────────
 * D6: each id is its own handler call and its own transaction, so a batch can
 * PARTIALLY apply — `applied: 3, failed: 2` is a normal outcome, not an
 * exception. An optimistic UI removes all five rows the instant the button is
 * pressed and then has to put two of them back. During that window the screen
 * is telling the operator something false about their own brain, on the one
 * surface where the next click might be a permanent delete. So: fire, wait,
 * re-read, and render what the brain says.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CHUNKED, SEQUENTIALLY
 * ─────────────────────────────────────────────────────────────────────────
 * `MAX_BULK` ids per request (`model.ts#chunkIds`), issued one at a time. The
 * server dispatches each id sequentially over ONE better-sqlite3 connection and
 * several handlers open a `db.transaction()`; firing chunks in parallel buys
 * nothing on a loopback UI and invites a nested-transaction error under load.
 */

import { useCallback, useRef, useState } from "react";
import { api, ApiError, type BriefRef, type TriageResultPayload } from "../lib/api";
import {
  buildBriefWriteRequest,
  buildTriageRequest,
  chunkIds,
  mergeResults,
  type BriefWriteAction,
  type TriageAction,
  type TriageSummary,
  type WriteAction,
} from "./model";

export interface TriageMutation {
  /** True while a batch is in flight. Every write affordance disables on it. */
  busy: boolean;
  /** The last completed batch's merged outcome, or `null` before the first. */
  summary: TriageSummary | null;
  /** The action the last summary belongs to. */
  lastAction: WriteAction | null;
  /** A TRANSPORT failure. Distinct from a per-id failure and from `degraded`. */
  error: string | null;
  apply: (
    action: TriageAction,
    ids: readonly number[],
    extra?: { reason?: string; briefId?: string },
  ) => Promise<TriageSummary | null>;
  /**
   * FR-247 — the BRIEF-addressed twin of `apply`.
   *
   * A second entry point rather than a union parameter, because every property
   * this hook guarantees is shared through `runBatch` below: one batch in
   * flight, chunked at `MAX_BULK`, sequential, no optimistic state, an
   * unconditional re-read in `finally`. What differs between the two is only
   * how a chunk becomes a request body — which is exactly the one thing each
   * wrapper supplies.
   */
  applyRefs: (
    action: BriefWriteAction,
    refs: readonly BriefRef[],
    extra?: { priority?: string; goalId?: string },
  ) => Promise<TriageSummary | null>;
  /** Drop the last summary — used when the selection or the tab changes. */
  clear: () => void;
}

export function useTriage(onApplied: () => void): TriageMutation {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<TriageSummary | null>(null);
  const [lastAction, setLastAction] = useState<WriteAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The refetch callback is read from a ref for the same reason
  // `useLayerList`'s fetcher is: callers pass an inline closure whose identity
  // changes every render, and an `apply` that changed identity every render
  // would re-create every button's handler on the beat.
  const done = useRef(onApplied);
  done.current = onApplied;

  // A guard, not an optimisation. Two concurrent batches would interleave their
  // chunks over one connection and produce a summary that belongs to neither.
  const inFlight = useRef(false);

  /**
   * The ONE batch runner. Both public entry points are wrappers over it, so
   * the in-flight guard, the chunking, the sequencing, the no-optimistic-state
   * rule and the unconditional re-read have exactly one implementation.
   */
  const runBatch = useCallback(
    async <T,>(
      action: WriteAction,
      items: readonly T[],
      toBody: (chunk: T[]) => Parameters<typeof api.triage>[0],
    ): Promise<TriageSummary | null> => {
      const chunks = chunkIds(items);
      // ZERO chunks means an empty selection. Refuse rather than fire: the
      // server 400s an empty `ids`/`refs`, and a UI that can issue a bulk
      // action on nothing is a UI whose selection state is wrong.
      if (chunks.length === 0 || inFlight.current) return null;

      inFlight.current = true;
      setBusy(true);
      setError(null);
      setLastAction(action);
      try {
        const responses: TriageResultPayload[] = [];
        for (const chunk of chunks) responses.push(await api.triage(toBody(chunk)));
        const merged = mergeResults(items.length, responses);
        setSummary(merged);
        return merged;
      } catch (err: unknown) {
        // A transport failure is NOT a per-id failure and must not be rendered
        // as one: nothing is known about what landed, so the summary is dropped
        // and the operator is told to re-read rather than shown a count.
        setSummary(null);
        setError(err instanceof ApiError ? err.message : String(err));
        return null;
      } finally {
        inFlight.current = false;
        setBusy(false);
        // Re-read unconditionally, INCLUDING after a throw: a request that
        // failed mid-batch may still have applied the ids before the failure,
        // and the list is the only honest account of what the brain now holds.
        done.current();
      }
    },
    [],
  );

  const apply = useCallback(
    (
      action: TriageAction,
      ids: readonly number[],
      extra: { reason?: string; briefId?: string } = {},
    ): Promise<TriageSummary | null> =>
      runBatch(action, ids, (chunk) => buildTriageRequest(action, chunk, extra)),
    [runBatch],
  );

  const applyRefs = useCallback(
    (
      action: BriefWriteAction,
      refs: readonly BriefRef[],
      extra: { priority?: string; goalId?: string } = {},
    ): Promise<TriageSummary | null> =>
      runBatch(action, refs, (chunk) => buildBriefWriteRequest(action, chunk, extra)),
    [runBatch],
  );

  const clear = useCallback(() => {
    setSummary(null);
    setError(null);
    setLastAction(null);
  }, []);

  return { busy, summary, lastAction, error, apply, applyRefs, clear };
}
