/**
 * Brain Engine v7.0 — Edges Component
 *
 * Wraps the typed-edges graph layer as a BrainComponent.
 * Provides 11 MCP tools:
 *   CRUD (FR-105):                igris_edge_create / list / remove
 *   Graph traversal (FR-113):     igris_graph_neighbors / path / subgraph
 *   Node CRUD + search (TD-171 M2): igris_graph_node_create / node_get /
 *                                    search / dashboard
 *   Visualization (FR-111):       igris_brief_graph_render
 * Subscribes to brief.created so structural Parent edges are captured
 * at insert time without coupling the briefs component to edge logic.
 * FR-210: also subscribes to the enriched memory.stored so learning→brief
 * (from the structured source_brief column) + model-supplied (edges[]) edges
 * are captured at store time — all edge-writes stay in this component.
 * Self-listens on edge.created and edge.removed to invalidate the
 * subgraph traversal cache.
 *
 * Emits: edge.created, edge.removed
 * Listens: brief.created, memory.stored, edge.created (self), edge.removed (self)
 *
 * Foundation for FR-107 (provenance), FR-110 (goals), FR-111
 * (visualization), FR-112 (community detection).
 *
 * @module engine/components/edges
 * @author fifty.dev
 */

import type {
  BrainComponent,
  ComponentContext,
  EventDef,
  EventHandler,
  EventPayload,
  Migration,
  ToolDefinition,
} from '../../types.js';
import { errMsg } from '../../helpers.js';
import { edgeMigrations } from './schema.js';
import {
  handleEdgeCreate,
  handleEdgeList,
  handleEdgeRemove,
  VALID_EDGE_TYPES,
  VALID_ENTITY_TYPES,
  VALID_PROVENANCE,
} from './handlers.js';
import {
  handleGraphNeighbors,
  handleGraphPath,
  handleGraphSubgraph,
  invalidateSubgraphCache,
} from './traversal.js';
import { handleBriefGraphRender } from './visualization-tool.js';
import {
  handleGraphNodeCreate,
  handleGraphNodeGet,
  handleGraphSearch,
  handleGraphDashboard,
} from './nodes-handlers.js';

/**
 * Build the edges component instance.
 *
 * The factory pattern matches the rest of the engine; the returned
 * BrainComponent is registered in `engine/index.ts` after the briefs
 * component so the brief.created listener is wired before any brief
 * is synced.
 */
export function createEdgesComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  /**
   * Auto-create a parent_of edge when a brief is synced for the first time.
   *
   * Listens on brief.created; expects the payload to optionally include
   * a `parent_brief_id` field populated by the briefs component (parsed
   * from explicit input or `**Parent Brief:** FR-XXX` in markdown).
   */
  function onBriefCreated(payload: EventPayload): void {
    if (!_ctx) return;

    const briefId = payload.data.brief_id;
    const parentBriefId = payload.data.parent_brief_id;

    if (typeof briefId !== 'string' || !briefId) return;
    if (typeof parentBriefId !== 'string' || !parentBriefId) return;
    // Defensive: never auto-create a self-edge even if upstream parsing
    // produced a degenerate value like "**Parent Brief:** FR-105" inside FR-105.
    if (briefId === parentBriefId) return;

    try {
      const result = handleEdgeCreate({
        from_type: 'brief',
        from_id: briefId,
        to_type: 'brief',
        to_id: parentBriefId,
        edge_type: 'parent_of',
        confidence: 1.0,
        provenance: 'observed',
        metadata: { source: 'brief.created' },
      });

      if (!result.isError) {
        _ctx.bus.emit('edge.created', {
          from_type: 'brief',
          from_id: briefId,
          to_type: 'brief',
          to_id: parentBriefId,
          edge_type: 'parent_of',
          source: 'brief.created',
        });
        _ctx.log.info(
          `Auto-created parent_of edge: ${briefId} -> ${parentBriefId}`,
        );
      } else {
        _ctx.log.warn(
          `Auto-edge for ${briefId} -> ${parentBriefId} returned error: ${result.content[0]?.text ?? 'unknown'}`,
        );
      }
    } catch (err) {
      _ctx.log.error(
        `Failed to auto-create parent_of edge for ${briefId}: ${errMsg(err)}`,
      );
    }
  }

  /**
   * FR-210 — auto-populate cross-surface edges when a learning is stored.
   *
   * Listens on the enriched `memory.stored` payload
   * (`{ project, id, category, source_brief, edges }`, emitted by the memory
   * component). Two paths, both `provenance:'observed'`, both writing via
   * `handleEdgeCreate` so ownership of every edge-write stays here (learning
   * #206):
   *   - Path A (structured net): if `source_brief` is a non-empty string,
   *     create a `learning → brief` `derived_from` edge — the deterministic
   *     analogue of `onBriefCreated`'s `parent_of`, from a declared column
   *     (hence `observed`, not `inferred`). Fires even when the model omitted
   *     `edges`.
   *   - Path B (model-supplied): for each entry in `edges[]`, create a
   *     `learning → <to_type>` edge of the given `edge_type`.
   *
   * The learning node id is `String(id)` — the settled `numericId` convention
   * (traversal.ts:237); learning nodes auto-register on first edge reference.
   * Errors are logged, never thrown (mirrors `onBriefCreated`).
   */
  function onMemoryStored(payload: EventPayload): void {
    if (!_ctx) return;

    const data = payload.data;
    const rawId = data.id;
    // Need the new learning id to anchor the edge `from` side.
    if (rawId === undefined || rawId === null || rawId === '') return;
    const fromId = String(rawId);

    // Local helper: write one learning→X edge, guard degenerate self-edges,
    // emit edge.created on success, log (never throw) on failure.
    const writeEdge = (
      toType: string,
      toId: string,
      edgeType: string,
      confidence: number | undefined,
      metadata: Record<string, unknown>,
    ): void => {
      if (!_ctx) return;
      if (!toType || !toId || !edgeType) return;
      // Defensive: never auto-create a degenerate self-edge (mirror the :87
      // guard in onBriefCreated). from_type is always 'learning' here.
      if (toType === 'learning' && toId === fromId) return;

      const source = typeof metadata.source === 'string' ? metadata.source : 'memory.stored';

      try {
        const result = handleEdgeCreate({
          from_type: 'learning',
          from_id: fromId,
          to_type: toType,
          to_id: toId,
          edge_type: edgeType,
          confidence,
          provenance: 'observed',
          metadata,
        });

        if (!result.isError) {
          _ctx.bus.emit('edge.created', {
            from_type: 'learning',
            from_id: fromId,
            to_type: toType,
            to_id: toId,
            edge_type: edgeType,
            source,
          });
          _ctx.log.info(
            `Auto-created ${edgeType} edge: learning:${fromId} -> ${toType}:${toId}`,
          );
        } else {
          _ctx.log.warn(
            `Auto-edge learning:${fromId} -> ${toType}:${toId} returned error: ${result.content[0]?.text ?? 'unknown'}`,
          );
        }
      } catch (err) {
        _ctx.log.error(
          `Failed to auto-create ${edgeType} edge for learning:${fromId}: ${errMsg(err)}`,
        );
      }
    };

    // Path A — structured source_brief → derived_from (deterministic net).
    const sourceBrief = data.source_brief;
    if (typeof sourceBrief === 'string' && sourceBrief) {
      writeEdge('brief', sourceBrief, 'derived_from', undefined, {
        source: 'memory.stored',
      });
    }

    // Path B — model-supplied edges captured at store time.
    const edges = data.edges;
    if (Array.isArray(edges)) {
      for (const raw of edges) {
        if (!raw || typeof raw !== 'object') continue;
        const spec = raw as Record<string, unknown>;
        const toType = typeof spec.to_type === 'string' ? spec.to_type : '';
        const toId = typeof spec.to_id === 'string' ? spec.to_id : '';
        const edgeType = typeof spec.edge_type === 'string' ? spec.edge_type : '';
        const confidence = typeof spec.confidence === 'number' ? spec.confidence : undefined;
        const extraMeta =
          spec.metadata && typeof spec.metadata === 'object'
            ? (spec.metadata as Record<string, unknown>)
            : {};
        writeEdge(toType, toId, edgeType, confidence, {
          source: 'memory.stored.edges',
          ...extraMeta,
        });
      }
    }
  }

  // Cache-invalidation listeners are stable function references so they can
  // be passed to both bus.on() and bus.off() — typed loosely to satisfy the
  // EventHandler signature even though we ignore the payload.
  const onEdgeMutated: EventHandler = () => {
    invalidateSubgraphCache();
  };

  return {
    name: 'edges',
    version: '1.3.0',
    depends: ['briefs'],

    schema(): Migration[] {
      return edgeMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_edge_create
        // -----------------------------------------------------------------
        {
          name: 'igris_edge_create',
          description:
            'Create a typed edge between two Igris entities. Idempotent: re-creating an identical (from_type, from_id, to_type, to_id, edge_type) tuple returns the existing edge instead of failing. Self-loops are rejected unless edge_type is "recurs_with".',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              from_type: {
                type: 'string',
                enum: [...VALID_ENTITY_TYPES],
                description: 'Type of the source entity',
              },
              from_id: {
                type: 'string',
                description: 'Stable id of the source entity (e.g. "FR-105", "L-0042")',
              },
              to_type: {
                type: 'string',
                enum: [...VALID_ENTITY_TYPES],
                description: 'Type of the target entity',
              },
              to_id: {
                type: 'string',
                description: 'Stable id of the target entity',
              },
              edge_type: {
                type: 'string',
                enum: [...VALID_EDGE_TYPES],
                description: 'Edge type from the catalog',
              },
              confidence: {
                type: 'number',
                description: 'Confidence in [0, 1] (default 1.0)',
              },
              provenance: {
                type: 'string',
                enum: [...VALID_PROVENANCE],
                description: 'How the edge was discovered (default "observed")',
              },
              metadata: {
                type: 'object',
                description: 'Free-form metadata stored as JSON (default {})',
              },
            },
            required: ['from_type', 'from_id', 'to_type', 'to_id', 'edge_type'],
          },
          handler: (args) => {
            const result = handleEdgeCreate(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('edge.created', {
                from_type: args.from_type,
                from_id: args.from_id,
                to_type: args.to_type,
                to_id: args.to_id,
                edge_type: args.edge_type,
                source: 'tool',
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_edge_list
        // -----------------------------------------------------------------
        {
          name: 'igris_edge_list',
          description:
            'List edges with optional filters (all ANDed). Soft-deleted edges (metadata.deleted=true) are excluded by default. Default LIMIT 200, max 1000.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              from_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
              from_id: { type: 'string' },
              to_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
              to_id: { type: 'string' },
              edge_type: { type: 'string', enum: [...VALID_EDGE_TYPES] },
              provenance: { type: 'string', enum: [...VALID_PROVENANCE] },
              min_confidence: {
                type: 'number',
                description: 'Filter to edges with confidence >= this value (0-1)',
              },
              include_deleted: {
                type: 'boolean',
                description: 'Include soft-deleted edges (default false)',
              },
              limit: { type: 'integer', description: 'Default 200, max 1000' },
              offset: { type: 'integer', description: 'Pagination offset (default 0)' },
            },
          },
          handler: (args) => handleEdgeList(args),
        },

        // -----------------------------------------------------------------
        // igris_edge_remove
        // -----------------------------------------------------------------
        {
          name: 'igris_edge_remove',
          description:
            'Remove an edge by id. Soft-deletes by default (sets metadata.deleted=true so the row remains for audit). Pass hard=true for a permanent DELETE.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: { type: 'integer', description: 'Edge id (entity_edges.id)' },
              hard: {
                type: 'boolean',
                description: 'When true, permanently delete the row (default false)',
              },
            },
            required: ['id'],
          },
          handler: (args) => {
            const result = handleEdgeRemove(args);
            if (!result.isError && _ctx) {
              // Emit edge.removed so cache layers (traversal subgraph cache)
              // and any future subscribers can react to the deletion.
              _ctx.bus.emit('edge.removed', {
                id: args.id,
                hard: args.hard === true,
                source: 'tool',
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // FR-113: igris_graph_neighbors
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_neighbors',
          description:
            "Return all entity nodes within N hops of a seed node. Direction-aware: 'out' follows from→to, 'in' follows to→from, 'both' is undirected. Excludes soft-deleted edges by default. Caps depth at 10 and result count at 100.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              node_type: {
                type: 'string',
                enum: [...VALID_ENTITY_TYPES],
                description: 'Type of the seed entity',
              },
              node_id: {
                type: 'string',
                description: 'Stable id of the seed entity',
              },
              depth: {
                type: 'integer',
                description: 'Maximum hops from seed (default 1, max 10)',
                minimum: 1,
                maximum: 10,
              },
              edge_types: {
                type: 'array',
                items: { type: 'string', enum: [...VALID_EDGE_TYPES] },
                description: 'Optional edge_type filter (subset of catalog)',
              },
              direction: {
                type: 'string',
                enum: ['in', 'out', 'both'],
                description: 'Edge direction to follow (default both)',
              },
              max_nodes: {
                type: 'integer',
                description: 'Maximum nodes to return (default 100, max 100)',
                minimum: 1,
                maximum: 100,
              },
              include_deleted: {
                type: 'boolean',
                description: 'Include soft-deleted edges (default false)',
              },
            },
            required: ['node_type', 'node_id'],
          },
          handler: (args) => handleGraphNeighbors(args),
        },

        // -----------------------------------------------------------------
        // FR-113: igris_graph_path
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_path',
          description:
            'Find the shortest directed path from one entity to another following outgoing edges. Returns found=false when no path exists within max_depth. Cycle-safe via visited-set tracking. Excludes soft-deleted edges by default.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              from_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
              from_id: { type: 'string' },
              to_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
              to_id: { type: 'string' },
              edge_types: {
                type: 'array',
                items: { type: 'string', enum: [...VALID_EDGE_TYPES] },
                description: 'Optional edge_type filter',
              },
              max_depth: {
                type: 'integer',
                description: 'Maximum hops to explore (default 5, max 10)',
                minimum: 1,
                maximum: 10,
              },
              include_deleted: {
                type: 'boolean',
                description: 'Include soft-deleted edges (default false)',
              },
            },
            required: ['from_type', 'from_id', 'to_type', 'to_id'],
          },
          handler: (args) => handleGraphPath(args),
        },

        // -----------------------------------------------------------------
        // FR-113: igris_graph_subgraph
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_subgraph',
          description:
            'Return the connected subgraph (nodes + edges) reachable from a seed node, bounded by max_nodes. Useful for visualization. Results cached for 5 minutes; cache invalidated by edge mutations.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              seed_node_type: { type: 'string', enum: [...VALID_ENTITY_TYPES] },
              seed_node_id: { type: 'string' },
              max_nodes: {
                type: 'integer',
                description: 'Maximum nodes to include (default 20, max 100)',
                minimum: 1,
                maximum: 100,
              },
              edge_types: {
                type: 'array',
                items: { type: 'string', enum: [...VALID_EDGE_TYPES] },
                description: 'Optional edge_type filter',
              },
              include_deleted: {
                type: 'boolean',
                description: 'Include soft-deleted edges (default false)',
              },
            },
            required: ['seed_node_type', 'seed_node_id'],
          },
          handler: (args) => handleGraphSubgraph(args),
        },

        // -----------------------------------------------------------------
        // TD-171 M2: igris_graph_node_create
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_node_create',
          description:
            'Idempotently register a free-standing graph node (typically node_type=concept or decision). Brief / learning / error / session / goal nodes auto-register on first reference via igris_edge_create — only call this for nodes that do NOT have a backing row in another table. Returns created=false on UNIQUE(node_type, node_external_id) re-creation; the existing label is preserved (rename via delete + recreate).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              node_type: {
                type: 'string',
                enum: [...VALID_ENTITY_TYPES],
                description:
                  'Node type. Typically "concept" or "decision" for free-standing nodes; the brief/learning/error/session/goal types are accepted but those nodes usually live in their own tables and are referenced by entity_edges directly.',
              },
              node_external_id: {
                type: 'string',
                description:
                  'Stable string id (e.g. "FR-105", "concept:vector-search", "decision:swap-better-sqlite3-for-libsql"). Used as the join key from entity_edges.',
              },
              label: {
                type: 'string',
                description: 'Human-readable display label (used by graph visualizations and search).',
              },
              properties: {
                type: 'object',
                description: 'Free-form JSON property bag (default {}). Use the `project` key to scope a node for igris_graph_dashboard project filtering.',
                additionalProperties: true,
              },
            },
            required: ['node_type', 'node_external_id', 'label'],
          },
          handler: (args) => handleGraphNodeCreate(args),
        },

        // -----------------------------------------------------------------
        // TD-171 M2: igris_graph_node_get
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_node_get',
          description:
            'Inspect one graph_nodes row plus its in/out edge degrees. Soft-deleted edges are excluded from the degree counts (parity with igris_edge_list). Errors when the (node_type, node_external_id) pair does not match a registered node.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              node_type: {
                type: 'string',
                description: 'Node type to look up (matches graph_nodes.node_type).',
              },
              node_external_id: {
                type: 'string',
                description: 'Stable id to look up (matches graph_nodes.node_external_id).',
              },
            },
            required: ['node_type', 'node_external_id'],
          },
          handler: (args) => handleGraphNodeGet(args),
        },

        // -----------------------------------------------------------------
        // TD-171 M2: igris_graph_search
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_search',
          description:
            'Find graph_nodes by partial label or node_external_id (LIKE substring match). Optional node_type filter restricts to a single type. Returns a score per result (fraction of the matched field the query covers; 1.0 = exact match). Default limit 20, max 100.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description:
                  'Search term. Matched (case-sensitive in SQLite default) against label and node_external_id. SQL LIKE wildcards in the input are escaped — pass plain text.',
              },
              node_type: {
                type: 'string',
                description: 'Optional exact-match filter on node_type (e.g. "concept").',
              },
              limit: {
                type: 'number',
                description: 'Maximum results to return. Default 20, capped at 100.',
              },
            },
            required: ['query'],
          },
          handler: (args) => handleGraphSearch(args),
        },

        // -----------------------------------------------------------------
        // TD-171 M2: igris_graph_dashboard
        // -----------------------------------------------------------------
        {
          name: 'igris_graph_dashboard',
          description:
            'Aggregate snapshot over graph_nodes + entity_edges: node counts by type, edge counts by type, orphan-node count, recent stats, and top god-nodes by total degree. Mirrors the canonical TD-171 _dashboard shape (totals + recent + samples). Honors summary_only to skip the samples block. Project filter applies to graph_nodes via properties.project; edge totals are unfiltered (edges have no project column).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description:
                  'Optional project filter — narrows graph_nodes via properties.project. Edge counts remain global.',
              },
              summary_only: {
                type: 'boolean',
                description: 'Counts only, no samples block (omits top_god_nodes). Default false.',
              },
              days: {
                type: 'number',
                description: 'Time window for recent.* stats. Default 30. Must be non-negative.',
              },
            },
          },
          handler: (args) => handleGraphDashboard(args),
        },

        // -----------------------------------------------------------------
        // FR-111: igris_brief_graph_render
        // -----------------------------------------------------------------
        {
          name: 'igris_brief_graph_render',
          description:
            "Render an interactive HTML force-directed graph of a project's briefs and typed edges. Briefs are nodes, typed edges are connections, goals appear as anchor nodes when at least one brief in the project links to them via serves_goal. Output is a single self-contained HTML file (vis-network via CDN, vanilla JS, no build step). Soft-deleted edges are excluded. Brief content is capped at 8 KB per brief to bound output size. Returns the output path, node/edge/goal counts, top god nodes by degree, and render time.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug (matches brief_status.project).',
              },
              output_path: {
                type: 'string',
                description:
                  "Output HTML path. Defaults to ~/.igris/projects/{project}/visualizations/briefs-graph-{timestamp}.html (parent directory auto-created).",
              },
            },
            required: ['project'],
          },
          handler: (args) => handleBriefGraphRender(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          {
            name: 'edge.created',
            description: 'A typed edge was created (via tool or auto-hook)',
          },
          {
            name: 'edge.removed',
            description:
              'A typed edge was soft- or hard-deleted (cache invalidation signal for downstream subscribers)',
          },
        ],
        listens: [
          {
            name: 'brief.created',
            description: 'Auto-create parent_of edge when payload contains parent_brief_id',
          },
          {
            name: 'memory.stored',
            description: 'FR-210: auto-create learning-to-brief (source_brief) + model-supplied (edges array) edges at store time',
          },
          {
            name: 'edge.created',
            description: 'Self-listen to invalidate the FR-113 subgraph traversal cache',
          },
          {
            name: 'edge.removed',
            description: 'Self-listen to invalidate the FR-113 subgraph traversal cache',
          },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.bus.on('brief.created', onBriefCreated);
      // FR-210: capture cross-surface edges at learning-store time.
      ctx.bus.on('memory.stored', onMemoryStored);
      // Self-listen for cache invalidation (FR-113 subgraph cache).
      ctx.bus.on('edge.created', onEdgeMutated);
      ctx.bus.on('edge.removed', onEdgeMutated);
      ctx.log.info('Edges component initialized (v1.3.0 — TD-171 M2 graph nodes)');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('brief.created', onBriefCreated);
        _ctx.bus.off('memory.stored', onMemoryStored);
        _ctx.bus.off('edge.created', onEdgeMutated);
        _ctx.bus.off('edge.removed', onEdgeMutated);
      }
      // Clear cache on shutdown so a re-init doesn't see stale data.
      invalidateSubgraphCache();
      _ctx = null;
    },
  };
}
