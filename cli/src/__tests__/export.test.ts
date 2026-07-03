/**
 * FR-229 — `igris export` producer tests.
 *
 * Each case runs against a REAL seeded tmp brain DB (IGRIS_BRAIN_DIR sandboxed) +
 * a fixture context dir on disk, then packs a real `.igris-pack.tar.gz` and
 * extracts it to assert the round-trip. We NEVER mock better-sqlite3 or `tar`
 * (L-159: they are the modules-under-test's own dependencies). `closeDb()` runs
 * between cases so the accessor re-opens the swapped sandbox (the brain-db.test
 * precedent).
 *
 * Maps to the FR-229 Acceptance Criteria: standard round-trip, tier selection,
 * approved-only learnings, claim-state stripped, redaction/no-abs-path leak,
 * cross-project edge exclusion, content_hash correctness, --since, missing-table
 * degrade, missing-DB hard-fail, exclusions absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { x as tarExtract } from "tar";
import { runExport, buildExport } from "../verbs/export.js";
import { closeDb } from "../lib/brain-db.js";

let tmpRoot: string;
let prevBrainDir: string | undefined;

// --- schema (copied from the brain's authoritative DDL) -------------------

const BRIEF_STATUS_DDL = `
  CREATE TABLE brief_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    brief_type TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT,
    effort TEXT,
    phase TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_by TEXT,
    claimed_at TEXT,
    UNIQUE(project, brief_id)
  );
`;

const BRIEF_FILES_DDL = `
  CREATE TABLE brief_files (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    brief_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project, brief_id)
  );
`;

const ENTITY_EDGES_DDL = `
  CREATE TABLE entity_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_type TEXT NOT NULL,
    from_id   TEXT NOT NULL,
    to_type   TEXT NOT NULL,
    to_id     TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    provenance TEXT NOT NULL DEFAULT 'observed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata   TEXT NOT NULL DEFAULT '{}',
    UNIQUE(from_type, from_id, to_type, to_id, edge_type)
  );
`;

const GOALS_DDL = `
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT NOT NULL UNIQUE,
    project_slug TEXT,
    title TEXT NOT NULL,
    description TEXT,
    outcome TEXT NOT NULL,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    priority TEXT NOT NULL DEFAULT 'P2-Medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    achieved_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );
`;

const LEARNINGS_DDL = `
  CREATE TABLE learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '',
    tech_stack TEXT DEFAULT '',
    scope TEXT DEFAULT 'local',
    source_brief TEXT DEFAULT '',
    confidence REAL DEFAULT 0.8,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0,
    last_accessed_at TEXT,
    review_status TEXT DEFAULT 'approved',
    provenance TEXT DEFAULT 'human_asserted',
    source_extractor TEXT,
    promoted_to_doc TEXT
  );
`;

const ERRORS_DDL = `
  CREATE TABLE errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    message TEXT NOT NULL,
    solution TEXT DEFAULT '',
    context TEXT DEFAULT '',
    tech_stack TEXT DEFAULT '',
    scope TEXT DEFAULT 'local',
    occurrence_count INTEGER DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
`;

const GRAPH_NODES_DDL = `
  CREATE TABLE graph_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_type TEXT NOT NULL,
    node_external_id TEXT NOT NULL,
    label TEXT NOT NULL,
    properties TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(node_type, node_external_id)
  );
`;

const ALL_DDL = [
  BRIEF_STATUS_DDL,
  BRIEF_FILES_DDL,
  ENTITY_EDGES_DDL,
  GOALS_DDL,
  LEARNINGS_DDL,
  ERRORS_DDL,
  GRAPH_NODES_DDL,
];

/** Open the sandboxed brain DB and run a seed callback against it. */
function seedBrain(fn: (db: Database.Database) => void): void {
  const dbDir = join(tmpRoot, "memory");
  mkdirSync(dbDir, { recursive: true });
  const seed = new Database(join(dbDir, "knowledge.db"));
  seed.pragma("journal_mode = WAL");
  fn(seed);
  seed.close();
}

/** Seed the full schema + a canonical project ("acme") plus a foreign project. */
function seedCanonical(): void {
  seedBrain((db) => {
    for (const ddl of ALL_DDL) db.exec(ddl);

    // brief_status — two acme briefs (+ claim-state that MUST be stripped) and
    // one foreign-project brief.
    db.prepare(
      `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at, claimed_by, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("acme", "FR-1", "Feature", "First", "Done", "P1", "M", "COMPLETE", "2026-06-01 10:00:00", "worker-9", "2026-06-01 09:00:00");
    db.prepare(
      `INSERT INTO brief_status
       (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("acme", "FR-2", "Feature", "Second", "Open", "P2", "S", "PLANNING", "2026-06-10 10:00:00");
    db.prepare(
      `INSERT INTO brief_status
       (project, brief_id, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("other", "FR-99", "Foreign", "Open", "2026-06-10 10:00:00");

    // brief_files — one acme brief file.
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("bf1", "acme", "FR-1", "FR-1.md", "brief body one", "stale-hash", "2026-06-01 10:00:00");

    // entity_edges — a brief↔brief edge within acme, and one to the foreign brief.
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, created_at)
       VALUES ('brief','FR-1','brief','FR-2','relates_to','2026-06-05 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, created_at)
       VALUES ('brief','FR-1','brief','FR-99','relates_to','2026-06-05 10:00:00')`,
    ).run();

    // goals — one acme goal, one foreign.
    db.prepare(
      `INSERT INTO goals (goal_id, project_slug, title, outcome, status, updated_at)
       VALUES ('G-1','acme','Ship it','shipped','active','2026-06-02 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO goals (goal_id, project_slug, title, outcome, status, updated_at)
       VALUES ('G-9','other','Foreign goal','x','active','2026-06-02 10:00:00')`,
    ).run();

    // learnings — one approved acme, one pending acme, one foreign approved.
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, review_status, created_at)
       VALUES ('acme','pattern','Good','approved body','approved','2026-06-03 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, review_status, created_at)
       VALUES ('acme','pattern','Pending','pending body','pending','2026-06-03 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, review_status, created_at)
       VALUES ('other','pattern','Foreign','x','approved','2026-06-03 10:00:00')`,
    ).run();

    // errors — one acme error.
    db.prepare(
      `INSERT INTO errors (project, fingerprint, message, last_seen_at)
       VALUES ('acme','fp-1','boom','2026-06-04 10:00:00')`,
    ).run();

    // graph_nodes — one acme concept, one foreign concept.
    db.prepare(
      `INSERT INTO graph_nodes (node_type, node_external_id, label, properties)
       VALUES ('concept','c-acme','Acme concept', json('{"project":"acme"}'))`,
    ).run();
    db.prepare(
      `INSERT INTO graph_nodes (node_type, node_external_id, label, properties)
       VALUES ('concept','c-other','Foreign concept', json('{"project":"other"}'))`,
    ).run();
    // A concept edge touching the acme concept.
    db.prepare(
      `INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type, created_at)
       VALUES ('concept','c-acme','brief','FR-1','explains','2026-06-06 10:00:00')`,
    ).run();
  });
}

/** Write fixture context docs into the sandboxed project context dir. */
function seedContextDocs(): void {
  const dir = join(tmpRoot, "projects", "acme", "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "coding_guidelines.md"), "# Guidelines\n");
  writeFileSync(join(dir, "architecture_map.md"), "# Arch\n");
}

/** Extract a produced tarball into a fresh temp dir and return its root path. */
async function extract(tarPath: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "igris-export-extract-"));
  await tarExtract({ file: tarPath, cwd: out });
  return out;
}

/** Read a JSON data store file from an extracted bundle. */
function readStore(root: string, name: string): Record<string, unknown>[] {
  return JSON.parse(readFileSync(join(root, "data", `${name}.json`), "utf-8"));
}

function readManifest(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
}

beforeEach(() => {
  prevBrainDir = process.env.IGRIS_BRAIN_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-export-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  closeDb();
});

afterEach(() => {
  closeDb();
  if (prevBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrainDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("igris export — standard tier round-trip", () => {
  it("produces a valid gzip tar with manifest + data + context; briefs/goals round-trip; NO learnings", async () => {
    seedCanonical();
    seedContextDocs();
    const out = join(tmpRoot, "acme.igris-pack.tar.gz");

    const code = await runExport({ project: "acme", out, json: false });
    expect(code).toBe(0);

    const root = await extract(out);
    const manifest = readManifest(root);
    expect(manifest.format).toBe("igris-pack");
    expect(manifest.tier).toBe("standard");

    const briefStatus = readStore(root, "brief_status");
    expect(briefStatus.map((r) => r.brief_id).sort()).toEqual(["FR-1", "FR-2"]);
    const goals = readStore(root, "goals");
    expect(goals.map((r) => r.goal_id)).toEqual(["G-1"]);

    // learnings.json is ABSENT at standard tier.
    expect(() => readStore(root, "learnings")).toThrow();
    // context docs present.
    expect(readFileSync(join(root, "context", "coding_guidelines.md"), "utf-8")).toContain("Guidelines");
  });
});

describe("igris export — tier selection", () => {
  it("core omits edges/goals/context; full includes approved-only learnings + errors + concept-graph", async () => {
    seedCanonical();
    seedContextDocs();

    // core
    const coreOut = join(tmpRoot, "core.tar.gz");
    expect(await runExport({ project: "acme", out: coreOut, tier: "core", json: false })).toBe(0);
    const coreRoot = await extract(coreOut);
    expect(readStore(coreRoot, "brief_status").length).toBe(2);
    expect(() => readStore(coreRoot, "goals")).toThrow();
    expect(() => readStore(coreRoot, "entity_edges")).toThrow();

    // full
    const fullOut = join(tmpRoot, "full.tar.gz");
    expect(await runExport({ project: "acme", out: fullOut, tier: "full", json: false })).toBe(0);
    const fullRoot = await extract(fullOut);

    const learnings = readStore(fullRoot, "learnings");
    expect(learnings.map((r) => r.title)).toEqual(["Good"]); // approved only
    expect(readStore(fullRoot, "errors").map((r) => r.fingerprint)).toEqual(["fp-1"]);
    expect(readStore(fullRoot, "graph_nodes").map((r) => r.node_external_id)).toEqual(["c-acme"]);
    expect(readStore(fullRoot, "concept_edges").length).toBe(1);
  });
});

describe("igris export — column whitelist (#213) + claim-state strip", () => {
  it("brief_status rows carry exactly the whitelisted keys; claimed_* NEVER present", async () => {
    seedCanonical();
    const out = join(tmpRoot, "acme.tar.gz");
    await runExport({ project: "acme", out, json: false });
    const root = await extract(out);
    const rows = readStore(root, "brief_status");
    const keys = Object.keys(rows[0]).sort();
    expect(keys).toEqual(
      ["brief_id", "brief_type", "effort", "phase", "priority", "project", "status", "title", "updated_at"].sort(),
    );
    for (const r of rows) {
      expect(r).not.toHaveProperty("claimed_by");
      expect(r).not.toHaveProperty("claimed_at");
    }
  });
});

describe("igris export — redaction / no absolute-path leak", () => {
  it("manifest carries only the slug (no absolute path) and no home path leaks into the bundle", async () => {
    seedCanonical();
    seedContextDocs();
    const out = join(tmpRoot, "acme.tar.gz");
    await runExport({ project: "acme", out, tier: "full", json: false });
    const root = await extract(out);
    const manifest = readManifest(root);

    expect(manifest.project).toEqual({ slug: "acme" });
    expect((manifest.redaction as { applied: boolean }).applied).toBe(true);

    // No home-absolute path anywhere in the manifest text.
    const manifestText = readFileSync(join(root, "manifest.json"), "utf-8");
    expect(manifestText).not.toContain(homedir());
  });
});

describe("igris export — brief-graph scoping", () => {
  it("excludes edges to a foreign-project brief; includes intra-project brief↔brief edges", async () => {
    seedCanonical();
    const out = join(tmpRoot, "acme.tar.gz");
    await runExport({ project: "acme", out, json: false });
    const root = await extract(out);
    const edges = readStore(root, "entity_edges");
    // Only the FR-1 -> FR-2 edge; the FR-1 -> FR-99 (foreign) edge is excluded.
    expect(edges.length).toBe(1);
    expect(edges[0].to_id).toBe("FR-2");
  });
});

describe("igris export — content_hash correctness", () => {
  it("manifest content_hashes[brief_id] == sha256(content), not the stale stored hash", async () => {
    seedCanonical();
    const out = join(tmpRoot, "acme.tar.gz");
    await runExport({ project: "acme", out, json: false });
    const root = await extract(out);
    const manifest = readManifest(root);
    const desc = (manifest.stores as Record<string, { content_hashes: Record<string, string> }>).brief_files;
    const expected = createHash("sha256").update("brief body one").digest("hex");
    expect(desc.content_hashes["FR-1"]).toBe(expected);
    // The stored (stale) hash must NOT be surfaced.
    expect(desc.content_hashes["FR-1"]).not.toBe("stale-hash");
  });
});

describe("igris export — --since filter", () => {
  it("excludes rows older than the cutoff by each store's timestampCol", async () => {
    seedCanonical();
    const out = join(tmpRoot, "acme.tar.gz");
    // FR-1 updated 2026-06-01, FR-2 updated 2026-06-10.
    await runExport({ project: "acme", out, since: "2026-06-05", json: false });
    const root = await extract(out);
    const rows = readStore(root, "brief_status");
    expect(rows.map((r) => r.brief_id)).toEqual(["FR-2"]);
  });
});

describe("igris export — missing-table degrade (#133, create-never)", () => {
  it("absent brief_files/goals/entity_edges tables → empty stores, valid bundle, no throw", async () => {
    // Seed ONLY brief_status (no other tables).
    seedBrain((db) => {
      db.exec(BRIEF_STATUS_DDL);
      db.prepare(
        `INSERT INTO brief_status (project, brief_id, title, status, updated_at)
         VALUES ('acme','FR-1','Only','Open','2026-06-01 10:00:00')`,
      ).run();
    });
    const out = join(tmpRoot, "acme.tar.gz");
    const code = await runExport({ project: "acme", out, json: false });
    expect(code).toBe(0);
    const root = await extract(out);
    expect(readStore(root, "brief_status").length).toBe(1);
    expect(readStore(root, "brief_files")).toEqual([]);
    expect(readStore(root, "goals")).toEqual([]);
    expect(readStore(root, "entity_edges")).toEqual([]);
  });
});

describe("igris export — missing brain DB is a HARD failure", () => {
  it("returns non-zero when the brain DB is absent (unlike assess)", async () => {
    // No seedBrain → knowledge.db does not exist.
    const out = join(tmpRoot, "acme.tar.gz");
    const code = await runExport({ project: "acme", out, json: false });
    expect(code).toBe(1);
  });
});

describe("igris export — exclusions self-described + absent from data/", () => {
  it("manifest.excluded lists never-exported stores; none appear as data files", async () => {
    seedCanonical();
    const out = join(tmpRoot, "acme.tar.gz");
    await runExport({ project: "acme", out, tier: "full", json: false });
    const root = await extract(out);
    const manifest = readManifest(root);
    const excluded = manifest.excluded as string[];
    expect(excluded).toContain("instances");
    expect(excluded).toContain("session_files");
    expect(excluded).toContain("embeddings");
    for (const name of excluded) {
      expect(() => readStore(root, name)).toThrow();
      expect(manifest.stores as Record<string, unknown>).not.toHaveProperty(name);
    }
  });
});

describe("igris export — buildExport checksum is deterministic over payload", () => {
  it("same seed → identical checksum across two builds", () => {
    seedCanonical();
    seedContextDocs();
    const a = buildExport("acme", "full", [], undefined);
    closeDb();
    const b = buildExport("acme", "full", [], undefined);
    expect(a.digest.checksum).toBe(b.digest.checksum);
    expect(a.digest.checksum.length).toBe(64);
  });
});
