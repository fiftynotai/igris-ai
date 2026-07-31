/**
 * FR-241 (D1) — the CLI -> brain-bundle **WRITE** door.
 *
 * This is the SECOND door into the vendored brain bundle. `brain-bridge.ts` is
 * the read door (FR-238/FR-240: pure `db`-param readers over a `query_only`
 * handle). This file is the read-WRITE one, and the two are deliberately
 * separate modules returning separate connections:
 *
 *   - `openBrainReadonly()` / `openBrainReadonlyWithVec()` are NOT touched by
 *     this brief. FR-240's G-RO-3 pin (an `UPDATE` throws on the bridge handle)
 *     stays true because the write door is a different function in a different
 *     module returning a different connection object.
 *   - Nothing here is reachable from a pure-read session. The engine boots
 *     LAZILY — the first `POST /api/triage` boots it and nothing else does.
 *
 * WHY AN IN-PROCESS ENGINE AND NOT AN IMPORTED HANDLER
 * ----------------------------------------------------
 * The five write handlers take no `db` parameter; each calls `getDb()`. So a
 * handler import would have to call `db.ts#setAdapter` anyway — which is half of
 * `bootEngine` minus the bus (so `handlePerceptionApprove`'s
 * `bus.emit('perception.candidate_approved')` would behave differently from the
 * MCP path) and minus the GATEWAY, which is where validation actually lives:
 * the BR-080 `required` walk (`gateway.ts:153-159`) and the TD-128
 * `additionalProperties:false` extras walk (`gateway.ts:162-176`). Importing a
 * handler directly silently drops both.
 *
 * So the dashboard's write path is not *like* the MCP path. It **is** the MCP
 * path with the JSON-RPC framing removed: `createBrainServer()`'s
 * `CallToolRequestSchema` handler (`brain-mcp-server/src/index.ts:231-247`) is a
 * one-line wrapper around the same `gateway.dispatch(name, args)` call this
 * module makes. Audit parity, validation parity and event parity are
 * CONSEQUENCES of that shape, not features implemented here.
 *
 * THE ONE DEVIATION FROM THE MCP SERVER'S ENGINE (D1a)
 * ----------------------------------------------------
 * `schedules` is the only disabled component. `bootEngine` otherwise starts the
 * schedules cron daemon (`schedules/index.ts` -> `daemon.ts:314-336`, a
 * self-rescheduling `setTimeout` that is **not** `unref()`'d — verified below),
 * which would turn `igris dashboard` into a second brain daemon firing
 * `igris_subconscious_run`, the perception/synapse/janitor extractors and their
 * LLM calls on cron. `sync` STAYS enabled: `suggestions` and `learnings` are
 * both `SYNC_TABLES`, so disabling it would make dashboard writes fail to
 * propagate while MCP writes succeeded — a parity break in the other direction.
 *
 * ===========================================================================
 * FR-241 PHASE-0 PROBE RESULTS — RECORDED VERBATIM (the plan requires this)
 * ===========================================================================
 * Run 2026-07-31 on darwin/arm64, Node v24.7.0, better-sqlite3 11.x,
 * sqlite-vec 0.1.7, against a `VACUUM INTO` snapshot of the real 56 MB brain
 * (1,188 pending suggestions / 17 perception candidates / 2,005 event_log
 * rows). **The live brain was never opened.** Its `knowledge.db` sha256 was
 * `27e0983684465ef25d1356dcaab0b3c21dd27fecd87f9523d2f66e99e45f73e5` before and
 * after every probe, with an unchanged mtime and unchanged 1188/17 counts.
 *
 * STEP 1 — SNAPSHOT. `sqlite3 -readonly <live> "VACUUM INTO <snap>"`, 0.24 s,
 *   54,190,080 bytes, sha256
 *   `6c13a710328b2c5692081fb82689bdcfb9693a73dc34a7afd73c30e71cf3089c`.
 *   The snapshot opens in `journal_mode = delete`, 188 sqlite_master objects
 *   (66 tables).
 *
 * STEP 2 — IMPORT + BOOT.
 *   - `import()` of `cli/dist/brain-mcp-server/dist/engine/index.js` — OK,
 *     59-63 ms. The module's ONLY export is `bootEngine`.
 *   - `bootEngine({dbPath: <snap>, components: {schedules:{enabled:false}}})` —
 *     **645 ms cold / 82 ms warm.** Under the plan's 500 ms "boot on tab entry
 *     instead" threshold on a warm page cache; a first-ever boot is not.
 *   - `gateway.toolCount()` = **105**.
 *   - `registry.getBootOrder()` = [memory, errors, projects, context, metrics,
 *     sessions, briefs, edges, goals, instances, sync, cache, cognition,
 *     monitoring, catalog] — **15**, i.e. the 16-component set MINUS
 *     `schedules`. `registry.ts:99-104` skips a disabled component entirely.
 *   - No tool matching /schedule/i is registered. All five triage tools are:
 *     `igris_suggestion_dismiss|_acted|_apply_action`,
 *     `igris_perception_approve|_reject` all report `hasTool = true`.
 *   - Boot writes ~35 lines to **stderr** (`[engine] Booting…`, one
 *     `[<component>] Loaded…` per component). A CLI that boots this in the
 *     foreground inherits that noise.
 *
 * STEP 3 — WHAT THE BOOT ITSELF WROTE (the number that decides whether lazy
 *   boot is acceptable, and the baseline the parity differ subtracts):
 *     schema objects ADDED by boot:   (none)
 *     schema objects REMOVED by boot: (none)
 *     TOTAL rows created by boot:     **0**
 *   Measured by byte-copying the snapshot pre-boot, then `ATTACH`ing the copy
 *   and running `SELECT * FROM main.T EXCEPT SELECT * FROM pre.T` over all 66
 *   plain tables (fts5/vec shadow tables excluded). **The single side effect of
 *   a boot on an already-migrated brain is `journal_mode: delete -> wal`.**
 *   That is a FILE-level change with no row delta, and it is the residual
 *   TD-319 already owns; G-RO-5's fixture is a `delete`-mode brain, which is
 *   exactly why the write engine must stay LAZY.
 *
 * STEP 4 — THE D1a EDGE CASE. The `schedules` TABLE is present (the component
 *   being disabled does not drop it) and carries the three bootstrap rows:
 *   (cron fields written with a middle dot for the `*` so this block comment
 *   cannot be closed by a `0 *<dot>/6` literal — the `*` + `/` pair terminates
 *   a block comment, and a probe record that breaks the build is not a record):
 *     janitor_engine      enabled=1 `0 4 · · ·`   igris_janitor_run_now
 *     subconscious_engine enabled=0 `0 ·/6 · · ·` igris_subconscious_run
 *     subconscious_engine enabled=1 `0 ·/6 · · ·` igris_subconscious_run (dup)
 *     synapse_engine      enabled=1 `0 3 · · ·`   igris_synapse_run
 *   so all three cognition instances logged `Schedule "<name>" already exists;
 *   skipping bootstrap` — **no dispatch, no bus emit, no event_log row**
 *   (`event_log WHERE event_name LIKE '%bootstrap%'` = 0). The noisy
 *   table-present-row-absent case does not exist on this brain. (Incidental
 *   finding, not this brief's: `subconscious_engine` has TWO rows.)
 *
 * STEP 5 — `gateway.dispatch('igris_suggestion_dismiss', {id, reason})` on a
 *   seeded scratch row (id 1213), 1 ms:
 *     returned: {"updated": true, "suggestion": {…, "status": "dismissed",
 *                "dismissed_at": "…", "dismissed_reason": "fr241 phase-0 probe"}}
 *     `suggestions`        row delta:  **0** (a status FLIP, not an insert)
 *     `dismissed_patterns` row delta:  **+1**
 *       {"source_module":"probe_module","project_slug":"fr241-probe",
 *        "evidence_signature":"probe_module:fallback:{\"probe\":\"step5\"}",
 *        "dismiss_count":1,"reasons":"[\"fr241 phase-0 probe\"]"}
 *     `event_log`          row delta:  **0** — rows since watermark: `[]`.
 *   The plan's prediction is CONFIRMED, not assumed: dismiss is event-silent.
 *
 * STEP 5b — the other four, on a fresh sandbox brain (same probe, `8d`):
 *     `igris_suggestion_acted`   -> status='acted', acted_brief_id set;
 *                                   event_log delta **0**
 *     `igris_perception_approve` -> review_status='approved';
 *                                   event_log delta **0** (it DOES
 *                                   `bus.emit('perception.candidate_approved')`,
 *                                   but `monitoring` does not listen for it)
 *     `igris_perception_reject`, seen_again_count=0 -> `{"deleted":true}`, the
 *                                   `learnings` row is **GONE**;
 *                                   event_log delta **0**
 *     `igris_perception_reject`, seen_again_count=1 -> `{"deleted":true,
 *                                   "soft":true,"recurring":true}`, the row
 *                                   survives with review_status='rejected' +
 *                                   deleted_at; event_log delta **1**:
 *       {"event_name":"perception.rejected_pattern_recurring",
 *        "component":"perception","project_slug":null,
 *        "payload":"{\"learning_id\":2,\"title\":\"recurring\",\"reason\":\"probe\"}"}
 *   So L-140 is HALF STALE (reject is a three-tier outcome, not a blanket hard
 *   delete) and the L-857 naming trap resolves to the LEGACY literal
 *   `component = 'perception'` — `perception/events.ts:110` passes it directly
 *   to `insertEventLogRow`; it is NOT `cognition.perception`.
 *
 * STEP 5c — GATEWAY VALIDATION REACHES A NON-MCP CALLER (verified, not assumed):
 *     dispatch('igris_suggestion_dismiss', {})            THREW
 *       "igris_suggestion_dismiss: missing required argument 'id'. Required:
 *        id. (strict-input contract; BR-080)"
 *     dispatch('igris_suggestion_dismiss', {id:1,bogus:1}) THREW
 *       "igris_suggestion_dismiss: unknown argument 'bogus'. Accepted keys: id,
 *        reason. (strict-input contract; TD-128)"
 *     dispatch('igris_perception_approve', {id:1})         THREW
 *       "igris_perception_approve: missing required argument 'learning_id'.
 *        Required: learning_id. (strict-input contract; BR-080)"
 *     dispatch('igris_not_a_tool', {})                     THREW "Unknown tool:
 *        igris_not_a_tool"
 *   This is why `TRIAGE_ACTIONS.idKey` is `learning_id` for the two perception
 *   actions and `id` for the three suggestion ones: getting it wrong is a
 *   gateway rejection, not a silent mis-write.
 *
 * STEP 6 — THE SANDBOX FENCE. With `IGRIS_DB_PATH` pointed at a POISON path
 *   (`…/poison/POISON-MUST-NOT-EXIST.db`), the same dismiss dispatch:
 *     row 1214 in the SNAPSHOT -> status='dismissed', reason recorded
 *     `dismissed_patterns` in the snapshot: **+1**
 *     poison path exists on disk: **false**; poison DIRECTORY: **false**
 *   **`IGRIS_DB_PATH` is dead code once `setAdapter` has run** (`db.ts:1297-1301`
 *   short-circuits on `_adapter` before `resolveDbPath()` is consulted). The
 *   destructive suites are therefore fenced BY CONSTRUCTION, not by discipline.
 *
 * STEP 7 — TWO ENGINES IN ONE PROCESS **CROSS-CONTAMINATE**. After booting a
 *   second engine at a second dbPath, engine **A**'s gateway dispatched against
 *   **B**'s database:
 *     seeded id 1215 in A; `engineA.gateway.dispatch('igris_suggestion_dismiss',
 *       {id:1215})` -> {"isError":true, "Error: Suggestion not found: 1215"}
 *     A suggestions delta 0 · B suggestions delta 0 · row 1215 still 'pending'
 *   `setAdapter` is a MODULE-GLOBAL (`db.ts:73`), so the last boot wins for
 *   every `getDb()` in the process regardless of which gateway is called.
 *   TWO CONSEQUENCES, both load-bearing:
 *     (a) the FR-241 parity gate must run in two **PROCESSES**, never two
 *         engines in one process;
 *     (b) this module must boot **at most one** engine per process. The memo
 *         below is not an optimisation — it is the correctness property.
 *
 * STEP 8 — SHUTDOWN. `engine.shutdown()` completes in 4 ms and leaves **no**
 *   active handles and **no** active requests; the process exits 0.
 *   STEP 8b — booting WITHOUT calling shutdown also leaves no active handle and
 *   still exits 0, because the only timer a default-minus-schedules boot can
 *   arm is `sync`'s 10 s batch flush, which is `.unref()`'d
 *   (`sync/index.ts:410-411`) AND is armed only on a bus event when
 *   `auto_push === true` in `~/.igris/config.json` (absent on this machine, so
 *   `loadAutoPushConfig()` returns null and the path is inert). The
 *   NON-unref'd timers are the schedules daemon's (`daemon.ts:314,326,332,336`)
 *   — which D1a forecloses. `shutdownWriteEngine()` is therefore hygiene plus
 *   a closed connection, not the difference between exiting and hanging.
 *   STEP 8c — `bootEngine` at a path whose DIRECTORY does not exist THROWS
 *   `TypeError: Cannot open database because the directory does not exist`.
 *   Boot must be wrapped: this module never throws, it degrades.
 *
 * WHAT THE PROBE DID NOT ESTABLISH: nothing about concurrency (two dashboard
 * requests dispatching at once), and nothing about the remote brain's copy
 * after a `sync` egress. Both are out of this brief's scope and stated rather
 * than assumed.
 *
 * ===========================================================================
 * THIS FILE CONTAINS ZERO SQL, and that is asserted mechanically by
 * `dashboard-server.test.ts`'s scope scan. It is not a query layer, it is a
 * DELEGATION layer: nothing here parses SQL and nothing here knows what a
 * suggestion IS. Every mutation is `gateway.dispatch(<a name from the frozen
 * map>, <args>)`.
 * ===========================================================================
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { brainDbPath } from "./paths.js";
import {
  ENGINE_MODULE_REL,
  brainBundleCandidates,
  resolveBundleModule,
} from "./brain-bridge.js";

// ---------------------------------------------------------------------------
// Structural type facade — mirrors `brain-mcp-server/src/engine/index.ts` and
// `src/engine/gateway.ts`. Same per-field source-line discipline the read
// bridge uses; MAINTAINING's bundle-import row pins it.
// ---------------------------------------------------------------------------

/** gateway.ts:14 (`ToolResult` in `engine/types.ts`) — the MCP result envelope. */
export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** engine/gateway.ts:124 — `dispatch`. THROWS on validation failure (BR-080/TD-128). */
type DispatchFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/** engine/index.ts:48 — `Engine`, narrowed to what this bridge uses. */
interface EngineHandle {
  gateway: {
    dispatch: DispatchFn;
    /** gateway.ts:193 */
    hasTool: (name: string) => boolean;
    /** gateway.ts:186 */
    toolCount: () => number;
  };
  /** engine/index.ts:136 */
  shutdown: () => void;
}

/** engine/index.ts:68 — `bootEngine(config)`. THROWS; see Phase-0 step 8c. */
type BootEngineFn = (config: {
  dbPath: string;
  components: Record<string, { enabled: boolean }>;
}) => EngineHandle;

// ---------------------------------------------------------------------------
// The delegation map — THE REVIEW ARTIFACT
// ---------------------------------------------------------------------------

/**
 * The COMPLETE set of mutations the dashboard can perform, as `action -> brain
 * tool`. A mutation that does not resolve to a row here does not exist.
 *
 * MAINTAINING carries this as its own contract row, and the change procedure is
 * one sentence: **a dashboard mutation may only ever be added by adding a row
 * to this map; a mutation that does not resolve to a registered brain tool is
 * forbidden.** That is what makes "no raw SQL in the server layer" assertable
 * by construction rather than by review — there is no other way to write.
 *
 * `idKey` is ASYMMETRIC and deliberately so: the three suggestion tools declare
 * `required: ['id']`, the two perception tools declare
 * `required: ['learning_id']`. Getting it wrong does not mis-write — the
 * gateway rejects the call with `missing required argument 'learning_id'`
 * (Phase-0 step 5c observed exactly that), which is BR-080 working.
 *
 * `bulk: false` on `apply` is D4: `igris_suggestion_apply_action` dispatches
 * arbitrary action KINDS (`tick_ac` / a `create_brief` draft / `add_edge` /
 * `flag_for_review`). Bulk-firing heterogeneous side effects behind one confirm
 * is not a triage flow.
 *
 * `extra` is an ALLOW-LIST, not documentation: `buildArgs` copies only these
 * keys, so a client that posts `{reason, brief_id, winner_id}` at `dismiss`
 * cannot reach the handler with `winner_id`. (The gateway would reject it too —
 * this is the defence-in-depth half, and it keeps the 400 client-side.)
 */
export interface TriageActionSpec {
  readonly tool: string;
  readonly bulk: boolean;
  readonly idKey: "id" | "learning_id";
  readonly extra: readonly ("reason" | "brief_id")[];
}

export const TRIAGE_ACTIONS: Readonly<Record<string, TriageActionSpec>> =
  Object.freeze({
    dismiss: Object.freeze({
      tool: "igris_suggestion_dismiss",
      bulk: true,
      idKey: "id",
      extra: Object.freeze(["reason"]),
    }),
    acted: Object.freeze({
      tool: "igris_suggestion_acted",
      bulk: true,
      idKey: "id",
      extra: Object.freeze(["brief_id"]),
    }),
    apply: Object.freeze({
      tool: "igris_suggestion_apply_action",
      bulk: false,
      idKey: "id",
      extra: Object.freeze([]),
    }),
    approve: Object.freeze({
      tool: "igris_perception_approve",
      bulk: true,
      idKey: "learning_id",
      extra: Object.freeze([]),
    }),
    reject: Object.freeze({
      tool: "igris_perception_reject",
      bulk: true,
      idKey: "learning_id",
      extra: Object.freeze(["reason"]),
    }),
  } as Record<string, TriageActionSpec>);

/** The action names, for the parser's allowlist and for `/api/health`. */
export const TRIAGE_ACTION_NAMES: readonly string[] = Object.freeze(
  Object.keys(TRIAGE_ACTIONS),
);

/** Look an action up. Returns `null` for anything not in the frozen map. */
export function triageAction(action: string): TriageActionSpec | null {
  // `Object.hasOwn` rather than `TRIAGE_ACTIONS[action]`: `"constructor"` and
  // `"toString"` are truthy on a plain object literal and would otherwise
  // resolve to a Function, which is a prototype-pollution-shaped bug even
  // though `Object.freeze` makes it harmless here.
  return Object.hasOwn(TRIAGE_ACTIONS, action)
    ? (TRIAGE_ACTIONS[action] as TriageActionSpec)
    : null;
}

// ---------------------------------------------------------------------------
// Lazy engine boot
// ---------------------------------------------------------------------------

/**
 * The ONE component this engine disables (D1a). Everything else defaults to
 * enabled, so the dispatch path is the MCP server's path.
 *
 * Exported so a test can assert the deviation set is EXACTLY this — "the
 * dashboard is not a second brain daemon" is a claim about a set, and a claim
 * about a set needs the set asserted, not sampled.
 */
export const WRITE_ENGINE_COMPONENTS: Readonly<
  Record<string, { enabled: boolean }>
> = Object.freeze({
  schedules: Object.freeze({ enabled: false }),
});

/**
 * Why the write surface is unavailable. Discriminated for the same reason
 * `BuildGraphResult` is: the three causes send an operator to completely
 * different places.
 *
 *  - `engine_unavailable` — the vendored `engine/index.js` did not resolve or
 *    import. A PACKAGING problem (a moved artifact, a vendored `node_modules`
 *    absent before `postinstall`).
 *  - `brain_unavailable`  — no brain database at `brainDbPath()`. A DATA
 *    problem. Note the write door checks EXISTENCE first and never creates one:
 *    `bootEngine` on a fresh path would happily MANUFACTURE a brain, and a
 *    dashboard that invents an empty brain because the real one was not mounted
 *    is worse than one that says it cannot reach it.
 *  - `boot_failed`        — the module loaded and the file is there, but
 *    `bootEngine` threw (Phase-0 step 8c: an unreadable directory does this).
 */
export type WriteEngineFailureKind =
  | "engine_unavailable"
  | "brain_unavailable"
  | "boot_failed";

export type WriteEngineResult =
  | { ok: true; engine: EngineHandle }
  | { ok: false; kind: WriteEngineFailureKind; reason: string };

/**
 * The lazily-booted engine.
 *
 * AT MOST ONE PER PROCESS, and that is a CORRECTNESS property rather than an
 * optimisation: Phase-0 step 7 showed `db.ts#setAdapter` is a module-global, so
 * a second `bootEngine` in this process would silently re-point every
 * `getDb()` — including the first engine's — at the second database.
 */
let engine: EngineHandle | null = null;
let engineFailure: { kind: WriteEngineFailureKind; reason: string } | null = null;
let bootInFlight: Promise<WriteEngineResult> | null = null;

/** Memoised `bootEngine` handle — the import is expensive, the artifact static. */
let cachedBoot: BootEngineFn | null = null;
let cachedBootFailure: string | null = null;

/**
 * Load `bootEngine` from the vendored bundle.
 *
 * Returns `null` on ANY failure and NEVER rejects — the same degrade-not-throw
 * contract `loadBuildBrainGraph` carries, and for the same reason: this is a
 * PATH-LITERAL dependency on a build artifact.
 */
export async function loadBootEngine(): Promise<BootEngineFn | null> {
  if (cachedBoot !== null) return cachedBoot;
  if (cachedBootFailure !== null) return null;

  const modulePath = resolveBundleModule(ENGINE_MODULE_REL);
  if (modulePath === null) {
    cachedBootFailure = `brain engine module not found: ${ENGINE_MODULE_REL} (looked in: ${brainBundleCandidates().join(", ")})`;
    return null;
  }

  try {
    const mod: unknown = await import(pathToFileURL(modulePath).href);
    const fn = (mod as { bootEngine?: unknown }).bootEngine;
    if (typeof fn !== "function") {
      cachedBootFailure = `module at ${modulePath} does not export bootEngine`;
      return null;
    }
    cachedBoot = fn as BootEngineFn;
    return cachedBoot;
  } catch (err) {
    cachedBootFailure = `import failed: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

/**
 * Boot the write engine, once, at `brainDbPath()`.
 *
 * NEVER throws. Concurrent callers share ONE in-flight boot — two simultaneous
 * `POST /api/triage`s must not race two `bootEngine` calls, because step 7
 * makes a double boot a data-integrity problem rather than a wasted 80 ms.
 *
 * A FAILURE IS STICKY. A boot that threw once will throw again for the same
 * reason (a missing artifact, an unreadable directory), and retrying it per
 * request would turn a degraded surface into a slow one. `resetWriteEngine()`
 * is the seam tests use between sandboxes.
 */
export async function bootWriteEngine(): Promise<WriteEngineResult> {
  if (engine !== null) return { ok: true, engine };
  if (engineFailure !== null) return { ok: false, ...engineFailure };
  if (bootInFlight !== null) return bootInFlight;

  bootInFlight = (async (): Promise<WriteEngineResult> => {
    const boot = await loadBootEngine();
    if (boot === null) {
      engineFailure = {
        kind: "engine_unavailable",
        reason:
          cachedBootFailure ??
          "brain engine module could not be loaded from the vendored bundle",
      };
      return { ok: false, ...engineFailure };
    }

    const dbPath = brainDbPath();
    if (!existsSync(dbPath)) {
      // Deliberately NOT sticky-cached: unlike a moved artifact, a brain can
      // appear (a mount, a first `igris init`) while the dashboard is running,
      // and a sticky failure here would require a restart to notice.
      return {
        ok: false,
        kind: "brain_unavailable",
        reason: `brain database not found at ${dbPath}`,
      };
    }

    try {
      const booted = boot({
        dbPath,
        // A COPY, not the frozen object: `bootEngine` is third-party-shaped
        // code from this module's point of view, and handing it a frozen
        // literal it might try to normalise is a needless failure mode.
        components: { ...WRITE_ENGINE_COMPONENTS },
      });
      engine = booted;
      return { ok: true, engine: booted };
    } catch (err) {
      engineFailure = {
        kind: "boot_failed",
        // Verbatim. `Cannot open database because the directory does not exist`
        // is the whole diagnosis; a generic message would throw it away.
        reason: `brain write engine boot failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      return { ok: false, ...engineFailure };
    }
  })().finally(() => {
    bootInFlight = null;
  });

  return bootInFlight;
}

/**
 * The write engine's state, for `/api/health` and for FR-241's G-RO-6.
 *
 * `"not-booted"` is the value a PURE-READ SESSION must still report after the
 * FR-240 read-only request sequence: it is what makes "lazy boot is real" a
 * mechanical fact rather than an accident of route ordering.
 *
 * Deliberately SYNCHRONOUS and side-effect-free — a state probe that booted the
 * thing it was probing would make the assertion above impossible to write.
 */
export function writeEngineState(): string {
  if (engine !== null) return "booted";
  if (engineFailure !== null) return `unavailable:${engineFailure.kind}`;
  return "not-booted";
}

/** The memoised boot-failure cause, for diagnostics and tests. */
export function lastWriteEngineFailure(): string | null {
  return engineFailure?.reason ?? cachedBootFailure;
}

/** The `/api/health` view of the write surface. */
export interface WriteProbe {
  available: boolean;
  reason: string | null;
  /** `writeEngineState()` at probe time. */
  state: string;
  /** The complete action vocabulary — the frozen map's keys, never a hand-list. */
  actions: string[];
}

/**
 * Non-throwing availability probe for `/api/health`.
 *
 * DELIBERATELY DOES NOT BOOT, AND DELIBERATELY DOES NOT IMPORT.
 *
 * What it checks: that the `engine/index.js` ARTIFACT resolves on disk, that a
 * brain file exists, and whether a previous boot already failed.
 *
 * WHAT IT PROVES: that the two path-literal preconditions for a write hold, so
 * an operator whose bundle moved or whose brain is unmounted gets a stated
 * reason instead of a button that throws.
 * WHAT IT DOES NOT PROVE: that the module would IMPORT (a vendored
 * `node_modules` absent before `postinstall` fails at import, not at
 * `existsSync`) or that `bootEngine` would succeed. Those become visible on
 * the first `POST /api/triage`, which returns a `degraded` block carrying the
 * discriminated kind — and from then on this probe reports it too, because
 * `engineFailure` is sticky.
 *
 * WHY NOT IMPORT: `/api/health` is the shell's 5-second liveness beat.
 * Importing `engine/index.js` pulls in all sixteen components on every beat's
 * first call, and — more to the point — a health probe that touched the write
 * door would make FR-241's G-RO-6 ("a read-only session never opens it")
 * unassertable, since `/api/health` is in the read sequence.
 */
export function writeProbe(): WriteProbe {
  const actions = [...TRIAGE_ACTION_NAMES];
  const state = writeEngineState();

  if (engineFailure !== null) {
    return { available: false, reason: engineFailure.reason, state, actions };
  }
  const modulePath = resolveBundleModule(ENGINE_MODULE_REL);
  if (modulePath === null) {
    return {
      available: false,
      reason: `brain engine module not found: ${ENGINE_MODULE_REL} (looked in: ${brainBundleCandidates().join(", ")})`,
      state,
      actions,
    };
  }
  const dbPath = brainDbPath();
  if (!existsSync(dbPath)) {
    return {
      available: false,
      reason: `brain database not found at ${dbPath}`,
      state,
      actions,
    };
  }
  return { available: true, reason: null, state, actions };
}

/**
 * Shut the engine down and drop the memo.
 *
 * Wired into the verb's SIGINT/SIGTERM teardown. Phase-0 step 8b established
 * that this is HYGIENE rather than a hang-fix — the only timer a
 * minus-schedules boot can arm is `sync`'s batch flush, which is `unref()`'d
 * (`sync/index.ts:410-411`) — but it closes the read-write connection, which on
 * a WAL brain is what lets the `-wal` checkpoint out.
 */
export function shutdownWriteEngine(): void {
  const current = engine;
  engine = null;
  if (current === null) return;
  try {
    current.shutdown();
  } catch {
    /* already down / never fully up — a teardown must not throw */
  }
}

/**
 * Drop every memo, INCLUDING the module handle. Tests use this between
 * sandboxes; nothing in the shipped path calls it.
 */
export function resetWriteEngine(): void {
  shutdownWriteEngine();
  engineFailure = null;
  bootInFlight = null;
  cachedBoot = null;
  cachedBootFailure = null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** One id's outcome. `ok:false` carries the HANDLER's or GATEWAY's own message. */
export interface TriageItemResult {
  id: number;
  ok: boolean;
  /** The brain's verbatim message when `ok` is false; null otherwise. */
  error: string | null;
}

export type DispatchTriageResult =
  | { ok: true; results: TriageItemResult[] }
  | { ok: false; kind: WriteEngineFailureKind; reason: string };

/**
 * Build one dispatch's args from the map row.
 *
 * The ONLY place a request body becomes brain-tool arguments. Two properties:
 *  - the id lands under the row's `idKey`, which is the `id`/`learning_id`
 *    asymmetry in one line rather than five;
 *  - `extra` is copied by ALLOW-LIST, so no caller-supplied key reaches the
 *    gateway unless the map named it. This is the `ALLOWED_KEYS_PER_OP` shape
 *    `architecture_map.md` requires of anything forwarding external payloads to
 *    a brain tool ("No `Record<string, unknown>` passthrough from callers").
 */
export function buildTriageArgs(
  spec: TriageActionSpec,
  id: number,
  extra: Record<string, string>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { [spec.idKey]: id };
  for (const key of spec.extra) {
    const value = extra[key];
    // Absent-vs-empty matters: `reason: ""` is a legitimate value under BR-080's
    // presence-not-truthiness rule, but a caller that simply did not send the
    // key must not have one invented for it.
    if (value !== undefined) args[key] = value;
  }
  return args;
}

/**
 * Dispatch one action across ids, SEQUENTIALLY, one transaction per id (D6).
 *
 * NO CROSS-ID TRANSACTION. Wrapping N dispatches in a transaction would mean
 * the server layer running `BEGIN` on the brain — the raw-SQL mutation this
 * tier forbids — and it would make a single bad id discard 199 good ones. So a
 * failure is REPORTED PER ID and the batch continues; the caller renders
 * `applied` / `failed`.
 *
 * SEQUENTIAL, not parallel: every dispatch shares ONE better-sqlite3 connection
 * and several handlers open a `db.transaction()`. Interleaving them is how you
 * get a nested-transaction error under load for no gain on a loopback UI.
 *
 * A THROW IS A RESULT, NOT AN OUTCOME FOR THE BATCH. The gateway throws on
 * BR-080/TD-128 violations and handlers return `{isError:true}` envelopes; both
 * become one `ok:false` row carrying the brain's own message, so the dashboard
 * never invents its own vocabulary for a brain failure.
 */
export async function dispatchTriage(
  action: string,
  ids: readonly number[],
  extra: Record<string, string> = {},
): Promise<DispatchTriageResult> {
  const spec = triageAction(action);
  if (spec === null) {
    // Unreachable through the HTTP route (the parser rejects first), but this
    // function is exported and must not become a hole in the delegation rule.
    return {
      ok: false,
      kind: "engine_unavailable",
      reason: `unknown triage action: ${action}`,
    };
  }

  const booted = await bootWriteEngine();
  if (!booted.ok) return booted;

  const results: TriageItemResult[] = [];
  for (const id of ids) {
    try {
      const res = await booted.engine.gateway.dispatch(
        spec.tool,
        buildTriageArgs(spec, id, extra),
      );
      if (res.isError === true) {
        results.push({
          id,
          ok: false,
          // The handler's verbatim text (`Suggestion 12 already acted; cannot
          // dismiss`). Re-wording it here would hide the one fact the operator
          // needs.
          error: res.content?.[0]?.text ?? "brain reported an error",
        });
      } else {
        results.push({ id, ok: true, error: null });
      }
    } catch (err) {
      results.push({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: true, results };
}
