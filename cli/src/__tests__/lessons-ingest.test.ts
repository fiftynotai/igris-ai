/**
 * TD-496 — `igris lessons ingest`: approved agent-memory rows stored through
 * the brain's OWN gateway (the `sync push` door: `bootWriteEngine` +
 * `gateway.dispatch`), so BR-080 / TD-128 validation, auto-embed and the
 * `memory.stored` subscribers run exactly as over MCP.
 *
 * Harness:
 *   - HOME + IGRIS_BRAIN_DIR fenced (BR-106) and a belt, before AND after each
 *     test, asserting `brainDbPath()` is the fenced brain and never the
 *     operator's live one (`$IGRIS_REAL_HOME/.igris/memory/knowledge.db`) —
 *     the live DB is never read here (running sessions write it, so a hash or
 *     mtime of it flakes); a fetch fence that records and refuses every
 *     outbound request (asserted empty after each test);
 *   - the sandbox brain is MIGRATED by the vendored engine (the artifact the
 *     verb boots), then seeded with a plain handle BEFORE the verb boots;
 *   - `allowRemoteModels = false` on the vendored transformers (no 90 MB
 *     download into `cli/dist`), read back as armed.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fenceHome, realHome, type HomeFence } from "./home-fence.js";
import { armHermeticEmbeddings } from "./hermetic-embeddings.js";
import { brainDbPath, bundledBrainNodeModulesDir } from "../lib/paths.js";
import { closeDb } from "../lib/brain-db.js";
import { bootWriteEngine, resetWriteEngine } from "../lib/brain-write-bridge.js";
import { loadNearestMatch, resetNearestMatch, resolveBundleModule } from "../lib/brain-bridge.js";
import {
  INGEST_STORE_KEYS,
  INGEST_TOOLS,
  dryRunIngest,
  parseIngestJsonl,
  type NearestMatcher,
} from "../lib/lessons-ingest.js";
import { runLessons, type LessonsOptions } from "../verbs/lessons.js";
import type { IngestResult, LedgerRow } from "../types.js";

const CLI_DIR = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const VENDORED_ENGINE = join(CLI_DIR, "dist", "brain-mcp-server", "dist", "engine", "index.js");
const K1 = "amx:aaaaaaaaaaa1";
const K2 = "amx:aaaaaaaaaaa2";
const K3 = "amx:aaaaaaaaaaa3";

let fence: HomeFence;
let refused: string[] = [];
let realFetch: typeof globalThis.fetch;

/** Sandbox-brain hashes only (D1/D3); the live brain is never read. */
function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Belt: the brain every verb resolves is the fenced one, never the live one. */
function assertFenced(): void {
  fence.assertArmed();
  expect(brainDbPath()).toBe(join(fence.brainDir, "memory", "knowledge.db"));
  const real = realHome();
  if (real !== undefined) expect(brainDbPath()).not.toBe(join(real, ".igris", "memory", "knowledge.db"));
}

function store(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    op: "store",
    args: {
      project: "demo",
      category: "pattern",
      title: `Lesson ${key}`,
      content: `Hook for ${key}\n\nBody for ${key}.\n\nSource: agent-memory main/warden/${key}.md (sha256 0123456789ab)`,
      tags: `${key},agent-memory,role:warden`,
      source_extractor: "distill",
      provenance: "observed",
      scope: "local",
      ...over,
    },
  };
}

function writeJsonl(name: string, rows: unknown[]): string {
  const p = join(fence.home, name);
  writeFileSync(p, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return p;
}

function readLedger(p: string): LedgerRow[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as LedgerRow);
}

/** Migrate the sandbox brain with the vendored engine, then seed with a plain handle. */
async function seedBrain(seedFn?: (db: Database.Database) => void): Promise<void> {
  mkdirSync(join(fence.brainDir, "memory"), { recursive: true });
  if (!existsSync(brainDbPath())) new Database(brainDbPath()).close();
  const booted = await bootWriteEngine();
  expect(booted.ok, booted.ok ? "" : booted.reason).toBe(true);
  resetWriteEngine();
  const db = new Database(brainDbPath());
  try {
    db.prepare("INSERT INTO projects (slug, name, path) VALUES ('demo', 'Demo', '/tmp/demo')").run();
    db.prepare("INSERT INTO projects (slug, name, path) VALUES ('other', 'Other', '/tmp/other')").run();
    seedFn?.(db);
  } finally {
    db.close();
  }
}

function insertLearning(db: Database.Database, r: Record<string, unknown>): number {
  const row = { project: "demo", category: "pattern", content: "existing body", tags: "", scope: "local", review_status: "approved", ...r };
  return Number(
    db.prepare(
      "INSERT INTO learnings (project, category, title, content, tags, scope, review_status) VALUES (@project, @category, @title, @content, @tags, @scope, @review_status)",
    ).run(row).lastInsertRowid,
  );
}

function learnings(): Array<{ id: number; project: string; title: string; content: string; tags: string }> {
  const db = new Database(brainDbPath(), { readonly: true });
  try {
    return db.prepare("SELECT id, project, title, content, tags FROM learnings ORDER BY id").all() as never;
  } finally {
    db.close();
  }
}

async function run(action: string, opts: LessonsOptions): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (out.push(String(c)), true)),
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (err.push(String(c)), true)),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ") + "\n")),
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void err.push(a.join(" ") + "\n")),
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void err.push(a.join(" ") + "\n")),
  ];
  try {
    const code = await runLessons(action, opts);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

/** `--json` is ONE object `{ok, dry_run, results}` (the script parses it whole). */
function results(out: string): IngestResult[] {
  const doc = JSON.parse(out) as { ok: boolean; dry_run: boolean; results: IngestResult[] };
  expect(doc.ok).toBe(true);
  expect(Object.keys(doc).sort()).toEqual(["dry_run", "ok", "results"]);
  return doc.results;
}

beforeAll(async () => {
  expect(existsSync(VENDORED_ENGINE), "vendored brain bundle not staged — run `npm run build` in cli/").toBe(true);
  const herm = await armHermeticEmbeddings();
  expect(herm.armed, herm.reason ?? "").toBe(true);
});

beforeEach(() => {
  fence = fenceHome("igris-td496-ingest-");
  delete process.env.IGRIS_DB_PATH;
  assertFenced();
  resetWriteEngine();
  resetNearestMatch();
  refused = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    refused.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    throw new Error("HTTP 403 — TD-496 fetch fence");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetWriteEngine();
  closeDb();
  try {
    assertFenced();
    expect(refused).toEqual([]);
  } finally {
    fence.release();
  }
});

describe("TD-496 — ingest writes through the gateway", () => {
  it("I1: a store appends {key,id,sha256,op}; a rerun is already-present with the same id", async () => {
    await seedBrain();
    const input = writeJsonl("batch.jsonl", [store(K1)]);
    const ledger = join(fence.home, "stored.jsonl");
    const first = await run("ingest", { in: input, ledger, json: true });
    expect(first.code, first.err).toBe(0);
    const [r1] = results(first.out);
    expect(r1).toMatchObject({ key: K1, op: "store", status: "stored", error: null });
    const rows = learnings();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(r1.id);
    expect(rows[0].tags.split(",")).toContain(K1);
    expect(readLedger(ledger)).toEqual([{ key: K1, id: r1.id, sha256: sha256(rows[0].content), op: "store" }]);

    const again = await run("ingest", { in: input, ledger, json: true });
    expect(again.code).toBe(0);
    expect(results(again.out)[0]).toMatchObject({ status: "already-present", id: r1.id, key_present: true });
    expect(learnings()).toHaveLength(1);
    expect(readLedger(ledger)).toHaveLength(1);
  });

  it("I2: crash heal — a row in the brain but not the ledger is already-present and the ledger row is appended", async () => {
    let id = 0;
    await seedBrain((db) => {
      id = insertLearning(db, { title: "healed", content: "healed body", tags: `agent-memory,${K1},role:warden` });
    });
    const ledger = join(fence.home, "stored.jsonl");
    const { code, out } = await run("ingest", { in: writeJsonl("b.jsonl", [store(K1)]), ledger, json: true });
    expect(code).toBe(0);
    expect(results(out)[0]).toMatchObject({ status: "already-present", id });
    expect(readLedger(ledger)).toEqual([{ key: K1, id, sha256: sha256("healed body"), op: "store" }]);
    expect(learnings()).toHaveLength(1);
  });

  it("I3: add_tags takes the token union with no duplicates; an unknown id is a per-item error", async () => {
    let id = 0;
    await seedBrain((db) => {
      id = insertLearning(db, { title: "tag me", tags: "foo, role:sentinel,agent-memory" });
    });
    const ledger = join(fence.home, "stored.jsonl");
    const rows = [
      { key: K1, op: "add_tags", id, tags: `agent-memory,role:warden,${K1}` },
      { key: K2, op: "add_tags", id: 9999, tags: `agent-memory,role:warden,${K2}` },
    ];
    const { code, out } = await run("ingest", { in: writeJsonl("t.jsonl", rows), ledger, json: true });
    expect(code).toBe(1);
    const [a, b] = results(out);
    expect(a).toMatchObject({ status: "tagged", id });
    expect(b).toMatchObject({ status: "error", error: "unknown-id:9999" });
    expect(learnings()[0].tags).toBe(`foo,role:sentinel,agent-memory,role:warden,${K1}`);
    expect(readLedger(ledger)).toEqual([{ key: K1, id, sha256: sha256("existing body"), op: "add_tags" }]);
    const again = await run("ingest", { in: writeJsonl("t2.jsonl", [rows[0]]), ledger, json: true });
    expect(again.code).toBe(0);
    expect(results(again.out)[0]).toMatchObject({ status: "already-present", id });
    expect(readLedger(ledger)).toHaveLength(1);
  });

  it("I3b: add_tags on a soft-deleted id is deleted-id:<id> in dry run and write mode; nothing written", async () => {
    let id = 0;
    const tags = "foo,agent-memory";
    await seedBrain((db) => {
      id = insertLearning(db, { title: "gone", tags });
      db.prepare("UPDATE learnings SET deleted_at = '2026-11-01 00:00:00' WHERE id = ?").run(id);
    });
    const ledger = join(fence.home, "stored.jsonl");
    const input = writeJsonl("del.jsonl", [{ key: K1, op: "add_tags", id, tags: `agent-memory,role:warden,${K1}` }]);
    const dry = await run("ingest", { in: input, dryRun: true, json: true });
    expect(dry.code, dry.err).toBe(0);
    expect(results(dry.out)[0]).toMatchObject({ status: "error", error: `deleted-id:${id}` });
    const wr = await run("ingest", { in: input, ledger, json: true });
    expect(wr.code).toBe(1);
    expect(results(wr.out)[0]).toMatchObject({ status: "error", error: `deleted-id:${id}` });
    expect(learnings()[0].tags).toBe(tags);
    expect(readLedger(ledger)).toEqual([]);
  });

  it("I4: a (project, category, title) collision stores nothing — title-collision:<id>", async () => {
    let id = 0;
    await seedBrain((db) => {
      id = insertLearning(db, { title: "Lesson amx:aaaaaaaaaaa1" });
    });
    const ledger = join(fence.home, "stored.jsonl");
    const { code, out } = await run("ingest", { in: writeJsonl("c.jsonl", [store(K1)]), ledger, json: true });
    expect(code).toBe(1);
    expect(results(out)[0]).toMatchObject({ status: "title-collision", error: `title-collision:${id}`, collision: { id, key: null } });
    expect(learnings()).toHaveLength(1);
    expect(readLedger(ledger)).toEqual([]);
  });

  it("I5: pre-dispatch refusals — an extra arg, a key missing from tags, an unregistered project; unknown op / bad JSON exit 2", async () => {
    await seedBrain();
    const ledger = join(fence.home, "stored.jsonl");
    const rows = [
      store(K1, { confidence: 0.9 }),
      store(K2, { tags: "agent-memory,role:warden" }),
      store(K3, { project: "nowhere" }),
    ];
    const { code, out } = await run("ingest", { in: writeJsonl("r.jsonl", rows), ledger, json: true });
    expect(code).toBe(1);
    const res = results(out);
    expect(res.map((r) => r.status)).toEqual(["error", "error", "error"]);
    expect(res[0].error).toMatch(/confidence/);
    expect(res[1].error).toMatch(/key .* not in args\.tags/);
    expect(res[2].error).toBe("unregistered-project:nowhere");
    expect(learnings()).toHaveLength(0);
    expect(INGEST_STORE_KEYS).toEqual([
      "project", "category", "title", "content", "tags", "tech_stack", "source_brief", "scope", "provenance", "source_extractor",
    ]);

    for (const bad of [[{ key: K1, op: "delete", id: 1 }], ["{not json"], [store(K1), store(K1)]]) {
      const r = await run("ingest", { in: writeJsonl("bad.jsonl", bad), ledger, json: true });
      expect(r.code, JSON.stringify(bad)).toBe(2);
    }
    expect((await run("ingest", { in: join(fence.home, "absent.jsonl"), ledger })).code).toBe(2);
    expect((await run("ingest", { in: writeJsonl("ok.jsonl", [store(K1)]) })).code).toBe(2); // no --ledger
    expect(learnings()).toHaveLength(0);
  });

  it("I6: a handler refusal ('Validation error: Invalid …') is an item error; later rows still store", async () => {
    await seedBrain();
    const ledger = join(fence.home, "stored.jsonl");
    const rows = [store(K1, { provenance: "telepathy" }), store(K2, { category: "nonsense" }), store(K3)];
    const { code, out } = await run("ingest", { in: writeJsonl("g.jsonl", rows), ledger, json: true });
    expect(code).toBe(1);
    const res = results(out);
    expect(res[0]).toMatchObject({ status: "error" });
    expect(res[0].error).toMatch(/Validation error: Invalid provenance/);
    expect(res[1]).toMatchObject({ status: "error" });
    expect(res[1].error).toMatch(/Invalid category/);
    expect(res[2]).toMatchObject({ status: "stored" });
    expect(learnings().map((l) => l.tags.includes(K3))).toEqual([true]);
    expect(readLedger(ledger).map((l) => l.key)).toEqual([K3]);
  });

  it("I7: only igris_memory_store and igris_memory_update are dispatched", async () => {
    let id = 0;
    await seedBrain((db) => {
      id = insertLearning(db, { title: "t" });
    });
    const booted = await bootWriteEngine();
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    const names: string[] = [];
    const dispatch = booted.engine.gateway.dispatch;
    booted.engine.gateway.dispatch = (name, args) => {
      names.push(name);
      return dispatch(name, args);
    };
    const rows = [store(K1), { key: K2, op: "add_tags", id, tags: `${K2},agent-memory,role:warden` }];
    const { code } = await run("ingest", { in: writeJsonl("s.jsonl", rows), ledger: join(fence.home, "l.jsonl"), json: true });
    expect(code).toBe(0);
    expect(names).toEqual(["igris_memory_store", "igris_memory_update"]);
    expect([...INGEST_TOOLS]).toEqual(["igris_memory_store", "igris_memory_update"]);
  });

  it("I8: no brain exits 3 and nothing is created at brainDbPath()", async () => {
    const input = writeJsonl("n.jsonl", [store(K1)]);
    const ledger = join(fence.home, "stored.jsonl");
    expect((await run("ingest", { in: input, ledger })).code).toBe(3);
    const dry = await run("ingest", { in: input, dryRun: true, json: true });
    expect(dry.code).toBe(3);
    expect(JSON.parse(dry.out)).toMatchObject({ ok: false, dry_run: true, exit: 3, results: [] });
    expect(dry.err).toMatch(/nothing written/);
    expect(existsSync(brainDbPath())).toBe(false);
    expect(existsSync(join(fence.brainDir, "memory"))).toBe(false);
    expect(existsSync(ledger)).toBe(false);
  });
});

describe("TD-496 — ingest --dry-run", () => {
  function matcher(map: Record<string, { id: number; similarity: number }>, available = true, reason: string | null = null): NearestMatcher {
    return {
      available,
      reason,
      match: async (title: string) => map[title] ?? null,
    };
  }

  it("D1: reports key_present, collision (brain + in-file), project_registered, vector_available, nearest — brain unchanged", async () => {
    const ids: Record<string, number> = {};
    await seedBrain((db) => {
      ids.present = insertLearning(db, { title: "present", tags: `${K1},agent-memory,role:warden` });
      ids.colliding = insertLearning(db, { title: "Lesson amx:aaaaaaaaaaa2" });
      ids.same = insertLearning(db, { title: "same project", tags: "role:warden" });
      ids.otherLocal = insertLearning(db, { project: "other", title: "other local" });
      ids.otherGlobal = insertLearning(db, { project: "other", title: "other global", scope: "global" });
      ids.pending = insertLearning(db, { title: "pending", review_status: "pending_review" });
    });
    const before = { sha: sha(brainDbPath()), mtime: statSync(brainDbPath()).mtimeMs };
    const K4 = "amx:aaaaaaaaaaa4";
    const K5 = "amx:aaaaaaaaaaa5";
    const K6 = "amx:aaaaaaaaaaa6";
    const K7 = "amx:aaaaaaaaaaa7";
    const K8 = "amx:aaaaaaaaaaa8";
    const parsed = parseIngestJsonl(
      [
        store(K1),
        store(K2),
        store(K3, { title: "near same" }),
        store(K4, { title: "near other local" }),
        store(K5, { title: "near other global" }),
        store(K6, { title: "near pending", project: "nowhere" }),
        store(K7, { title: "dup in file" }),
        store(K8, { title: "dup in file" }),
      ].map((r) => JSON.stringify(r)).join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const run1 = await dryRunIngest(parsed.rows, {
      matcher: matcher({
        "near same": { id: ids.same, similarity: 0.91 },
        "near other local": { id: ids.otherLocal, similarity: 0.88 },
        "near other global": { id: ids.otherGlobal, similarity: 0.86 },
        "dup in file": { id: ids.pending, similarity: 0.83 },
      }),
    });
    expect(run1.ok).toBe(true);
    if (!run1.ok) return;
    const by = Object.fromEntries(run1.results.map((r) => [r.key, r]));
    expect(by[K1]).toMatchObject({ status: "already-present", key_present: true, id: ids.present, nearest: null });
    expect(by[K2]).toMatchObject({ status: "title-collision", collision: { id: ids.colliding, key: null } });
    expect(by[K3]).toMatchObject({ status: "would-store", project_registered: true, vector_available: true });
    expect(by[K3].nearest).toMatchObject({ id: ids.same, project: "demo", title: "same project", tags: "role:warden", similarity: 0.91, advisory: false });
    expect(by[K4].nearest).toMatchObject({ id: ids.otherLocal, advisory: true });
    expect(by[K5].nearest).toMatchObject({ id: ids.otherGlobal, advisory: false, scope: "global" });
    expect(by[K6]).toMatchObject({ status: "error", error: "unregistered-project:nowhere", project_registered: false });
    expect(by[K7]).toMatchObject({ status: "would-store" });
    expect(by[K7].nearest).toMatchObject({ id: ids.pending, advisory: true });
    expect(by[K8]).toMatchObject({ status: "title-collision", collision: { id: null, key: K7 } });
    for (const r of run1.results) expect(r.vector_available).toBe(true);
    expect({ sha: sha(brainDbPath()), mtime: statSync(brainDbPath()).mtimeMs }).toEqual(before);
  });

  it("D2: an unavailable matcher is reported on every row, never silent", async () => {
    await seedBrain();
    const parsed = parseIngestJsonl(JSON.stringify(store(K1)));
    if (!parsed.ok) throw new Error(parsed.error);
    const r = await dryRunIngest(parsed.rows, { matcher: matcher({}, false, "sqlite-vec not loaded") });
    expect(r.ok && r.results[0]).toMatchObject({ status: "would-store", vector_available: false, vector_reason: "sqlite-vec not loaded", nearest: null });
  });

  it("D3: the REAL matcher path reports vector_available as true or as false WITH a reason", async () => {
    await seedBrain();
    const before = sha(brainDbPath());
    const { code, out } = await run("ingest", { in: writeJsonl("v.jsonl", [store(K1)]), dryRun: true, json: true });
    expect(code).toBe(0);
    const [r] = results(out);
    expect(typeof r.vector_available).toBe("boolean");
    if (r.vector_available === false) expect(r.vector_reason).toMatch(/\S/);
    expect(r.status).toBe("would-store");
    expect(sha(brainDbPath())).toBe(before);
  });

  it("D4: the canonical dedup module resolves from the bundle and loads", async () => {
    const rel = join("engine", "components", "perception", "dedup.js");
    expect(resolveBundleModule(rel), rel).not.toBeNull();
    expect(typeof (await loadNearestMatch())).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// The BUILT CLI as a real process (BR-117 tier): the engine is shut down and
// the embedding pipeline disposed, so the process exits on its own.
// ---------------------------------------------------------------------------

const CLI_ENTRY = join(CLI_DIR, "dist", "index.js");
const DIST_FROM_SRC = ["index", "verbs/lessons", "lib/lessons", "lib/lessons-ingest", "lib/brain-bridge", "lib/brain-db"];
const STRIP_FROM_CHILD = /^(VITEST(_.*)?|TEST|NODE_ENV|NODE_OPTIONS|IGRIS_REAL_HOME)$/;
/** TD-336 spawn half; the suite's 15_000 testTimeout is the test half. */
const INGEST_CHILD_TIMEOUT_MS = 10_000;

function assertDistFresh(): void {
  expect(existsSync(CLI_ENTRY), "cli/dist/index.js is absent — run `npm run build` in cli/").toBe(true);
  for (const m of DIST_FROM_SRC) {
    const js = join(CLI_DIR, "dist", `${m}.js`);
    expect(existsSync(js), `cli/dist/${m}.js is absent — run \`npm run build\` in cli/`).toBe(true);
    expect(statSync(js).mtimeMs >= statSync(join(CLI_DIR, "src", `${m}.ts`)).mtimeMs, `cli/dist is older than src/${m}.ts`).toBe(true);
  }
}

/** A `--import` preload that blocks the model download in the child and writes a receipt. */
function hermeticPreload(): { file: string; receipt: string } {
  const receipt = join(fence.home, "hermetic.json");
  const file = join(fence.home, "no-remote-models.mjs");
  const entry = join(bundledBrainNodeModulesDir(), "@huggingface", "transformers", "dist", "transformers.node.mjs");
  writeFileSync(
    file,
    [
      'import { writeFileSync } from "node:fs";',
      "let armed = false; let reason = 'not attempted';",
      `try { const m = await import(${JSON.stringify(pathToFileURL(entry).href)}); m.env.allowRemoteModels = false; armed = m.env.allowRemoteModels === false; reason = null; }`,
      "catch (e) { reason = String(e && e.message || e); }",
      `writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ armed, reason }));`,
      "",
    ].join("\n"),
  );
  return { file, receipt };
}

function runBuiltCli(args: string[], stdin?: string): Promise<{ status: number | null; signal: string | null; out: string; err: string }> {
  assertDistFresh();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_FROM_CHILD.test(k)) env[k] = v;
  expect(env.HOME).toBe(homedir());
  expect(env.IGRIS_BRAIN_DIR).toBe(join(env.HOME, ".igris"));
  const pre = hermeticPreload();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(pre.file).href, CLI_ENTRY, ...args], {
      cwd: homedir(),
      env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: INGEST_CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const receipt = JSON.parse(readFileSync(pre.receipt, "utf8")) as { armed: boolean; reason: string | null };
      expect(receipt.armed, receipt.reason ?? "").toBe(true);
      resolve({ status, signal, out, err });
    });
  });
}

describe("TD-496 — the BUILT `igris lessons` as a real process", () => {
  it("R1: ingest stores, exits 0 on its own (no hang, never 134); digest then prints the row", async () => {
    await seedBrain();
    const ledger = join(fence.home, "stored.jsonl");
    // Dry run from stdin (`--in -`) on the real matcher path: reported, never silent.
    const dry = await runBuiltCli(["lessons", "ingest", "--in", "-", "--dry-run", "--json"], JSON.stringify(store(K1)) + "\n");
    expect(dry.status, dry.err).toBe(0);
    const [d] = results(dry.out);
    expect(d).toMatchObject({ key: K1, status: "would-store", project_registered: true });
    expect(typeof d.vector_available).toBe("boolean");
    if (d.vector_available === false) expect(d.vector_reason).toMatch(/\S/);
    expect(dry.err).toMatch(/^lessons ingest --dry-run: 1 rows — would-store 1, /m);
    const ing = await runBuiltCli(["lessons", "ingest", "--in", writeJsonl("p.jsonl", [store(K1)]), "--ledger", ledger, "--json"]);
    const why = `status=${ing.status} signal=${ing.signal}\n${ing.out}\n${ing.err}`;
    expect(ing.status, why).toBe(0);
    expect(ing.signal).toBeNull();
    expect(results(ing.out)[0]).toMatchObject({ key: K1, status: "stored" });
    expect(readLedger(ledger)).toHaveLength(1);

    const dg = await runBuiltCli(["lessons", "digest", "--role", "warden", "--project", "demo"]);
    expect(dg.status, dg.err).toBe(0);
    expect(dg.out).toMatch(/^Role lessons \(warden\): 1 of 1 for demo\.\n- L-\d+ Lesson amx:aaaaaaaaaaa1 — Hook for amx:aaaaaaaaaaa1\n/);
  });
});
