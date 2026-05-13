/**
 * Brain Engine v7.0 — Edges Component
 *
 * Wraps the typed-edges graph layer as a BrainComponent.
 * Provides 7 MCP tools:
 *   CRUD (FR-105):       igris_edge_create / list / remove
 *   Graph (FR-113):      igris_graph_neighbors / path / subgraph
 *   Visualization (FR-111): igris_brief_graph_render
 * Subscribes to brief.created so structural Parent edges are captured
 * at insert time without coupling the briefs component to edge logic.
 * Self-listens on edge.created and edge.removed to invalidate the
 * subgraph traversal cache.
 *
 * Emits: edge.created, edge.removed
 * Listens: brief.created, edge.created (self), edge.removed (self)
 *
 * Foundation for FR-107 (provenance), FR-110 (goals), FR-111
 * (visualization), FR-112 (community detection).
 *
 * @module engine/components/edges
 * @author Fifty.ai
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

  // Cache-invalidation listeners are stable function references so they can
  // be passed to both bus.on() and bus.off() — typed loosely to satisfy the
  // EventHandler signature even though we ignore the payload.
  const onEdgeMutated: EventHandler = () => {
    invalidateSubgraphCache();
  };

  return {
    name: 'edges',
    version: '1.2.0',
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
      // Self-listen for cache invalidation (FR-113 subgraph cache).
      ctx.bus.on('edge.created', onEdgeMutated);
      ctx.bus.on('edge.removed', onEdgeMutated);
      ctx.log.info('Edges component initialized (v1.2.0 — FR-111 visualization)');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('brief.created', onBriefCreated);
        _ctx.bus.off('edge.created', onEdgeMutated);
        _ctx.bus.off('edge.removed', onEdgeMutated);
      }
      // Clear cache on shutdown so a re-init doesn't see stale data.
      invalidateSubgraphCache();
      _ctx = null;
    },
  };
}
