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

import type { Migration } from '../../types.js';

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
];
