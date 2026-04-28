/**
 * Brain Engine v5.0 — Edges Component Schema
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
 * @author Fifty.ai
 */

import type { Migration } from '../../types.js';

/**
 * Edge schema migrations.
 *
 * Version 1: entity_edges table + 3 indexes (from, to, edge_type).
 *   Idempotent via IF NOT EXISTS on every DDL statement, safe to re-run.
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
];
