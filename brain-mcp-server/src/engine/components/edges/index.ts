/**
 * Brain Engine v5.0 — Edges Component
 *
 * Wraps the typed-edges graph layer as a BrainComponent.
 * Provides 3 MCP tools (igris_edge_create / list / remove) and
 * subscribes to brief.created so structural Parent edges are
 * captured at insert time without coupling the briefs component
 * to edge logic.
 *
 * Emits: edge.created
 * Listens: brief.created
 *
 * Foundation for FR-107 (provenance), FR-110 (goals), FR-111
 * (visualization), FR-112 (community detection), FR-113 (graph
 * traversal MCP tools).
 *
 * @module engine/components/edges
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  EventDef,
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

  return {
    name: 'edges',
    version: '1.0.0',
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
            properties: {
              id: { type: 'integer', description: 'Edge id (entity_edges.id)' },
              hard: {
                type: 'boolean',
                description: 'When true, permanently delete the row (default false)',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleEdgeRemove(args),
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
        ],
        listens: [
          {
            name: 'brief.created',
            description: 'Auto-create parent_of edge when payload contains parent_brief_id',
          },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.bus.on('brief.created', onBriefCreated);
      ctx.log.info('Edges component initialized');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('brief.created', onBriefCreated);
      }
      _ctx = null;
    },
  };
}
