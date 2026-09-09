/**
 * Brain Engine v7.0 — FR-237 `igris_graph_brain` handler
 *
 * Thin MCP wrapper over the whole-brain graph data layer. Validates args,
 * grabs the live brain DB via `getDb()`, and delegates to the ONE pure builder
 * in `whole-graph.ts`.
 *
 * This split is the `visualization.ts` / `visualization-tool.ts` precedent:
 * the pure layer takes a `db` param and imports no singleton, so the FR-238
 * dashboard server can import `buildBrainGraph` directly with its own
 * read-only handle. **Do not move logic up from the builder into this file.**
 *
 * @module engine/components/edges/whole-graph-tool
 * @author fifty.dev
 */

import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';
import { VALID_ENTITY_TYPES } from './handlers.js';
import {
  buildBrainGraph,
  emptyBrainGraph,
  DEFAULT_MAX_EDGE_REPLICAS,
  type BuildOpts,
} from './whole-graph.js';

/** Lower bound for `max_edge_replicas` (1 = exclusion-equivalent). */
const MIN_EDGE_REPLICAS = 1;

/** Upper bound for `max_edge_replicas` (above this, replicas are pure noise). */
const MAX_EDGE_REPLICAS_CEILING = 32;

/**
 * MCP handler for `igris_graph_brain`.
 *
 * Optional args: `project`, `node_types`, `max_edge_replicas`.
 *
 * Behaviour:
 *   - Invalid args -> `errorResult` (the gateway already rejects UNKNOWN args;
 *     this validates the VALUES of known ones).
 *   - A throw from `getDb()` or the builder -> a SUCCESS result carrying an
 *     EMPTY graph plus `degraded.reason`. AC #8 says a degraded brain "returns
 *     an empty graph, does not throw", and an operator dashboard must render an
 *     empty brain rather than an error envelope.
 */
export function handleGraphBrain(args: Record<string, unknown>): ToolResult {
  const opts: BuildOpts = {};

  const project = args.project;
  if (project !== undefined) {
    if (typeof project !== 'string' || project === '') {
      return errorResult('project must be a non-empty string');
    }
    opts.project = project;
  }

  const nodeTypes = args.node_types;
  if (nodeTypes !== undefined) {
    if (!Array.isArray(nodeTypes)) {
      return errorResult('node_types must be an array of entity types');
    }
    const allowed = new Set<string>(VALID_ENTITY_TYPES);
    for (const t of nodeTypes) {
      if (typeof t !== 'string' || !allowed.has(t)) {
        return errorResult(
          `node_types contains an unknown entity type: ${JSON.stringify(t)}. ` +
            `Accepted: ${VALID_ENTITY_TYPES.join(', ')}`,
        );
      }
    }
    opts.node_types = nodeTypes as string[];
  }

  const maxReplicas = args.max_edge_replicas;
  if (maxReplicas !== undefined) {
    if (
      typeof maxReplicas !== 'number' ||
      !Number.isInteger(maxReplicas) ||
      maxReplicas < MIN_EDGE_REPLICAS ||
      maxReplicas > MAX_EDGE_REPLICAS_CEILING
    ) {
      return errorResult(
        `max_edge_replicas must be an integer between ${MIN_EDGE_REPLICAS} and ${MAX_EDGE_REPLICAS_CEILING} (default ${DEFAULT_MAX_EDGE_REPLICAS})`,
      );
    }
    opts.maxEdgeReplicas = maxReplicas;
  }

  try {
    const db = getDb();
    return successResult(JSON.stringify(buildBrainGraph(db, opts), null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return successResult(JSON.stringify(emptyBrainGraph(msg, opts), null, 2));
  }
}
