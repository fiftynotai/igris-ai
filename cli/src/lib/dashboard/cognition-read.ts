/**
 * FR-266 D1 — the cognition-health layer. ZERO SQL, and zero re-derivation.
 *
 * `igris cognition health` already owns the whole roster / gate / classifier /
 * schedule computation as an exported structured function
 * (`verbs/cognition.ts#buildCognitionHealthDigest`). So this module adds exactly
 * two things: an `existsSync` preflight and a guarded call. It contains no
 * classifier, no gate resolver and no roster.
 *
 * THE PRECEDENT IS ALREADY IN THIS DIRECTORY. `context-docs-read.ts:39` imports
 * `buildContextDocsInventoryDigest` from `../../verbs/context-docs.js` and calls
 * it at `:142`. A dashboard route reaching a VERB's digest builder in-process is
 * the established direction here, not a new one — which is why D1 is settled by
 * precedent rather than by preference.
 *
 * WHY IN-PROCESS AND NOT `spawn("igris", ["cognition","health","--json"])`
 * ---------------------------------------------------------------------------
 * Five reasons, each disqualifying alone:
 *
 *  1. PATH DEPENDENCE. `igris` need not be on the `PATH` of the process serving
 *     the dashboard. `dashboard.bats` T8 runs the whole surface from a
 *     packed-and-extracted tarball at an arbitrary path, and `browser-gate.mjs`
 *     runs `dist/index.js` directly. A spawn is a new environmental
 *     precondition for both.
 *  2. COLD START PER REQUEST. A Node boot (~150-300 ms) against siblings that
 *     answer in single-digit ms, on a page that follows a 5-second beat.
 *  3. A NEW CAPABILITY ON A NO-AUTH LOOPBACK ORIGIN. `lib/dashboard/**` contains
 *     zero `child_process` today. An HTTP handler that forks is a
 *     security-posture change arriving as a convenience.
 *  4. IT MOVES THE READ-ONLY GUARANTEE OUT OF REACH OF THE GATE THAT OWNS IT.
 *     `dashboard-readonly.test.ts` G-RO-3 asserts `query_only = 1` on the
 *     IN-PROCESS handle. A child process opens a handle that suite cannot
 *     inspect, so "read-only is mechanically true" would degrade to "true in a
 *     process we did not measure".
 *  5. SANDBOX ESCAPE. `dashboard-readonly.test.ts` pins that `brainDbPath()`
 *     resolves inside the test sandbox. A child would read the operator's REAL
 *     brain unless `IGRIS_BRAIN_DIR` were threaded into its env by hand at every
 *     call site — one forgotten thread and the suite silently tests production.
 *
 * WHY IN-PROCESS IS SAFE HERE SPECIFICALLY — this is not a general licence:
 *
 *  - `buildCognitionHealthDigest()` reaches the brain ONLY through
 *    `brain-db.ts#withReadonlyBrain` -> `brain-bridge.ts#openBrainReadonly` —
 *    the SAME door the tier's structural read-door claim already rests on
 *    (`{readonly:true, fileMustExist:true}` plus `query_only = ON`). The new
 *    endpoint inherits G-RO-3 / G-RO-5 by construction rather than by promise.
 *  - It honours `IGRIS_BRAIN_DIR` for BOTH of its inputs: the DB through
 *    `brainDbPath()` and `config.json` through `configJsonPath()` ->
 *    `brainDir()`. The sandbox seam works unchanged.
 *  - `verbs/cognition.ts`'s own header states that it deliberately does NOT use
 *    the `bootEngine` write door, BECAUSE asking a health question must not run
 *    `monitoring`'s 30-day `event_log` purge. That reasoning is exactly what
 *    makes the function importable from a read tier.
 *
 * THE COST, STATED: an import edge `lib/dashboard/**` -> `verbs/**`. It is one
 * named symbol, it is the established direction, and this module joins the
 * zero-SQL corpus scan in `dashboard-server.test.ts`.
 *
 * MEASURED COST OF THE CALL, AND THE CADENCE DECISION IT SETTLED (D7)
 * ---------------------------------------------------------------------------
 * `buildCognitionHealthDigest` does ONE `openBrainReadonly` open/close per
 * reader per instance — roster + retention floor + (per instance) run signals +
 * schedule + output counts. For 7 instances that is ~20+ open/close cycles per
 * call. The per-call open/close is deliberate and correct (`brain-db.ts`: *"so a
 * `/hunt` writing to the brain is visible on the next read"*), so the lever is
 * the CADENCE, not the reader.
 *
 * MEASURED on the operator's real brain (7 instances, macOS, node v22, one
 * discarded warm-up then 20 samples through a loopback server on port 0):
 *
 *     p50 13.0 ms · p95 14.6 ms · min 12.6 ms · max 17.3 ms · payload 4,853 B
 *
 * The pre-declared fallback — once-per-scope with a visible `AS OF` stamp and a
 * REFRESH control, the call `RecordDetail` and `pages/Graph.tsx` already make —
 * was to be taken if p95 exceeded 250 ms. It came in ~17x under that, so the
 * client FOLLOWS the shell's 5-second beat: a diagnostics surface whose whole
 * premise is continuous visibility should not need a button pressed to be true.
 *
 * RE-MEASURE IF THE ROSTER GROWS BY AN ORDER OF MAGNITUDE. The cost is linear
 * in the instance count, and the registry is OPEN by design.
 */

import { existsSync } from "node:fs";
import { brainDbPath } from "../paths.js";
import { buildCognitionHealthDigest } from "../../verbs/cognition.js";
import type { CognitionHealthDigest } from "../../types.js";

/** The outcome of asking for the cognition digest. */
export type CognitionResult =
  | { ok: true; digest: CognitionHealthDigest }
  | { ok: false; reason: string };

/**
 * Read the cognition health digest.
 *
 * NEVER THROWS, and the 200-not-500 contract is why: a degraded brain is an
 * ordinary state of a personal lens. An absent DB and a builder throw are kept
 * DISTINCT from the digest's own `degraded` flag, and anything at this level
 * becomes an `ok:false` the route turns into the FR-238 envelope.
 */
export function readCognitionHealth(): CognitionResult {
  if (!existsSync(brainDbPath())) {
    // Named at THIS level rather than left to the digest's own `degraded`,
    // because the two send an operator to different places: no file at all is
    // "run `igris install`", while an unreadable roster is "boot a brain build
    // that projects it".
    return { ok: false, reason: `brain database not found at ${brainDbPath()}` };
  }
  try {
    // NO FIELD SELECTION. Forwarded whole — see `types.ts#CognitionPayload`.
    return { ok: true, digest: buildCognitionHealthDigest() };
  } catch (err) {
    return {
      ok: false,
      reason: `cognition health read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
