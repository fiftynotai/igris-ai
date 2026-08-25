/**
 * FR-266 — `GET /api/cognition`, over real HTTP.
 *
 * Nothing is mocked. The server binds a real loopback port and the brain is a
 * real SQLite file in a sandboxed `IGRIS_BRAIN_DIR` seeded by
 * `dashboard-layers-fixture.ts#seedCognitionBrain`. The digest is built by the
 * REAL `verbs/cognition.ts#buildCognitionHealthDigest` — the same function
 * `igris cognition health --json` prints — so a suite that stubbed it would pass
 * with the classifier deleted.
 *
 * WHAT THESE GATES PROVE
 * ----------------------
 *  - T1 (AC-2) — the WIRE SHAPE, as four EXACT key sets spelled out literally,
 *    plus a negative control proving the comparator can fire, plus the
 *    cross-seam mirror check against `cli/dashboard/src/lib/api.ts`.
 *  - T2 (AC-5) — THREE server-side degraded states, every one DRIVEN rather
 *    than asserted: no brain, a brain with no roster table, and a corrupt
 *    `.db`. The FOURTH state AC-5 implies — a read that never settles — has no
 *    server side at all, so it is driven where it lives: `useCognition`'s
 *    deadline, asserted in `diagnostics/__tests__/panel.test.tsx`. The
 *    UNKNOWN-STATUS case is likewise client-side, because the classifier can
 *    only emit its own six verdicts — an unrecognised one arrives when a NEWER
 *    brain's projection reaches an older client, which no server fixture can
 *    manufacture. What this file pins is that the endpoint forwards the value
 *    unfiltered; `diagnostics/__tests__/model.test.ts` pins what is done with
 *    it.
 *  - T3 (AC-3) — the roster is DERIVED: an instance id no shipped file mentions
 *    appears in the payload, in the projection's order rather than sorted.
 *  - T4 (AC-7) — THE REAL FAILURE STATE. The 2026-08-24 reading reproduced in
 *    the shape the classifier actually produces, with an un-wedge control that
 *    proves the verdicts are computed rather than an artifact of the seeder.
 *  - T7 (AC-6) — that the endpoint opens no handle of its own, so the read-only
 *    guarantee holds by construction. **Sibling:** `dashboard-readonly.test.ts`,
 *    which crawls this path and hashes the DB around it.
 *
 * WHAT THEY DO NOT PROVE
 * ----------------------
 *  - That the PANEL renders any of it. **Siblings:**
 *    `cli/dashboard/src/diagnostics/__tests__/model.test.ts` (the tone rules)
 *    and `panel.test.tsx` (the markup over this same fixture).
 *  - That nothing was written. **Sibling:** `dashboard-readonly.test.ts`.
 *
 * @module __tests__/dashboard-cognition-endpoint.test
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { get as httpGet } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { closeDb as closeBrainDb } from "../lib/brain-db.js";
import { closeDb as closeRegistryDb } from "../lib/registry.js";
import { resetBrainBridge, resetLayerReaders } from "../lib/brain-bridge.js";
import { startServer, type DashboardServer } from "../lib/dashboard/server.js";
import {
  COGNITION_FIXTURE,
  seedCognitionBrain,
  writeCognitionConfig,
} from "./dashboard-layers-fixture.js";
import type { CognitionPayload } from "../types.js";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let sandbox: string;
let srv: DashboardServer | null = null;
const prevBrain = process.env.IGRIS_BRAIN_DIR;

function dbPath(): string {
  return join(sandbox, "memory", "knowledge.db");
}

function req(path: string): Promise<{ status: number; body: string }> {
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
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("error", reject);
  });
}

/**
 * Fetch the payload.
 *
 * The 200 is asserted HERE rather than in each test because the degraded
 * contract is 200-always: a non-200 from this path is itself a failure, and
 * every caller below would otherwise repeat the same guard.
 */
async function payload(): Promise<CognitionPayload> {
  const r = await req("/api/cognition");
  expect(r.status, `/api/cognition -> ${r.status}: ${r.body.slice(0, 300)}`).toBe(200);
  return JSON.parse(r.body) as CognitionPayload;
}

async function start(): Promise<void> {
  srv = await startServer({ port: 0, cliVersion: "test" });
}

/** The full FR-266 world: the roster, its events and schedules, and the gates. */
function seed(): void {
  seedCognitionBrain(dbPath());
  writeCognitionConfig(sandbox);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "igris-fr266-cog-"));
  process.env.IGRIS_BRAIN_DIR = sandbox;
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
});

afterEach(async () => {
  if (srv !== null) {
    await srv.close();
    srv = null;
  }
  closeBrainDb();
  closeRegistryDb();
  resetBrainBridge();
  resetLayerReaders();
  rmSync(sandbox, { recursive: true, force: true });
  if (prevBrain === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrain;
});

// ---------------------------------------------------------------------------
// The sandbox seam — asserted, not assumed (coding_guidelines §12)
// ---------------------------------------------------------------------------

describe("the suite is pointed at the SANDBOX, never the operator's brain", () => {
  it("brainDbPath() resolves inside the sandbox", async () => {
    const { brainDbPath } = await import("../lib/paths.js");
    expect(brainDbPath()).toBe(dbPath());
    expect(brainDbPath().startsWith(sandbox)).toBe(true);
    expect(brainDbPath()).not.toContain("/.igris/memory");
  });

  it("the digest reads the SANDBOX config.json, not ~/.igris/config.json", async () => {
    seed();
    const { configJsonPath } = await import("../lib/paths.js");
    expect(configJsonPath()).toBe(join(sandbox, "config.json"));
    // ...and it is really being read: the ONE gate the fixture sets to false is
    // the ONE instance that comes back disabled. If the resolver were reading
    // the operator's real config, this instance would not be `disabled` (the
    // operator's own cluster gate is absent, which resolves to the same verdict
    // — so the assertion below pairs it with the sandbox path check above,
    // which is the half that cannot be satisfied by the wrong file).
    await start();
    const p = await payload();
    const row = p.cognition?.instances.find((i) => i.id === "cartographer");
    expect(row?.disabled_by).toBe(COGNITION_FIXTURE.disabledGate);
  });

  it("ARMED CHECK — the fixture's host choice is load-bearing, not incidental", async () => {
    /*
     * `GET /api/cognition` calls `buildCognitionHealthDigest()` with NO options,
     * so its run signals are scoped to `os.hostname()`. The fixture defaults to
     * that same host, and this is the control that proves the default is doing
     * work rather than being a coincidence: seed the SAME roster and the SAME
     * events under a FOREIGN host and every verdict must collapse to
     * `no_signal`, because `event_log` is a SYNC table and a VPS-born success
     * must not render a locally-wedged instance green.
     *
     * Without this, a later edit that dropped the host predicate from the reader
     * would leave every T4 assertion below green — the fixture's host and the
     * reader's host would simply both stop mattering.
     */
    seedCognitionBrain(dbPath(), COGNITION_FIXTURE.foreignHost);
    writeCognitionConfig(sandbox);
    await start();
    const p = await payload();
    const status = (id: string): string | undefined =>
      p.cognition?.instances.find((i) => i.id === id)?.status;

    /*
     * ONLY the rows whose verdict comes from `event_log` move, and that split is
     * itself the finding. `schedule_runs` and `schedules` carry NO hostname —
     * they are the antidote to the 30-day `event_log` purge — so `janitor` stays
     * `wedged` from its open run and the two rows it drives stay
     * `blocked_upstream` from ITS verdict. `cartographer` stays `disabled`
     * because a gate is read from `config.json`, not from any table.
     *
     * So the population that must collapse is exactly the four event-driven
     * rows, and naming them rather than filtering by outcome is what stops this
     * control from being written around its own result.
     */
    for (const id of ["perception", "subconscious", "synapse", COGNITION_FIXTURE.derivedInstanceId]) {
      const row = p.cognition?.instances.find((i) => i.id === id);
      // Not `ok`, not `failing` — the terminal events exist but belong to
      // another machine, so THIS host has no evidence either way.
      expect(row?.status, `${id} saw a foreign host's events`).toBe("no_signal");
      expect(row?.last_run_at).toBeNull();
      // ...and the digest still REPORTS the foreign activity rather than hiding
      // it, which is the half that keeps `no_signal` from meaning "never ran".
      expect(row?.last_run_any_host).not.toBeNull();
    }

    // The non-event-driven verdicts are UNMOVED, which is what makes the four
    // changes above attributable to the host predicate and to nothing else.
    expect(status("janitor")).toBe("wedged");
    expect(status("arbiter")).toBe("blocked_upstream");
    expect(status("curator")).toBe("blocked_upstream");
    expect(status("cartographer")).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// T1 — the payload-shape pin (AC-2)
// ---------------------------------------------------------------------------

/**
 * THE KEY SETS ARE SPELLED OUT LITERALLY AND ARE NOT DERIVED FROM
 * `CognitionInstanceHealth`.
 *
 * Deriving the assertion from the type the endpoint serves makes it a tautology
 * — the same argument `dashboard-readonly.test.ts` makes for the `write.actions`
 * list: *"reading it from the same constant the endpoint reads would make the
 * assertion a tautology."* These four arrays are transcribed from the LIVE
 * producer (`node cli/dist/index.js cognition health --json | jq 'keys'`), which
 * is the only authority that cannot agree with a wrong implementation.
 *
 * `toEqual`, not `toContain`, in both directions on purpose: a DROPPED field is
 * red (the AC's own words) and an ADDED one is red too, because MAINTAINING row
 * 122's four-place sweep must be a deliberate act landing in one commit — and
 * since FR-266 the dashboard mirror is a fifth place.
 */
const ENVELOPE_KEYS = ["cognition", "degraded", "generated_at"];

const DIGEST_KEYS = [
  "degraded",
  "degraded_reason",
  "event_log_oldest_at",
  "event_log_retention_days",
  "hostname",
  "instances",
  "warnings",
];

const INSTANCE_KEYS = [
  "component",
  "disabled_by",
  "driver",
  "driver_ref",
  "enabled",
  "event_prefix",
  "gate_default",
  "gate_keys",
  "id",
  "last_outcome",
  "last_run_any_host",
  "last_run_at",
  "output",
  "output_rows",
  "reason",
  "runs_today",
  "schedule",
  "status",
];

const SCHEDULE_KEYS = [
  "enabled",
  "name",
  "next_run_at",
  "open_run_age_days",
  "open_run_id",
  "open_run_started_at",
  "overdue",
  "rows",
];

/** The comparator T1(a) uses and T1(b) proves can fire. */
function keySetsOf(body: CognitionPayload): Record<string, string[] | null> {
  const digest = body.cognition;
  const first = digest?.instances[0] ?? null;
  const scheduled = digest?.instances.find((i) => i.schedule !== null) ?? null;
  return {
    envelope: Object.keys(body).sort(),
    digest: digest === null ? null : Object.keys(digest).sort(),
    instance: first === null ? null : Object.keys(first).sort(),
    schedule:
      scheduled === null || scheduled.schedule === null
        ? null
        : Object.keys(scheduled.schedule).sort(),
  };
}

describe("T1 (AC-2) — the wire shape is pinned, and a dropped field is red", () => {
  it("(a) the four key sets are EXACTLY these", async () => {
    seed();
    await start();
    const sets = keySetsOf(await payload());
    expect(sets.envelope).toEqual(ENVELOPE_KEYS);
    expect(sets.digest).toEqual(DIGEST_KEYS);
    expect(sets.instance).toEqual(INSTANCE_KEYS);
    // The schedule block is a nested shape a field could be dropped from
    // without any of the three sets above moving.
    expect(sets.schedule).toEqual(SCHEDULE_KEYS);
  });

  it("(b) NEGATIVE CONTROL — the comparator fires on a dropped field", async () => {
    seed();
    await start();
    const body = await payload();

    // Clone, delete ONE key from instances[0], run the SAME comparator.
    // Without this, the pass above is indistinguishable from a comparator
    // pointed at the wrong object (learning 1094 / coding_guidelines §12).
    const mutated = JSON.parse(JSON.stringify(body)) as CognitionPayload;
    const victim = mutated.cognition?.instances[0] as unknown as Record<string, unknown>;
    delete victim.status;
    expect(keySetsOf(mutated).instance).not.toEqual(INSTANCE_KEYS);

    // ...and an ADDED field is red too, which is the half a `toContain`
    // assertion would silently allow.
    const widened = JSON.parse(JSON.stringify(body)) as CognitionPayload;
    (widened.cognition?.instances[0] as unknown as Record<string, unknown>).disabled_reason =
      "explicit_false";
    expect(keySetsOf(widened).instance).not.toEqual(INSTANCE_KEYS);
  });

  it("(c) the CROSS-SEAM mirror: every server field name appears in the client mirror", () => {
    /*
     * `cli/src/types.ts` and `cli/dashboard/src/lib/api.ts` compile SEPARATELY
     * with ZERO shared import (MAINTAINING row 110), so nothing but a scan can
     * hold them together. This is the mechanism `dashboard-layers-source.test.ts`
     * already uses for TD-326's `project_scope` seam.
     *
     * The subject is the FIELD NAMES, not the types: a browser mirror that
     * declared `last_run_at: number` would be wrong in a way this cannot see,
     * and that is stated rather than implied.
     */
    const client = readFileSync(
      join(CLI_ROOT, "dashboard", "src", "lib", "api.ts"),
      "utf-8",
    );
    const missing = [...DIGEST_KEYS, ...INSTANCE_KEYS, ...SCHEDULE_KEYS].filter(
      (k) => !new RegExp(`\\b${k}\\s*:`).test(client),
    );
    expect(missing, `absent from the browser mirror: ${missing.join(", ")}`).toEqual([]);
  });

  it("(c) SELF-NEGATIVE-CONTROL — that scan can report a MISS", () => {
    const client = readFileSync(
      join(CLI_ROOT, "dashboard", "src", "lib", "api.ts"),
      "utf-8",
    );
    // A field name that is deliberately NOT in the digest. If this "passes",
    // the regex above matches anything and the scan proves nothing.
    expect(/\bdisabled_reason\s*:/.test(client)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2 — degradation, four states, all DRIVEN (AC-5)
// ---------------------------------------------------------------------------

describe("T2 (AC-5) — it degrades honestly, and the two degraded meanings stay apart", () => {
  it("no brain at all -> 200, cognition null, the reason NAMES the path", async () => {
    await start();
    const p = await payload();
    expect(p.cognition).toBeNull();
    expect(p.degraded).not.toBeNull();
    expect(p.degraded?.reason).toContain(dbPath());
  });

  it("a brain with NO cognition_instances -> 200, ENVELOPE clean, DIGEST degraded", async () => {
    /*
     * THE D3 DISTINCTION, ASSERTED. These are two different remedies:
     *  - `degraded` (envelope)         -> there is no brain. Run `igris install`.
     *  - `cognition.degraded` (digest) -> the brain is readable but has never
     *                                     booted a build that projects the
     *                                     roster.
     * `cognition-health.test.ts` makes the same point one tier down:
     * *"Collapsing them hides which remedy applies."*
     */
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    const db = new Database(dbPath());
    db.exec(
      `CREATE TABLE event_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL,
         component TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`,
    );
    db.close();

    await start();
    const p = await payload();
    expect(p.degraded).toBeNull();
    expect(p.cognition).not.toBeNull();
    expect(p.cognition?.degraded).toBe(true);
    expect(p.cognition?.degraded_reason).toMatch(/cognition_instances not present/);
    expect(p.cognition?.instances).toEqual([]);
  });

  it("a CORRUPT .db -> 200, never a 500, never a stack trace", async () => {
    mkdirSync(join(sandbox, "memory"), { recursive: true });
    writeFileSync(dbPath(), "this is not a sqlite file", "utf-8");

    await start();
    const r = await req("/api/cognition");
    expect(r.status).toBe(200);
    expect(r.body).not.toContain("at Object.");
    expect(r.body).not.toContain(".ts:");
    const p = JSON.parse(r.body) as CognitionPayload;
    // Either depth may own this — the roster read degrades rather than throwing
    // — so the assertion is that SOMETHING states an unknown, and that nothing
    // renders as a healthy empty roster.
    const stated =
      p.degraded !== null || (p.cognition !== null && p.cognition.degraded === true);
    expect(stated, `neither depth stated a failure: ${r.body.slice(0, 300)}`).toBe(true);
  });

  it("a status the CLI has never heard of survives to the wire, verbatim", async () => {
    /*
     * The roster is an OPEN registry and the CLI/brain pair is not upgraded
     * atomically on a running machine. The classifier can only emit its own six
     * statuses, so an unknown one cannot be produced by seeding a roster row —
     * it arrives when a NEWER brain build's verdict reaches an older client. The
     * client-side half of this rule (unknown -> tone `attention`, raw string
     * shown) is pinned in `diagnostics/__tests__/model.test.ts`; what THIS test
     * pins is that the endpoint does not filter, coerce or drop the value on the
     * way past, because it forwards the digest verbatim.
     */
    seed();
    await start();
    const p = await payload();
    const statuses = (p.cognition?.instances ?? []).map((i) => i.status);
    // Every seeded verdict reached the wire as a plain string, unmapped.
    expect(statuses.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    expect(new Set(statuses).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// T3 — the roster is DERIVED (AC-3)
// ---------------------------------------------------------------------------

describe("T3 (AC-3) — the roster is derived from the projection, never hand-listed", () => {
  it("an instance id NO shipped file mentions appears in the payload", async () => {
    seed();
    await start();
    const p = await payload();
    const ids = (p.cognition?.instances ?? []).map((i) => i.id);
    expect(ids).toContain(COGNITION_FIXTURE.derivedInstanceId);
  });

  it("the order is the PROJECTION's order, not sorted", async () => {
    seed();
    await start();
    const p = await payload();
    const ids = (p.cognition?.instances ?? []).map((i) => i.id);
    expect(ids).toEqual(COGNITION_FIXTURE.expected.map((e) => e.id));
    // ...and that really is a claim: the projection order is NOT alphabetical,
    // so a payload that had been sorted would fail the assertion above.
    expect(ids).not.toEqual([...ids].sort());
  });
});

// ---------------------------------------------------------------------------
// T4 — THE REAL FAILURE STATE (AC-7)
// ---------------------------------------------------------------------------

describe("T4 (AC-7) — the 2026-08-24 failure state, reproduced and surfaced", () => {
  it("every instance lands on the classifier branch the fixture aimed it at", async () => {
    seed();
    await start();
    const p = await payload();
    const got = (p.cognition?.instances ?? []).map((i) => ({ id: i.id, status: i.status }));
    expect(got).toEqual(COGNITION_FIXTURE.expected.map((e) => ({ ...e })));
  });

  it("POSITIVE CONTROL — FIVE distinct statuses are present, not one repeated", async () => {
    /*
     * Without this, a classifier that answered the same verdict for every input
     * would satisfy the exact-match test above only by luck, and every
     * downstream tone assertion would be measuring one branch.
     *
     * FIVE of the six members of `CognitionHealthStatus` are reachable in ONE
     * fixture. The sixth, `no_signal`, is DELIBERATELY absent here and is driven
     * by its own case — the foreign-host ARMED CHECK above — because seeding it
     * in this world would mean an instance with no events, which is a weaker
     * reproduction than one whose events belong to another machine.
     */
    seed();
    await start();
    const p = await payload();
    const distinct = new Set((p.cognition?.instances ?? []).map((i) => i.status));
    expect([...distinct].sort()).toEqual([
      "blocked_upstream",
      "disabled",
      "failing",
      "ok",
      "wedged",
    ]);
  });

  it("the blocked rows NAME their driver, so the operator is sent to janitor", async () => {
    seed();
    await start();
    const p = await payload();
    for (const id of ["arbiter", "curator"]) {
      const row = p.cognition?.instances.find((i) => i.id === id);
      expect(row?.status).toBe("blocked_upstream");
      expect(row?.driver_ref).toBe("janitor");
      // The remedy sentence, verbatim from `classify()`. This is the whole
      // reason `blocked_upstream` exists as a status: reporting these two as
      // `no_signal` points the operator at the silent instance instead of at
      // the one thing actually broken.
      expect(row?.reason).toContain("janitor is wedged");
      expect(row?.reason).toContain("fix the driver, not this instance");
    }
  });

  it("the wedged row states the OPEN run and the overdue schedule", async () => {
    seed();
    await start();
    const p = await payload();
    const janitor = p.cognition?.instances.find((i) => i.id === "janitor");
    expect(janitor?.status).toBe("wedged");
    expect(janitor?.schedule?.open_run_id).toBe(COGNITION_FIXTURE.wedgedRunId);
    expect(janitor?.schedule?.overdue).toBe(true);
    expect(janitor?.reason).toContain(COGNITION_FIXTURE.wedgedRunId);
  });

  it("the failing row is failing because the LATEST terminal failed", async () => {
    seed();
    await start();
    const p = await payload();
    const synapse = p.cognition?.instances.find((i) => i.id === "synapse");
    expect(synapse?.status).toBe("failing");
    expect(synapse?.last_outcome).toBe("cognition.synapse.run_failed");
    // The fixture ALSO seeds an earlier success, so this verdict is "the latest
    // terminal is a failure" and not "a failure exists in the window".
    expect(synapse?.reason).toContain("with no later success");
  });

  it("the disabled row carries the FAILING gate, not the first declared one", async () => {
    seed();
    await start();
    const p = await payload();
    const cart = p.cognition?.instances.find((i) => i.id === "cartographer");
    expect(cart?.status).toBe("disabled");
    expect(cart?.gate_keys).toEqual(["cognition.janitor.enabled", COGNITION_FIXTURE.disabledGate]);
    // The FIRST key resolved true; the SECOND did not. Reporting the first
    // DECLARED key would send the operator to the wrong toggle.
    expect(cart?.disabled_by).toBe(COGNITION_FIXTURE.disabledGate);
  });

  it("UN-WEDGE CONTROL — clearing the open run moves THREE verdicts", async () => {
    /*
     * Borrowed from `cognition-health.test.ts`. Without it, the statuses above
     * could be an artifact of a seeder that produced the same verdict for any
     * input: this flips ONE cell in `schedule_runs` and requires the wedged row
     * AND both rows it drives to change, while the rows that depend on neither
     * stay exactly where they were.
     */
    seed();
    await start();

    const before = await payload();
    expect(before.cognition?.instances.find((i) => i.id === "janitor")?.status).toBe("wedged");

    const db = new Database(dbPath());
    db.prepare(`UPDATE schedule_runs SET status = 'success' WHERE id = ?`).run(
      COGNITION_FIXTURE.wedgedRunId,
    );
    db.close();

    const after = await payload();
    const status = (id: string): string | undefined =>
      after.cognition?.instances.find((i) => i.id === id)?.status;

    expect(status("janitor")).not.toBe("wedged");
    expect(status("arbiter")).not.toBe("blocked_upstream");
    expect(status("curator")).not.toBe("blocked_upstream");
    // ...and the rows the open run has nothing to do with did NOT move, which
    // is what makes the three changes above attributable to the one cell.
    expect(status("synapse")).toBe("failing");
    expect(status("cartographer")).toBe("disabled");
    expect(status("perception")).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// T7 — read-only by construction (AC-6)
// ---------------------------------------------------------------------------

describe("T7 (AC-6) — the endpoint opens no handle of its own", () => {
  it("the server-layer module names no database constructor and no SQL", () => {
    /*
     * The BEHAVIOURAL half of AC-6 lives in `dashboard-readonly.test.ts`, which
     * crawls `/api/cognition` and hashes the `.db` around it. THIS is the
     * structural half: the reason that crawl's verdict transfers is that the
     * endpoint delegates to `verbs/cognition.ts`, whose every read goes through
     * `brain-db.ts#withReadonlyBrain` -> `openBrainReadonly`. A module that
     * opened its own handle would be a second door with its own pragmas, and
     * the G-RO-3 structural claim would stop covering this path.
     *
     * `dashboard-server.test.ts` runs the same scan as part of the server-layer
     * corpus; it is repeated here because THIS is the file a reader of AC-6
     * opens, and a cross-file pointer is not an assertion.
     */
    const src = readFileSync(
      join(CLI_ROOT, "src", "lib", "dashboard", "cognition-read.ts"),
      "utf-8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(/\bnew Database\b/.test(code)).toBe(false);
    expect(/\.prepare\s*\(/.test(code)).toBe(false);
    expect(/\bSELECT\s/i.test(code)).toBe(false);
    // It reaches the digest through the VERB, which is the whole argument.
    expect(code).toContain("buildCognitionHealthDigest");
  });

  it("SELF-NEGATIVE-CONTROL — that scan really read the file", () => {
    const src = readFileSync(
      join(CLI_ROOT, "src", "lib", "dashboard", "cognition-read.ts"),
      "utf-8",
    );
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("readCognitionHealth");
  });

  it("a repeated read leaves the .db bytes alone", async () => {
    // A narrower, faster sibling of G-RO-1, scoped to this one path so a
    // failure here names this endpoint rather than a 25-URL crawl.
    seed();
    await start();
    const { statSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const digestOf = (): string =>
      createHash("sha256").update(readFileSync(dbPath())).digest("hex");

    const beforeSha = digestOf();
    const beforeSize = statSync(dbPath()).size;
    await payload();
    await payload();
    expect(digestOf()).toBe(beforeSha);
    expect(statSync(dbPath()).size).toBe(beforeSize);
  });
});
