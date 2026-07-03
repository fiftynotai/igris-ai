/**
 * FR-230 — `igris import` consumer tests.
 *
 * Fixtures are built by driving the REAL `runExport` (the FR-229 producer) into
 * a sandboxed brain DB (IGRIS_BRAIN_DIR), mutating the sandbox, then `runImport`
 * — a genuine round-trip. Only the executable-surface + checksum-tamper cases
 * hand-craft a bundle (they exercise the reject paths a valid producer can't
 * emit). We NEVER mock better-sqlite3 or `tar` (L-159). `closeDb()` runs between
 * cases so the accessors re-open the swapped sandbox. The projects/ledger dir is
 * isolated by the SAME IGRIS_BRAIN_DIR seam, so the CLI-local import ledger +
 * context dir land inside the sandbox.
 *
 * Maps to the FR-230 Acceptance Criteria: dry-run zero-writes, each policy, the
 * ancestor-based conflict truth table (NOT timestamp), idempotent re-import,
 * checksum-reject, executable-surface reject, claim-state never written,
 * context-doc conflict-protection + backup, the hand-off/hand-back round-trip,
 * and `--as` fresh-slug all-NEW.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { c as tarCreate, x as tarExtract } from "tar";
import { runExport } from "../verbs/export.js";
import { runImport } from "../verbs/import.js";
import { closeDb } from "../lib/brain-db.js";

let tmpRoot: string;
let prevBrainDir: string | undefined;

// --- schema (copied from the brain's authoritative DDL, per export.test.ts) ---

// The real brain schema: brief_status carries a FK to projects(slug)
// (brain-mcp-server/src/db.ts:294). Mirror it so the FK precondition is
// exercised (C4) — the importer enforces `foreign_keys = ON` for the apply.
const PROJECTS_DDL = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    tech_stack TEXT DEFAULT '',
    igris_version TEXT DEFAULT '4.0.0',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'inactive')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_session_at TEXT,
    metadata TEXT DEFAULT '{}'
  );
`;

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
    UNIQUE(project, brief_id),
    FOREIGN KEY (project) REFERENCES projects(slug)
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
  PROJECTS_DDL,
  BRIEF_STATUS_DDL,
  BRIEF_FILES_DDL,
  ENTITY_EDGES_DDL,
  GOALS_DDL,
  LEARNINGS_DDL,
  ERRORS_DDL,
  GRAPH_NODES_DDL,
];

/**
 * Open the sandboxed brain DB and run a seed/mutate callback against it.
 *
 * better-sqlite3 enables `foreign_keys` by default; this is a FIXTURE-seeding
 * connection (it pre-loads brief rows before a project row exists), so FK is
 * turned OFF here. The REAL enforcement path is `runImport` → `getDb`, which
 * keeps FK ON and auto-registers the project in-txn (C2) — that is what the
 * FK-precondition tests exercise.
 */
function withBrain(fn: (db: Database.Database) => void): void {
  const dbDir = join(tmpRoot, "memory");
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(join(dbDir, "knowledge.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");
  fn(db);
  db.close();
}

function schema(db: Database.Database): void {
  for (const ddl of ALL_DDL) db.exec(ddl);
}

/** Seed a canonical "acme" project with a couple briefs + a goal + a learning. */
function seedCanonical(): void {
  withBrain((db) => {
    schema(db);
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at, claimed_by, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("acme", "FR-1", "Feature", "First", "Done", "P1", "M", "COMPLETE", "2026-06-01 10:00:00", "worker-9", "2026-06-01 09:00:00");
    db.prepare(
      `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("acme", "FR-2", "Feature", "Second", "Open", "P2", "S", "PLANNING", "2026-06-10 10:00:00");
    db.prepare(
      `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("bf1", "acme", "FR-1", "FR-1.md", "brief body one", createHash("sha256").update("brief body one").digest("hex"), "2026-06-01 10:00:00");
    db.prepare(
      `INSERT INTO goals (goal_id, project_slug, title, outcome, status, updated_at)
       VALUES ('G-1','acme','Ship it','shipped','active','2026-06-02 10:00:00')`,
    ).run();
    db.prepare(
      `INSERT INTO learnings (project, category, title, content, tags, review_status, created_at, updated_at)
       VALUES ('acme','pattern','Good','approved body','a,b','approved','2026-06-03 10:00:00','2026-06-03 10:00:00')`,
    ).run();
  });
}

function seedContextDocs(): void {
  const dir = join(tmpRoot, "projects", "acme", "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "coding_guidelines.md"), "# Guidelines v1\n");
  writeFileSync(join(dir, "architecture_map.md"), "# Arch v1\n");
}

/** Produce a bundle from the current sandbox brain (real FR-229 export). */
async function exportBundle(tier: "core" | "standard" | "full" = "full"): Promise<string> {
  const out = join(tmpRoot, `acme-${Math.random().toString(36).slice(2)}.igris-pack.tar.gz`);
  const code = await runExport({ project: "acme", out, tier, json: false });
  expect(code).toBe(0);
  closeDb();
  return out;
}

/** Wipe the brain to an empty schema (so an import lands as all-NEW). */
function resetBrainEmptySchema(): void {
  rmSync(join(tmpRoot, "memory"), { recursive: true, force: true });
  withBrain((db) => schema(db));
  closeDb();
}

function openBrainRead(): Database.Database {
  return new Database(join(tmpRoot, "memory", "knowledge.db"), { readonly: true });
}

function briefTitle(project: string, briefId: string): string | undefined {
  const db = openBrainRead();
  try {
    const row = db.prepare("SELECT title FROM brief_status WHERE project=? AND brief_id=?").get(project, briefId) as { title: string } | undefined;
    return row?.title;
  } finally {
    db.close();
  }
}

function countBriefs(project: string): number {
  const db = openBrainRead();
  try {
    return (db.prepare("SELECT COUNT(*) c FROM brief_status WHERE project=?").get(project) as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Read the manifest checksum out of a produced bundle. */
async function bundleChecksum(bundlePath: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "igris-import-peek-"));
  try {
    await tarExtract({ file: bundlePath, cwd: out });
    return (JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")) as { checksum: string }).checksum;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Repack an extracted staging dir into a bundle (recomputing NO checksum — used for tamper). */
async function repack(stageDir: string, outPath: string): Promise<void> {
  const entries: string[] = [];
  const walk = (abs: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) entries.push(relative(stageDir, child).split(sep).join("/"));
    }
  };
  walk(stageDir);
  await tarCreate({ gzip: true, file: outPath, cwd: stageDir, portable: true, noMtime: true }, entries.sort());
}

/** Recompute export.ts's payloadChecksum over a stage dir (sorted path\0content\0, manifest excluded). */
function recomputePayloadChecksum(stageDir: string): string {
  const rels: string[] = [];
  const walk = (abs: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) rels.push(relative(stageDir, child).split(sep).join("/"));
    }
  };
  walk(stageDir);
  const hash = createHash("sha256");
  for (const rel of rels.sort()) {
    if (rel === "manifest.json") continue;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(stageDir, rel), "utf-8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Extract a bundle, run an edit callback over the stage dir + its parsed
 * manifest, recompute the payload checksum so the tampered bundle passes the
 * integrity check, and repack. Returns the new bundle path.
 */
async function restage(
  bundle: string,
  outName: string,
  edit: (stageDir: string, manifest: Record<string, unknown>) => void,
): Promise<string> {
  const stage = mkdtempSync(join(tmpdir(), "igris-import-restage-"));
  await tarExtract({ file: bundle, cwd: stage });
  const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf-8")) as Record<string, unknown>;
  edit(stage, manifest);
  // Recompute the checksum AFTER edits so the bundle is internally consistent.
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...manifest, checksum: "PLACEHOLDER" }, null, 2) + "\n");
  const checksum = recomputePayloadChecksum(stage);
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...manifest, checksum }, null, 2) + "\n");
  const out = join(tmpRoot, outName);
  await repack(stage, out);
  rmSync(stage, { recursive: true, force: true });
  return out;
}

function projectRow(slug: string): { slug: string; path: string; name: string } | undefined {
  const db = openBrainRead();
  try {
    return db.prepare("SELECT slug, path, name FROM projects WHERE slug=?").get(slug) as
      | { slug: string; path: string; name: string }
      | undefined;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  prevBrainDir = process.env.IGRIS_BRAIN_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "igris-import-brain-"));
  process.env.IGRIS_BRAIN_DIR = tmpRoot;
  closeDb();
});

afterEach(() => {
  closeDb();
  if (prevBrainDir === undefined) delete process.env.IGRIS_BRAIN_DIR;
  else process.env.IGRIS_BRAIN_DIR = prevBrainDir;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- AC1: dry-run zero writes ------------------------------------------------

describe("igris import — dry-run writes nothing", () => {
  it("classifies + previews but leaves the DB untouched and writes no ledger", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    expect(countBriefs("acme")).toBe(0);
    const code = await runImport({ bundle, dryRun: true, json: false });
    expect(code).toBe(0);
    // Zero writes.
    expect(countBriefs("acme")).toBe(0);
    // No ledger written.
    expect(existsSync(join(tmpRoot, "projects", "acme", "imports"))).toBe(false);
  });
});

// --- AC2 / round-trip: theirs applies all NEW + updates ----------------------

describe("igris import — theirs policy applies deterministically (no prompt)", () => {
  it("lands NEW briefs into an empty brain of the same slug", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    const code = await runImport({ bundle, onConflict: "theirs", json: false });
    expect(code).toBe(0);
    expect(countBriefs("acme")).toBe(2);
    expect(briefTitle("acme", "FR-1")).toBe("First");
    expect(briefTitle("acme", "FR-2")).toBe("Second");
  });
});

// --- AC6: claim-state never written; exec-surface store rejected -------------

describe("igris import — claim-state never written (AC6/AC7)", () => {
  it("imported brief_status rows have NULL claimed_by/claimed_at", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    await runImport({ bundle, onConflict: "theirs", json: false });
    const db = openBrainRead();
    try {
      const row = db.prepare("SELECT claimed_by, claimed_at FROM brief_status WHERE project='acme' AND brief_id='FR-1'").get() as { claimed_by: unknown; claimed_at: unknown };
      expect(row.claimed_by).toBeNull();
      expect(row.claimed_at).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("igris import — executable-surface store rejected (AC9)", () => {
  it("a bundle declaring a 'skills' store is rejected with zero writes", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    // Hand-tamper the manifest to declare an executable-surface store.
    const stage = mkdtempSync(join(tmpdir(), "igris-import-mal-"));
    await tarExtract({ file: bundle, cwd: stage });
    const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf-8")) as Record<string, unknown>;
    (manifest.stores as Record<string, unknown>).skills = { file: "data/skills.json", count: 0, table: "skills", columns: ["name"], syncKey: ["name"], strategy: "lww" };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const malicious = join(tmpRoot, "malicious.igris-pack.tar.gz");
    await repack(stage, malicious);
    rmSync(stage, { recursive: true, force: true });

    const code = await runImport({ bundle: malicious, onConflict: "theirs", json: false });
    expect(code).toBe(1);
    expect(countBriefs("acme")).toBe(0);
  });
});

// --- AC8: checksum tamper + corrupt gzip + missing DB ------------------------

describe("igris import — corrupt/tampered bundle is a hard failure with zero writes (AC8)", () => {
  it("a checksum-mismatched bundle exits non-zero and writes nothing", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    // Tamper a payload file WITHOUT updating manifest.checksum → mismatch.
    const stage = mkdtempSync(join(tmpdir(), "igris-import-tamper-"));
    await tarExtract({ file: bundle, cwd: stage });
    const briefStatusPath = join(stage, "data", "brief_status.json");
    const rows = JSON.parse(readFileSync(briefStatusPath, "utf-8")) as Record<string, unknown>[];
    rows[0].title = "TAMPERED";
    writeFileSync(briefStatusPath, JSON.stringify(rows, null, 2) + "\n");
    const tampered = join(tmpRoot, "tampered.igris-pack.tar.gz");
    await repack(stage, tampered);
    rmSync(stage, { recursive: true, force: true });

    const code = await runImport({ bundle: tampered, onConflict: "theirs", json: false });
    expect(code).toBe(1);
    expect(countBriefs("acme")).toBe(0);
  });

  it("a corrupt gzip exits non-zero", async () => {
    withBrain((db) => schema(db));
    closeDb();
    const corrupt = join(tmpRoot, "corrupt.igris-pack.tar.gz");
    writeFileSync(corrupt, "this is not gzip");
    const code = await runImport({ bundle: corrupt, onConflict: "theirs", json: false });
    expect(code).toBe(1);
  });

  it("a missing brain DB is a hard failure (exit 1)", async () => {
    // No brain DB file at all.
    const fake = join(tmpRoot, "whatever.tar.gz");
    writeFileSync(fake, "x");
    const code = await runImport({ bundle: fake, onConflict: "theirs", json: false });
    expect(code).toBe(1);
  });
});

// --- AC5: idempotent re-import ----------------------------------------------

describe("igris import — idempotent re-import (AC5)", () => {
  it("importing the same bundle twice is a no-op the second time", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    expect(await runImport({ bundle, onConflict: "theirs", json: false })).toBe(0);
    expect(countBriefs("acme")).toBe(2);

    // Second import: bundle-applied short-circuit.
    expect(await runImport({ bundle, onConflict: "theirs", json: false })).toBe(0);
    expect(countBriefs("acme")).toBe(2);
    expect(briefTitle("acme", "FR-1")).toBe("First");
  });

  it("row-level UNCHANGED holds idempotency even with the ledger removed", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();

    await runImport({ bundle, onConflict: "theirs", json: false });
    closeDb();
    // Nuke the ledger → the bundle-applied short-circuit is gone.
    rmSync(join(tmpRoot, "projects", "acme", "imports"), { recursive: true, force: true });

    expect(await runImport({ bundle, onConflict: "theirs", json: false })).toBe(0);
    expect(countBriefs("acme")).toBe(2);
    expect(briefTitle("acme", "FR-1")).toBe("First");
  });
});

// --- AC3: ancestor-based conflict truth table (NOT timestamp) ----------------

describe("igris import — ancestor-based classification (AC3)", () => {
  /**
   * Seed a shared ancestor via a first import, then diverge one/both sides and
   * observe the DB result under a probing policy. LOCAL_ONLY keeps mine under
   * BOTH `theirs` and `mine` (policy governs CONFLICT only); CONFLICT flips with
   * the policy. That pair distinguishes the classes without parsing the digest.
   */
  it("INCOMING (only theirs advanced) fast-forwards even under 'mine'", async () => {
    seedCanonical();
    const bundle1 = await exportBundle();
    resetBrainEmptySchema();
    await runImport({ bundle: bundle1, onConflict: "theirs", json: false }); // seed ancestor
    closeDb();

    // Colleague advances FR-2 only; local untouched → INCOMING.
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='Second-EDITED', updated_at='2026-06-11 10:00:00' WHERE project='acme' AND brief_id='FR-2'").run();
    });
    const bundle2 = await exportBundle();
    // Restore local FR-2 to the ancestor title so only THEIRS differs.
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='Second', updated_at='2026-06-10 10:00:00' WHERE project='acme' AND brief_id='FR-2'").run();
    });
    closeDb();

    // INCOMING resolves regardless of policy → title becomes theirs even under mine.
    expect(await runImport({ bundle: bundle2, onConflict: "mine", json: false })).toBe(0);
    expect(briefTitle("acme", "FR-2")).toBe("Second-EDITED");
  });

  it("LOCAL_ONLY (only mine advanced) keeps mine even under 'theirs' + newer timestamp", async () => {
    seedCanonical();
    const bundle1 = await exportBundle();
    resetBrainEmptySchema();
    await runImport({ bundle: bundle1, onConflict: "theirs", json: false }); // seed ancestor (title 'Second')
    closeDb();

    // Local advances FR-2 with a NEWER updated_at; the bundle stays the ancestor.
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='Mine-Only', updated_at='2027-01-01 10:00:00' WHERE project='acme' AND brief_id='FR-2'").run();
    });
    closeDb();

    // bundle1 is stale (== ancestor). Under 'theirs', LOCAL_ONLY must NOT revert
    // to stale data — and a newer local updated_at must NOT matter (ancestor-based).
    expect(await runImport({ bundle: bundle1, onConflict: "theirs", json: false })).toBe(0);
    expect(briefTitle("acme", "FR-2")).toBe("Mine-Only");
  });

  it("CONFLICT (both diverged) is policy-governed: mine keeps local, theirs takes bundle", async () => {
    seedCanonical();
    const bundle1 = await exportBundle();
    resetBrainEmptySchema();
    await runImport({ bundle: bundle1, onConflict: "theirs", json: false }); // seed ancestor
    closeDb();

    // Colleague edits FR-2 → re-export (bundle diverged from ancestor).
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='Theirs-Edit', updated_at='2026-06-12 10:00:00' WHERE project='acme' AND brief_id='FR-2'").run();
    });
    const bundle2 = await exportBundle();
    // Local ALSO diverges (both changed) → CONFLICT.
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='Mine-Edit', updated_at='2026-06-13 10:00:00' WHERE project='acme' AND brief_id='FR-2'").run();
    });
    closeDb();

    // mine → keep local.
    expect(await runImport({ bundle: bundle2, onConflict: "mine", json: false })).toBe(0);
    expect(briefTitle("acme", "FR-2")).toBe("Mine-Edit");

    // theirs → take bundle (re-import: idempotency short-circuit is per-checksum,
    // and this checksum was applied under 'mine' — so wipe the applied-marker to
    // let the theirs pass re-resolve the same conflict).
    closeDb();
    const importsDir = join(tmpRoot, "projects", "acme", "imports");
    for (const f of readdirSync(importsDir)) {
      if (f.endsWith(".json") && f !== "index.json") rmSync(join(importsDir, f));
    }
    expect(await runImport({ bundle: bundle2, onConflict: "theirs", json: false })).toBe(0);
    expect(briefTitle("acme", "FR-2")).toBe("Theirs-Edit");
  });
});

// --- AC4: provenance / ancestor ledger --------------------------------------

describe("igris import — provenance ledger (AC4)", () => {
  it("the per-bundle record lists imported (store,key)s and the ancestor index carries the fingerprint", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    const checksum = await bundleChecksum(bundle);
    resetBrainEmptySchema();

    await runImport({ bundle, onConflict: "theirs", json: false });

    const importsDir = join(tmpRoot, "projects", "acme", "imports");
    const record = JSON.parse(readFileSync(join(importsDir, `${checksum}.json`), "utf-8")) as {
      checksum: string;
      source_fingerprint: string;
      rows: { store: string; key: string; hash: string }[];
    };
    expect(record.checksum).toBe(checksum);
    expect(record.source_fingerprint).toContain("acme@");
    const briefKeys = record.rows.filter((r) => r.store === "brief_status").map((r) => r.key);
    // The row key joins syncKey values with the NUL unit separator.
    expect(briefKeys.some((k) => k.startsWith("acme") && k.endsWith("FR-1"))).toBe(true);
    expect(briefKeys.some((k) => k.startsWith("acme") && k.endsWith("FR-2"))).toBe(true);

    const index = JSON.parse(readFileSync(join(importsDir, "index.json"), "utf-8")) as Record<string, { fingerprint: string }>;
    const idxKey = Object.keys(index).find((k) => k.startsWith("brief_status") && k.endsWith("FR-1"));
    expect(idxKey).toBeDefined();
    expect(index[idxKey as string].fingerprint).toContain("acme@");
  });
});

// --- AC7: context docs land + conflict-protection + backup -------------------

describe("igris import — context docs (AC7)", () => {
  it("standard-tier context docs land as files under the project context dir", async () => {
    seedCanonical();
    seedContextDocs();
    const bundle = await exportBundle("standard");
    resetBrainEmptySchema();
    // Also remove the seeded context docs so they classify NEW.
    rmSync(join(tmpRoot, "projects", "acme", "context"), { recursive: true, force: true });

    await runImport({ bundle, onConflict: "theirs", json: false });
    const landed = readFileSync(join(tmpRoot, "projects", "acme", "context", "coding_guidelines.md"), "utf-8");
    expect(landed).toContain("Guidelines v1");
  });

  it("a locally-edited context doc is CONFLICT-protected under 'mine' and backed up under 'theirs'", async () => {
    seedCanonical();
    seedContextDocs();
    const bundle = await exportBundle("standard");
    closeDb();

    // Locally edit the doc AFTER export → local differs from bundle, no ancestor → CONFLICT.
    const docPath = join(tmpRoot, "projects", "acme", "context", "coding_guidelines.md");
    writeFileSync(docPath, "# Guidelines LOCAL EDIT\n");

    // mine → keep the local edit (not clobbered).
    expect(await runImport({ bundle, onConflict: "mine", json: false })).toBe(0);
    expect(readFileSync(docPath, "utf-8")).toContain("LOCAL EDIT");

    // theirs → overwrite with the bundle version AND back up the prior local file.
    closeDb();
    const importsDir = join(tmpRoot, "projects", "acme", "imports");
    for (const f of readdirSync(importsDir)) {
      if (f.endsWith(".json") && f !== "index.json") rmSync(join(importsDir, f));
    }
    const checksum = await bundleChecksum(bundle);
    expect(await runImport({ bundle, onConflict: "theirs", json: false })).toBe(0);
    expect(readFileSync(docPath, "utf-8")).toContain("Guidelines v1");
    const backup = readFileSync(join(importsDir, checksum, "backup", "coding_guidelines.md"), "utf-8");
    expect(backup).toContain("LOCAL EDIT");
  });
});

// --- round-trip: hand-off / hand-back preserving a non-conflicting local edit -

describe("igris import — hand-off/hand-back round-trip (AC2/AC3)", () => {
  it("theirs lands new brief B, updates brief A, and PRESERVES a non-conflicting local edit to brief C", async () => {
    // Seed 3 briefs, export as the ancestor, import into a clean brain (seed ledger).
    withBrain((db) => {
      schema(db);
      const ins = db.prepare(
        `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
         VALUES ('acme', ?, 'Feature', ?, 'Open', 'P2', 'S', 'PLANNING', ?)`,
      );
      ins.run("A", "A-v1", "2026-06-01 10:00:00");
      ins.run("C", "C-v1", "2026-06-01 10:00:00");
    });
    const ancestorBundle = await exportBundle();
    resetBrainEmptySchema();
    await runImport({ bundle: ancestorBundle, onConflict: "theirs", json: false }); // seed ancestor for A + C
    closeDb();

    // Colleague: edits A + adds B (their working copy). Export the hand-back bundle.
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='A-v2', updated_at='2026-06-05 10:00:00' WHERE project='acme' AND brief_id='A'").run();
      db.prepare(
        `INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
         VALUES ('acme','B','Feature','B-v1','Open','P2','S','PLANNING','2026-06-05 10:00:00')`,
      ).run();
    });
    const handBack = await exportBundle();
    // Restore A to ancestor + make a NON-conflicting local edit to C (only mine).
    withBrain((db) => {
      db.prepare("UPDATE brief_status SET title='A-v1', updated_at='2026-06-01 10:00:00' WHERE project='acme' AND brief_id='A'").run();
      db.prepare("UPDATE brief_status SET title='C-v2-local', updated_at='2026-06-06 10:00:00' WHERE project='acme' AND brief_id='C'").run();
    });
    closeDb();

    expect(await runImport({ bundle: handBack, onConflict: "theirs", json: false })).toBe(0);
    // B lands (NEW), A updates (INCOMING → theirs), C is preserved (LOCAL_ONLY).
    expect(briefTitle("acme", "B")).toBe("B-v1");
    expect(briefTitle("acme", "A")).toBe("A-v2");
    expect(briefTitle("acme", "C")).toBe("C-v2-local");
  });
});

// --- --as fresh slug all-NEW -------------------------------------------------

describe("igris import — --as fresh slug (all NEW)", () => {
  it("imports under a new slug with brief rows scoped to the new project", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    // Keep the acme rows; import under a DIFFERENT slug.
    closeDb();

    expect(await runImport({ bundle, onConflict: "theirs", as: "acme-copy", json: false })).toBe(0);
    expect(countBriefs("acme-copy")).toBe(2);
    expect(briefTitle("acme-copy", "FR-1")).toBe("First");
    // The original acme rows are still present + unchanged.
    expect(countBriefs("acme")).toBe(2);
  });
});

// --- learnings tag-union on update ------------------------------------------

describe("igris import — learnings tag-union on an INCOMING update", () => {
  it("merges local + bundle tags rather than overwriting", async () => {
    seedCanonical();
    const bundle1 = await exportBundle();
    resetBrainEmptySchema();
    await runImport({ bundle: bundle1, onConflict: "theirs", json: false }); // seed ancestor (tags a,b)
    closeDb();

    // Colleague changes the learning content + tags → re-export.
    withBrain((db) => {
      db.prepare("UPDATE learnings SET content='approved body v2', tags='b,c', created_at='2026-06-04 10:00:00' WHERE project='acme' AND category='pattern' AND title='Good'").run();
    });
    const bundle2 = await exportBundle();
    // Restore local learning to ancestor so only THEIRS differs → INCOMING.
    withBrain((db) => {
      db.prepare("UPDATE learnings SET content='approved body', tags='a,b', created_at='2026-06-03 10:00:00' WHERE project='acme' AND category='pattern' AND title='Good'").run();
    });
    closeDb();

    await runImport({ bundle: bundle2, onConflict: "theirs", json: false });
    const db = openBrainRead();
    try {
      const row = db.prepare("SELECT content, tags FROM learnings WHERE project='acme' AND category='pattern' AND title='Good'").get() as { content: string; tags: string };
      expect(row.content).toBe("approved body v2");
      expect(row.tags).toBe("a,b,c"); // union, sorted
    } finally {
      db.close();
    }
  });
});

// --- C2: FK precondition — auto-register the target project ------------------

describe("igris import — auto-registers an unregistered project (C2)", () => {
  it("lands briefs under a fresh slug with 0 FK failures and creates the projects row", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema(); // schema present, NO projects rows (fresh machine)

    const code = await runImport({
      bundle,
      onConflict: "theirs",
      projectPath: "/tmp/acme-work",
      json: false,
    });
    // 0 FK failures (would fail without the in-txn auto-register).
    expect(code).toBe(0);
    expect(countBriefs("acme")).toBe(2);
    const proj = projectRow("acme");
    expect(proj).toBeDefined();
    expect(proj?.path).toBe("/tmp/acme-work");
    expect(proj?.name).toBe("acme");
  });

  it("does NOT overwrite an existing project's path/name (colleague keeps their real path)", async () => {
    seedCanonical();
    const bundle = await exportBundle();
    resetBrainEmptySchema();
    // Pre-register acme with a real local path.
    withBrain((db) => {
      db.prepare("INSERT INTO projects (slug, name, path) VALUES ('acme', 'Acme Real', '/real/acme')").run();
    });
    closeDb();

    const code = await runImport({
      bundle,
      onConflict: "theirs",
      projectPath: "/tmp/should-not-be-used",
      json: false,
    });
    expect(code).toBe(0);
    expect(countBriefs("acme")).toBe(2);
    const proj = projectRow("acme");
    expect(proj?.path).toBe("/real/acme"); // untouched
    expect(proj?.name).toBe("Acme Real");
  });
});

// --- C1/C3: partial apply — non-zero exit, not marked applied, retryable -----

describe("igris import — partial apply is loud, non-zero, and retryable (C1/C3)", () => {
  it("a per-row failure yields exit 3, lands siblings, is NOT marked applied, and a valid re-import recovers", async () => {
    seedCanonical();
    const validBundle = await exportBundle("core"); // brief_status + brief_files

    // Tamper: drop the NOT-NULL `status` column from the FR-2 data row so its
    // INSERT fails while FR-1 (and brief_files) land. Recompute the checksum so
    // the bundle passes integrity verification and reaches the apply.
    const tampered = await restage(validBundle, "tampered.igris-pack.tar.gz", (stage) => {
      const p = join(stage, "data", "brief_status.json");
      const rows = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>[];
      for (const r of rows) {
        if (r.brief_id === "FR-2") delete r.status;
      }
      writeFileSync(p, JSON.stringify(rows, null, 2) + "\n");
    });

    resetBrainEmptySchema();

    // Partial apply → exit 3, FR-1 lands, FR-2 fails.
    const code1 = await runImport({ bundle: tampered, onConflict: "theirs", json: false });
    expect(code1).toBe(3);
    expect(briefTitle("acme", "FR-1")).toBe("First");
    expect(briefTitle("acme", "FR-2")).toBeUndefined();

    // NOT marked applied → re-importing the SAME tampered bundle re-attempts
    // (exit 3 again, not a no-op short-circuit).
    const code2 = await runImport({ bundle: tampered, onConflict: "theirs", json: false });
    expect(code2).toBe(3);

    // Recovery: the valid bundle lands the previously-failed FR-2 (FR-1 is
    // UNCHANGED) → clean, exit 0.
    const code3 = await runImport({ bundle: validBundle, onConflict: "theirs", json: false });
    expect(code3).toBe(0);
    expect(countBriefs("acme")).toBe(2);
    expect(briefTitle("acme", "FR-2")).toBe("Second");
  });
});

// --- data fidelity: legacy BLOB brief_files.content round-trips --------------

describe("igris import — BLOB brief_files.content round-trips (data fidelity)", () => {
  it("a Buffer/BLOB content brief imports with correct bytes + 0 failures; string content unaffected", async () => {
    const blobText = "legacy blob body ✓ multi-byte";
    withBrain((db) => {
      for (const d of ALL_DDL) db.exec(d);
      // A normal string-content brief (regression guard for the Buffer rehydrate).
      db.prepare(
        `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("bf-str", "acme", "FR-1", "FR-1.md", "plain string body", createHash("sha256").update("plain string body").digest("hex"), "2026-06-01 10:00:00");
      // A legacy BLOB-content brief (FR-111/TD-179/TD-277/TD-278 shape): content is a Buffer.
      const blob = Buffer.from(blobText, "utf-8");
      db.prepare(
        `INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("bf-blob", "acme", "FR-9", "FR-9.md", blob, createHash("sha256").update(blob).digest("hex"), "2026-06-01 10:00:00");
    });

    const bundle = await exportBundle("core");
    resetBrainEmptySchema();

    // Capture the JSON digest to assert failed === 0 / applied "full".
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runImport({ bundle, onConflict: "theirs", json: true });
    const digest = JSON.parse(spy.mock.calls.map((c) => String(c[0])).join("")) as {
      applied: string;
      failed: number;
    };
    spy.mockRestore();

    // Exit 0 + full apply + zero failures (before the rehydrate fix the BLOB row
    // failed with "Too few parameter values were provided" → exit 3).
    expect(code).toBe(0);
    expect(digest.applied).toBe("full");
    expect(digest.failed).toBe(0);

    const db = openBrainRead();
    try {
      const asText = (c: unknown): string => (Buffer.isBuffer(c) ? c.toString("utf8") : String(c));
      const strRow = db.prepare("SELECT content FROM brief_files WHERE project='acme' AND brief_id='FR-1'").get() as { content: unknown };
      const blobRow = db.prepare("SELECT content FROM brief_files WHERE project='acme' AND brief_id='FR-9'").get() as { content: unknown };
      expect(asText(strRow.content)).toBe("plain string body");
      expect(asText(blobRow.content)).toBe(blobText); // BLOB bytes preserved
    } finally {
      db.close();
    }
  });
});

// --- M1: adversarial claim-state — allowlist holds against a hostile manifest -

describe("igris import — claim-state allowlist is adversarial-proof (M1)", () => {
  it("a bundle whose DATA rows + descriptor columns include claimed_by/claimed_at still never writes them", async () => {
    seedCanonical();
    const bundle = await exportBundle("core");

    const hostile = await restage(bundle, "hostile-claims.igris-pack.tar.gz", (stage, manifest) => {
      // Inject claim columns into the DATA rows.
      const p = join(stage, "data", "brief_status.json");
      const rows = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>[];
      for (const r of rows) {
        r.claimed_by = "attacker";
        r.claimed_at = "2026-01-01 00:00:00";
      }
      writeFileSync(p, JSON.stringify(rows, null, 2) + "\n");
      // AND name them in the descriptor columns (the manifest is untrusted).
      const stores = manifest.stores as Record<string, { columns?: string[] }>;
      stores.brief_status.columns = [...(stores.brief_status.columns ?? []), "claimed_by", "claimed_at"];
    });

    resetBrainEmptySchema();
    const code = await runImport({ bundle: hostile, onConflict: "theirs", json: false });
    expect(code).toBe(0);
    expect(countBriefs("acme")).toBe(2);

    const db = openBrainRead();
    try {
      const rows = db.prepare("SELECT claimed_by, claimed_at FROM brief_status WHERE project='acme'").all() as { claimed_by: unknown; claimed_at: unknown }[];
      expect(rows.length).toBe(2);
      for (const r of rows) {
        expect(r.claimed_by).toBeNull(); // EXPORT_TABLES ∩ localColumns allowlist holds
        expect(r.claimed_at).toBeNull();
      }
    } finally {
      db.close();
    }
  });
});
