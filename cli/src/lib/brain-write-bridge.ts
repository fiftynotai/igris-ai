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
 * FR-247 PHASE-0 PROBE RESULTS — RECORDED VERBATIM (2026-08-03)
 * ===========================================================================
 * Read READ-ONLY off the operator brain with
 * `sqlite3 "file:$HOME/.igris/memory/knowledge.db?mode=ro"`. The live brain was
 * never opened read-write, and `schema_version` is v23 throughout.
 *
 * P0.2 — `brief_status.priority` histogram, ALL projects:
 *     P2-Medium 726 · P1-High 606 · P3-Low 332 · P0-Critical 87 · NULL 59
 *     · bare `P2` 5 · bare `P1` 2 · `P4-Trivial` 1
 *   (The plan predicted `P2-Medium` 724; the drift is +2 and changes nothing.)
 *   So the NON-canonical population is 8 rows and it is REAL. D2: the picker
 *   offers the canonical four plus CLEAR; the 8 stay VISIBLE (the list badge
 *   renders `row.priority` verbatim, the FILTER's options are derived from the
 *   rows, and the picker renders a non-canonical current value as a DISABLED
 *   `not offerable` entry). TD-338 owns folding them — they arrived by SYNC,
 *   which is an LWW column copy with no normaliser, so folding here without
 *   closing that door just re-runs.
 *
 * P0.3 — THE D6 POPULATION, measured rather than assumed:
 *     brief_files rows with NO matching brief_status row = **1**
 *   Non-zero, so the guard below has a real subject; small, so an operator is
 *   unlikely to meet it by accident. The red-first proof therefore needs a
 *   SEEDED fixture (`TRIAGE_FIXTURE.filesOnlyBrief`), which is what it uses.
 *
 * P0.4 — THE BR-078 GOAL JOIN (D3). `goals/read.ts#getGoal` builds
 *   `serving_briefs` as
 *     FROM entity_edges e JOIN brief_status bs ON bs.brief_id = e.from_id
 *     WHERE e.to_type='goal' AND e.to_id=? AND e.from_type='brief' …
 *   — there is **no project predicate on either side**. Two consequences, both
 *   recorded rather than fixed here (see D3 / R6; a TD is owed):
 *     (a) a `serves_goal` edge is genuinely project-ambiguous, so the dashboard
 *         is MINTING ambiguity when it attaches. `attach_goal`'s row drops the
 *         ref's `project` explicitly, at the point it is minted, so the loss is
 *         visible in the map rather than buried in a builder;
 *     (b) the join is an INNER join on `brief_status`, so an edge whose brief
 *         has no `brief_status` row is INVISIBLE in the goal detail. That is
 *         the second, independent reason the precondition below refuses such a
 *         ref for `attach_goal` too, not only for `set_priority`.
 *
 * P0.5 — THE AUTO-PUSH FENCE (R4). `sync/index.ts:720` wires
 *   `bus.on('brief.synced', onImmediateEvent)` UNCONDITIONALLY, and that
 *   handler fire-and-forgets `pushTables({brief_status, brief_files})` to
 *   `remote_brain.url` whenever `_autoPushConfig` is non-null. `_autoPushConfig`
 *   is `loadAutoPushConfig()`, which reads `join(homedir(), '.igris',
 *   'config.json')` and returns null unless `config.auto_push === true`.
 *   On this machine `auto_push` is ABSENT (top-level keys: cli_targets,
 *   cognition, database, features, installed_at, onboarding, paths,
 *   remote_brain, source_repo, version, vps), so the path is inert — but
 *   `remote_brain.url` IS configured (`https://brain.fifty.dev`), so the only
 *   thing between a fixture write and a real egress is one boolean in a file
 *   the tests do not own. Every mutating suite therefore arms
 *   `armAutoPushFence()` (`__tests__/auto-push-fence.ts`), which points `HOME`
 *   at the sandbox AND replaces `globalThis.fetch` with a recording thrower,
 *   and ASSERTS both are armed before a single write. A priority write is the
 *   first dashboard mutation that can reach that listener at all: none of
 *   FR-241's five actions emits `brief.synced`.
 *
 * P0.6 — `edge.created` / `goal.created` are in NEITHER
 *   `monitoring/index.ts#EVENT_COMPONENT_MAP` (:46-100) NOR monitoring's
 *   `bus.on` list (:263-292) — re-grepped, whole component, zero hits for
 *   /edge|goal/. `'brief.synced': 'briefs'` IS in both (:56, :272). So:
 *   `set_priority` writes a REAL `event_log` row and is AC-5's positive
 *   control; `attach_goal` is DECLARED-EMPTY and its "something happened" half
 *   is carried by `entity_edges`, which the parity differ already selects.
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
  lastLayerReadersFailure,
  loadLayerReaders,
  openBrainReadonly,
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
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE TD-311 BOUNDARY — READ THIS BEFORE ADDING A ROW
 * ───────────────────────────────────────────────────────────────────────────
 * `brief_status.status`, `.phase` and a brief's `content`/`title`/`filename`
 * are the BUILD-STATE INVARIANT. `docs/architecture/brief-state-source-of-truth.md`
 * (TD-311/TD-257) makes the brain the single source of truth for them, and the
 * `/hunt` state machine plus the pre-commit phase guard are their only sanctioned
 * writers. A dashboard that could set `status` would be a second writer for the
 * one column whose whole value is having exactly one.
 *
 * So, as a RULE OVER THIS MAP and not as a convention:
 *
 *   1. **No row may name `status`, `phase`, `content`, `title` or `filename`
 *      in `extra`, in `fixed`, in `refKeys`, or as the TARGET of a `rename`.**
 *      All four, not just the first two — the runtime predicate covers every
 *      one, and `rename` is the route a row-adder is most likely to think is
 *      permitted, because it names the forbidden field on the RIGHT-hand side
 *      where a reader's eye does not look for it (`rename: {reason: "status"}`
 *      would smuggle a status write past a rule that only read `extra`).
 *      Asserted at runtime over the frozen object
 *      by `dashboard-server.test.ts` (AC-3(a)), with a self-negative-control
 *      that runs the same predicate over a deliberately dirty map and requires
 *      it to fire — a comment cannot fool a runtime set intersection, and a
 *      predicate that only ever reports "clean" is indistinguishable from a
 *      broken one (learning 1094).
 *   2. **`igris_brief_sync` is FORBIDDEN BY NAME** — for a reason that is NOT
 *      the one BR-080/TD-323 give, and the difference was measured rather than
 *      read. Those record it as an upsert whose `ON CONFLICT DO UPDATE SET
 *      title = excluded.title, status = excluded.status, …` binds an OMITTED
 *      `title` as NULL (`briefs.ts:139-161`). True of the SQL, and UNREACHABLE
 *      through this door: the tool declares
 *      `required: ['project','brief_id','title','status']`, so the gateway's
 *      BR-080 walk refuses a title-less call before the handler runs
 *      (`dashboard-triage-endpoint.test.ts` G-TR-11 drives it and quotes the
 *      verbatim rejection).
 *      The reason that survives is weaker and sufficient: because it REQUIRES
 *      `title` and `status`, every call OVERWRITES them. A row using this tool
 *      could not express a priority-only write at all — it would be a full-row
 *      write into the invariant above by construction, whatever the caller
 *      intended. `igris_brief_update` is the correct tool precisely because its
 *      SET list is built from the fields actually supplied.
 *   3. **One row = one `gateway.dispatch`.** No row may fire two tools or thread
 *      one tool's output into another's input. This is why goal CREATION is
 *      deferred to FR-249 rather than shipped here: `dispatchTriage` discards the
 *      tool payload (`results.push({id, ok:true, error:null})`), so
 *      create-then-attach would need one row to orchestrate — and the property
 *      that makes this map a review artifact is that it cannot.
 *
 * If a future brief needs to move `status` from the dashboard, that is a
 * decision about TD-311's boundary and it belongs in a brief that argues the
 * boundary, not in a diff that adds a row here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TWO TARGET KINDS (FR-247) — AND WHY THAT IS NOT A NEW ENDPOINT
 * ───────────────────────────────────────────────────────────────────────────
 * The five FR-241 rows address a row by INTEGER id. A brief is not addressable
 * that way: `igris_brief_update` declares `required: ['project','brief_id']`
 * (`briefs/index.ts:377`), and although `brief_status.id` exists and is even on
 * the wire, NO brain tool accepts it — translating id -> (project, brief_id) in
 * this tier would mean a SQL lookup, which the zero-SQL scan forbids by
 * construction.
 *
 * So the ROW SHAPE widens once, additively: `target` says whether the caller
 * supplies `ids: number[]` or `refs: {project, brief_id}[]`. `POST /api/triage`
 * is unchanged as a PATH — the surface stays sixteen GET + one POST, which
 * `dashboard.bats`'s exact-set string asserts byte-identically. That is the
 * payoff of refusing a new endpoint, and it is a measurement rather than a
 * claim.
 *
 * `refKeys` and `fixed` are what keep a `brief-ref` row honest:
 *   - `fixed` values come from the MAP, never from the caller. If
 *     `attach_goal`'s `edge_type` were caller-supplied, that ONE row would
 *     silently become ~20 mutations (`VALID_EDGE_TYPES`). Only `goal_id` is
 *     caller-supplied, and `rename` maps it to `to_id`.
 *   - `refKeys` states, per row, WHICH parts of the ref reach the tool.
 *     `set_priority` forwards both; `attach_goal` forwards `brief_id` alone,
 *     and the ABSENCE of `project` is the BR-078 asymmetry written down where
 *     the ambiguity is minted (Phase-0 P0.4).
 *
 * `idKey` and `refKeys` are mutually exclusive and each is optional here rather
 * than modelled as a discriminated union, deliberately: a union would make
 * `TRIAGE_ACTIONS.dismiss?.idKey` a type error across four shipped suites for
 * no behavioural gain, and the invariant ("exactly one of the two, matching
 * `target`") is asserted at RUNTIME over the frozen object instead — which is
 * the stronger instrument here anyway, since it also covers a row added by a
 * cast.
 */

/** Every body field any row may name. The union IS the allow-list. */
export type TriageExtraKey = "reason" | "brief_id" | "priority" | "goal_id";

/** FR-247 — how a `brief-ref` row addresses its subject. */
export interface BriefRef {
  project: string;
  brief_id: string;
}

export interface TriageActionSpec {
  readonly tool: string;
  readonly bulk: boolean;
  /** FR-247. `"id"` = `ids: number[]`; `"brief-ref"` = `refs: BriefRef[]`. */
  readonly target: "id" | "brief-ref";
  /** `target: "id"` only. The tool's own required id argument name. */
  readonly idKey?: "id" | "learning_id";
  /**
   * `target: "brief-ref"` only. `<tool argument> -> <which half of the ref>`.
   * A ref field that is not named here NEVER reaches the tool.
   */
  readonly refKeys?: Readonly<Record<string, keyof BriefRef>>;
  readonly extra: readonly TriageExtraKey[];
  /** Constants the MAP pins. Never caller-supplied. See the header. */
  readonly fixed?: Readonly<Record<string, string>>;
  /** `<body field> -> <tool argument>`, when they differ. */
  readonly rename?: Readonly<Record<string, string>>;
}

export const TRIAGE_ACTIONS: Readonly<Record<string, TriageActionSpec>> =
  Object.freeze({
    // --- FR-241: the five id-addressed triage rows. `target` is the ONLY
    //     field FR-247 added to them, and `dashboard-server.test.ts` asserts
    //     the other fields are byte-identical to their FR-241 values, so the
    //     widening is provably additive rather than argued to be.
    dismiss: Object.freeze({
      tool: "igris_suggestion_dismiss",
      bulk: true,
      target: "id",
      idKey: "id",
      extra: Object.freeze(["reason"]),
    }),
    acted: Object.freeze({
      tool: "igris_suggestion_acted",
      bulk: true,
      target: "id",
      idKey: "id",
      extra: Object.freeze(["brief_id"]),
    }),
    apply: Object.freeze({
      tool: "igris_suggestion_apply_action",
      bulk: false,
      target: "id",
      idKey: "id",
      extra: Object.freeze([]),
    }),
    approve: Object.freeze({
      tool: "igris_perception_approve",
      bulk: true,
      target: "id",
      idKey: "learning_id",
      extra: Object.freeze([]),
    }),
    reject: Object.freeze({
      tool: "igris_perception_reject",
      bulk: true,
      target: "id",
      idKey: "learning_id",
      extra: Object.freeze(["reason"]),
    }),

    // --- FR-247: the two brief-addressed rows.
    /**
     * Set a brief's priority. `igris_brief_update` is a GENUINE partial update
     * — read, not assumed: `allowedColumns` maps each field and the SET list is
     * built by `if (val !== undefined)`, so a priority-only call emits
     * `priority = ?, updated_at = ?` and leaves `title` alone
     * (`briefs.ts:629-647`).
     *
     * IT HAS A FORK, AND THE FORK IS WHY `dispatchBriefWrite` READS FIRST. When
     * the brief exists in `brief_files` with NO `brief_status` row, the same
     * call takes the ELSE branch (`briefs.ts:653-676`) and creates a row with
     * `args.title ?? ''` and `args.status ?? 'Ready'` — so a priority-only
     * write would blank the title AND invent a status, violating the TD-311
     * boundary above through the very handler that is otherwise correct. The
     * precondition read refuses such a ref; see `dispatchBriefWrite`.
     *
     * The VALUE is not validated here. Three layers, three jobs: the parser
     * allow-lists the KEY, the brain's `normalizePriority` folds the VALUE
     * (`briefs.ts:632`), and the picker prescribes the CHOICES
     * (`triage/model.ts#CANONICAL_PRIORITIES`). A fourth copy of the vocabulary
     * in this tier would be a fourth thing to drift.
     */
    set_priority: Object.freeze({
      tool: "igris_brief_update",
      bulk: true,
      target: "brief-ref",
      refKeys: Object.freeze({ project: "project", brief_id: "brief_id" }),
      extra: Object.freeze(["priority"]),
    }),
    /**
     * Attach a brief to an EXISTING goal. An EDGE write, not a brief-column
     * write — which is why it belongs in this map (a second map would be a
     * second place a mutation can be added, which the change procedure forbids)
     * and why `fixed` exists.
     *
     * `from_type`/`to_type`/`edge_type` are pinned HERE. The tool's `edge_type`
     * is an enum over `VALID_EDGE_TYPES`; a caller-supplied one would make this
     * single row ~20 different mutations behind one confirm.
     *
     * `refKeys` FORWARDS ONLY `brief_id`. `entity_edges.from_id` is the BARE
     * brief id with no project column, and `BR-001` names a different brief in
     * 25 projects — so a `serves_goal` edge is project-ambiguous and
     * `getGoal`'s `serving_briefs` join has no project predicate (Phase-0
     * P0.4). That is PRE-EXISTING (BR-078) and not this brief's to fix, but the
     * dashboard is minting new instances of it, so the drop is written down at
     * the point it happens rather than hidden in a builder.
     *
     * GOAL CREATION IS NOT HERE. Deferred to FR-249 by operator decision, on
     * rule 3 above — see the TD-311 boundary block. `docs/dashboard.md` states
     * the deferral and its reasoning so this reads as a decision, not a gap.
     */
    attach_goal: Object.freeze({
      tool: "igris_edge_create",
      bulk: true,
      target: "brief-ref",
      refKeys: Object.freeze({ from_id: "brief_id" }),
      extra: Object.freeze(["goal_id"]),
      fixed: Object.freeze({
        from_type: "brief",
        to_type: "goal",
        edge_type: "serves_goal",
      }),
      rename: Object.freeze({ goal_id: "to_id" }),
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

/**
 * One item's outcome. `ok:false` carries the HANDLER's or GATEWAY's own message.
 *
 * FR-247: exactly one of `id` / `ref` is populated, matching the row's
 * `target`. `id` became nullable rather than gaining a sentinel because `0` and
 * `-1` are both things an operator could read as an id, and a result the client
 * cannot attribute to a row is a result it cannot render.
 */
export interface TriageItemResult {
  id: number | null;
  /** FR-247 — the `(project, brief_id)` this result belongs to, or `null`. */
  ref: BriefRef | null;
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
  if (spec.target !== "id" || spec.idKey === undefined) {
    // Not reachable through the route (`triage()` branches on `target` first),
    // but this function is exported and a silent `{undefined: 3}` argument
    // object would reach the gateway as a TD-128 rejection whose message named
    // the wrong problem.
    throw new TypeError(
      `buildTriageArgs called for a non-id action (${spec.tool}, target=${spec.target})`,
    );
  }
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
 * FR-247 — build one BRIEF-addressed dispatch's args from the map row.
 *
 * Fully declarative: every argument that reaches the tool comes from `fixed`,
 * from `refKeys` or from the `extra` allow-list, all three of which are on the
 * row a reviewer is already reading. There is no branch on the tool NAME here,
 * because a builder that special-cased `igris_edge_create` would be a second
 * copy of the map, in code, out of the reviewer's line of sight.
 *
 * Consequences that matter and are asserted (`G-TR-9`):
 *  - a caller-supplied `status`/`content`/`title` cannot reach the tool, even
 *    if the parser were to let it past — the built object's key set is exactly
 *    `fixed ∪ refKeys ∪ (extra ∩ supplied)`;
 *  - `attach_goal` really does drop the ref's `project`, because `refKeys` does
 *    not name it (P0.4 / BR-078).
 */
export function buildBriefArgs(
  spec: TriageActionSpec,
  ref: BriefRef,
  extra: Record<string, string>,
): Record<string, unknown> {
  if (spec.target !== "brief-ref" || spec.refKeys === undefined) {
    throw new TypeError(
      `buildBriefArgs called for a non-brief-ref action (${spec.tool}, target=${spec.target})`,
    );
  }
  const args: Record<string, unknown> = { ...(spec.fixed ?? {}) };
  for (const [argKey, refField] of Object.entries(spec.refKeys)) {
    args[argKey] = ref[refField];
  }
  for (const key of spec.extra) {
    const value = extra[key];
    if (value !== undefined) args[spec.rename?.[key] ?? key] = value;
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
          ref: null,
          ok: false,
          // The handler's verbatim text (`Suggestion 12 already acted; cannot
          // dismiss`). Re-wording it here would hide the one fact the operator
          // needs.
          error: res.content?.[0]?.text ?? "brain reported an error",
        });
      } else {
        results.push({ id, ref: null, ok: true, error: null });
      }
    } catch (err) {
      results.push({
        id,
        ref: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// FR-247 — the BRIEF-addressed dispatch, and its precondition read
// ---------------------------------------------------------------------------

/**
 * The refusal message for a ref whose brief has no `brief_status` row.
 *
 * Exported so the test asserts the SHIPPED string rather than a copy of it, and
 * written as a function so the two facts it states stay attached to the ref
 * they are about.
 *
 * Both halves are real and were measured (Phase-0 P0.3/P0.4):
 *  - `igris_brief_update` would CREATE the row, with an empty title and an
 *    invented `status`, which is a write into TD-311's invariant;
 *  - `igris_edge_create` would succeed and the edge would be INVISIBLE, because
 *    `getGoal`'s `serving_briefs` inner-joins `brief_status`.
 * So the refusal is uniform across both brief-ref rows, for two different
 * reasons, and neither reason is speculative.
 */
export function briefStatusRequiredReason(ref: BriefRef): string {
  return (
    `FR-247 ${ref.project}/${ref.brief_id}: no brief_status row — refusing. ` +
    `A priority write would CREATE one with status='Ready' and title='' ` +
    `(briefs.ts:653-676), and a serves_goal edge to it would be invisible to ` +
    `getGoal's brief_status join (BR-078).`
  );
}

/** The other refusal: the ref names a brief that is in NEITHER table. */
export function unknownBriefReason(ref: BriefRef): string {
  return `FR-247 ${ref.project}/${ref.brief_id}: no such brief in this project — refusing.`;
}

/**
 * Does this ref have a `brief_status` row? THE PREDICATE IS `status !== null`,
 * NOT `record !== null`, AND THE DIFFERENCE IS THE WHOLE GUARD.
 *
 * `getBrief` (`briefs-read.ts:218-277`) tries `brief_files LEFT JOIN
 * brief_status` FIRST, and only falls back to a `brief_status`-only lookup if
 * that misses. So for exactly the population this guard exists to catch — a
 * brief in `brief_files` with no `brief_status` row — it returns a NON-NULL
 * record whose six status-side fields are all `null`. A `record !== null` test
 * would therefore have passed every ref it was written to refuse: the guard
 * would have been present, readable, commented, and vacuous.
 *
 * `status` is the right field of the six to key on because it is the only one
 * the schema makes `NOT NULL` (`db.ts:299`, `status TEXT NOT NULL`) — `title`
 * is also NOT NULL but the fork writes `''` into it, and `priority`, `effort`,
 * `phase` and `brief_type` are all legitimately nullable, so a guard on any of
 * those would refuse real briefs. This function therefore DEPENDS on that
 * `NOT NULL`, and `dashboard-triage-endpoint.test.ts` pins it: it reads the
 * live DDL out of the sandbox schema and asserts the constraint is there, so a
 * migration relaxing it fails loudly here instead of silently un-arming this.
 */
function hasBriefStatusRow(record: { status: unknown } | null): boolean {
  return record !== null && record.status !== null && record.status !== undefined;
}

/** Why the precondition read itself could not run. Degrades the whole call. */
function preconditionUnavailable(cause: string): string {
  return (
    `FR-247 precondition read unavailable: ${cause}. ` +
    `Refusing every ref rather than writing unguarded.`
  );
}

/**
 * Dispatch a BRIEF-addressed action across refs, SEQUENTIALLY (FR-247).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRECONDITION READ, AND WHY IT USES THE **READ** DOOR
 * ───────────────────────────────────────────────────────────────────────────
 * Every ref is checked through `loadLayerReaders().getBrief` on an
 * `openBrainReadonly()` handle before ANY dispatch. Three properties come out
 * of using FR-240's read door rather than a query here:
 *
 *   - no SQL enters this tier (the zero-SQL scan stays true by construction);
 *   - the handle is opened with `query_only = ON`, so an accidental write on it
 *     throws `SQLITE_READONLY` rather than succeeding quietly;
 *   - ONE read-only connection per POST, not per ref. A read-only connection is
 *     safe alongside the live write engine; a read-WRITE one is not — opening
 *     and closing a second read-write connection while the engine holds the
 *     file leaves the engine writing into an unlinked `-wal`, and every later
 *     reader then reports the PRE-dispatch state (measured; see
 *     `dashboard-triage-fixture.ts`'s header).
 *
 * THE THREE ALTERNATIVES, REJECTED:
 *   - *trust the handler* — it invents `status`; AC-3 asks for a mechanical
 *     guarantee, not a reviewed one;
 *   - *guard client-side* — a client guard is not a guard;
 *   - *fix `handleBriefUpdate`* — a behaviour change to a brain tool with many
 *     callers, plus packed bytes, for a defect nobody asked this brief to fix.
 *     A TD is owed instead.
 *
 * A DEGRADED READ LAYER DEGRADES THE WHOLE CALL. It never silently skips the
 * guard: the failure returns `ok:false` and the route renders it as
 * `200 + degraded, applied: 0`, which is the same shape a down write surface
 * produces and the same shape the UI already knows how to say.
 */
export async function dispatchBriefWrite(
  action: string,
  refs: readonly BriefRef[],
  extra: Record<string, string> = {},
): Promise<DispatchTriageResult> {
  const spec = triageAction(action);
  if (spec === null || spec.target !== "brief-ref") {
    return {
      ok: false,
      kind: "engine_unavailable",
      reason: `unknown brief-write action: ${action}`,
    };
  }

  // The read door is loaded lazily and separately from the write engine, so a
  // bundle that can read but not boot still reports the RIGHT cause.
  const readers = await loadLayerReaders();
  if (readers === null) {
    return {
      ok: false,
      kind: "brain_unavailable",
      reason: preconditionUnavailable(
        lastLayerReadersFailure() ?? "the brain read layer could not be loaded",
      ),
    };
  }

  const booted = await bootWriteEngine();
  if (!booted.ok) return booted;

  // ONE handle for the whole POST. Opened AFTER the engine so the two orders
  // cannot differ between a first and a subsequent request.
  const db = openBrainReadonly();
  if (db === null) {
    return {
      ok: false,
      kind: "brain_unavailable",
      reason: preconditionUnavailable("no read-only brain handle"),
    };
  }

  const results: TriageItemResult[] = [];
  try {
    for (const ref of refs) {
      let record: { status: unknown } | null;
      try {
        record = readers.getBrief(db, ref.project, ref.brief_id);
      } catch (err) {
        // A THROWN precondition is a per-ref refusal, never an assumed pass.
        results.push({
          id: null,
          ref,
          ok: false,
          error: preconditionUnavailable(
            err instanceof Error ? err.message : String(err),
          ),
        });
        continue;
      }
      if (!hasBriefStatusRow(record)) {
        results.push({
          id: null,
          ref,
          ok: false,
          // The two refusals are DISTINGUISHED: "this brief does not exist" and
          // "this brief exists but has no status row" send an operator to
          // completely different places, and collapsing them would hide the
          // second — which is the interesting one.
          error:
            record === null
              ? unknownBriefReason(ref)
              : briefStatusRequiredReason(ref),
        });
        continue;
      }

      try {
        const res = await booted.engine.gateway.dispatch(
          spec.tool,
          buildBriefArgs(spec, ref, extra),
        );
        results.push(
          res.isError === true
            ? {
                id: null,
                ref,
                ok: false,
                error: res.content?.[0]?.text ?? "brain reported an error",
              }
            : { id: null, ref, ok: true, error: null },
        );
      } catch (err) {
        results.push({
          id: null,
          ref,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      /* a teardown must not throw */
    }
  }

  return { ok: true, results };
}
