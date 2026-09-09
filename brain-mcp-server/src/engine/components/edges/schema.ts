/**
 * Brain Engine v7.0 — Edges Component Schema
 *
 * Database migrations for the typed-edges graph layer.
 * Creates the entity_edges table with a UNIQUE constraint over the
 * (from_type, from_id, to_type, to_id, edge_type) tuple, and three
 * lookup indexes (from, to, edge_type).
 *
 * Design note: brief FR-105 acceptance text says "5 indexes" but the
 * canonical schema in the brief lists 3. Per the implementation plan,
 * we ship the 3 listed indexes here. Speculative indexes on
 * `provenance` and `confidence` are deferred to FR-113 (graph traversal).
 *
 * @module engine/components/edges/schema
 * @author fifty.dev
 */

import { existsSync, unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Migration } from '../../types.js';

// ---------------------------------------------------------------------------
// v4 (BR-083) — pre-flight and post-check for the entity_edges rebuild
// ---------------------------------------------------------------------------

/** Backup suffix. Named for the migration so two rebuilds never share a file. */
export const EDGES_V4_BACKUP_SUFFIX = '.pre-edges-v4.bak';

/** True for the in-memory handles every test and several scripts open. */
function isMemoryDb(name: string): boolean {
  return name === '' || name === ':memory:' || name.startsWith('file::memory:');
}

/**
 * BR-083 — verified backup + `foreign_keys = OFF`, OUTSIDE the transaction.
 *
 * Returns `false` to ABORT the migration (component stays at v3, next boot
 * retries). Every failure path here is a refusal, never a warning: this is the
 * only destructive migration the edges component has ever shipped.
 *
 * WHY THE BACKUP IS VERIFIED BY `ATTACH`, NOT BY A SECOND CONNECTION.
 * The brain's tables include `vec0` virtual tables (`learnings_vec`, …). A
 * second `new Database(bak)` would not have `sqlite-vec` loaded, so any check
 * that has to instantiate those tables is answering a different question than
 * "can the brain open this file". `ATTACH` reuses THIS connection, which the
 * adapter already loaded the extension into, and proves three things in one
 * pass: the file opens, `integrity_check` says `ok`, and its `entity_edges`
 * row count equals the source's. *A backup nobody verified is not a backup —
 * it is a hope* (`db.ts:1469`).
 */
export function edgesV4Preflight(dbRaw: unknown): boolean {
  const db = dbRaw as Database.Database;

  // `foreign_keys` is a no-op inside a transaction and reports NO error, which
  // is why it is toggled here. Nothing currently references `entity_edges`
  // (measured: zero FK clauses, triggers or views name it), so this is
  // belt-and-braces for SQLite's documented 12-step rebuild rather than a
  // load-bearing step — but a future referencing table must not silently turn
  // the rebuild into a cascade.
  try {
    db.pragma('foreign_keys = OFF');
  } catch {
    return false;
  }

  const path = db.name;
  if (isMemoryDb(path)) {
    // Nothing to back up. A `:memory:` brain is created and destroyed inside
    // one process; the "backup" would be a copy of a database that cannot
    // outlive the failure it protects against.
    return true;
  }

  const backup = `${path}${EDGES_V4_BACKUP_SUFFIX}`;
  try {
    // VACUUM INTO refuses to overwrite. A stale backup from an aborted earlier
    // attempt is deliberately replaced: the one we want is the one taken
    // immediately before the rebuild that is about to run.
    if (existsSync(backup)) unlinkSync(backup);
    db.prepare('VACUUM INTO ?').run(backup);

    const sourceCount = (
      db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get() as { n: number }
    ).n;

    db.exec(`ATTACH '${backup.replace(/'/g, "''")}' AS edges_v4_bak`);
    try {
      const check = db.pragma('edges_v4_bak.integrity_check') as Array<{
        integrity_check: string;
      }>;
      const verdict = check[0]?.integrity_check ?? 'missing';
      if (verdict !== 'ok') {
        console.error(`[edges@4] backup integrity_check returned "${verdict}" — ABORT`);
        return false;
      }
      const backupCount = (
        db.prepare('SELECT COUNT(*) AS n FROM edges_v4_bak.entity_edges').get() as {
          n: number;
        }
      ).n;
      if (backupCount !== sourceCount) {
        console.error(
          `[edges@4] backup has ${backupCount} entity_edges rows, source has ${sourceCount} — ABORT`,
        );
        return false;
      }
    } finally {
      db.exec('DETACH edges_v4_bak');
    }

    console.error(
      `[edges@4] verified backup at ${backup} (${sourceCount} entity_edges rows, integrity ok)`,
    );
    return true;
  } catch (err) {
    console.error(
      `[edges@4] backup FAILED: ${err instanceof Error ? err.message : String(err)} — ABORT`,
    );
    return false;
  }
}

/**
 * BR-083 — post-commit checks: referential integrity survived the rebuild, and
 * the connection is handed back with `foreign_keys` restored to the adapter's
 * `ON`. A failure here is LOUD but cannot roll back — the migration is already
 * committed and claiming otherwise would be the lie this brief exists to stop.
 */
export function edgesV4Postcheck(dbRaw: unknown): void {
  const db = dbRaw as Database.Database;
  try {
    // SCOPED TO THE REBUILT TABLE, measured rather than assumed. The
    // whole-database form was tried first and reported EIGHT violations on the
    // operator's brain — all of them PRE-EXISTING orphan `schedule_runs` rows
    // whose `schedules` parent is gone, none of them touched by this
    // migration. An unscoped check would make every future edges migration
    // print an alarm about another component's data, which is how a real
    // signal gets trained into noise.
    const violations = db.pragma('foreign_key_check(entity_edges)') as unknown[];
    if (violations.length > 0) {
      console.error(
        `[edges@4] POST-CHECK: foreign_key_check(entity_edges) reported ${violations.length} violation(s)`,
      );
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Edge schema migrations.
 *
 * Version 1: entity_edges table + 3 indexes (from, to, edge_type).
 *   Idempotent via IF NOT EXISTS on every DDL statement, safe to re-run.
 *
 * Version 2 (FR-113): adds compound index (from_type, from_id, edge_type) to
 *   accelerate filtered traversal queries. Recursive CTE BFS in the graph
 *   tools repeatedly probes "for this node, give me all outgoing edges of
 *   types X, Y, Z" — without the compound index that requires a scan of
 *   idx_edges_from + filter on edge_type.
 *
 * Version 4 (BR-083): adds `from_project` / `to_project`, **NULLABLE**, via
 *   SQLite's documented 12-step table rebuild.
 *
 *   THE COLUMNS ARE NULLABLE ON PURPOSE AND MUST STAY THAT WAY. Do not
 *   "harden" them into `NOT NULL`: a `concept -> concept` edge and synapse's
 *   deliberately project-less `edge_inference` suggestions legitimately have no
 *   project, and ~half of the pre-BR-083 rows are DELIBERATELY UNATTRIBUTED
 *   (a wrong attribution is worse than a null — BR-083's central ruling).
 *
 *   THE REQUIREMENT RULE IS NOT A `CHECK`, AND CANNOT BE. It is
 *   *"a qualifier is required iff `|P(type, id)| > 1`"*, where `P` is the set
 *   of projects that `(type, id)` lives in — a LOOKUP into `brief_status`.
 *   A DDL `CHECK` cannot read another table, and a JSON-Schema `required` array
 *   cannot be conditional on another argument's VALUE. It therefore lives in
 *   `handleEdgeCreate` (see that function's header for why that is the choke
 *   point rather than a per-tool guard).
 *
 *   THE UNIQUE CONSTRAINT IS AN EXPRESSION INDEX, NOT A TABLE-LEVEL `UNIQUE`.
 *   NULL is DISTINCT from NULL in a SQLite UNIQUE, so
 *   `UNIQUE(..., from_project, ...)` would let two identical project-less
 *   concept edges BOTH insert and silently break `handleEdgeCreate`'s
 *   idempotency for exactly the population that legitimately has no project.
 *   `COALESCE(from_project, '')` folds NULL into one comparable value.
 *   A table-level UNIQUE cannot be dropped in place, which is why v4 is a
 *   rebuild rather than two `ALTER TABLE ADD COLUMN`s — and the rebuild is
 *   also what makes two edges differing ONLY by project STORABLE at all.
 *
 * Version 3 (TD-171 M2): adds graph_nodes table — a lightweight node-row
 *   layer for free-standing concept/decision nodes that don't have a
 *   backing brief / learning / error / session / goal row. Brief/learning/
 *   error/session/goal nodes continue to live in their own tables and are
 *   referenced by entity_edges via (type, id). The graph_nodes table is
 *   ONLY for nodes registered explicitly via igris_graph_node_create —
 *   typically `node_type = 'concept'` or `'decision'`. UNIQUE(node_type,
 *   node_external_id) enforces idempotent INSERT-or-IGNORE semantics.
 */
export const edgeMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create entity_edges table with UNIQUE constraint and 3 lookup indexes',
    sql: `
      CREATE TABLE IF NOT EXISTS entity_edges (
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

      CREATE INDEX IF NOT EXISTS idx_edges_from ON entity_edges(from_type, from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to   ON entity_edges(to_type, to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON entity_edges(edge_type);
    `,
  },
  {
    version: 2,
    description: 'FR-113: compound index on (from_type, from_id, edge_type) for filtered traversal',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_edges_compound
        ON entity_edges(from_type, from_id, edge_type);
    `,
  },
  {
    version: 3,
    description:
      'TD-171 M2: graph_nodes table for free-standing concept/decision nodes (idempotent via UNIQUE(node_type, node_external_id))',
    sql: `
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_type TEXT NOT NULL,
        node_external_id TEXT NOT NULL,
        label TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(node_type, node_external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);
    `,
  },
  {
    version: 4,
    description:
      'BR-083: project-qualify entity_edges (from_project / to_project, nullable) via a 12-step rebuild; expression UNIQUE index over COALESCE(project,\'\')',
    pre: edgesV4Preflight,
    post: edgesV4Postcheck,
    sql: `
      DROP TABLE IF EXISTS entity_edges_v4_new;

      CREATE TABLE entity_edges_v4_new (
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
        from_project TEXT,
        to_project   TEXT
      );

      INSERT INTO entity_edges_v4_new
        (id, from_type, from_id, to_type, to_id, edge_type,
         confidence, provenance, created_at, metadata)
      SELECT
         id, from_type, from_id, to_type, to_id, edge_type,
         confidence, provenance, created_at, metadata
      FROM entity_edges;

      DROP TABLE entity_edges;
      ALTER TABLE entity_edges_v4_new RENAME TO entity_edges;

      CREATE INDEX IF NOT EXISTS idx_edges_from ON entity_edges(from_type, from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to   ON entity_edges(to_type, to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON entity_edges(edge_type);
      CREATE INDEX IF NOT EXISTS idx_edges_compound
        ON entity_edges(from_type, from_id, edge_type);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON entity_edges(
        from_type, from_id, COALESCE(from_project, ''),
        to_type,   to_id,   COALESCE(to_project, ''),
        edge_type);

      CREATE INDEX IF NOT EXISTS idx_edges_from_proj
        ON entity_edges(from_type, from_id, from_project);
      CREATE INDEX IF NOT EXISTS idx_edges_to_proj
        ON entity_edges(to_type, to_id, to_project);
    `,
  },
];
