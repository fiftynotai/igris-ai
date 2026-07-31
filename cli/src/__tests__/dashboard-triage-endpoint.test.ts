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
import { request as httpRequest } from "node:http";
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
  dispatchTriage,
  resetWriteEngine,
  writeEngineState,
  WRITE_ENGINE_COMPONENTS,
} from "../lib/brain-write-bridge.js";
import { brainDbPath } from "../lib/paths.js";
import { MAX_BULK } from "../lib/dashboard/params.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import { bundleStaged } from "./hermetic-embeddings.js";
import {
  TRIAGE_FIXTURE,
  countPending,
  learningState,
  pendingSuggestionIds,
  seedTriageBrain,
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

interface TriagePayload {
  action: string;
  requested: number;
  applied: number;
  failed: number;
  results: { id: number; ok: boolean; error: string | null }[];
  params: string[];
  degraded: { reason: string } | null;
}

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr241-tr-"));
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

    const before = countPending(dbPath());
    const r = await triage({ action: "dismiss", ids: [1], reason: "poison probe" });
    expect(r.status).toBe(200);
    expect(r.json<TriagePayload>().applied).toBe(1);

    // The write landed in the SANDBOX...
    expect(countPending(dbPath())).toBe(before - 1);
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
    expect(p.results).toEqual([{ id: 1, ok: true, error: null }]);

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
    expect(countPending(dbPath())).toBe(TRIAGE_FIXTURE.pendingSuggestions);
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
    expect(countPending(dbPath())).toBe(5);
    const states = suggestionStates(dbPath());
    const stillPending = states.filter((s) => s.status === "pending").map((s) => s.id);
    expect(stillPending, "the WRONG five survived").toEqual(survivors);
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
    const before = countPending(dbPath());
    const r = await triage({ action: "dismiss", ids: [], reason: "nothing" });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("must not be empty");
    expect(countPending(dbPath())).toBe(before);
  });

  it("SELF-NEGATIVE-CONTROL — the count really can move, and the reader really reads", async () => {
    // Without this, "5 survived" is also what you observe from a `countPending`
    // that returns a constant.
    expect(countPending(dbPath())).toBe(17);
    await triage({ action: "dismiss", ids: [1], reason: "one" });
    expect(countPending(dbPath())).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// G-TR-3 — partial failure (D6) and the clamp
// ---------------------------------------------------------------------------

describe("G-TR-3 — partial failure is REPORTED per id, never rolled back", () => {
  it("3 valid + 1 missing + 1 already-acted -> applied 3, failed 2, the 3 LANDED", async () => {
    const missing = 9999;
    const ids = [3, 4, 5, missing, TRIAGE_FIXTURE.actedSuggestionId];
    expect(countPending(dbPath())).toBe(17);

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
    expect(countPending(dbPath())).toBe(14);
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
    // Only the 17 real pending rows could succeed; the rest are `not found`.
    expect(p.applied).toBe(17);
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
    const before = countPending(dbPath());
    const r = await triage({ action: "apply", ids: [1, 2] });
    expect(r.status).toBe(400);
    expect(r.json<{ error: string }>().error).toContain("single-item only");
    expect(countPending(dbPath())).toBe(before);
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
    const before = countPending(dbPath());
    const r = await dispatchTriage("__not_in_the_map__", [1]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown triage action");
    expect(countPending(dbPath())).toBe(before);
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
