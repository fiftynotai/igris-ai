/**
 * FR-241 — **the event_log parity differ. G-EP-1 / G-EP-2 / G-EP-3.**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE HEADLINE AC, AND WHY IT IS NEARLY VACUOUS IF YOU DO NOT SAY SO
 * ═════════════════════════════════════════════════════════════════════════════
 * The AC is: *a mutation made from the dashboard is indistinguishable, in
 * `event_log`, from the same mutation made through an MCP call.* Producing BOTH
 * and diffing them is the only way to assert that, and the diff is only worth
 * anything if you first state what it can and cannot see.
 *
 * FOUR OF THE FIVE ACTIONS WRITE NOTHING TO `event_log` (Phase-0 step 5/5b,
 * measured, not inferred). `dismiss`, `acted` and `apply_action` have no
 * `bus.emit` and no direct write; `reject` on the FIRST-TIME branch writes
 * nothing either. So for most of the surface the honest parity assertion is
 * `[] === []` — which is exactly the vacuous gate this repo has shipped three
 * times running.
 *
 * Three things make it non-vacuous, and all three are required:
 *
 *   G-EP-1  the DECLARED-EMPTY negative control. `dismiss` produces `[]` on
 *           both sides, and the test asserts BOTH that they match AND that
 *           empty is what it EXPECTED, citing the traced reason. A silently
 *           empty parity assertion is the failure mode; a declared one is a
 *           finding. It also diffs the DOMAIN tables, which are NOT empty —
 *           so the "nothing happened" reading is excluded by construction.
 *
 *   G-EP-2  the POSITIVE control. A recurring reject (`seen_again_count > 0`)
 *           takes the FR-116 M3 branch, which writes a real
 *           `perception.rejected_pattern_recurring` row via `writePerceptionEvent`
 *           — and, since FR-241 Phase 6b, a `perception.candidate_rejected` row
 *           through `monitoring` as well. Both sides must produce BOTH rows,
 *           identical on every compared column INCLUDING the literal
 *           `component = 'perception'` (the L-857 naming trap:
 *           `writePerceptionEvent` pins the LEGACY name, `writeExtractorEvent`
 *           would have produced `cognition.perception`).
 *
 *   G-EP-3  the FLIP. The same comparison, with one side's payload mutated on
 *           purpose, must FAIL. Without it, G-EP-1's empty match proves nothing
 *           about the differ.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO **PROCESSES**, NOT TWO ENGINES
 * ═════════════════════════════════════════════════════════════════════════════
 * Phase-0 step 7 measured that `db.ts#setAdapter` is a MODULE GLOBAL: after a
 * second `bootEngine` in the same process, engine A's gateway dispatches against
 * engine B's database (observed: `Suggestion not found: 1215` for a row that
 * existed in A). A parity test run as two engines in one process would compare
 * one brain to itself and pass unconditionally. So each arm is a child `node`
 * process with its own module registry, its own adapter and its own brain file.
 *
 *   ARM A — the literal MCP path: `bootEngine(...).gateway.dispatch(tool, args)`.
 *           `createBrainServer()`'s `CallToolRequestSchema` handler
 *           (`brain-mcp-server/src/index.ts:231-247`) is a one-line wrapper
 *           around exactly this call, so this IS the MCP path minus JSON-RPC.
 *   ARM B — the dashboard: `startServer()` + a real `POST /api/triage` over a
 *           real socket.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE GATES DO **NOT** PROVE
 * ═════════════════════════════════════════════════════════════════════════════
 *   - Nothing about `apply_action`'s heterogeneous kinds: it is single-item by
 *     D4 and dispatches arbitrary action kinds, none of which is exercised here.
 *   - Nothing about the REMOTE brain's copy after `sync` auto-push. `sync` stays
 *     enabled precisely so the two paths propagate identically, but this suite
 *     never reaches the VPS.
 *   - Nothing about `machine_hostname` / `created_at` / `id`, which are excluded
 *     from the comparison — and the exclusion list is itself ASSERTED below so
 *     it cannot quietly grow to cover a real difference.
 *   SIBLING covering the general case: `dashboard-triage-endpoint.test.ts`
 *   G-TR-5(b), which proves the same handler FUNCTION OBJECT is reached by the
 *   HTTP path. These per-action diffs sample that argument; G-TR-5(b) makes it.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MODULE_REL, resolveBundleModule } from "../lib/brain-bridge.js";
import { bundleStaged } from "./hermetic-embeddings.js";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(CLI_ROOT, "dist", "index.js");

/**
 * The comparable columns. `id`, `created_at` and `machine_hostname` are
 * EXCLUDED — an autoincrement, a clock and a hostname cannot agree across two
 * processes on principle. The list is asserted in its own test so it cannot
 * grow to swallow a real difference.
 */
const COMPARED = ["event_name", "component", "project_slug", "instance_id", "payload"] as const;
const EXCLUDED = ["id", "created_at", "machine_hostname"] as const;

const REAL_BRAIN = join(homedir(), ".igris", "memory", "knowledge.db");
/**
 * ACCESS witness, not a byte witness (learning 1096). The byte digest this
 * replaced was blind in the direction that matters — a triage dispatch lands
 * entirely in the `-wal`, leaving the `.db` byte-identical (G-RO-6) — and noisy
 * in the other, since long-lived `brain-mcp-server` processes hold the file
 * open and a checkpoint by any of them would have named THIS suite as the
 * culprit. See `dashboard-triage-endpoint.test.ts`'s REAL_BRAIN block.
 *
 * Both arms are child processes, so the witness is each child's own resolved
 * dbPath, collected from its reported preamble.
 *
 * Proves: neither arm addressed `~/.igris/memory`.
 * Does NOT prove: that the file was unmodified — another process may well have
 * modified it, and that is not this suite's claim to make.
 */
const armDbPaths: string[] = [];

/** `event_log`'s column list as reported by an arm (see the union assertion). */
let armEventCols: string[] = [];

afterAll(() => {
  // SELF-NEGATIVE-CONTROL: an empty list would make the loop vacuously true.
  expect(armDbPaths.length).toBeGreaterThan(0);
  for (const p of armDbPaths) {
    expect(p, "A PARITY ARM ADDRESSED THE OPERATOR'S REAL BRAIN").not.toBe(
      REAL_BRAIN,
    );
  }
});

// ---------------------------------------------------------------------------
// The two arms, each a child process
// ---------------------------------------------------------------------------

interface ArmResult {
  events: Record<string, unknown>[];
  domain: Record<string, unknown>;
  response: string;
  path: string;
  /** `event_log`'s own column list, read by the arm from its own schema. */
  eventCols: string[];
}

const ENGINE_JS = resolveBundleModule(ENGINE_MODULE_REL);

/** Shared preamble: build a migrated + seeded brain in a fresh sandbox. */
const PREAMBLE = String.raw`
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import D from "better-sqlite3";

const sandbox = mkdtempSync(join(tmpdir(), "igris-fr241-parity-"));
mkdirSync(join(sandbox, "memory"), { recursive: true });
const DB = join(sandbox, "memory", "knowledge.db");
process.env.IGRIS_BRAIN_DIR = sandbox;
process.env.IGRIS_DB_PATH = DB;

const { bootEngine } = await import(process.env.ENGINE_JS);

// PASS 1 — migrate with a THROWAWAY engine, then shut it down. Nothing may hold
// a read-write connection while another one is live (see the triage fixture's
// header: it silently unlinks the WAL and every later read goes stale).
new D(DB).close();
bootEngine({ dbPath: DB, components: { schedules: { enabled: false } } }).shutdown();

// PASS 2 — seed IDENTICAL rows on both arms, on a quiescent file.
const seed = new D(DB);
seed.prepare("INSERT INTO suggestions (id, source_module, project_slug, title, evidence, priority, status, created_at) VALUES (1,'gap','demo','parity row','{\"kind\":\"gap\"}','high','pending','2026-07-01 09:00:00')").run();
seed.prepare("INSERT INTO learnings (id, project, category, title, content, confidence, provenance, review_status, source_extractor, seen_again_count, tags, tech_stack, scope) VALUES (1,'demo','pattern','recurring parity','body',0.8,'inferred','pending_review','perception',3,'','','local')").run();
seed.prepare("INSERT INTO learnings (id, project, category, title, content, confidence, provenance, review_status, source_extractor, seen_again_count, tags, tech_stack, scope) VALUES (2,'demo','pattern','first-time parity','body',0.8,'inferred','pending_review','perception',0,'','','local')").run();
// FR-247. NO BACKTICKS IN THIS BLOCK -- it is inside a template literal, and
// one backtick ends the arm's whole source. brief_status.project has a FK to
// projects(slug) and better-sqlite3 opens with foreign_keys = 1, so the
// project row is inserted first. TWO briefs: one carrying a canonical priority
// and one carrying NULL, so the priority arm exercises both an
// UPDATE-over-a-value and an UPDATE-over-NULL.
seed.prepare("INSERT INTO projects (slug, name, path) VALUES ('demo','Demo','/tmp/demo')").run();
seed.prepare("INSERT INTO brief_status (project, brief_id, title, status, priority, effort, phase, brief_type, updated_at) VALUES ('demo','FR-900','Parity brief one','Ready','P2-Medium','M',NULL,'Feature','2026-08-01 10:00:00')").run();
seed.prepare("INSERT INTO brief_status (project, brief_id, title, status, priority, effort, phase, brief_type, updated_at) VALUES ('demo','FR-901','Parity brief two','Ready',NULL,'S',NULL,'Feature','2026-08-01 10:00:00')").run();
seed.prepare("INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at) VALUES ('parity-file','demo','FR-900','FR-900.md','body','sha','2026-08-01 10:00:00')").run();
seed.prepare("INSERT INTO goals (goal_id, project_slug, title, outcome, status, priority, created_at, updated_at, metadata) VALUES ('GL-900','demo','Parity goal','an outcome','active','high','2026-08-01 10:00:00','2026-08-01 10:00:00','{}')").run();
seed.close();

const watermark = (() => {
  const c = new D(DB, { readonly: true });
  const n = c.prepare("SELECT COALESCE(MAX(id),0) AS n FROM event_log").get().n;
  c.close();
  return n;
})();

function harvest(response) {
  const c = new D(DB, { readonly: true });
  const events = c.prepare(
    "SELECT ${COMPARED.join(", ")} FROM event_log WHERE id > ? ORDER BY id"
  ).all(watermark);
  const strip = (rows) => rows.map((r) => {
    const { dismissed_at, acted_at, updated_at, created_at, last_seen_at, deleted_at, ...rest } = r;
    return { ...rest, deleted: deleted_at == null ? 0 : 1 };
  });
  const domain = {
    suggestions: strip(c.prepare("SELECT * FROM suggestions ORDER BY id").all()),
    dismissed_patterns: strip(c.prepare("SELECT source_module, project_slug, evidence_signature, dismiss_count, reasons FROM dismissed_patterns ORDER BY id").all()),
    learnings: strip(c.prepare("SELECT id, project, title, review_status, seen_again_count, deleted_at FROM learnings ORDER BY id").all()),
    entity_edges: strip(c.prepare("SELECT from_type, from_id, to_type, to_id, edge_type FROM entity_edges ORDER BY id").all()),
    // FR-247 -- ONE line, and no backticks (template literal). title and
    // status are COMPARED rather than stripped: the whole point of the
    // priority arm is that both paths move the same single column and leave
    // the same others alone.
    brief_status: strip(c.prepare("SELECT project, brief_id, title, status, priority, effort, phase, brief_type FROM brief_status ORDER BY project, brief_id").all()),
    // FR-249 -- goals. Without this selection a create_goal comparison would be
    // [] === [] on every table AND on event_log, i.e. two arms agreeing that
    // nothing happened while both had written a row. goal_id IS compared: both
    // arms allocate MAX+1 from their OWN copy of the same seed, so the id is
    // deterministic across them and a divergence would be real.
    goals: strip(c.prepare("SELECT goal_id, project_slug, title, description, outcome, deadline, status, priority, metadata FROM goals ORDER BY id").all()),
  };
  // The arm reports event_log's OWN column list so the parent can assert the
  // COMPARED+EXCLUDED union equals it. The parent has no brain of its own, and
  // disjointness alone would let a NEW column sit in neither list, uncompared.
  const eventCols = c.pragma("table_info(event_log)").map((x) => x.name);
  c.close();
  process.stdout.write("@@PARITY@@" + JSON.stringify({ events, domain, response, path: DB, eventCols }) + "@@END@@");
}
`;

/** ARM A — the literal MCP path: boot the engine and dispatch. */
function armMcp(tool: string, args: Record<string, unknown>): ArmResult {
  return runArm(
    `${PREAMBLE}
const engine = bootEngine({ dbPath: DB, components: { schedules: { enabled: false } } });
const res = await engine.gateway.dispatch(${JSON.stringify(tool)}, ${JSON.stringify(args)});
harvest(res.content?.[0]?.text ?? "");
engine.shutdown();
`,
  );
}

/** ARM B — the dashboard: a real server and a real POST over a real socket. */
function armDashboard(body: Record<string, unknown>): ArmResult {
  return runArm(
    `${PREAMBLE}
const { startServer } = await import(process.env.CLI_SERVER_JS);
const srv = await startServer({ port: 0, cliVersion: "parity" });
const res = await fetch("http://127.0.0.1:" + srv.port + "/api/triage", {
  method: "POST",
  headers: { "content-type": "application/json", host: "127.0.0.1:" + srv.port },
  body: JSON.stringify(${JSON.stringify(body)}),
});
const text = await res.text();
if (res.status !== 200) { process.stderr.write("ARM B status " + res.status + ": " + text); process.exit(3); }
harvest(text);
await srv.close();
`,
  );
}

/**
 * Run one arm as a CHILD PROCESS.
 *
 * `--input-type=module -e` rather than a written temp file, and the reason is
 * the same one `scripts/browser-gate.mjs#runSeedScript` records: Node resolves
 * a bare specifier by walking up from the SCRIPT's directory, so a `.mjs` in a
 * system temp dir cannot find `better-sqlite3` (measured: `ERR_MODULE_NOT_FOUND`
 * on the first run of this file). A `-e` program resolves from `cwd`, which is
 * `cli/`. Writing the file INSIDE `cli/dist` would resolve — and would land in
 * `package.json` `files`, moving the packed-size figure this brief is gated on.
 */
function runArm(source: string): ArmResult {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      ENGINE_JS: `file://${ENGINE_JS}`,
      CLI_SERVER_JS: `file://${join(CLI_ROOT, "dist", "lib", "dashboard", "server.js")}`,
      // Neither arm may inherit the operator's brain dir; the preamble sets its
      // own, and this makes an accidental inheritance impossible rather than
      // merely unlikely.
      IGRIS_BRAIN_DIR: join(scratch, "must-be-overridden"),
      // FR-247 R4 — THE EGRESS FENCE FOR THE ARMS.
      //
      // `set_priority` dispatches `igris_brief_update`, which emits
      // `brief.synced`; `sync` listens for it unconditionally and
      // fire-and-forgets `pushTables({brief_status, brief_files})` to
      // `remote_brain.url` whenever `auto_push` is true. `loadAutoPushConfig`
      // reads `join(homedir(), '.igris', 'config.json')`, and a child process
      // inherits `HOME` — so without this line the arms would read the
      // OPERATOR'S config, and a parity fixture row could land in the real
      // remote brain. Pointing `HOME` at the scratch dir makes that
      // structurally impossible rather than dependent on one boolean in a file
      // no test owns. The in-process suites use `auto-push-fence.ts`, which
      // also proves the mechanism is real (G-TR-13 ARM B).
      HOME: scratch,
    },
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const m = /@@PARITY@@([\s\S]*?)@@END@@/.exec(out);
  if (m === null) throw new Error(`arm produced no parity payload:\n${out.slice(-2000)}`);
  const result = JSON.parse(m[1]!) as ArmResult;
  // Feed the ACCESS witness (see afterAll). `path` is the dbPath the arm's own
  // engine booted at, reported by the arm itself — so this witnesses where the
  // write actually went, not where the parent thinks it told it to go.
  armDbPaths.push(result.path);
  if (Array.isArray(result.eventCols) && result.eventCols.length > 0) {
    armEventCols = result.eventCols;
  }
  return result;
}

/** A guard dir for `IGRIS_BRAIN_DIR`; each arm overrides it in its preamble. */
const scratch = mkdtempSync(join(tmpdir(), "igris-fr241-arms-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// The differ
// ---------------------------------------------------------------------------

/** Diff two arms. Returns the empty array when they agree. */
function diff(a: ArmResult, b: ArmResult): string[] {
  const out: string[] = [];
  const ja = JSON.stringify(a.events);
  const jb = JSON.stringify(b.events);
  if (ja !== jb) out.push(`event_log differs:\n  MCP:  ${ja}\n  DASH: ${jb}`);
  for (const table of Object.keys(a.domain)) {
    const ta = JSON.stringify((a.domain as Record<string, unknown>)[table]);
    const tb = JSON.stringify((b.domain as Record<string, unknown>)[table]);
    if (ta !== tb) out.push(`${table} differs:\n  MCP:  ${ta}\n  DASH: ${tb}`);
  }
  return out;
}

describe("the parity harness is real before anything is compared", () => {
  it("the vendored engine and the built CLI server both exist", () => {
    expect(bundleStaged(), "run `cd cli && npm run build` first").toBe(true);
    expect(ENGINE_JS, ENGINE_MODULE_REL).not.toBeNull();
    expect(existsSync(CLI_ENTRY), `${CLI_ENTRY} missing — run the build`).toBe(true);
    expect(
      existsSync(join(CLI_ROOT, "dist", "lib", "dashboard", "server.js")),
      "the compiled dashboard server is missing",
    ).toBe(true);
  });

  it("the EXCLUSION LIST is exactly three columns, and they are named", () => {
    // The failure mode this forecloses: an exclusion list that grows one column
    // at a time until it covers the difference the gate was written to catch.
    // Changing it means changing this assertion, deliberately.
    expect([...EXCLUDED]).toEqual(["id", "created_at", "machine_hostname"]);
    expect([...COMPARED]).toEqual([
      "event_name",
      "component",
      "project_slug",
      "instance_id",
      "payload",
    ]);
    // ...and every column of `event_log` is in exactly one of the two lists.
    //
    // Disjointness ALONE does not prove that. A new column would be in NEITHER
    // list and would be silently uncompared — the exact hole the sentence above
    // claims is foreclosed — so the schema itself is read and the union is
    // asserted to EQUAL it. Without this read, adding a column to `event_log`
    // narrows the headline AC's gate and nothing goes red.
    const cols = [...COMPARED, ...EXCLUDED];
    expect(new Set(cols).size, "a column appears in both lists").toBe(cols.length);

    // The parent has no brain of its own, so the schema comes from an ARM —
    // read by the arm from the same table the diff reads.
    expect(armEventCols.length, "no arm reported a schema").toBeGreaterThan(0);
    expect(
      [...cols].sort(),
      "an event_log column is in NEITHER list — it would be silently uncompared",
    ).toEqual([...armEventCols].sort());
  });

  it("the two arms run in SEPARATE PROCESSES at SEPARATE brains", () => {
    // Phase-0 step 7: `setAdapter` is a module global, so two engines in ONE
    // process compare a brain to itself. Distinct paths are the evidence that
    // did not happen.
    const a = armMcp("igris_suggestion_dismiss", { id: 1, reason: "harness" });
    const b = armDashboard({ action: "dismiss", ids: [1], reason: "harness" });
    expect(a.path).not.toBe(b.path);
    expect(a.path).toContain("igris-fr241-parity-");
    expect(b.path).toContain("igris-fr241-parity-");
  });
});

// ---------------------------------------------------------------------------
// G-EP-1 — the DECLARED-EMPTY negative control
// ---------------------------------------------------------------------------

describe("G-EP-1 — dismiss: event_log is empty on BOTH sides, and empty is EXPECTED", () => {
  const mcp = armMcp("igris_suggestion_dismiss", { id: 1, reason: "parity" });
  const dash = armDashboard({ action: "dismiss", ids: [1], reason: "parity" });

  it("DECLARED: dismiss writes no event_log row, for a traced reason", () => {
    // `handleSuggestionDismiss` (`subconscious/handlers.ts`) has no `bus.emit`
    // and no `event_log` INSERT; it writes `suggestions` and
    // `dismissed_patterns` only. Phase-0 step 5 measured the delta as 0 against
    // a snapshot of the real 2,005-row brain. So `[]` here is a FINDING, not an
    // absence of evidence — and if either side ever starts logging, this is the
    // assertion that says so.
    expect(mcp.events, "the MCP path started logging a dismiss").toEqual([]);
    expect(dash.events, "the dashboard path started logging a dismiss").toEqual([]);
  });

  it("the DOMAIN tables are NOT empty — so `[] === []` is not `nothing happened`", () => {
    // The half that keeps G-EP-1 from being satisfiable by two arms that both
    // silently did nothing. Both must have really dismissed the row and really
    // written the suppression-loop signal.
    const suggestions = mcp.domain.suggestions as Record<string, unknown>[];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ id: 1, status: "dismissed" });
    expect(mcp.domain.dismissed_patterns as unknown[], "no dismissed_patterns row").toHaveLength(
      1,
    );
    const dashSuggestions = dash.domain.suggestions as Record<string, unknown>[];
    expect(dashSuggestions[0]).toMatchObject({ id: 1, status: "dismissed" });
  });

  it("ARM B really went over HTTP and really applied — not a silent no-op", () => {
    // Without this, "both arms match" is satisfiable by a dashboard arm whose
    // POST 200'd with `degraded` and applied nothing, against an MCP arm that
    // also happened to write no event. The response body is the receipt.
    const body = JSON.parse(dash.response) as {
      applied: number;
      degraded: unknown;
      results: unknown[];
    };
    expect(body.applied).toBe(1);
    expect(body.degraded).toBeNull();
    expect(body.results).toHaveLength(1);
    // ARM A's receipt is the handler's own JSON.
    expect(JSON.parse(mcp.response)).toMatchObject({ updated: true });
  });

  it("the two arms are IDENTICAL on event_log AND on all six domain tables", () => {
    expect(diff(mcp, dash).join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// G-EP-2 — the POSITIVE control
// ---------------------------------------------------------------------------

describe("G-EP-2 — recurring reject: the ONE branch that logs, byte-equal on both sides", () => {
  const mcp = armMcp("igris_perception_reject", { learning_id: 1, reason: "recurring parity" });
  const dash = armDashboard({ action: "reject", ids: [1], reason: "recurring parity" });

  it("BOTH arms wrote real event_log rows — this control is not empty", () => {
    expect(mcp.events.length, "the recurring branch stopped logging").toBeGreaterThan(0);
    expect(dash.events.length).toBe(mcp.events.length);
  });

  it("the rows are the two FR-241-era events, in order, with component='perception'", () => {
    // Two rows since Phase 6b: `writePerceptionEvent` writes
    // `perception.rejected_pattern_recurring` DIRECTLY (`handlers.ts:690`),
    // then `bus.emit('perception.candidate_rejected')` reaches `monitoring`,
    // which FR-241 6b subscribed. Order is therefore direct-then-bus.
    const names = mcp.events.map((e) => e.event_name);
    expect(names).toEqual([
      "perception.rejected_pattern_recurring",
      "perception.candidate_rejected",
    ]);
    for (const e of mcp.events) {
      // THE L-857 TRAP, asserted as a LITERAL. `writePerceptionEvent`
      // (`perception/events.ts:110`) and FR-241's `EVENT_COMPONENT_MAP` entry
      // both pin the LEGACY `'perception'`; `writeExtractorEvent` would have
      // produced `cognition.perception`. Do not assume — this is the assertion.
      expect(e.component, `component for ${String(e.event_name)}`).toBe("perception");
    }
    expect(dash.events.map((e) => e.event_name)).toEqual(names);
  });

  it("the payloads carry the operator's reason, on both sides", () => {
    for (const arm of [mcp, dash]) {
      for (const e of arm.events) {
        expect(JSON.parse(String(e.payload))).toMatchObject({
          learning_id: 1,
          reason: "recurring parity",
        });
      }
    }
  });

  it("the row SURVIVED (soft delete) on both sides — tier 2, not tier 3", () => {
    for (const arm of [mcp, dash]) {
      const learnings = arm.domain.learnings as Record<string, unknown>[];
      const row = learnings.find((l) => l.id === 1);
      expect(row, "the recurring row was HARD-deleted").toBeDefined();
      expect(row).toMatchObject({ review_status: "rejected" });
      expect(row?.deleted_at).not.toBeNull();
    }
  });

  it("the two arms are IDENTICAL on event_log AND on all six domain tables", () => {
    expect(diff(mcp, dash).join("\n")).toBe("");
  });
});

describe("G-EP-2b — first-time reject: HARD delete, and still event-silent on both sides", () => {
  const mcp = armMcp("igris_perception_reject", { learning_id: 2, reason: "first-time parity" });
  const dash = armDashboard({ action: "reject", ids: [2], reason: "first-time parity" });

  it("the row is GONE on both sides — tier 3", () => {
    for (const arm of [mcp, dash]) {
      const learnings = arm.domain.learnings as Record<string, unknown>[];
      expect(learnings.map((l) => l.id), "the first-time row survived").not.toContain(2);
      expect(learnings.map((l) => l.id)).toContain(1); // the recurring one is untouched
    }
  });

  it("DECLARED: the first-time branch logs `candidate_rejected` only", () => {
    // Before Phase 6b this branch was completely silent. It now emits ONE row
    // (the bus event monitoring subscribed) and NOT `rejected_pattern_recurring`
    // — which is what keeps the two reject branches distinguishable in the
    // audit trail, and is exactly why 6b did not also subscribe the recurring
    // event (it is written directly and would have been double-logged).
    expect(mcp.events.map((e) => e.event_name)).toEqual(["perception.candidate_rejected"]);
    expect(dash.events.map((e) => e.event_name)).toEqual(["perception.candidate_rejected"]);
  });

  it("the two arms are IDENTICAL", () => {
    expect(diff(mcp, dash).join("\n")).toBe("");
  });
});

describe("G-EP-2c — approve: Phase 6b made this branch falsifiable at all", () => {
  const mcp = armMcp("igris_perception_approve", { learning_id: 2 });
  const dash = armDashboard({ action: "approve", ids: [2] });

  it("both arms log exactly one `perception.candidate_approved`", () => {
    // Phase-0 step 5b measured this delta as **0** — the emit went nowhere
    // because `monitoring`'s listen list omitted it. FR-241 Phase 6b subscribed
    // it, so this assertion could not have been written before this brief.
    expect(mcp.events.map((e) => e.event_name)).toEqual([
      "perception.candidate_approved",
    ]);
    expect(mcp.events[0]).toMatchObject({ component: "perception" });
    expect(dash.events.map((e) => e.event_name)).toEqual(mcp.events.map((e) => e.event_name));
  });

  it("the learning is approved on both sides, and the two arms are IDENTICAL", () => {
    for (const arm of [mcp, dash]) {
      const row = (arm.domain.learnings as Record<string, unknown>[]).find((l) => l.id === 2);
      expect(row).toMatchObject({ review_status: "approved" });
    }
    expect(diff(mcp, dash).join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// G-EP-3 — THE FLIP. Without this, every match above proves nothing.
// ---------------------------------------------------------------------------

describe("G-EP-3 — the differ CAN fail: three injected differences, three catches", () => {
  const mcp = armMcp("igris_perception_reject", { learning_id: 1, reason: "flip base" });
  const dash = armDashboard({ action: "reject", ids: [1], reason: "flip base" });

  it("the baseline agrees (so the mutations below are the only variable)", () => {
    expect(diff(mcp, dash)).toEqual([]);
  });

  it("a mutated PAYLOAD is caught", () => {
    const tampered: ArmResult = {
      ...dash,
      events: dash.events.map((e, i) =>
        i === 0 ? { ...e, payload: '{"learning_id":1,"reason":"NOT THE SAME"}' } : e,
      ),
    };
    const d = diff(mcp, tampered);
    expect(d.length, "a changed payload slipped through the differ").toBeGreaterThan(0);
    expect(d[0]).toContain("event_log differs");
  });

  it("a mutated COMPONENT is caught — the L-857 trap would be visible", () => {
    // The precise failure this differ exists to catch: one path writing
    // `cognition.perception` where the other writes `perception`.
    const tampered: ArmResult = {
      ...dash,
      events: dash.events.map((e) => ({ ...e, component: "cognition.perception" })),
    };
    expect(diff(mcp, tampered).join("\n")).toContain("event_log differs");
  });

  it("a DOMAIN-TABLE-only difference is caught, with event_log still matching", () => {
    // The failure an event_log-only differ would miss entirely: identical audit
    // rows, different data. Four of five actions write no event at all, so this
    // is the common case rather than the exotic one.
    const learnings = (dash.domain.learnings as Record<string, unknown>[]).map((l) => ({
      ...l,
      review_status: "approved",
    }));
    const tampered: ArmResult = { ...dash, domain: { ...dash.domain, learnings } };
    const d = diff(mcp, tampered);
    expect(d.join("\n")).toContain("learnings differs");
    expect(d.join("\n"), "event_log should still agree here").not.toContain(
      "event_log differs",
    );
  });

  it("a MISSING row is caught (a truncated event_log is not a match)", () => {
    const tampered: ArmResult = { ...dash, events: dash.events.slice(0, -1) };
    expect(diff(mcp, tampered).join("\n")).toContain("event_log differs");
  });

  it("SELF-NEGATIVE-CONTROL — an arm really produced rows to mutate", () => {
    // A flip test over an empty array passes vacuously for every mutation
    // above. The recurring branch is chosen precisely because it is not empty.
    expect(dash.events.length).toBeGreaterThan(1);
    expect((dash.domain.learnings as unknown[]).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FR-247 — the two brief writes, through the SAME two-process differ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * G-EP-4 is a genuinely NON-EMPTY positive control, and that is new for this
 * family. FR-241's headline parity AC was near-vacuous: four of its five
 * actions write nothing to `event_log`, so `[] === []` carried the claim.
 *
 * `set_priority` does not have that problem, and the reason was traced rather
 * than hoped for:
 *   - `briefs/index.ts:404` — `igris_brief_update`'s registration emits
 *     `brief.synced` on EVERY update;
 *   - `monitoring/index.ts:56` — `EVENT_COMPONENT_MAP` carries
 *     `'brief.synced': 'briefs'`;
 *   - `monitoring/index.ts:272` — monitoring subscribes it.
 * So a priority write produces a real `event_log` row on both arms, at zero
 * brain-side cost.
 *
 * G-EP-5 is the complement, and it is DECLARED-EMPTY rather than merely empty:
 * `edge.created` is in NEITHER `EVENT_COMPONENT_MAP` nor monitoring's listen
 * list (re-grepped over the whole component, zero hits for /edge|goal/), so an
 * attach is event-silent BY CONSTRUCTION. `entity_edges` carries the
 * "something really happened" half, which the differ already selected.
 */

describe("G-EP-4 — set_priority: a REAL event_log row, byte-equal on both sides", () => {
  const args = { project: "demo", brief_id: "FR-900", priority: "P0-Critical" };
  const mcp = armMcp("igris_brief_update", args);
  const dash = armDashboard({
    action: "set_priority",
    refs: [{ project: "demo", brief_id: "FR-900" }],
    priority: "P0-Critical",
  });

  it("BOTH arms wrote EXACTLY ONE event_log row — this control is not empty", () => {
    expect(
      mcp.events.length,
      "the MCP priority write logged nothing — has brief.synced stopped reaching monitoring?",
    ).toBe(1);
    expect(dash.events.length).toBe(1);
  });

  it("the row is brief.synced / component='briefs' / the right project — ASSERTED, not assumed", () => {
    // `component` is a LITERAL from `EVENT_COMPONENT_MAP:56`, not something
    // derived at read time. G-EP-2 records the L-857 trap on the perception
    // side (the legacy `'perception'` rather than `'cognition.perception'`);
    // this is the same discipline applied to a different map entry.
    for (const arm of [mcp, dash]) {
      expect(arm.events[0]?.event_name).toBe("brief.synced");
      expect(arm.events[0]?.component).toBe("briefs");
      expect(arm.events[0]?.project_slug).toBe("demo");
      expect(JSON.parse(String(arm.events[0]?.payload))).toEqual({
        project: "demo",
        brief_id: "FR-900",
      });
    }
  });

  it("ARM B really went over HTTP and really applied — not a silent no-op", () => {
    const body = JSON.parse(dash.response) as {
      applied: number;
      degraded: unknown;
      results: { ref: unknown }[];
    };
    expect(body.applied).toBe(1);
    expect(body.degraded).toBeNull();
    expect(body.results[0]?.ref).toEqual({ project: "demo", brief_id: "FR-900" });
  });

  it("the brief_status row moved on BOTH arms, and ONLY in `priority`", () => {
    // The half that keeps the event comparison from being satisfiable by two
    // arms that both did nothing.
    for (const arm of [mcp, dash]) {
      const rows = arm.domain.brief_status as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        project: "demo",
        brief_id: "FR-900",
        title: "Parity brief one",
        status: "Ready",
        priority: "P0-Critical",
        effort: "M",
        phase: null,
        brief_type: "Feature",
        // `deleted` is the SHARED stripper's artifact — it folds every
        // `deleted_at` into a presence flag for the learnings arm. Asserted
        // rather than dropped from the comparison, so the expectation is the
        // WHOLE row and a new column cannot slip in uncompared.
        deleted: 0,
      });
      // ...and the OTHER brief, which neither arm named, is untouched with its
      // priority still NULL.
      expect(rows[1]).toMatchObject({ brief_id: "FR-901", priority: null });
    }
  });

  it("the two arms are IDENTICAL on event_log AND on every domain table", () => {
    expect(diff(mcp, dash).join("\n")).toBe("");
  });
});

describe("G-EP-5 — attach_goal: DECLARED-empty on event_log, non-empty on entity_edges", () => {
  const args = {
    from_type: "brief",
    from_id: "FR-900",
    to_type: "goal",
    to_id: "GL-900",
    edge_type: "serves_goal",
  };
  const mcp = armMcp("igris_edge_create", args);
  const dash = armDashboard({
    action: "attach_goal",
    refs: [{ project: "demo", brief_id: "FR-900" }],
    goal_id: "GL-900",
  });

  it("DECLARED: an edge write logs nothing, for a traced reason", () => {
    // `edges/index.ts` DOES `bus.emit('edge.created', …)`, and NOBODY listens:
    // `edge.created` is absent from `EVENT_COMPONENT_MAP` and from
    // `monitoring`'s `bus.on` list (`edges/index.ts:759` self-listens only, to
    // invalidate the traversal cache). So `[]` here is a FINDING. If either
    // side ever starts logging, this assertion is what says so.
    expect(mcp.events, "the MCP edge path started logging").toEqual([]);
    expect(dash.events, "the dashboard edge path started logging").toEqual([]);
  });

  it("...and `entity_edges` is NOT empty, so `[] === []` cannot read as `nothing happened`", () => {
    for (const arm of [mcp, dash]) {
      expect(arm.domain.entity_edges).toEqual([
        {
          from_type: "brief",
          from_id: "FR-900",
          to_type: "goal",
          to_id: "GL-900",
          edge_type: "serves_goal",
          // The shared stripper's `deleted_at` presence flag — see G-EP-4.
          deleted: 0,
        },
      ]);
    }
  });

  it("the dashboard arm DROPPED the ref's project, exactly as the MCP arm never had one", () => {
    // BR-078, made visible where it is minted. `entity_edges.from_id` is the
    // BARE brief id with no project column, so the two arms can only agree
    // because the map's `refKeys` forwards `brief_id` alone. If a future edit
    // ever threaded `project` through, this diff would go red rather than
    // silently minting a differently-shaped edge from the dashboard.
    expect(diff(mcp, dash).join("\n")).toBe("");
  });

  it("no brief COLUMN moved on either arm — an attach is not a brief write", () => {
    for (const arm of [mcp, dash]) {
      const rows = arm.domain.brief_status as Record<string, unknown>[];
      expect(rows[0]).toMatchObject({
        title: "Parity brief one",
        status: "Ready",
        priority: "P2-Medium",
      });
    }
  });
});

describe("G-EP-6 — THE FLIP: the FR-247 comparisons can actually fail", () => {
  const mcp = armMcp("igris_brief_update", {
    project: "demo",
    brief_id: "FR-900",
    priority: "P0-Critical",
  });
  const dash = armDashboard({
    action: "set_priority",
    refs: [{ project: "demo", brief_id: "FR-900" }],
    priority: "P0-Critical",
  });

  /** A structural clone with one field rewritten. */
  const tamper = (arm: ArmResult, fn: (clone: ArmResult) => void): ArmResult => {
    const clone = JSON.parse(JSON.stringify(arm)) as ArmResult;
    fn(clone);
    return clone;
  };

  it("a mutated PAYLOAD is caught", () => {
    const bad = tamper(dash, (c) => {
      c.events[0]!.payload = JSON.stringify({ project: "demo", brief_id: "FR-999" });
    });
    expect(diff(mcp, bad).join("\n")).toContain("event_log differs");
  });

  it("a mutated COMPONENT is caught — the L-857 shape", () => {
    const bad = tamper(dash, (c) => {
      c.events[0]!.component = "cognition.briefs";
    });
    expect(diff(mcp, bad).join("\n")).toContain("event_log differs");
  });

  it("a DROPPED row is caught — i.e. a dashboard write that logged nothing", () => {
    const bad = tamper(dash, (c) => {
      c.events = [];
    });
    expect(diff(mcp, bad).join("\n")).toContain("event_log differs");
  });

  it("a brief_status-ONLY difference is caught while event_log still matches", () => {
    // The most important flip of the four. A dashboard write that produced the
    // right event and the WRONG row is exactly the failure an event-only differ
    // cannot see — and `brief_status` was added to the domain set for this.
    const bad = tamper(dash, (c) => {
      (c.domain.brief_status as Record<string, unknown>[])[0]!.title = "BLANKED";
    });
    const d = diff(mcp, bad).join("\n");
    expect(d).toContain("brief_status differs");
    expect(d, "the event comparison should still agree").not.toContain("event_log differs");
  });

  it("SELF-NEGATIVE-CONTROL — the arms really produced rows to mutate", () => {
    // Every flip above is vacuous over an empty array.
    expect(dash.events.length).toBeGreaterThan(0);
    expect((dash.domain.brief_status as unknown[]).length).toBeGreaterThan(0);
    // ...and the UNTAMPERED comparison agrees, so the flips are measuring the
    // tamper rather than a pre-existing difference.
    expect(diff(mcp, dash).join("\n")).toBe("");
  });
});

describe("G-EP-7 — create_goal: DECLARED-empty on event_log, non-empty on goals", () => {
  const args = { title: "Parity created goal", outcome: "an outcome", project: "demo" };
  const mcp = armMcp("igris_goal_create", args);
  const dash = armDashboard({
    action: "create_goal",
    goal_title: "Parity created goal",
    goal_outcome: "an outcome",
    goal_project: "demo",
  });

  it("DECLARED: a goal create logs nothing, for a traced reason", () => {
    // `goals/index.ts` DOES `bus.emit('goal.created', …)` — and nobody listens.
    // `goal.created` is in NEITHER `monitoring`'s `EVENT_COMPONENT_MAP` nor its
    // `bus.on` list, so `[]` here is a FINDING rather than an absence. If either
    // side ever starts logging, this is the assertion that says so.
    expect(mcp.events, "the MCP goal path started logging").toEqual([]);
    expect(dash.events, "the dashboard goal path started logging").toEqual([]);
  });

  it("...and `goals` is NOT empty, so `[] === []` cannot read as `nothing happened`", () => {
    for (const arm of [mcp, dash]) {
      const rows = arm.domain.goals as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        // GL-900 is seeded, so MAX+1 is GL-901 on BOTH arms — the allocator is
        // deterministic over identical seeds, which is what lets the id be
        // compared rather than stripped.
        goal_id: "GL-901",
        project_slug: "demo",
        title: "Parity created goal",
        outcome: "an outcome",
        // The HANDLER's defaults, identical on both paths. The dashboard offers
        // neither field, and this is where "it inherits them" stops being a
        // claim about the UI and becomes a claim about the row.
        status: "active",
        priority: "P2-Medium",
      });
    }
  });

  it("the two arms are IDENTICAL on event_log AND on every domain table", () => {
    // The whole point: `goal_title` on the wire and `title` at the tool produce
    // a byte-identical row. A rename that leaked its source key, or a default
    // the dashboard supplied itself, would show up here.
    expect(diff(mcp, dash).join("\n")).toBe("");
  });

  it("THE FLIP — a goals-ONLY difference is caught while event_log still matches", () => {
    // Without this, the `goals` selection could be silently dropped from
    // `harvest` and every assertion above would still pass.
    const bad = JSON.parse(JSON.stringify(dash)) as ArmResult;
    (bad.domain.goals as Record<string, unknown>[])[1]!.title = "BLANKED";
    const d = diff(mcp, bad).join("\n");
    expect(d).toContain("goals differs");
    expect(d, "the event comparison should still agree").not.toContain("event_log differs");
  });

  it("no brief COLUMN and no EDGE moved on either arm — a create touches neither", () => {
    for (const arm of [mcp, dash]) {
      expect(arm.domain.entity_edges).toEqual([]);
      expect((arm.domain.brief_status as Record<string, unknown>[])[0]).toMatchObject({
        title: "Parity brief one",
        status: "Ready",
        priority: "P2-Medium",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Sandbox hygiene
// ---------------------------------------------------------------------------

describe("the arms never touched the operator's brain", () => {
  it("every arm's OWN reported dbPath is inside a sandbox, not ~/.igris", () => {
    // ACCESS, not bytes. Both arms are child processes that report the dbPath
    // their engine actually booted at, so this witnesses where the write went
    // rather than where the parent believes it sent it. A byte digest was tried
    // first and is unsound in both directions — see the armDbPaths block.
    expect(armDbPaths.length).toBeGreaterThan(0);
    for (const p of armDbPaths) {
      expect(p, "A PARITY ARM ADDRESSED THE OPERATOR'S REAL BRAIN").not.toBe(
        REAL_BRAIN,
      );
      expect(p).toContain("igris-fr241-");
    }
  });
});
