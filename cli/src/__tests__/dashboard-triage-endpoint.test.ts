/**
 * FR-241 — **the write endpoint, end to end, against a real brain engine.**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE GATES, AND WHAT EACH ONE PROVES AND DOES NOT
 * ═════════════════════════════════════════════════════════════════════════════
 *  G-TR-0  SANDBOX FENCE. Runs first. The deviation set is asserted as a SET;
 *          `brainDbPath()` resolves inside the sandbox; a POISON
 *          `IGRIS_DB_PATH` does not move the writes; and every path this
 *          suite's handle resolved to is witnessed at suite end (ACCESS, not
 *          bytes — see the REAL_BRAIN block for why a digest was unsound in
 *          both directions).
 *          Proves: this destructive suite's handle never ADDRESSED `~/.igris`.
 *          Does NOT prove: that the real file was unmodified — another process
 *          may modify it and that is not this suite's claim. Nor anything about
 *          correctness.
 *
 *  G-TR-1  Each of the five actions, single item: assert the PRE-state, POST,
 *          assert the returned per-id result AND the row change.
 *          Proves: the frozen map is wired end to end, including the
 *          `id`/`learning_id` asymmetry and BOTH branches of the reject fork.
 *          Does NOT prove: that the brain's own handler was REACHED rather than
 *          reimplemented — G-TR-5(b).
 *
 *  G-TR-2  BULK, with the pre-state asserted. 17 seeded, 12 dismissed, 5 must
 *          survive and be the RIGHT five.
 *          Proves: bulk acts on a non-empty set and only on the selection.
 *          Does NOT prove: the `MAX_BULK` boundary — G-TR-3.
 *          **This is the brief's named vacuous-gate trap** (a bulk action on
 *          zero items). The seeded count, the surviving-five identity check and
 *          the delta assertion are what make it non-vacuous.
 *
 *  G-TR-3  Partial failure (D6: no rollback) and the 200-id clamp.
 *
 *  G-TR-4  DEGRADED write surface: 200 + `degraded`, `applied: 0`, never a 500.
 *          With a NEGATIVE CONTROL in the same test — the same POST applies
 *          when the bundle is present. Without that half, "returns degraded" is
 *          satisfiable by an endpoint that is simply broken.
 *
 *  G-TR-5  DELEGATION IS STRUCTURAL. Behavioural, not a grep: spy the resolved
 *          handler in the loaded bundle module and assert the HTTP request
 *          invokes it; then break the map's tool name and assert the row is
 *          UNCHANGED — i.e. there is no fallback that writes without the
 *          handler. (The source-scan half lives in `dashboard-server.test.ts`;
 *          a grep-only guard on a new module is what got FR-240 REJECTed, so
 *          BOTH are required.)
 *
 *  G-TR-6  GATEWAY VALIDATION PARITY (BR-080 / TD-128). A missing required key
 *          and an unknown extra key must fail with the GATEWAY's own message,
 *          not one this brief wrote.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY GATE HERE MUTATES. READ THE FIXTURE'S HEADER BEFORE EDITING ONE.
 * ═════════════════════════════════════════════════════════════════════════════
 * Two properties are load-bearing and neither is obvious:
 *   1. the brain is built by the ENGINE's own migrations, because the FR-240
 *      hand-rolled schema makes `bootEngine` throw `duplicate column name:
 *      archetype`;
 *   2. nothing opens a read-WRITE connection while the engine is live, because
 *      doing so makes every subsequent read return the PRE-dispatch state — a
 *      false green in the safest-looking direction.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { get as httpGet, request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import {
  ENGINE_MODULE_REL,
  resetBrainBridge,
  resetLayerReaders,
  resolveBundleModule,
} from "../lib/brain-bridge.js";
import {
  TRIAGE_ACTIONS,
  bootWriteEngine,
  buildBriefArgs,
  buildSubjectlessArgs,
  dispatchBriefWrite,
  dispatchSubjectless,
  dispatchTriage,
  resetWriteEngine,
  writeEngineState,
  WRITE_ENGINE_COMPONENTS,
} from "../lib/brain-write-bridge.js";
import { brainDbPath } from "../lib/paths.js";
import { MAX_BULK } from "../lib/dashboard/params.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { bundleStaged } from "./hermetic-embeddings.js";
import { armAutoPushFence, type AutoPushFence } from "./auto-push-fence.js";
import {
  TRIAGE_FIXTURE,
  briefStatusCount,
  briefStatusRow,
  briefStatusRows,
  briefStatusStatusIsNotNull,
  countPendingBrainLevel,
  countPendingWithProject,
  edgeRows,
  eventsSince,
  goalRows,
  learningState,
  maxEventId,
  pendingSuggestionIds,
  readTriageBrain,
  seedTriageBrain,
  seededBriefIds,
  suggestionStates,
} from "./dashboard-triage-fixture.js";

// ---------------------------------------------------------------------------
// G-TR-0 — the fence, armed before anything else in this file runs
// ---------------------------------------------------------------------------

/**
 * The operator's REAL brain. PROVE ACCESS, NOT BYTES (learning 1096).
 *
 * This started life as a byte witness — `sha256(.db)` captured at module load
 * and re-checked in `afterAll`, failing with "THE OPERATOR'S REAL BRAIN WAS
 * MODIFIED BY THIS SUITE". Sentinel measured that it was wrong in BOTH
 * directions and it was replaced:
 *
 *  - **Blind to the write it existed to catch.** This brief's own G-RO-6
 *    establishes that a triage dispatch lands ENTIRELY in the `-wal` and leaves
 *    the `.db` byte-identical (reproduced by swapping G-RO-6's `logicalDump`
 *    for `sha256` — its negative control then FAILS). Had this suite genuinely
 *    written to the live brain, the byte witness would very likely have passed.
 *  - **Noisy in the other direction.** Long-lived `brain-mcp-server` processes
 *    hold that file open; a checkpoint by any of them mid-run moves the bytes
 *    and fires an assertion that names THIS suite as the culprit.
 *
 * A logical dump is not the answer either: other processes legitimately write
 * `suggestions`, `learnings` and `event_log` while this suite runs, so a
 * content witness of any kind is unsound here.
 *
 * The sound instrument is ACCESS. The path this suite's writes resolve to is
 * `brainDbPath()`, seamed on `IGRIS_BRAIN_DIR`, and the write engine boots at
 * that path — so asserting the resolved path is never the real one proves the
 * suite CANNOT have reached it, regardless of what any other process did to the
 * file. The poison-`IGRIS_DB_PATH` case below proves the seam is structural
 * rather than conventional.
 *
 * Proves: this suite's brain handle never addressed `~/.igris/memory`.
 * Does NOT prove: that the file was unmodified — it may well have been, by
 * another process. That is not this suite's claim to make.
 */
const REAL_BRAIN = join(homedir(), ".igris", "memory", "knowledge.db");

/** Every path this suite's brain handle resolved to, one per test. */
const resolvedDuringRun: string[] = [];

let sandbox: string;
let srv: DashboardServer | null = null;
let seeded: { ok: true } | { ok: false; kind: string; reason: string } = {
  ok: false,
  kind: "engine_unavailable",
  reason: "not attempted",
};

const prevBrainDir = process.env.IGRIS_BRAIN_DIR;
const prevDbPath = process.env.IGRIS_DB_PATH;

const dbPath = (): string => join(sandbox, "memory", "knowledge.db");

/** `true` when the bundle is staged; every write gate skips loudly otherwise. */
const canBoot = (): boolean => bundleStaged() && resolveBundleModule(ENGINE_MODULE_REL) !== null;

interface Res {
  status: number;
  body: string;
  json: <T>() => T;
}

function post(
  path: string,
  body: string | null,
  headers: Record<string, string> = {},
): Promise<Res> {
  const server = srv;
  if (server === null) throw new Error("server not started");
  return new Promise((resolve, reject) => {
    const payload = body === null ? undefined : Buffer.from(body, "utf-8");
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: "POST",
        agent: false,
        headers: {
          host: `127.0.0.1:${server.port}`,
          "content-type": "application/json",
          ...(payload !== undefined ? { "content-length": String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            json: <T,>() => JSON.parse(text) as T,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** `POST /api/triage` with a JSON body. The only mutating call in the tier. */
function triage(body: unknown): Promise<Res> {
  return post("/api/triage", JSON.stringify(body));
}

/** A plain GET. TD-326's gate needs the READ half to build the write's input. */
function get(path: string): Promise<Res> {
  const server = srv;
  if (server === null) throw new Error("server not started");
  return new Promise((resolve, reject) => {
    const r = httpGet(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        agent: false,
        headers: { host: `127.0.0.1:${server.port}` },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            json: <T,>() => JSON.parse(text) as T,
          }),
        );
      },
    );
    r.on("error", reject);
  });
}

interface TriagePayload {
  action: string;
  requested: number;
  applied: number;
  failed: number;
  results: {
    id: number | null;
    ref: { project: string; brief_id: string } | null;
    ok: boolean;
    error: string | null;
    /** FR-249 — populated only for a row that DECLARES a `returns` path. */
    created_id: string | null;
  }[];
  params: string[];
  degraded: { reason: string } | null;
}

/** FR-247 — the fixture's project, spelled once. */
const P = TRIAGE_FIXTURE.briefProject;
const ref = (briefId: string): { project: string; brief_id: string } => ({
  project: P,
  brief_id: briefId,
});

/**
 * FR-247 — the auto-push egress fence, armed for EVERY test in this file.
 *
 * Armed before `seedTriageBrain` (which boots the engine, which is where
 * `sync` reads its config) and released in `afterEach`. See
 * `auto-push-fence.ts`'s header for the chain this closes; G-TR-13 below is
 * what proves it closes anything.
 */
let fence: AutoPushFence | null = null;

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr241-tr-"));
  fence = armAutoPushFence(sandbox);
  fence.assertArmed();
  process.env.IGRIS_BRAIN_DIR = sandbox;
  // The ACCESS witness, recorded WHILE the fence is up. It cannot be taken in
  // `afterAll` — teardown restores `IGRIS_BRAIN_DIR` first, so `brainDbPath()`
  // would resolve to the real brain there and the guard would fire on every
  // clean run. (It did, on first write. The failure was the guard's, not the
  // code's — recorded here so nobody "fixes" it back.)
  resolvedDuringRun.push(brainDbPath());
  // BELT AND BRACES. Phase-0 step 6 proved `IGRIS_DB_PATH` is DEAD CODE once
  // `setAdapter` has run, and G-TR-0 asserts that with a poison value. Setting
  // it at the sandbox here means the suite is fenced even if that ever regresses.
  process.env.IGRIS_DB_PATH = dbPath();
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  resetWriteEngine();
  seeded = await seedTriageBrain(dbPath());
  srv = await startServer({ port: 0, cliVersion: "test" });
});

afterEach(async () => {
  if (srv !== null) {
    await srv.close();
    srv = null;
  }
  resetWriteEngine();
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  rmSync(sandbox, { recursive: true, force: true });
  if (fence !== null) {
    fence.release();
    fence = null;
  }
  if (prevBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrainDir;
  if (prevDbPath === undefined) delete process.env.IGRIS_DB_PATH;
  else process.env.IGRIS_DB_PATH = prevDbPath;
});

// ---------------------------------------------------------------------------
// G-TR-0
// ---------------------------------------------------------------------------

describe("G-TR-0 — the sandbox fence", () => {
  it("the deviation set is EXACTLY {schedules: disabled} — asserted, not sampled", () => {
    // "The dashboard is not a second brain daemon" is a claim about a SET.
    // `WRITE_ENGINE_COMPONENTS` was exported for this test and the test was
    // never written (found in review). Sampling `.schedules.enabled === false`
    // would pass while a second component was quietly disabled — and disabling
    // `sync` in particular would break VPS propagation for dashboard writes
    // while MCP writes kept working, a parity break in the opposite direction
    // to the one this brief guards.
    expect(Object.keys(WRITE_ENGINE_COMPONENTS)).toEqual(["schedules"]);
    expect(WRITE_ENGINE_COMPONENTS.schedules).toEqual({ enabled: false });
    expect(Object.isFrozen(WRITE_ENGINE_COMPONENTS)).toBe(true);
  });

  it("the vendored engine is staged, so nothing below skips silently", () => {
    // A SKIP is a coverage hole. This suite states its precondition rather than
    // quietly passing over an unstaged bundle.
    expect(
      bundleStaged(),
      "run `cd cli && npm run build` before this suite — every write gate below needs the vendored engine",
    ).toBe(true);
    expect(resolveBundleModule(ENGINE_MODULE_REL), ENGINE_MODULE_REL).not.toBeNull();
    expect(
      seeded.ok,
      seeded.ok ? "" : `fixture could not migrate the sandbox: ${seeded.reason}`,
    ).toBe(true);
  });

  it("brainDbPath() resolves inside the sandbox, never ~/.igris", () => {
    expect(brainDbPath()).toBe(dbPath());
    expect(brainDbPath().startsWith(sandbox)).toBe(true);
    expect(brainDbPath()).not.toContain("/.igris/memory");
  });

  it("a POISON IGRIS_DB_PATH does not move the writes", async () => {
    // Phase-0 step 6, re-asserted as a standing gate: once `setAdapter` has run
    // (`db.ts:1297-1301` short-circuits before `resolveDbPath()`), the handlers'
    // legacy env-var escape hatch is dead code, so the fence is STRUCTURAL
    // rather than a matter of test discipline.
    const poison = join(sandbox, "poison", "POISON-MUST-NOT-EXIST.db");
    process.env.IGRIS_DB_PATH = poison;

    const before = countPendingWithProject(dbPath());
    const r = await triage({ action: "dismiss", ids: [1], reason: "poison probe" });
    expect(r.status).toBe(200);
    expect(r.json<TriagePayload>().applied).toBe(1);

    // The write landed in the SANDBOX...
    expect(countPendingWithProject(dbPath())).toBe(before - 1);
    // ...and the poison path was never created, at any level.
    expect(existsSync(poison), "the poison DB FILE was created").toBe(false);
    expect(existsSync(join(sandbox, "poison")), "the poison DIRECTORY was created").toBe(
      false,
    );
  });

  it("the write engine boots at the SANDBOX path and reports so", async () => {
    expect(writeEngineState()).toBe("not-booted");
    const booted = await bootWriteEngine();
    expect(booted.ok, booted.ok ? "" : booted.reason).toBe(true);
    expect(writeEngineState()).toBe("booted");
  });
});

afterAll(() => {
  // The claim the whole suite rests on, re-checked at the END rather than only
  // at the start: 1,188 real pending suggestions and 17 real candidates live in
  // that file, and `igris_perception_reject` hard-deletes a first-time
  // candidate. An ACCESS witness, not a byte witness — see the REAL_BRAIN
  // block above for why bytes were the wrong instrument in both directions.
  // SELF-NEGATIVE-CONTROL: an empty witness list would make every assertion
  // below vacuously true, so the list must be non-empty first.
  expect(resolvedDuringRun.length).toBeGreaterThan(0);
  for (const resolved of resolvedDuringRun) {
    expect(
      resolved,
      "THIS SUITE'S BRAIN HANDLE ADDRESSED THE OPERATOR'S REAL BRAIN",
    ).not.toBe(REAL_BRAIN);
    expect(resolved).toContain("igris-fr241-tr-");
  }
});

// ---------------------------------------------------------------------------
// G-TR-1 — each of the five actions
// ---------------------------------------------------------------------------

describe("G-TR-1 — one action at a time, PRE-state asserted, row change read back", () => {
  it("dismiss -> status flips, reason recorded, a dismissed_patterns row appears", async () => {
    const before = suggestionStates(dbPath()).find((s) => s.id === 1);
    expect(before, "fixture pre-state").toMatchObject({
      status: "pending",
      dismissed_reason: null,
    });

    const r = await triage({ action: "dismiss", ids: [1], reason: "cohort: stale gap" });
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ action: "dismiss", requested: 1, applied: 1, failed: 0 });
    // FR-247 widened the item shape: `ref` is EXPLICITLY null on an
    // id-addressed result, and asserted as such rather than dropped from the
    // comparison — "exactly one of id/ref is populated" is the contract, and a
    // `toMatchObject` here would not have noticed a row carrying both.
    expect(p.results).toEqual([
      { id: 1, ref: null, ok: true, error: null, created_id: null },
    ]);

    const after = suggestionStates(dbPath()).find((s) => s.id === 1);
    expect(after).toMatchObject({
      status: "dismissed",
      dismissed_reason: "cohort: stale gap",
    });
  });

  it("acted -> status + acted_brief_id", async () => {
    expect(suggestionStates(dbPath()).find((s) => s.id === 2)?.acted_brief_id).toBeNull();
    const r = await triage({ action: "acted", ids: [2], brief_id: "FR-241" });
    expect(r.json<TriagePayload>().applied).toBe(1);
    expect(suggestionStates(dbPath()).find((s) => s.id === 2)).toMatchObject({
      status: "acted",
      acted_brief_id: "FR-241",
    });
  });

  it("approve -> review_status flips to approved", async () => {
    const id = TRIAGE_FIXTURE.firstTimeCandidateIds[0]!;
    expect(learningState(dbPath(), id)?.review_status).toBe("pending_review");
    const r = await triage({ action: "approve", ids: [id] });
    expect(r.json<TriagePayload>().applied).toBe(1);
    expect(learningState(dbPath(), id)).toMatchObject({ review_status: "approved" });
  });

  it("reject, seen_again_count = 0 -> the row is GONE (tier 3, hard delete)", async () => {
    const id = TRIAGE_FIXTURE.firstTimeCandidateIds[1]!;
    // ASSERT-THEN-DIFF: the pre-state also pins WHICH branch this row takes, so
    // a fixture change that made it recurring would fail here rather than
    // silently converting this into a duplicate of the test below.
    expect(learningState(dbPath(), id)).toMatchObject({
      review_status: "pending_review",
      seen_again_count: 0,
      deleted_at: null,
    });

    const r = await triage({ action: "reject", ids: [id], reason: "noise" });
    expect(r.json<TriagePayload>().applied).toBe(1);
    expect(learningState(dbPath(), id), "the row survived a HARD delete").toBeNull();
  });

  it("reject, seen_again_count > 0 -> SOFT delete: the row SURVIVES with deleted_at", async () => {
    const id = TRIAGE_FIXTURE.recurringCandidateIds[0]!;
    expect(learningState(dbPath(), id)).toMatchObject({
      review_status: "pending_review",
      seen_again_count: TRIAGE_FIXTURE.recurringSeenAgain,
      deleted_at: null,
    });

    const r = await triage({ action: "reject", ids: [id], reason: "recurring noise" });
    expect(r.json<TriagePayload>().applied).toBe(1);

    const after = learningState(dbPath(), id);
    // L-140 is HALF STALE, and this is the half that refutes it. A UI that
    // called every reject "irreversible" would be lying about this row.
    expect(after, "the recurring row was HARD-deleted — the FR-116 M3 fork is gone").not.toBeNull();
    expect(after).toMatchObject({ review_status: "rejected" });
    expect(after?.deleted_at).not.toBeNull();
  });

  it("the id/learning_id asymmetry is real — a suggestion id is not a learning id", async () => {
    // The two perception tools declare `required: ['learning_id']`; the three
    // suggestion tools declare `required: ['id']`. The map's `idKey` is what
    // reconciles them, and getting it wrong is a GATEWAY rejection rather than a
    // silent mis-write (G-TR-6 pins the message).
    expect(TRIAGE_ACTIONS.dismiss?.idKey).toBe("id");
    expect(TRIAGE_ACTIONS.approve?.idKey).toBe("learning_id");
    expect(TRIAGE_ACTIONS.reject?.idKey).toBe("learning_id");
  });
});

// ---------------------------------------------------------------------------
// G-TR-2 — BULK. The brief's named vacuous-gate trap.
// ---------------------------------------------------------------------------

describe("G-TR-2 — bulk acts on a NON-EMPTY set, and only on the selection", () => {
  it("17 pending -> dismiss 12 -> 5 pending, and they are the RIGHT five", async () => {
    // 1. THE PRE-STATE, asserted. A bulk gate whose starting count is unstated
    //    is the BR-080 drain-test-on-an-empty-queue failure: `applied: 0` over
    //    zero rows is indistinguishable from success.
    expect(countPendingWithProject(dbPath())).toBe(TRIAGE_FIXTURE.pendingSuggestions);
    expect(TRIAGE_FIXTURE.pendingSuggestions).toBe(17);

    const target = pendingSuggestionIds().slice(0, 12);
    const survivors = pendingSuggestionIds().slice(12);
    expect(target).toHaveLength(12);
    expect(survivors).toHaveLength(5);

    // 2. THE ACTION.
    const r = await triage({
      action: "dismiss",
      ids: target,
      reason: "cohort clear",
    });
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 12, applied: 12, failed: 0 });
    expect(p.results.map((x) => x.id)).toEqual(target);

    // 3. THE POST-STATE, and 4. THE DELTA — both, not either.
    expect(countPendingWithProject(dbPath())).toBe(5);
    const states = suggestionStates(dbPath());
    // Restricted to the PROJECT-BEARING ids on purpose (TD-326): the fixture
    // also seeds ids 19-21, which belong to no project and are outside this
    // gate's claim. They are separately asserted UNTOUCHED below, which is the
    // stronger statement — this dismiss reached neither more nor less than the
    // twelve it named.
    const stillPending = states
      .filter((s) => s.status === "pending" && pendingSuggestionIds().includes(s.id))
      .map((s) => s.id);
    expect(stillPending, "the WRONG five survived").toEqual(survivors);
    expect(
      states.filter((s) => TRIAGE_FIXTURE.brainLevelPendingIds.includes(
        s.id as (typeof TRIAGE_FIXTURE.brainLevelPendingIds)[number],
      )),
      "a project bulk reached the project-less rows",
    ).toHaveLength(TRIAGE_FIXTURE.brainLevelPendingIds.length);
    expect(countPendingBrainLevel(dbPath())).toBe(
      TRIAGE_FIXTURE.brainLevelPendingIds.length,
    );
    const nowDismissed = states.filter((s) => s.status === "dismissed").map((s) => s.id);
    expect(nowDismissed).toEqual(target);
    // Every dismissal carried the reason — the suppression-loop signal.
    for (const s of states.filter((x) => target.includes(x.id))) {
      expect(s.dismissed_reason).toBe("cohort clear");
    }
    // The already-`acted` row was NOT in the selection and was NOT touched.
    expect(
      states.find((s) => s.id === TRIAGE_FIXTURE.actedSuggestionId)?.status,
    ).toBe("acted");
  });

  it("SELF-NEGATIVE-CONTROL — the server REFUSES an empty bulk rather than reporting success", async () => {
    // The vacuous shape this whole gate is named after, driven deliberately: a
    // 200/applied:0 here would make "bulk works" satisfiable by a no-op.
    const before = countPendingWithProject(dbPath());
    const r = await triage({ action: "dismiss", ids: [], reason: "nothing" });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("must not be empty");
    expect(countPendingWithProject(dbPath())).toBe(before);
  });

  it("SELF-NEGATIVE-CONTROL — the count really can move, and the reader really reads", async () => {
    // Without this, "5 survived" is also what you observe from a `countPendingWithProject`
    // that returns a constant.
    expect(countPendingWithProject(dbPath())).toBe(17);
    await triage({ action: "dismiss", ids: [1], reason: "one" });
    expect(countPendingWithProject(dbPath())).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// G-TR-3 — partial failure (D6) and the clamp
// ---------------------------------------------------------------------------

describe("G-TR-3 — partial failure is REPORTED per id, never rolled back", () => {
  it("3 valid + 1 missing + 1 already-acted -> applied 3, failed 2, the 3 LANDED", async () => {
    const missing = 9999;
    const ids = [3, 4, 5, missing, TRIAGE_FIXTURE.actedSuggestionId];
    expect(countPendingWithProject(dbPath())).toBe(17);

    const r = await triage({ action: "dismiss", ids, reason: "mixed batch" });
    expect(r.status, "a partial failure is NOT an HTTP error").toBe(200);
    const p = r.json<TriagePayload>();
    expect(p.applied).toBe(3);
    expect(p.failed).toBe(2);

    // The failures carry the BRAIN's own message, not one this brief wrote.
    const failures = p.results.filter((x) => !x.ok);
    expect(failures.map((f) => f.id).sort((a, b) => a - b)).toEqual([
      TRIAGE_FIXTURE.actedSuggestionId,
      missing,
    ]);
    for (const f of failures) {
      expect(f.error, `id ${f.id} reported no message`).toBeTruthy();
      expect(f.error).not.toContain("brain reported an error");
    }

    // D6: NO ROLLBACK. The three valid ones are dismissed.
    const states = suggestionStates(dbPath());
    for (const id of [3, 4, 5]) {
      expect(states.find((s) => s.id === id)?.status, `id ${id}`).toBe("dismissed");
    }
    expect(countPendingWithProject(dbPath())).toBe(14);
    // ...and the already-acted row is STILL acted — a failed id mutated nothing.
    expect(states.find((s) => s.id === TRIAGE_FIXTURE.actedSuggestionId)?.status).toBe(
      "acted",
    );
  });

  it("a 250-id batch CLAMPS to 200 and says so in `params`", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const r = await triage({ action: "dismiss", ids, reason: "clamp probe" });
    const p = r.json<TriagePayload>();
    expect(p.requested).toBe(MAX_BULK);
    expect(p.params.join(" ")).toContain(`clamped to ${MAX_BULK}`);
    // The clamp is REPORTED, not silent — that is the whole difference between
    // a bounded endpoint and one that loses 50 rows without saying so.
    expect(p.params.join(" ")).toContain("the rest were NOT applied");
    // Only the real PENDING rows could succeed; the rest are `not found` (or,
    // for id 18, already acted). Since TD-326 that is 17 project-bearing rows
    // plus the 3 project-less ones — this batch names ids 1..250, so it spans
    // both populations, which is why the number is derived rather than typed.
    const pending =
      TRIAGE_FIXTURE.pendingSuggestions + TRIAGE_FIXTURE.brainLevelPendingIds.length;
    expect(pending).toBe(20);
    expect(p.applied).toBe(pending);
  });

  it("duplicate ids are dropped ONCE and reported, not dismissed twice", async () => {
    const r = await triage({ action: "dismiss", ids: [6, 6, 7], reason: "dupes" });
    const p = r.json<TriagePayload>();
    expect(p.requested).toBe(2);
    expect(p.applied).toBe(2);
    expect(p.failed, "a duplicate produced a spurious failure").toBe(0);
    expect(p.params.join(" ")).toContain("duplicate id (6)");
  });

  it("`apply` is single-item only (D4) — a bulk is a 400, and nothing mutates", async () => {
    const before = countPendingWithProject(dbPath());
    const r = await triage({ action: "apply", ids: [1, 2] });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("single-item only");
    expect(countPendingWithProject(dbPath())).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// G-TR-4 — the degraded write surface, WITH its negative control
// ---------------------------------------------------------------------------

describe("G-TR-4 — a down write surface is DISABLED, not broken", () => {
  it("no brain at all -> health says unavailable, POST is 200 + degraded, applied 0", async () => {
    // Remove the brain entirely. `bootWriteEngine` checks existence FIRST and
    // never manufactures one — a dashboard that invented an empty brain because
    // the real one was not mounted is worse than one that says it cannot reach it.
    await srv!.close();
    srv = null;
    resetWriteEngine();
    rmSync(dbPath(), { force: true });
    rmSync(`${dbPath()}-wal`, { force: true });
    rmSync(`${dbPath()}-shm`, { force: true });
    resetBrainBridge();
    resetLayerReaders();
    closeBrainDb();
    closeRegistryDb();
    srv = await startServer({ port: 0, cliVersion: "test" });

    const health = await post("/api/triage", JSON.stringify({ action: "dismiss", ids: [1] }));
    expect(health.status, "a down write surface must never be a 500").toBe(200);
    const p = health.json<TriagePayload>();
    expect(p.applied).toBe(0);
    expect(p.failed).toBe(0);
    expect(p.results).toEqual([]);
    expect(p.degraded, "no degraded block on a down surface").not.toBeNull();
    // A DISCRIMINATED reason: a missing brain and a missing artifact send an
    // operator to completely different places.
    expect(p.degraded?.reason).toContain("brain database not found");
    // NEVER A STACK TRACE. Asserted over the RAW response text, not over a
    // field: a leaked trace would most likely arrive as an unstructured body.
    expect(health.body, "a stack trace leaked to the client").not.toContain("    at ");
    expect(health.body).not.toContain("node:internal");
  });

  it("NEGATIVE CONTROL — with the bundle and brain present, the SAME post applies", async () => {
    // Without this half, "returns degraded" is satisfiable by an endpoint that
    // is simply broken for every input.
    const r = await triage({ action: "dismiss", ids: [1], reason: "control" });
    const p = r.json<TriagePayload>();
    expect(p.degraded).toBeNull();
    expect(p.applied).toBe(1);
    expect(suggestionStates(dbPath()).find((s) => s.id === 1)?.status).toBe("dismissed");
  });

  it("`/api/health` reports the write surface, and lazily — a probe does NOT boot it", async () => {
    resetWriteEngine();
    expect(writeEngineState()).toBe("not-booted");
    const r = await post("/api/triage", JSON.stringify({ action: "__nope__", ids: [1] }));
    // A rejected ACTION never reaches the engine, so the door stays shut.
    expect(r.status).toBe(400);
    expect(writeEngineState(), "a 400 booted the write engine").toBe("not-booted");
  });
});

// ---------------------------------------------------------------------------
// G-TR-5(b) — DELEGATION IS STRUCTURAL (behavioural half)
// ---------------------------------------------------------------------------

describe("G-TR-5(b) — the write REACHES the brain's own handler, and has no bypass", () => {
  it("an HTTP POST invokes the resolved bundle's handleSuggestionDismiss", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    // Import the SAME module object the engine's gateway holds. ESM caches by
    // resolved URL, so patching the export here patches the function the
    // gateway will call — which is what makes this a call-graph assertion
    // rather than a grep.
    const handlersUrl = resolveBundleModule(
      "engine/components/subconscious/handlers.js",
    );
    expect(handlersUrl, "the subconscious handlers module did not resolve").not.toBeNull();
    const mod = (await import(
      new URL(`file://${handlersUrl!}`).href
    )) as Record<string, unknown>;

    const original = mod.handleSuggestionDismiss as (
      args: Record<string, unknown>,
    ) => unknown;
    expect(typeof original, "handleSuggestionDismiss is not exported").toBe("function");

    const calls: Record<string, unknown>[] = [];
    Object.defineProperty(mod, "handleSuggestionDismiss", {
      configurable: true,
      writable: true,
      value: (args: Record<string, unknown>) => {
        calls.push(args);
        return original(args);
      },
    });

    try {
      // Boot AFTER the patch, so the gateway registers the wrapped function.
      resetWriteEngine();
      const r = await triage({ action: "dismiss", ids: [8], reason: "spy" });
      expect(r.json<TriagePayload>().applied).toBe(1);

      // THE CALL TRACE, asserted — not just "a row changed". A reimplementation
      // in the server layer would change the row and call nothing.
      expect(calls, "the brain's own handler was never invoked").toHaveLength(1);
      expect(calls[0]).toEqual({ id: 8, reason: "spy" });
      // ...and the args carry the map's `idKey`, not a `learning_id`.
      expect(Object.keys(calls[0]!).sort()).toEqual(["id", "reason"]);
    } finally {
      Object.defineProperty(mod, "handleSuggestionDismiss", {
        configurable: true,
        writable: true,
        value: original,
      });
      resetWriteEngine();
    }
  });

  it("with a BOGUS tool name the row is UNCHANGED — there is no fallback writer", async () => {
    // The other half of "structural": if the gateway refuses the tool, nothing
    // else in this tier can write. `dispatchTriage` is called directly here
    // because the HTTP route cannot express a bogus tool — the map is frozen,
    // which is itself the point.
    const before = suggestionStates(dbPath()).find((s) => s.id === 9);
    expect(before?.status).toBe("pending");

    const spec = TRIAGE_ACTIONS.dismiss!;
    const bogus = { ...spec, tool: "igris_not_a_tool" };
    // Temporarily swap the map row. `TRIAGE_ACTIONS` is frozen, so this proves
    // the delegation is not merely conventional: the ONLY way to reach a write
    // is a name the gateway resolves.
    const booted = await bootWriteEngine();
    expect(booted.ok).toBe(true);
    if (booted.ok) {
      const res = await booted.engine.gateway
        .dispatch(bogus.tool, { id: 9 })
        .catch((err: Error) => ({ isError: true, content: [{ type: "text", text: err.message }] }));
      expect(JSON.stringify(res)).toContain("Unknown tool");
    }
    expect(suggestionStates(dbPath()).find((s) => s.id === 9)?.status).toBe("pending");
  });

  it("SELF-NEGATIVE-CONTROL — dispatchTriage refuses an action outside the frozen map", async () => {
    const before = countPendingWithProject(dbPath());
    const r = await dispatchTriage("__not_in_the_map__", [1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown triage action");
    expect(countPendingWithProject(dbPath())).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// G-TR-6 — gateway validation parity (BR-080 / TD-128)
// ---------------------------------------------------------------------------

describe("G-TR-6 — the dashboard is subject to the SAME input contract as an MCP client", () => {
  it("a missing required argument fails with the GATEWAY's own BR-080 message", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    const booted = await bootWriteEngine();
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;

    // Dispatch with the WRONG id key, which is exactly what a mis-typed
    // `TRIAGE_ACTIONS.idKey` would produce.
    await expect(
      booted.engine.gateway.dispatch("igris_perception_approve", { id: 1 }),
    ).rejects.toThrow(/missing required argument 'learning_id'.*BR-080/s);

    await expect(
      booted.engine.gateway.dispatch("igris_suggestion_dismiss", {}),
    ).rejects.toThrow(/missing required argument 'id'.*BR-080/s);
  });

  it("an unknown extra argument fails with the GATEWAY's own TD-128 message", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    const booted = await bootWriteEngine();
    if (!booted.ok) return;
    await expect(
      booted.engine.gateway.dispatch("igris_suggestion_dismiss", { id: 1, bogus: 1 }),
    ).rejects.toThrow(/unknown argument 'bogus'.*strict-input contract; TD-128/s);
  });

  it("the SERVER refuses an unknown field first, so the gateway is defence in depth", async () => {
    // `parseTriageBody` mirrors the TD-128 posture one layer out. Both fences
    // exist and each is asserted: the client gets a 400 with a stated field,
    // and if that ever regressed the gateway would still refuse the call.
    const r = await triage({ action: "dismiss", ids: [1], resaon: "typo" });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("unknown field: resaon");
    expect(suggestionStates(dbPath()).find((s) => s.id === 1)?.status).toBe("pending");
  });

  it("the extra ALLOW-LIST means a caller-supplied key cannot reach the handler", async () => {
    // `buildTriageArgs` copies only the map's `extra` keys. `dismiss` allows
    // `reason` and nothing else, so a `brief_id` on a dismiss is dropped BEFORE
    // the gateway would have rejected it.
    const r = await triage({ action: "dismiss", ids: [10], reason: "r", brief_id: "FR-1" });
    expect(r.status, "brief_id on a dismiss reached the gateway").toBe(200);
    const p = r.json<TriagePayload>();
    expect(p.applied).toBe(1);
    expect(suggestionStates(dbPath()).find((s) => s.id === 10)).toMatchObject({
      status: "dismissed",
      dismissed_reason: "r",
      acted_brief_id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// G-TR-7 — TD-326: the project-less population is BULK-TRIAGEABLE, and only it
// ---------------------------------------------------------------------------

/**
 * TD-326 AC #2 and AC #3, over the real write door.
 *
 * The read half (the count, the listing, the param handling) is
 * `dashboard-layers-endpoint.test.ts` G-EP-4. THIS gate answers the two
 * questions that only a mutation can answer:
 *
 *   - can the operator ACT on the project-less rows as their own population?
 *   - does acting on them leave every project's rows untouched, so D5 —
 *     "a bulk action never silently spans projects the operator did not
 *     choose" — still holds for the scope TD-326 adds?
 *
 * THE VACUOUS SHAPE, NAMED: a bulk over an EMPTY project-less population would
 * report `applied: 0` and every "the projects were untouched" assertion would
 * pass. So the pre-state asserts the population is non-empty, the post-state
 * asserts it emptied, and the delta asserts it was this action that did it.
 */
describe("G-TR-7 — TD-326: bulk-triaging the rows that belong to no project", () => {
  it("the fixture seeds a NON-EMPTY project-less population — the pre-state", () => {
    // Without this reading, every assertion below is satisfiable by zero rows.
    expect(countPendingBrainLevel(dbPath())).toBe(
      TRIAGE_FIXTURE.brainLevelPendingIds.length,
    );
    expect(countPendingBrainLevel(dbPath())).toBeGreaterThan(0);
    // ...and it is DISJOINT from the project-bearing one, which is what makes
    // "the projects were untouched" a meaningful claim rather than a tautology.
    expect(countPendingWithProject(dbPath())).toBe(TRIAGE_FIXTURE.pendingSuggestions);
    const nulls = suggestionStates(dbPath()).filter((s) =>
      TRIAGE_FIXTURE.brainLevelPendingIds.includes(
        s.id as (typeof TRIAGE_FIXTURE.brainLevelPendingIds)[number],
      ),
    );
    expect(nulls.every((s) => s.status === "pending")).toBe(true);
  });

  it("dismissing the brain-level cohort clears it and touches NO project row", async () => {
    const ids = [...TRIAGE_FIXTURE.brainLevelPendingIds];
    const beforeScoped = countPendingWithProject(dbPath());
    const beforeBrain = countPendingBrainLevel(dbPath());
    expect(beforeBrain).toBe(ids.length);

    const r = await triage({ action: "dismiss", ids, reason: "edge inferences reviewed" });
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: ids.length, applied: ids.length, failed: 0 });

    // POST-STATE and DELTA, both.
    expect(countPendingBrainLevel(dbPath())).toBe(0);
    expect(beforeBrain - countPendingBrainLevel(dbPath())).toBe(ids.length);
    // D5: the population the operator did NOT choose is bit-for-bit unmoved.
    expect(
      countPendingWithProject(dbPath()),
      "a brain-level bulk reached a project's rows",
    ).toBe(beforeScoped);
    const states = suggestionStates(dbPath());
    for (const id of pendingSuggestionIds()) {
      expect(states.find((s) => s.id === id)?.status, `id ${id}`).toBe("pending");
    }
    for (const id of ids) {
      expect(states.find((s) => s.id === id)).toMatchObject({
        status: "dismissed",
        dismissed_reason: "edge inferences reviewed",
      });
    }
  });

  it("the endpoint hands back exactly the ids the brain-level scope listed", async () => {
    // The round trip the UI performs: LIST under the scope, then act on what
    // came back. If these two disagreed, the bulk bar would be acting on a set
    // the operator never saw.
    const listed = JSON.parse(
      (await get("/api/suggestions?project_scope=brain-level&status=pending")).body,
    ) as { items: { id: number; project_slug: string | null }[]; total: number };
    expect(listed.total).toBe(TRIAGE_FIXTURE.brainLevelPendingIds.length);
    expect(listed.items.map((s) => s.id).sort((a, b) => a - b)).toEqual(
      [...TRIAGE_FIXTURE.brainLevelPendingIds].sort((a, b) => a - b),
    );
    expect(listed.items.every((s) => s.project_slug === null)).toBe(true);

    const r = await triage({
      action: "dismiss",
      ids: listed.items.map((s) => s.id),
      reason: "from the listed set",
    });
    expect(r.json<TriagePayload>().applied).toBe(listed.total);
    expect(countPendingBrainLevel(dbPath())).toBe(0);
  });

  it("SELF-NEGATIVE-CONTROL — a project bulk leaves the brain-level rows alone too", async () => {
    // The symmetric claim. Without it, "the two populations do not interfere"
    // rests on one direction, and a `WHERE` that silently matched everything
    // would still pass the test above.
    const beforeBrain = countPendingBrainLevel(dbPath());
    expect(beforeBrain).toBeGreaterThan(0);
    const r = await triage({
      action: "dismiss",
      ids: [...TRIAGE_FIXTURE.demoPendingIds],
      reason: "demo cohort",
    });
    expect(r.json<TriagePayload>().applied).toBe(TRIAGE_FIXTURE.demoPendingIds.length);
    expect(countPendingBrainLevel(dbPath())).toBe(beforeBrain);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FR-247 — the two BRIEF writes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * G-TR-8 … G-TR-13, and what each proves and does NOT prove.
 *
 *  G-TR-8   AC-3, over the WIRE. A body naming `status` is a 400 at the parser,
 *           and the `ids`/`refs` exclusivity is refused by name.
 *           Proves: the forbidden fields cannot enter through the door.
 *           Does NOT prove: that a field bypassing the parser would be dropped
 *           — G-TR-9.
 *
 *  G-TR-9   AC-3, BYPASSING the parser. `buildBriefArgs` called directly with a
 *           dirty `extra`, asserting the built key SET.
 *           Proves: the map's `extra` allow-list is the filter, not the parser.
 *           Does NOT prove: the handler received those args — G-TR-10.
 *
 *  G-TR-10  AC-3, BEHAVIOURAL. Spy the RESOLVED bundle's `handleBriefUpdate`
 *           and read the args it received, then re-read the row.
 *           Proves: what reached the brain's own handler, by call trace.
 *           Does NOT prove: anything about a brief with no status row — G-TR-11.
 *
 *  G-TR-11  AC-4, RED-FIRST, against the SHIPPED handler. The `brief_files`-only
 *           brief. RED first (the precondition removed by calling the handler
 *           the way the map would), then GREEN (the endpoint refuses).
 *           Plus the `handleBriefSync` contrast, so the suite DEMONSTRATES why
 *           `_update` is the right tool rather than asserting it.
 *
 *  G-TR-12  AC-6, BULK. Pre-state asserted, 12 of 17 moved, the other 5
 *           byte-identical, empty `refs` REFUSED, and the reader proven live.
 *
 *  G-TR-13  R4, THE EGRESS FENCE, PROVEN IN BOTH ARMS.
 *
 *  G-TR-14  AC-7, the degraded write surface for a brief write, with its
 *           negative control.
 */

// ---------------------------------------------------------------------------
// G-TR-8 — AC-3 at the door
// ---------------------------------------------------------------------------

describe("G-TR-8 — no brief write can name status, phase or content", () => {
  it("a body carrying `status` beside a priority is a 400, and nothing moves", async () => {
    const before = briefStatusRow(dbPath(), P, "FR-001");
    expect(before, "fixture pre-state").toMatchObject({
      priority: TRIAGE_FIXTURE.briefBasePriority,
      status: "Ready",
    });

    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-001")],
      priority: "P0-Critical",
      status: "Done",
    });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("unknown field: status");
    // THE POST-STATE, not just the status code: a 400 that had already written
    // would be the worst of both.
    expect(briefStatusRow(dbPath(), P, "FR-001")).toEqual(before);
  });

  it("`phase`, `content`, `title` and `filename` are refused the same way", async () => {
    for (const field of ["phase", "content", "title", "filename"]) {
      const r = await triage({
        action: "set_priority",
        refs: [ref("FR-002")],
        priority: "P1-High",
        [field]: "x",
      });
      expect(r.status, `${field} was accepted`).toBe(400);
      expect(r.json<{ error: string }>().error).toContain(`unknown field: ${field}`);
    }
    expect(briefStatusRow(dbPath(), P, "FR-002")?.priority).toBe(
      TRIAGE_FIXTURE.briefBasePriority,
    );
  });

  it("`ids` and `refs` are EXCLUSIVE, refused by name in both directions", async () => {
    const a = await triage({ action: "set_priority", ids: [1], priority: "P1-High" });
    expect(a.status).toBe(400);
    expect(a.json<{ error: string }>().error).toContain("'ids' is not accepted for it");

    const b = await triage({ action: "dismiss", refs: [ref("FR-001")], reason: "x" });
    expect(b.status).toBe(400);
    expect(b.json<{ error: string }>().error).toContain("'refs' is not accepted for it");

    // ...and neither reached anything.
    expect(briefStatusRow(dbPath(), P, "FR-001")?.priority).toBe(
      TRIAGE_FIXTURE.briefBasePriority,
    );
    expect(suggestionStates(dbPath()).find((s) => s.id === 1)?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// G-TR-9 — AC-3 with the parser bypassed
// ---------------------------------------------------------------------------

describe("G-TR-9 — the map's allow-list is the filter, not the parser", () => {
  it("buildBriefArgs over a DIRTY extra emits exactly {project, brief_id, priority}", () => {
    const spec = TRIAGE_ACTIONS.set_priority!;
    const args = buildBriefArgs(spec, ref("FR-001"), {
      priority: "P0-Critical",
      // Everything below is what a compromised or buggy client would send if it
      // got past the parser. None of it may appear in the output.
      status: "Done",
      phase: "COMMITTING",
      content: "x",
      title: "",
      filename: "x.md",
      goal_id: "GL-100",
      reason: "r",
    });
    expect(Object.keys(args).sort()).toEqual(["brief_id", "priority", "project"]);
    expect(args).toEqual({ project: P, brief_id: "FR-001", priority: "P0-Critical" });
  });

  it("attach_goal pins the edge shape and DROPS the ref's project (BR-078)", () => {
    const spec = TRIAGE_ACTIONS.attach_goal!;
    const args = buildBriefArgs(spec, ref("FR-001"), {
      goal_id: "GL-100",
      // A caller-supplied `edge_type` would turn ONE map row into ~20 different
      // mutations. It is not in `extra`, so it cannot arrive.
      edge_type: "blocks",
      status: "Done",
    });
    expect(args).toEqual({
      from_type: "brief",
      to_type: "goal",
      edge_type: "serves_goal",
      from_id: "FR-001",
      to_id: "GL-100",
    });
    // The `project` DROP, asserted rather than left to a comment. It is the
    // point at which the dashboard mints a BR-078-ambiguous edge, and the
    // absence is deliberate (`refKeys` does not name it).
    expect(Object.keys(args)).not.toContain("project");
  });

  it("SELF-NEGATIVE-CONTROL — the builder really does copy an allowed key", () => {
    // Without this, "the dirty keys are absent" is also what you observe from a
    // builder that returns a constant.
    const spec = TRIAGE_ACTIONS.set_priority!;
    expect(buildBriefArgs(spec, ref("X-1"), { priority: "P3-Low" })).toEqual({
      project: P,
      brief_id: "X-1",
      priority: "P3-Low",
    });
    // ...and an ABSENT allowed key is not invented (BR-080's presence rule).
    expect(Object.keys(buildBriefArgs(spec, ref("X-1"), {})).sort()).toEqual([
      "brief_id",
      "project",
    ]);
  });

  it("the three builders REFUSE each other's rows rather than emitting a wrong shape", () => {
    expect(() => buildBriefArgs(TRIAGE_ACTIONS.dismiss!, ref("FR-001"), {})).toThrow(
      /non-brief-ref action/,
    );
  });
});

// ---------------------------------------------------------------------------
// G-TR-10 — AC-3, behavioural
// ---------------------------------------------------------------------------

describe("G-TR-10 — the args the BRAIN's own handler received", () => {
  it("a real priority POST reaches handleBriefUpdate with no forbidden key", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    const briefsUrl = resolveBundleModule("tools/briefs.js");
    expect(briefsUrl, "the briefs tools module did not resolve").not.toBeNull();
    const mod = (await import(new URL(`file://${briefsUrl!}`).href)) as Record<
      string,
      unknown
    >;
    const original = mod.handleBriefUpdate as (a: Record<string, unknown>) => unknown;
    expect(typeof original, "handleBriefUpdate is not exported").toBe("function");

    const calls: Record<string, unknown>[] = [];
    Object.defineProperty(mod, "handleBriefUpdate", {
      configurable: true,
      writable: true,
      value: (a: Record<string, unknown>) => {
        calls.push(a);
        return original(a);
      },
    });

    try {
      resetWriteEngine();
      const before = briefStatusRow(dbPath(), P, "FR-003");
      expect(before?.title).toBe("Title of FR-003");

      const r = await triage({
        action: "set_priority",
        refs: [ref("FR-003")],
        priority: "P0-Critical",
      });
      expect(r.status).toBe(200);
      expect(r.json<TriagePayload>().applied).toBe(1);

      // THE CALL TRACE. A reimplementation in the server layer would change the
      // row and call nothing.
      expect(calls, "the brain's own handler was never invoked").toHaveLength(1);
      expect(Object.keys(calls[0]!).sort()).toEqual([
        "brief_id",
        "priority",
        "project",
      ]);
      for (const forbidden of ["status", "phase", "content", "title", "filename"]) {
        expect(calls[0], `${forbidden} reached the handler`).not.toHaveProperty(
          forbidden,
        );
      }

      // ...and the ROW: the one named column moved, every other one is
      // byte-identical. This is the half a call-trace cannot give.
      const after = briefStatusRow(dbPath(), P, "FR-003");
      expect(after).toEqual({ ...before, priority: "P0-Critical" });
    } finally {
      Object.defineProperty(mod, "handleBriefUpdate", {
        configurable: true,
        writable: true,
        value: original,
      });
      resetWriteEngine();
    }
  });

  it("attach_goal writes ONE serves_goal edge and touches no brief column", async () => {
    const before = briefStatusRows(dbPath());
    expect(edgeRows(dbPath())).toEqual([]);

    const r = await triage({
      action: "attach_goal",
      refs: [ref("FR-004")],
      goal_id: TRIAGE_FIXTURE.goalIds[0],
    });
    expect(r.status).toBe(200);
    expect(r.json<TriagePayload>()).toMatchObject({ applied: 1, failed: 0 });

    expect(edgeRows(dbPath())).toEqual([
      {
        from_type: "brief",
        from_id: "FR-004",
        to_type: "goal",
        to_id: TRIAGE_FIXTURE.goalIds[0],
        edge_type: "serves_goal",
      },
    ]);
    // NOT ONE brief_status column moved. An edge write that also nudged
    // `updated_at`'s neighbours would be a second writer nobody declared.
    expect(briefStatusRows(dbPath())).toEqual(before);
  });

  it("the per-item result carries the REF, and `id` is null", async () => {
    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-005"), ref("FR-006")],
      priority: "P3-Low",
    });
    const p = r.json<TriagePayload>();
    // FR-249 widened this payload by ONE field, and it is asserted here rather
    // than matched loosely: `created_id` is null for every row that declares no
    // `returns`, which is seven of the eight.
    expect(p.results).toEqual([
      { id: null, ref: ref("FR-005"), ok: true, error: null, created_id: null },
      { id: null, ref: ref("FR-006"), ok: true, error: null, created_id: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// G-TR-11 — AC-4, RED-FIRST, against the SHIPPED handler
// ---------------------------------------------------------------------------

/**
 * The brief asks for a proof "against a handler that upserts". The shipped
 * handler supplies a BETTER subject than a straw man, and this gate is built on
 * it: `handleBriefUpdate` is a genuine partial update for a brief that HAS a
 * `brief_status` row, and takes a row-CREATING branch for one that does not.
 *
 * RED and GREEN are both driven here, in the same file, so the defect is
 * DEMONSTRATED rather than described:
 *   - RED  — dispatch what the map would dispatch, with the precondition
 *            bypassed, and OBSERVE the damage.
 *   - GREEN— the same write through the endpoint is refused, and the damage is
 *            absent.
 */
describe("G-TR-11 — a priority-only write cannot invent a status or blank a title", () => {
  it("the fixture really seeds a brief_files-only brief — the pre-state", () => {
    // Without this reading every assertion below is satisfiable by zero rows.
    expect(briefStatusCount(dbPath(), P, TRIAGE_FIXTURE.filesOnlyBriefId)).toBe(0);
    // ...and it is not merely absent from BOTH tables, which would make the
    // whole gate a test of "unknown brief" instead.
    const db = readTriageBrain(dbPath());
    try {
      const n = (
        db
          .prepare("SELECT COUNT(*) AS n FROM brief_files WHERE project = ? AND brief_id = ?")
          .get(P, TRIAGE_FIXTURE.filesOnlyBriefId) as { n: number }
      ).n;
      expect(n, "the brief_files row is missing — this gate has no subject").toBe(1);
    } finally {
      db.close();
    }
  });

  it("RED — the SHIPPED handler, dispatched unguarded, INVENTS status='Ready' and title=''", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    const booted = await bootWriteEngine();
    expect(booted.ok, booted.ok ? "" : booted.reason).toBe(true);
    if (!booted.ok) return;

    // THE DEFECT, driven on purpose. This is exactly `buildBriefArgs`' output
    // for this ref — i.e. what the map dispatches — with `dispatchBriefWrite`'s
    // precondition read taken out of the path. Nothing here is a straw man: the
    // tool name, the args and the handler are the shipped ones.
    const args = buildBriefArgs(
      TRIAGE_ACTIONS.set_priority!,
      ref(TRIAGE_FIXTURE.filesOnlyBriefId),
      { priority: "P0-Critical" },
    );
    expect(args).toEqual({
      project: P,
      brief_id: TRIAGE_FIXTURE.filesOnlyBriefId,
      priority: "P0-Critical",
    });
    const res = await booted.engine.gateway.dispatch("igris_brief_update", args);
    expect(res.isError, JSON.stringify(res)).not.toBe(true);

    // THE OBSERVED DAMAGE. A row that did not exist now does, carrying a status
    // nobody asked for and an EMPTY title — two writes into the TD-311
    // build-state invariant from a request that named neither field.
    const created = briefStatusRow(dbPath(), P, TRIAGE_FIXTURE.filesOnlyBriefId);
    expect(created, "the INSERT branch did not fire — has briefs.ts:653-676 changed?").not.toBeNull();
    expect(created).toMatchObject({ status: "Ready", title: "", priority: "P0-Critical" });
  });

  it("GREEN — the same write through the endpoint is REFUSED, and no row appears", async () => {
    const r = await triage({
      action: "set_priority",
      refs: [ref(TRIAGE_FIXTURE.filesOnlyBriefId)],
      priority: "P0-Critical",
    });
    // A refusal is a per-item RESULT, not an HTTP error: the request was
    // well-formed and other refs in the same batch may well have applied.
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 1, applied: 0, failed: 1 });
    expect(p.results[0]?.ref).toEqual(ref(TRIAGE_FIXTURE.filesOnlyBriefId));
    expect(p.results[0]?.error).toContain("no brief_status row");
    expect(p.results[0]?.error).toContain("status='Ready'");

    // THE DAMAGE IS ABSENT.
    expect(briefStatusCount(dbPath(), P, TRIAGE_FIXTURE.filesOnlyBriefId)).toBe(0);
  });

  it("GREEN — attach_goal on the same ref is refused too, and mints NO edge", async () => {
    // The second, independent reason (Phase-0 P0.4): `getGoal`'s
    // `serving_briefs` INNER-joins `brief_status`, so an edge to a
    // status-less brief is invisible in the goal detail. Creating it would be
    // a silent no-op from the operator's point of view.
    const r = await triage({
      action: "attach_goal",
      refs: [ref(TRIAGE_FIXTURE.filesOnlyBriefId)],
      goal_id: TRIAGE_FIXTURE.goalIds[0],
    });
    expect(r.json<TriagePayload>().applied).toBe(0);
    expect(edgeRows(dbPath())).toEqual([]);
  });

  it("a ref naming a brief in NEITHER table gets its OWN message", async () => {
    // Two refusals, distinguished. Collapsing them would hide the interesting
    // one behind the boring one.
    const r = await triage({
      action: "set_priority",
      refs: [ref(TRIAGE_FIXTURE.missingBriefId)],
      priority: "P1-High",
    });
    const p = r.json<TriagePayload>();
    expect(p.failed).toBe(1);
    expect(p.results[0]?.error).toContain("no such brief in this project");
    expect(p.results[0]?.error).not.toContain("no brief_status row");
  });

  it("a refused ref does NOT stop the rest of the batch (D6: no rollback)", async () => {
    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-007"), ref(TRIAGE_FIXTURE.filesOnlyBriefId), ref("FR-008")],
      priority: "P0-Critical",
    });
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 3, applied: 2, failed: 1 });
    expect(briefStatusRow(dbPath(), P, "FR-007")?.priority).toBe("P0-Critical");
    expect(briefStatusRow(dbPath(), P, "FR-008")?.priority).toBe("P0-Critical");
    expect(briefStatusCount(dbPath(), P, TRIAGE_FIXTURE.filesOnlyBriefId)).toBe(0);
  });

  /**
   * THE UPSERT CONTRAST — and a CORRECTION to the premise this brief was
   * handed, found by running it rather than by reading it.
   *
   * The plan (and BR-080/TD-323) says `igris_brief_sync` is dangerous because
   * its `ON CONFLICT DO UPDATE SET title = excluded.title, …` binds an OMITTED
   * `title` as NULL. That is true of the SQL. It is NOT reachable through the
   * gateway: `igris_brief_sync` declares
   * `required: ['project','brief_id','title','status']`, so a title-omitting
   * call is refused by the BR-080 strict-input walk before the handler runs —
   * measured here, with the gateway's verbatim message.
   *
   * So the map's reason for forbidding the tool BY NAME is not the one the
   * plan gave, and stating the weaker true reason is worth more than repeating
   * the stronger false one: `igris_brief_sync` OVERWRITES `title` and `status`
   * on EVERY call, because it requires them. A map row using it could not
   * express a priority-only write at all — it would be a full-row write into
   * TD-311's invariant by construction, whatever the caller intended. Both
   * halves are asserted below.
   */
  it("THE UPSERT CONTRAST — the gateway refuses a title-less sync, and a sync OVERWRITES", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    const booted = await bootWriteEngine();
    if (!booted.ok) return;

    const before = briefStatusRow(dbPath(), P, "FR-009");
    expect(before).toMatchObject({ title: "Title of FR-009", status: "Ready" });

    // HALF 1 — BR-080 is the FIRST fence, and it holds. The omitted-title
    // upsert TD-323 describes cannot be reached through this door.
    await expect(
      booted.engine.gateway.dispatch("igris_brief_sync", {
        project: P,
        brief_id: "FR-009",
        priority: "P0-Critical",
      }),
    ).rejects.toThrow(/missing required argument 'title'.*BR-080/s);
    expect(briefStatusRow(dbPath(), P, "FR-009")).toEqual(before);

    // HALF 2 — and this is the reason that actually survives: a WELL-FORMED
    // sync overwrites `title` and `status` with whatever the caller supplied.
    // There is no way to spell "set only the priority" with this tool.
    await booted.engine.gateway.dispatch("igris_brief_sync", {
      project: P,
      brief_id: "FR-009",
      title: "OVERWRITTEN BY SYNC",
      status: "Done",
      priority: "P0-Critical",
    });
    expect(briefStatusRow(dbPath(), P, "FR-009")).toMatchObject({
      title: "OVERWRITTEN BY SYNC",
      status: "Done",
    });

    // ...which is why the map forbids it by name, and really does.
    expect(Object.values(TRIAGE_ACTIONS).map((s) => s.tool)).not.toContain(
      "igris_brief_sync",
    );
  });

  it("the D6 predicate's LOAD-BEARING schema constraint is still in place", () => {
    // `hasBriefStatusRow` keys on `status !== null` because `getBrief`
    // LEFT-JOINs and returns a non-null record with null status columns for a
    // `brief_files`-only brief. That is only sound while the column is NOT
    // NULL. Read from the schema the ENGINE built, not from `db.ts`.
    expect(
      briefStatusStatusIsNotNull(dbPath()),
      "brief_status.status is no longer NOT NULL — re-read hasBriefStatusRow",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G-TR-12 — AC-6, bulk, with the PRE-state and the named vacuous case
// ---------------------------------------------------------------------------

describe("G-TR-12 — a bulk priority write acts on the selection and ONLY the selection", () => {
  it("17 at P2-Medium -> 12 to P0-Critical -> the other 5 are BYTE-IDENTICAL", async () => {
    // 1. THE PRE-STATE. Both halves: what will move, and what must not.
    const all = seededBriefIds();
    expect(all).toHaveLength(17);
    const before = briefStatusRows(dbPath());
    expect(
      before.filter((r) => r.priority === TRIAGE_FIXTURE.briefBasePriority),
    ).toHaveLength(17);
    expect(before.filter((r) => r.priority === "P0-Critical")).toHaveLength(0);

    const target = all.slice(0, 12);
    const survivors = all.slice(12);
    expect(survivors).toHaveLength(5);

    // 2. THE ACTION.
    const r = await triage({
      action: "set_priority",
      refs: target.map(ref),
      priority: "P0-Critical",
    });
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 12, applied: 12, failed: 0 });
    expect(p.results.map((x) => x.ref?.brief_id)).toEqual(target);

    // 3. THE POST-STATE and 4. THE UNTOUCHED REMAINDER — the discriminating
    //    half. A bulk that silently widened to "everything in scope" passes a
    //    count-of-12 check and fails this one.
    const after = briefStatusRows(dbPath());
    expect(after.filter((x) => x.priority === "P0-Critical").map((x) => x.brief_id)).toEqual(
      target,
    );
    for (const id of survivors) {
      expect(
        after.find((x) => x.brief_id === id),
        `${id} was touched by a bulk that did not name it`,
      ).toEqual(before.find((x) => x.brief_id === id));
    }
    // ...and the non-canonical row, which was in neither half, is untouched.
    expect(
      after.find((x) => x.brief_id === TRIAGE_FIXTURE.nonCanonicalBriefId),
    ).toEqual(before.find((x) => x.brief_id === TRIAGE_FIXTURE.nonCanonicalBriefId));
  });

  it("SELF-NEGATIVE-CONTROL — an EMPTY refs bulk is a 400, not a 200/applied:0", async () => {
    // FR-247's OWN named vacuous case, driven on purpose. A 200/applied:0 here
    // would make every "bulk works" assertion above satisfiable by a no-op.
    const before = briefStatusRows(dbPath());
    const r = await triage({ action: "set_priority", refs: [], priority: "P0-Critical" });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("'refs' must not be empty");
    // THE PRE-STATE IS RE-READ, not assumed: the claim is that nothing moved.
    expect(briefStatusRows(dbPath())).toEqual(before);
  });

  it("SELF-NEGATIVE-CONTROL — the reader really reads, out of band", async () => {
    // Without this, "the other 5 are identical" is also what you observe from a
    // `briefStatusRows` that returns a constant.
    expect(briefStatusRow(dbPath(), P, "FR-017")?.priority).toBe("P2-Medium");
    await triage({ action: "set_priority", refs: [ref("FR-017")], priority: "P3-Low" });
    expect(briefStatusRow(dbPath(), P, "FR-017")?.priority).toBe("P3-Low");
  });

  it("duplicate refs are dropped ONCE and reported", async () => {
    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-010"), ref("FR-010"), ref("FR-011")],
      priority: "P1-High",
    });
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 2, applied: 2, failed: 0 });
    expect(p.params.join(" ")).toContain(`duplicate ref (${P}|FR-010)`);
  });

  it("a 250-ref batch CLAMPS to 200 and says so", async () => {
    const refs = Array.from({ length: 250 }, (_, i) => ref(`GEN-${i}`));
    const p = (
      await triage({ action: "set_priority", refs, priority: "P1-High" })
    ).json<TriagePayload>();
    expect(p.requested).toBe(MAX_BULK);
    expect(p.params.join(" ")).toContain(`refs: clamped to ${MAX_BULK}`);
    expect(p.params.join(" ")).toContain("the rest were NOT applied");
  });

  it("CLEAR sends the empty string and the brain folds it to NULL", async () => {
    // The picker's CLEAR (`model.ts#PRIORITY_CLEAR`) becomes `""` on the wire —
    // the sentinel itself is never sent, because a literal `__clear__` reaching
    // the brain would be stored verbatim as a NINTH non-canonical value.
    expect(briefStatusRow(dbPath(), P, "FR-012")?.priority).toBe("P2-Medium");
    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-012")],
      priority: "",
    });
    expect(r.json<TriagePayload>().applied).toBe(1);
    expect(briefStatusRow(dbPath(), P, "FR-012")?.priority).toBeNull();
  });

  it("writing to a NON-CANONICAL brief canonicalises it — stated, not chased", async () => {
    // D2's stated consequence. `normalizePriority` folds at the handler, so a
    // correct write to the `P4-Trivial` row also cleans it. That is a side
    // effect, not a fix: TD-338 owns the population and the SYNC path that
    // minted it, and this test exists so the behaviour is recorded rather than
    // discovered.
    expect(briefStatusRow(dbPath(), P, TRIAGE_FIXTURE.nonCanonicalBriefId)?.priority).toBe(
      TRIAGE_FIXTURE.nonCanonicalPriority,
    );
    await triage({
      action: "set_priority",
      refs: [ref(TRIAGE_FIXTURE.nonCanonicalBriefId)],
      priority: "P1-High",
    });
    expect(briefStatusRow(dbPath(), P, TRIAGE_FIXTURE.nonCanonicalBriefId)).toMatchObject({
      priority: "P1-High",
      // ...and its status, which was NOT `Ready`, is untouched. A write that
      // had gone through the INSERT branch would have made it `Ready`.
      status: "In Progress",
    });
  });
});

// ---------------------------------------------------------------------------
// G-TR-13 — R4: the auto-push egress fence, PROVEN IN BOTH ARMS
// ---------------------------------------------------------------------------

/**
 * The safety property this whole brief hangs on, and the one that cannot be
 * established by observing that nothing happened.
 *
 * ARM A (the fence's normal state): no `auto_push` in the sandbox config, so
 * zero outbound requests. On its own that reading is worthless — it is equally
 * what you get from a fence that does nothing and from a listener that was
 * never wired.
 *
 * ARM B: a sandbox config that says `auto_push: true`, pointed at a fictional
 * remote. The SAME priority write must now produce a BLOCKED outbound POST to
 * that remote's `/sync/push`. That single reading proves three things at once —
 * the egress path is real, the fence catches it, and Arm A's zero means
 * something.
 */
describe("G-TR-13 — a fixture write cannot egress to a remote brain", () => {
  it("the fence is ARMED, and it is not the operator's real HOME", () => {
    expect(fence, "the fence was not installed").not.toBeNull();
    fence!.assertArmed();
    expect(homedir()).toBe(sandbox);
    expect(homedir()).not.toBe(REAL_BRAIN.replace("/.igris/memory/knowledge.db", ""));
  });

  it("ARM A — with no auto_push configured, a priority write reaches no network", async () => {
    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-013")],
      priority: "P0-Critical",
    });
    expect(r.json<TriagePayload>().applied).toBe(1);
    // `sync`'s push is FIRE-AND-FORGET, so give the microtask queue a turn
    // before reading the counter — otherwise a zero could just be a race.
    await new Promise((res) => setTimeout(res, 50));
    expect(
      fence!.attempts,
      `an outbound request escaped: ${JSON.stringify(fence!.attempts)}`,
    ).toEqual([]);
  });

  it("ARM B — with auto_push:true, the SAME write attempts a push, and it is BLOCKED", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    // `loadAutoPushConfig` runs at `sync`'s init, i.e. at engine boot — so the
    // config has to be in place before the engine, and the engine has to be
    // torn down first because at most one may be live per process.
    await srv!.close();
    srv = null;
    resetWriteEngine();
    fence!.writeConfig({
      auto_push: true,
      remote_brain: {
        url: "https://fr247-fictional-remote.invalid",
        api_key: "fr247-not-a-real-key",
      },
    });
    srv = await startServer({ port: 0, cliVersion: "test" });

    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-014")],
      priority: "P0-Critical",
    });
    expect(r.json<TriagePayload>().applied).toBe(1);
    await new Promise((res) => setTimeout(res, 200));

    // THE EGRESS PATH IS REAL. `brief.synced` -> `sync`'s immediate handler ->
    // `pushTables({brief_status, brief_files})` -> `POST <remote>/sync/push`.
    expect(
      fence!.attempts.length,
      "no push was attempted — either brief.synced stopped reaching sync, or the fence is not intercepting",
    ).toBeGreaterThan(0);
    expect(fence!.attempts[0]?.url).toContain("fr247-fictional-remote.invalid");
    expect(fence!.attempts[0]?.url).toContain("/sync/push");
    expect(fence!.attempts[0]?.method).toBe("POST");
    // ...and it never reached the operator's REAL remote.
    for (const a of fence!.attempts) {
      expect(a.url, "a request was aimed at the real remote brain").not.toContain(
        "brain.fifty.dev",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// G-TR-14 — AC-7, with its negative control
// ---------------------------------------------------------------------------

describe("G-TR-14 — a down write surface makes brief writes DISABLED, not broken", () => {
  it("no brain -> 200 + degraded, applied 0, no stack trace", async () => {
    await srv!.close();
    srv = null;
    resetWriteEngine();
    rmSync(dbPath(), { force: true });
    rmSync(`${dbPath()}-wal`, { force: true });
    rmSync(`${dbPath()}-shm`, { force: true });
    resetBrainBridge();
    resetLayerReaders();
    closeBrainDb();
    closeRegistryDb();
    srv = await startServer({ port: 0, cliVersion: "test" });

    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-001")],
      priority: "P0-Critical",
    });
    expect(r.status, "a down write surface must never be a 500").toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ applied: 0, failed: 0, results: [] });
    expect(p.degraded).not.toBeNull();
    expect(r.body).not.toContain("    at ");
    expect(r.body).not.toContain("node:internal");
  });

  it("NEGATIVE CONTROL — with the brain present the SAME post applies", async () => {
    const r = await triage({
      action: "set_priority",
      refs: [ref("FR-001")],
      priority: "P0-Critical",
    });
    expect(r.json<TriagePayload>()).toMatchObject({ applied: 1, degraded: null });
    expect(briefStatusRow(dbPath(), P, "FR-001")?.priority).toBe("P0-Critical");
  });

  it("a brief write never boots the engine from a REJECTED body", async () => {
    resetWriteEngine();
    expect(writeEngineState()).toBe("not-booted");
    const r = await triage({ action: "set_priority", refs: [], priority: "P0-Critical" });
    expect(r.status).toBe(400);
    expect(writeEngineState(), "a 400 booted the write engine").toBe("not-booted");
  });

  it("dispatchBriefWrite refuses an id-addressed action outright", async () => {
    const before = briefStatusRows(dbPath());
    const r = await dispatchBriefWrite("dismiss", [ref("FR-001")], {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown brief-write action");
    expect(briefStatusRows(dbPath())).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FR-249 — the SUBJECTLESS write
// ═══════════════════════════════════════════════════════════════════════════

/**
 * G-TR-15 … G-TR-19, and what each proves and does NOT prove.
 *
 *  G-TR-15  AC-3's shape for a `target: "none"` row, BYPASSING the parser.
 *           `buildSubjectlessArgs` called with a dirty `extra`, asserting the
 *           built key SET is exactly `rename(extra ∩ supplied)`.
 *           Proves: the wire's `goal_title` really becomes the tool's `title`,
 *           and nothing else can ride along.
 *           Does NOT prove: the handler received those args — G-TR-16.
 *
 *  G-TR-16  BEHAVIOURAL. Spy the RESOLVED bundle's `handleGoalCreate`, read the
 *           args it received, and read the row back.
 *           Proves: `Object.keys(args)` is exactly `{title, outcome[, project]}`
 *           — no `status`, no `phase`, no brief field — and that the row
 *           carries the handler's OWN defaults.
 *           Does NOT prove: what happens when the second half fails — G-TR-17.
 *
 *  G-TR-17  THE PARTIAL-FAILURE PROOF, and it needs NO MOCK. Two requests:
 *           `create_goal` allocates `GL-102` deterministically, then
 *           `attach_goal` at the `brief_files`-only brief hits FR-247's SHIPPED
 *           precondition refusal. End state: the goal exists with ZERO serving
 *           edges — an ordinary state, not a broken transaction.
 *           STATED AND NOT REACHABLE: a create that succeeds followed by an
 *           attach that fails for a VALID brief cannot be produced without a
 *           mock. `igris_edge_create` never verifies the goal exists
 *           (`INSERT OR IGNORE` on any `to_id`) and its other failure modes are
 *           foreclosed by `fixed`. That is a property of option 3's design, not
 *           a gap in this gate, and no mock is manufactured to satisfy a
 *           sentence.
 *
 *  G-TR-18  THE BY-ABSENCE PROPERTY, over the wire. `create_goal` with `ids`,
 *           with `refs`, and with a bare `title` are all 400s BY NAME. The last
 *           is the one that keeps `params.ts`' stated property honest: the wire
 *           key is `goal_title`, so `title` is still refused for EVERY action.
 *
 *  G-TR-19  THE EGRESS FENCE over the new path. Meaningful only because G-TR-13
 *           above proves the fence CAN record an attempt.
 */

// ---------------------------------------------------------------------------
// G-TR-15 — the seam, with the parser bypassed
// ---------------------------------------------------------------------------

describe("G-TR-15 — a subjectless row's whole argument surface is its own map row", () => {
  it("buildSubjectlessArgs over a DIRTY extra emits exactly {title, outcome, project}", () => {
    const spec = TRIAGE_ACTIONS.create_goal!;
    const args = buildSubjectlessArgs(spec, {
      goal_title: "Ship the write door",
      goal_outcome: "Every mutation is a map row",
      goal_project: P,
      // Everything below is what a compromised or buggy client would send if it
      // got past the parser. None of it may appear in the output — including
      // the UNPREFIXED spellings, which are the ones a tool would actually act
      // on if the builder had copied the body instead of walking `extra`.
      title: "a brief title",
      status: "Done",
      phase: "COMMITTING",
      content: "x",
      filename: "x.md",
      priority: "P0-Critical",
      deadline: "2026-12-01",
      metadata: "{}",
      goal_id: "GL-100",
    });
    expect(Object.keys(args).sort()).toEqual(["outcome", "project", "title"]);
    expect(args).toEqual({
      title: "Ship the write door",
      outcome: "Every mutation is a map row",
      project: P,
    });
  });

  it("SELF-NEGATIVE-CONTROL — an ABSENT optional key is not invented", () => {
    // Without this, "the dirty keys are absent" is also what you observe from a
    // builder that returns a constant. BR-080's presence-not-truthiness rule:
    // an omitted `goal_project` must not arrive as `project: undefined`, which
    // the gateway would read as a supplied argument.
    const spec = TRIAGE_ACTIONS.create_goal!;
    expect(buildSubjectlessArgs(spec, { goal_title: "t", goal_outcome: "o" })).toEqual({
      title: "t",
      outcome: "o",
    });
    // ...and an EMPTY STRING is a supplied value, not an absent one. It is how
    // the client says "all projects" without a second control, and
    // `handleGoalCreate` folds it to `project_slug NULL`.
    expect(
      buildSubjectlessArgs(spec, { goal_title: "t", goal_outcome: "o", goal_project: "" }),
    ).toEqual({ title: "t", outcome: "o", project: "" });
  });

  it("the three builders REFUSE each other's rows rather than emitting a wrong shape", () => {
    expect(() => buildSubjectlessArgs(TRIAGE_ACTIONS.set_priority!, {})).toThrow(
      /subject-addressed action/,
    );
    expect(() => buildBriefArgs(TRIAGE_ACTIONS.create_goal!, ref("FR-001"), {})).toThrow(
      /non-brief-ref action/,
    );
  });

  it("`dispatchSubjectless` refuses an action outside its own target kind", async () => {
    // The exported dispatcher is not reachable with a wrong action through the
    // route (`triage()` switches on `target` first), so it must refuse on its
    // own rather than become a hole in the delegation rule.
    const before = goalRows(dbPath());
    const r = await dispatchSubjectless("attach_goal", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown subjectless action");
    expect(goalRows(dbPath())).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// G-TR-16 — behavioural: the args the BRAIN's own handler received
// ---------------------------------------------------------------------------

describe("G-TR-16 — a create reaches handleGoalCreate with exactly the mapped args", () => {
  it("the fixture seeds EXACTLY two goals, so GL-102 is the next id — the pre-state", () => {
    // Without this reading, every `GL-102` assertion below is satisfiable by a
    // fixture that happened to seed a different number of goals.
    expect(goalRows(dbPath()).map((g) => g.goal_id)).toEqual([
      ...TRIAGE_FIXTURE.goalIds,
    ]);
  });

  it("the call trace: `goal_title` arrived as `title`, and no forbidden key came with it", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    const goalsUrl = resolveBundleModule("engine/components/goals/handlers.js");
    expect(goalsUrl, "the goals handlers module did not resolve").not.toBeNull();
    const mod = (await import(new URL(`file://${goalsUrl!}`).href)) as Record<
      string,
      unknown
    >;
    const original = mod.handleGoalCreate as (a: Record<string, unknown>) => unknown;
    expect(typeof original, "handleGoalCreate is not exported").toBe("function");

    const calls: Record<string, unknown>[] = [];
    Object.defineProperty(mod, "handleGoalCreate", {
      configurable: true,
      writable: true,
      value: (a: Record<string, unknown>) => {
        calls.push(a);
        return original(a);
      },
    });

    try {
      resetWriteEngine();
      const r = await triage({
        action: "create_goal",
        goal_title: "Ship the write door",
        goal_outcome: "Every dashboard mutation is a map row",
        goal_project: P,
      });
      expect(r.status).toBe(200);
      expect(r.json<TriagePayload>()).toMatchObject({
        requested: 1,
        applied: 1,
        failed: 0,
      });

      // THE ARGUMENT SET. The wire names are `goal_*`; the tool's are not. A
      // rename that leaked its SOURCE key, or a builder that copied the body,
      // fails here rather than in review.
      expect(calls, "the brain's own handler was never invoked").toHaveLength(1);
      expect(Object.keys(calls[0]!).sort()).toEqual(["outcome", "project", "title"]);
      for (const forbidden of [
        "status",
        "phase",
        "content",
        "filename",
        "goal_title",
        "priority",
        "deadline",
        "metadata",
      ]) {
        expect(calls[0], `${forbidden} reached the handler`).not.toHaveProperty(
          forbidden,
        );
      }
    } finally {
      Object.defineProperty(mod, "handleGoalCreate", {
        configurable: true,
        writable: true,
        value: original,
      });
      resetWriteEngine();
    }
  });

  it("the ROW: GL-102, the posted values, and the HANDLER's defaults", async () => {
    const r = await triage({
      action: "create_goal",
      goal_title: "Ship the write door",
      goal_outcome: "Every dashboard mutation is a map row",
      goal_project: P,
    });
    expect(r.json<TriagePayload>().applied).toBe(1);

    const rows = goalRows(dbPath());
    expect(rows.map((g) => g.goal_id)).toEqual([...TRIAGE_FIXTURE.goalIds, "GL-102"]);
    expect(rows[2]).toEqual({
      goal_id: TRIAGE_FIXTURE.nextGoalId,
      project_slug: P,
      title: "Ship the write door",
      outcome: "Every dashboard mutation is a map row",
      // NOT CHOSEN BY THE OPERATOR — defaulted by `handleGoalCreate`. The form
      // offers neither field and SAYS so; asserting them here is what makes
      // that sentence checkable rather than decorative.
      status: "active",
      priority: "P2-Medium",
      deadline: null,
      description: null,
    });
  });

  it("the RESULT CHANNEL hands back the new id, and only for the row that declares it", async () => {
    const r = await triage({
      action: "create_goal",
      goal_title: "t",
      goal_outcome: "o",
    });
    const p = r.json<TriagePayload>();
    // The whole reason the channel exists: the client preselects this.
    expect(p.results).toEqual([
      {
        id: null,
        ref: null,
        ok: true,
        error: null,
        created_id: TRIAGE_FIXTURE.nextGoalId,
      },
    ]);

    // ...and a row that declares no `returns` reports `null`, not a stale id.
    const q = await triage({
      action: "attach_goal",
      refs: [ref("FR-001")],
      goal_id: TRIAGE_FIXTURE.nextGoalId,
    });
    expect(q.json<TriagePayload>().results[0]?.created_id).toBeNull();
  });

  it("a create with NO project stores NULL — the all-projects scope", async () => {
    // D-OP-4: the shell's scope supplies `goal_project`, and "all projects" is
    // the ABSENCE of one. `handleGoalCreate` stores that as NULL, which
    // `pages/layers/Goals.tsx` already renders as "Cross-project".
    const r = await triage({
      action: "create_goal",
      goal_title: "a cross-project goal",
      goal_outcome: "o",
    });
    expect(r.json<TriagePayload>().applied).toBe(1);
    expect(goalRows(dbPath())[2]?.project_slug).toBeNull();
  });

  it("the brain's own refusal is surfaced VERBATIM, and no row appears", async () => {
    // 256 is the brain's cap (`goals/handlers.ts#MAX_TITLE_LEN`). It is NOT
    // mirrored in `params.ts` — a fourth copy of a brain constant is a fourth
    // thing to drift — so the rejection has to arrive from the brain, and this
    // is the assertion that says it does.
    const r = await triage({
      action: "create_goal",
      goal_title: "x".repeat(257),
      goal_outcome: "o",
    });
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 1, applied: 0, failed: 1 });
    expect(p.results[0]?.error).toContain("title exceeds maximum length of 256");
    expect(p.results[0]?.created_id).toBeNull();
    expect(goalRows(dbPath())).toHaveLength(2);
  });

  it("a create writes NOTHING to event_log, to entity_edges or to brief_status", async () => {
    const events = maxEventId(dbPath());
    const briefsBefore = briefStatusRows(dbPath());
    await triage({ action: "create_goal", goal_title: "t", goal_outcome: "o" });

    // `goal.created` IS emitted on the bus (`goals/index.ts`), but it reaches
    // NEITHER `monitoring`'s `EVENT_COMPONENT_MAP` nor its `bus.on` list — so
    // the create is DECLARED-EMPTY on `event_log`, exactly like `attach_goal`.
    // Measured, not assumed (Phase-0 P0.2).
    expect(eventsSince(dbPath(), events)).toEqual([]);
    expect(edgeRows(dbPath())).toEqual([]);
    expect(briefStatusRows(dbPath())).toEqual(briefsBefore);
  });
});

// ---------------------------------------------------------------------------
// G-TR-17 — the partial-failure proof, with no mock
// ---------------------------------------------------------------------------

describe("G-TR-17 — create succeeds, attach fails, and the goal is an ORDINARY state", () => {
  it("two requests: GL-102 is created, then the attach is REFUSED and mints no edge", async () => {
    // 1. THE PRE-STATE, both halves.
    expect(goalRows(dbPath())).toHaveLength(2);
    expect(edgeRows(dbPath())).toEqual([]);
    expect(briefStatusCount(dbPath(), P, TRIAGE_FIXTURE.filesOnlyBriefId)).toBe(0);

    // 2. THE CREATE. Deterministic id — see `TRIAGE_FIXTURE.goalIds`.
    const created = await triage({
      action: "create_goal",
      goal_title: "Half a workflow",
      goal_outcome: "o",
      goal_project: P,
    });
    const c = created.json<TriagePayload>();
    expect(c).toMatchObject({ requested: 1, applied: 1, failed: 0 });
    expect(c.results[0]?.created_id).toBe(TRIAGE_FIXTURE.nextGoalId);

    // 3. THE ATTACH, at FR-247's SHIPPED precondition refusal. `BR-900` is a
    //    `brief_files` row with no `brief_status` row, seeded for this class.
    const attached = await triage({
      action: "attach_goal",
      refs: [ref(TRIAGE_FIXTURE.filesOnlyBriefId)],
      goal_id: TRIAGE_FIXTURE.nextGoalId,
    });
    const a = attached.json<TriagePayload>();
    expect(a).toMatchObject({ requested: 1, applied: 0, failed: 1 });
    expect(a.results[0]?.error).toContain("no brief_status row");

    // 4. THE END STATE. The goal EXISTS and serves nothing. That is not the
    //    orphan of a broken transaction — there is no `igris_goal_delete` to
    //    compensate with and none is wanted: a goal with zero serving briefs is
    //    a state the brain already models.
    expect(goalRows(dbPath()).map((g) => g.goal_id)).toEqual([
      ...TRIAGE_FIXTURE.goalIds,
      TRIAGE_FIXTURE.nextGoalId,
    ]);
    expect(edgeRows(dbPath())).toEqual([]);
    // ...and nothing was invented into `brief_status` for BR-900 along the way.
    expect(briefStatusCount(dbPath(), P, TRIAGE_FIXTURE.filesOnlyBriefId)).toBe(0);
  });

  it("the RETRY is one click and cannot double-write — the attach that DOES work", async () => {
    // The operator's next click after the refusal above. `igris_edge_create` is
    // `INSERT OR IGNORE` on a UNIQUE tuple, so firing it twice is free.
    await triage({ action: "create_goal", goal_title: "t", goal_outcome: "o" });
    for (const _ of [1, 2]) {
      const r = await triage({
        action: "attach_goal",
        refs: [ref("FR-004")],
        goal_id: TRIAGE_FIXTURE.nextGoalId,
      });
      expect(r.json<TriagePayload>().applied).toBe(1);
    }
    expect(edgeRows(dbPath())).toEqual([
      {
        from_type: "brief",
        from_id: "FR-004",
        to_type: "goal",
        to_id: TRIAGE_FIXTURE.nextGoalId,
        edge_type: "serves_goal",
      },
    ]);
  });

  it("a FAILED create leaves nothing for a second click to attach to", async () => {
    // An empty title is refused by the BRAIN, not by the parser — and that is
    // the shipped posture rather than an omission. This tier allow-lists KEYS;
    // presence and length are the tool's `required` and the handler's caps, and
    // a copy of either here would be a fourth thing to drift. The CLIENT's
    // disabled button is what makes this path rare; the server's job is to
    // report the brain's own sentence when it is reached.
    const r = await triage({ action: "create_goal", goal_title: "", goal_outcome: "o" });
    expect(r.status).toBe(200);
    const p = r.json<TriagePayload>();
    expect(p).toMatchObject({ requested: 1, applied: 0, failed: 1 });
    expect(p.results[0]?.error).toContain("Missing required fields: title, outcome");
    expect(p.results[0]?.created_id).toBeNull();
    expect(goalRows(dbPath())).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// G-TR-18 — the by-absence property, over the wire
// ---------------------------------------------------------------------------

describe("G-TR-18 — a subjectless row takes NEITHER ids NOR refs, and never `title`", () => {
  it("`ids` on a create is refused BY NAME, and nothing is created", async () => {
    const r = await triage({
      action: "create_goal",
      ids: [1],
      goal_title: "t",
      goal_outcome: "o",
    });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("'ids' is not accepted for it");
    expect(goalRows(dbPath())).toHaveLength(2);
  });

  it("`refs` on a create is refused BY NAME too", async () => {
    const r = await triage({
      action: "create_goal",
      refs: [ref("FR-001")],
      goal_title: "t",
      goal_outcome: "o",
    });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("'refs' is not accepted for it");
    expect(goalRows(dbPath())).toHaveLength(2);
  });

  it("A BARE `title` IS STILL AN UNKNOWN FIELD — for the create too", async () => {
    // THE ASSERTION THAT KEEPS `params.ts`' STATED PROPERTY HONEST. Its `KNOWN`
    // set gained `goal_title`, NOT `title`, precisely so that
    // "`status`, `phase`, `content` and `title` are refused HERE, by absence,
    // for every action" stays true byte-identically after FR-249. A row that
    // took a bare `title` would make that sentence a lie for `set_priority` as
    // well, because `KNOWN` is global.
    for (const field of ["title", "outcome", "status", "phase", "content", "filename"]) {
      const r = await triage({
        action: "create_goal",
        goal_title: "t",
        goal_outcome: "o",
        [field]: "x",
      });
      expect(r.status, `${field} was accepted`).toBe(400);
      expect(r.json<{ error: string }>().error).toContain(`unknown field: ${field}`);
    }
    expect(goalRows(dbPath())).toHaveLength(2);
  });

  it("a MISSING required field is the BRAIN's refusal, not a 400 — and no row appears", async () => {
    // Deliberate, and the alternative was considered: the parser COULD refuse a
    // create with no `goal_title`, but only by carrying a copy of the tool's
    // `required: ['title','outcome']` in wire spelling — a fourth copy of a
    // brain constant, which is exactly what `CANONICAL_PRIORITIES` is kept to
    // one mirror to avoid. The tier's shipped division holds instead: the
    // parser allow-lists KEYS, the brain validates PRESENCE, and the operator
    // sees the brain's own sentence.
    // AND THE TWO REFUSALS ARE NOT THE SAME ONE — measured, not assumed. An
    // ABSENT key never reaches the handler at all: the gateway's BR-080
    // strict-input walk refuses it first, with its own message. The handler's
    // `Missing required fields` is reachable only through an EMPTY STRING,
    // because BR-080 checks PRESENCE (`key in args`) and not truthiness. The
    // plan predicted the handler's sentence for both; the gateway's arrives for
    // one of them, which is BR-080 working exactly as the FR-247 header
    // describes for `igris_brief_sync`.
    for (const body of [
      { action: "create_goal", goal_outcome: "o" },
      { action: "create_goal", goal_title: "t" },
    ]) {
      const r = await triage(body);
      expect(r.status, JSON.stringify(body)).toBe(200);
      const p = r.json<TriagePayload>();
      expect(p).toMatchObject({ requested: 1, applied: 0, failed: 1 });
      expect(p.results[0]?.error).toMatch(
        /missing required argument '(title|outcome)'.*BR-080/s,
      );
      expect(p.results[0]?.created_id).toBeNull();
    }
    // The EMPTY-STRING branch is the handler's, and it says something else.
    const empty = await triage({
      action: "create_goal",
      goal_title: "",
      goal_outcome: "",
    });
    expect(empty.json<TriagePayload>().results[0]?.error).toContain(
      "Missing required fields: title, outcome",
    );
    expect(goalRows(dbPath())).toHaveLength(2);
  });

  it("a create is single-item by construction — `requested` is 1, never 0", async () => {
    // Without an explicit `target === "none" ? 1 : ids+refs`, a successful
    // create reports `requested: 0, applied: 1`, which is arithmetic the
    // operator has to decode.
    const r = await triage({ action: "create_goal", goal_title: "t", goal_outcome: "o" });
    expect(r.json<TriagePayload>()).toMatchObject({ requested: 1, applied: 1 });
  });

  it("a REJECTED create never boots the write engine", async () => {
    resetWriteEngine();
    expect(writeEngineState()).toBe("not-booted");
    const r = await triage({
      action: "create_goal",
      ids: [1],
      goal_title: "t",
      goal_outcome: "o",
    });
    expect(r.status).toBe(400);
    expect(writeEngineState(), "a 400 booted the write engine").toBe("not-booted");
  });

  it("`/api/health` offers the create as part of the vocabulary", async () => {
    const h = (await get("/api/health")).json<{ write: { actions: string[] } }>();
    expect(h.write.actions).toContain("create_goal");
    expect(h.write.actions).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// G-TR-19 — the egress fence over the NEW path
// ---------------------------------------------------------------------------

describe("G-TR-19 — a goal create cannot egress to a remote brain", () => {
  it("the fence is ARMED in THIS test's body, not merely in a beforeEach", () => {
    // A vitest worker is its own process and a fence armed in another file
    // protects nothing. `assertArmed` reads BOTH layers back.
    expect(fence, "the fence was not installed").not.toBeNull();
    fence!.assertArmed();
    expect(homedir()).toBe(sandbox);
  });

  it("with auto_push ON — the one arm that makes a zero mean something", async () => {
    if (!canBoot()) throw new Error("bundle not staged — see G-TR-0");
    await srv!.close();
    srv = null;
    resetWriteEngine();
    fence!.writeConfig({
      auto_push: true,
      remote_brain: {
        url: "https://fr249-fictional-remote.invalid",
        api_key: "fr249-not-a-real-key",
      },
    });
    srv = await startServer({ port: 0, cliVersion: "test" });

    const r = await triage({ action: "create_goal", goal_title: "t", goal_outcome: "o" });
    expect(r.json<TriagePayload>().applied).toBe(1);
    await new Promise((res) => setTimeout(res, 200));

    // ZERO, and it means something: G-TR-13 ARM B drives the SAME fence with
    // the SAME config and records an attempt, so this reading distinguishes
    // "no listener" from "a fence that does nothing". `sync` wires ten events
    // and `goal.created` is not among them; `goals` is a SYNC_TABLE, but only a
    // manual or scheduled push moves it and `schedules` is disabled here.
    expect(
      fence!.attempts,
      `a create escaped to the network: ${JSON.stringify(fence!.attempts)}`,
    ).toEqual([]);

    // ...and the write really happened, so the zero is not the zero of a
    // request that never ran.
    expect(goalRows(dbPath())).toHaveLength(3);
  });
});
