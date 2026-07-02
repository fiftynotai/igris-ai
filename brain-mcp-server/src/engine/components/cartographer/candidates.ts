/**
 * Brain Engine v7.1 — Cartographer cluster candidate generation (FR-116 M4).
 *
 * The cartographer's INPUT slot (`buildContext`) source. Unlike the janitor/
 * arbiter (vec0 KNN) or the curator (deterministic staleness), the cartographer's
 * candidate signal is DETERMINISTIC GRAPH COMMUNITY DETECTION: it runs the shared
 * `edges/community.ts:detectCommunities` primitive (Louvain over `entity_edges`,
 * READ-ONLY) over the learning subgraph, then filters each detected cluster to
 * APPROVED, recallable members and assembles a small digest per cluster.
 *
 * DON'T-DOUBLE-SUMMARIZE: a cluster whose members already carry a
 * `cluster_member_of` edge (already summarized into a meta-learning) is skipped,
 * and a cluster already pending as a `cartographer` `cluster_meta` suggestion is
 * skipped — so re-runs do not re-surface it. Every read is fail-soft (a query
 * error yields `[]`). Never throws.
 *
 * @module engine/components/cartographer/candidates
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { detectCommunities } from '../edges/community.js';
import {
  DEFAULT_CARTOGRAPHER_CONFIG,
  type CartographerConfig,
  type ClusterMember,
  type LearningCluster,
} from './types.js';

/** A learnings row read for the digest (only APPROVED, recallable members qualify). */
interface LearningDigestRow {
  id: number;
  title: string;
  content: string;
  review_status: string | null;
}

/** Truncate a learning content body to a compact snippet for the digest. */
function snippet(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 240)}…` : oneLine;
}

/**
 * The set of learning ids that already belong to a cluster (carry an outgoing OR
 * incoming `cluster_member_of` edge). A cluster ANY of whose members is already
 * summarized is skipped — the cartographer does not re-map an already-mapped
 * region. Fail-soft: a query error yields an empty set.
 */
export function loadAlreadyClusteredIds(db: Database.Database): Set<number> {
  const set = new Set<number>();
  try {
    const rows = db
      .prepare(
        `SELECT from_id AS id FROM entity_edges
           WHERE edge_type = 'cluster_member_of' AND from_type = 'learning'
             AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
         UNION
         SELECT to_id AS id FROM entity_edges
           WHERE edge_type = 'cluster_member_of' AND to_type = 'learning'
             AND COALESCE(json_extract(metadata, '$.deleted'), 0) = 0`,
      )
      .all() as Array<{ id: string }>;
    for (const r of rows) {
      const n = Number(r.id);
      if (Number.isInteger(n) && n > 0) set.add(n);
    }
  } catch {
    /* entity_edges absent — empty exclusion set */
  }
  return set;
}

/**
 * The set of learning ids already pending as a `cartographer` `cluster_meta`
 * suggestion (parsed from `suggested_action.cluster_member_ids`). Fail-soft.
 */
export function loadPendingClusterMemberIds(db: Database.Database): Set<number> {
  const set = new Set<number>();
  try {
    const rows = db
      .prepare(
        `SELECT suggested_action FROM suggestions
          WHERE status = 'pending' AND source_module = 'cartographer'`,
      )
      .all() as Array<{ suggested_action: string | null }>;
    for (const r of rows) {
      if (!r.suggested_action) continue;
      try {
        const action = JSON.parse(r.suggested_action) as { cluster_member_ids?: unknown };
        if (Array.isArray(action?.cluster_member_ids)) {
          for (const raw of action.cluster_member_ids) {
            const n = Number(raw);
            if (Number.isInteger(n) && n > 0) set.add(n);
          }
        }
      } catch {
        /* malformed action — skip */
      }
    }
  } catch {
    /* suggestions absent */
  }
  return set;
}

/**
 * Build the capped, deduped, DIGESTED cluster candidate set for one cartographer
 * run: run the DETERMINISTIC community primitive over the learning subgraph, drop
 * any cluster touching an already-clustered / already-pending member, filter each
 * remaining cluster to its APPROVED recallable members, and drop clusters that
 * fall below `min_cluster_size` after that filter. Deterministic + fail-soft.
 *
 * @param db     the brain DB
 * @param config the resolved cartographer config (min size / resolution / edge types / cap)
 */
export function buildClusters(
  db: Database.Database,
  config: CartographerConfig = DEFAULT_CARTOGRAPHER_CONFIG,
): LearningCluster[] {
  // 1. DETERMINISTIC community detection over the learning subgraph (READ-ONLY).
  const rawClusters = detectCommunities(db, {
    nodeType: 'learning',
    edgeTypes: config.cluster_edge_types,
    minClusterSize: config.min_cluster_size,
    resolution: config.resolution,
  });
  if (rawClusters.length === 0) return [];

  const alreadyClustered = loadAlreadyClusteredIds(db);
  const pending = loadPendingClusterMemberIds(db);

  const out: LearningCluster[] = [];
  for (const raw of rawClusters) {
    if (out.length >= config.max_clusters) break;
    // Skip a cluster if ANY member is already summarized or pending.
    const ids = raw.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.some((id) => alreadyClustered.has(id) || pending.has(id))) continue;
    if (ids.length === 0) continue;

    // 2. Filter to APPROVED, recallable members + build the digest.
    let rows: LearningDigestRow[] = [];
    try {
      const placeholders = ids.map(() => '?').join(', ');
      rows = db
        .prepare(
          `SELECT id, title, content, review_status FROM learnings
            WHERE id IN (${placeholders})
              AND COALESCE(review_status, 'approved') = 'approved'`,
        )
        .all(...ids) as LearningDigestRow[];
    } catch {
      continue; // learnings absent / query error — skip this cluster, fail-soft
    }
    if (rows.length < config.min_cluster_size) continue;

    const members: ClusterMember[] = rows
      .map((r) => ({ id: r.id, title: r.title, snippet: snippet(r.content) }))
      .sort((a, b) => a.id - b.id);
    out.push({
      cluster_index: out.length,
      member_ids: members.map((m) => m.id),
      members,
    });
  }
  return out;
}
