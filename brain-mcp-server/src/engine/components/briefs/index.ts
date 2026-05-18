/**
 * Brain Engine v7.0 — Briefs Component
 *
 * Wraps the existing brief tool handlers as a BrainComponent.
 * Provides: igris_brief_sync, igris_brief_dashboard
 *
 * @module engine/components/briefs
 * @author fifty.dev
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import {
  handleBriefSync,
  handleBriefDashboard,
  handleBriefGet,
  handleBriefList,
  handleBriefCreate,
  handleBriefUpdate,
  handleBriefVelocity,
  handleBriefSimilar,
  handleBriefBackfillEmbeddings,
  extractParentBriefId,
} from '../../../tools/briefs.js';
import type {
  BriefSyncInput,
  BriefDashboardInput,
  BriefGetInput,
  BriefListInput,
  BriefCreateInput,
  BriefUpdateInput,
  BriefVelocityInput,
  BriefSimilarInput,
  BriefBackfillInput,
} from '../../../tools/briefs.js';
import { getDb } from '../../../db.js';
import { briefMigrations } from './schema.js';
import { handleBriefClaim, handleBriefRelease } from './handlers.js';

export function createBriefsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'briefs',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return briefMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_brief_sync',
          description: 'Sync a brief status change to the Igris brain. Called when brief status changes during /hunt, /rest, or /archive. Uses upsert to maintain one record per project+brief_id.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "MG-010")',
              },
              brief_type: {
                type: 'string',
                description: 'Brief type (e.g., "Bug", "Migration", "Feature")',
              },
              title: {
                type: 'string',
                description: 'Brief title',
              },
              status: {
                type: 'string',
                description: 'Brief status (e.g., "Ready", "In Progress", "Done")',
              },
              priority: {
                type: 'string',
                description: 'Priority level (e.g., "P0", "P1-High")',
              },
              effort: {
                type: 'string',
                description: 'Effort estimate (e.g., "S-Small", "L-Large")',
              },
              phase: {
                type: 'string',
                description: 'Current workflow phase (e.g., "BUILDING", "TESTING")',
              },
            },
            required: ['project', 'brief_id', 'title', 'status'],
          },
          handler: (args) => {
            const typedArgs = args as Record<string, unknown>;
            const project = typedArgs.project as string;
            const briefId = typedArgs.brief_id as string;
            const status = typedArgs.status as string;
            const title = typedArgs.title as string;

            // Check if brief exists before upsert to detect new vs update
            const db = getDb();
            const existing = db.prepare(
              'SELECT status FROM brief_status WHERE project = ? AND brief_id = ?'
            ).get(project, briefId) as { status: string } | undefined;

            const result = handleBriefSync(args as unknown as BriefSyncInput);

            if (_ctx) {
              // Always emit synced
              _ctx.bus.emit('brief.synced', { project, brief_id: briefId });

              // Emit brief.created if this is a new brief
              if (!existing) {
                _ctx.bus.emit('brief.created', {
                  project,
                  brief_id: briefId,
                  title,
                  status,
                });
              }

              // Emit brief.completed if status transitioned to a terminal state
              // (Done or Archived). The guard `!prevTerminal` prevents double-fire
              // within the same terminal class, but Done -> Archived fires only
              // once because Done is already terminal.
              // Listener `onBriefCompleted` in tasks/index.ts is idempotent
              // (skips already-done/cancelled tasks) so re-firing is safe.
              const TERMINAL_STATUSES = ['Done', 'Archived'] as const;
              const prevTerminal = existing?.status
                ? (TERMINAL_STATUSES as readonly string[]).includes(existing.status)
                : false;
              const nowTerminal = (TERMINAL_STATUSES as readonly string[]).includes(status);
              if (nowTerminal && !prevTerminal) {
                _ctx.bus.emit('brief.completed', {
                  project,
                  brief_id: briefId,
                  title,
                });
              }
            }

            return result;
          },
        },
        {
          name: 'igris_brief_dashboard',
          description: 'Display a cross-project brief dashboard showing all tracked briefs with status counts. Supports filtering by status and project. Use summary_only=true to get only aggregate counts (by status and priority) without the full briefs table — ideal for /scan and /awaken where only counts are needed.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              status: {
                type: 'string',
                description: 'Filter by brief status (optional)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              summary_only: {
                type: 'boolean',
                description: 'When true, return only aggregate counts (by status and priority) without the full briefs table. Keeps response under 500 tokens. Default: false.',
              },
            },
          },
          handler: (args) => handleBriefDashboard(args as unknown as BriefDashboardInput),
        },
        {
          name: 'igris_brief_get',
          description: 'Get a single brief by project and brief_id. Returns content (from brief_files) and metadata (from brief_status). Falls back to metadata-only if no content is stored.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "FR-051")',
              },
            },
            required: ['project', 'brief_id'],
          },
          handler: (args) => handleBriefGet(args as unknown as BriefGetInput),
        },
        {
          name: 'igris_brief_list',
          description: 'List briefs with optional filters and pagination. Supports filtering by project, status, brief_type, and priority. Returns paginated results (default 25 per page) with total count. Set limit=0 to return all.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              status: {
                type: 'string',
                description: 'Filter by brief status, e.g., "Ready", "In Progress", "Done" (optional)',
              },
              brief_type: {
                type: 'string',
                description: 'Filter by brief type, e.g., "Bug", "Feature", "Migration" (optional)',
              },
              priority: {
                type: 'string',
                description: 'Filter by priority, e.g., "P0", "P1-High" (optional)',
              },
              include_content: {
                type: 'boolean',
                description: 'Include full brief content from brief_files (default: false)',
              },
              limit: {
                type: 'integer',
                description: 'Maximum number of briefs to return (default: 25, 0 = return all)',
              },
              offset: {
                type: 'integer',
                description: 'Number of briefs to skip for pagination (default: 0)',
              },
            },
          },
          handler: (args) => handleBriefList(args as unknown as BriefListInput),
        },
        {
          name: 'igris_brief_create',
          description: 'Create a new brief with content and metadata. Atomically inserts into both brief_files and brief_status. Use this to store a complete brief in the brain.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-032", "FR-052")',
              },
              title: {
                type: 'string',
                description: 'Brief title',
              },
              content: {
                type: 'string',
                description: 'Full brief content (markdown)',
              },
              filename: {
                type: 'string',
                description: 'Filename for the brief (default: "{brief_id}.md")',
              },
              brief_type: {
                type: 'string',
                description: 'Brief type (e.g., "Bug", "Feature", "Migration")',
              },
              status: {
                type: 'string',
                description: 'Brief status (default: "Ready")',
              },
              priority: {
                type: 'string',
                description: 'Priority level (e.g., "P0", "P1-High")',
              },
              effort: {
                type: 'string',
                description: 'Effort estimate (e.g., "S-Small", "M-Medium")',
              },
              phase: {
                type: 'string',
                description: 'Current workflow phase',
              },
              parent_brief: {
                type: 'string',
                description: 'Parent brief id (e.g., "FR-051"). When omitted, the briefs component scans the markdown content for "**Parent Brief:** FR-XXX". Used to auto-create a parent_of edge (FR-105).',
              },
            },
            required: ['project', 'brief_id', 'title', 'content'],
          },
          handler: async (args) => {
            const typedArgs = args as Record<string, unknown>;
            const result = await handleBriefCreate(args as unknown as BriefCreateInput);

            if (_ctx) {
              // FR-105: enrich payload with parent_brief_id so the edges
              // component can auto-create a parent_of edge. Prefer the
              // explicit field, fall back to scanning markdown content.
              const explicitParent = typedArgs.parent_brief as string | undefined;
              const content = (typedArgs.content as string | undefined) ?? '';
              const parsedParent = explicitParent ?? extractParentBriefId(content) ?? undefined;
              const briefId = typedArgs.brief_id as string;
              // Defensive: never let a brief claim itself as its own parent.
              const parentBriefId = parsedParent && parsedParent !== briefId ? parsedParent : undefined;

              _ctx.bus.emit('brief.created', {
                project: typedArgs.project as string,
                brief_id: briefId,
                title: typedArgs.title as string,
                status: (typedArgs.status as string) ?? 'Ready',
                ...(parentBriefId ? { parent_brief_id: parentBriefId } : {}),
              });

              // Check if similarity warning was emitted in the response
              const text = result.content[0]?.text ?? '';
              if (text.includes('similar brief(s) detected')) {
                _ctx.bus.emit('brief.similar_detected', {
                  project: typedArgs.project as string,
                  brief_id: briefId,
                });
              }
            }

            return result;
          },
        },
        {
          name: 'igris_brief_update',
          description: 'Update an existing brief\'s content and/or metadata. Only updates fields that are provided. Supports partial updates to both brief_files and brief_status.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "FR-051")',
              },
              content: {
                type: 'string',
                description: 'Updated brief content (markdown)',
              },
              title: {
                type: 'string',
                description: 'Updated brief title',
              },
              status: {
                type: 'string',
                description: 'Updated brief status',
              },
              priority: {
                type: 'string',
                description: 'Updated priority level',
              },
              effort: {
                type: 'string',
                description: 'Updated effort estimate',
              },
              phase: {
                type: 'string',
                description: 'Updated workflow phase',
              },
              brief_type: {
                type: 'string',
                description: 'Updated brief type',
              },
              filename: {
                type: 'string',
                description: 'Updated filename',
              },
            },
            required: ['project', 'brief_id'],
          },
          handler: (args) => {
            const typedArgs = args as Record<string, unknown>;
            const project = typedArgs.project as string;
            const briefId = typedArgs.brief_id as string;
            const newStatus = typedArgs.status as string | undefined;

            // Check current status before update for event detection
            let previousStatus: string | undefined;
            if (_ctx && newStatus) {
              const db = getDb();
              const existing = db.prepare(
                'SELECT status FROM brief_status WHERE project = ? AND brief_id = ?'
              ).get(project, briefId) as { status: string } | undefined;
              previousStatus = existing?.status;
            }

            const result = handleBriefUpdate(args as unknown as BriefUpdateInput);

            if (_ctx) {
              _ctx.bus.emit('brief.synced', { project, brief_id: briefId });

              // Emit brief.completed if status transitioned to a terminal state
              // (Done or Archived). The guard `!prevTerminal` prevents double-fire
              // within the same terminal class, but Done -> Archived fires only
              // once because Done is already terminal.
              // Listener `onBriefCompleted` in tasks/index.ts is idempotent
              // (skips already-done/cancelled tasks) so re-firing is safe.
              if (newStatus !== undefined) {
                const TERMINAL_STATUSES = ['Done', 'Archived'] as const;
                const prevTerminal = previousStatus
                  ? (TERMINAL_STATUSES as readonly string[]).includes(previousStatus)
                  : false;
                const nowTerminal = (TERMINAL_STATUSES as readonly string[]).includes(newStatus);
                if (nowTerminal && !prevTerminal) {
                  _ctx.bus.emit('brief.completed', {
                    project,
                    brief_id: briefId,
                    title: (typedArgs.title as string) ?? '',
                  });
                }
              }
            }

            return result;
          },
        },
        {
          name: 'igris_brief_velocity',
          description: 'Compute brief completion velocity metrics. Returns weekly completion counts, overall completion rate, and a week-over-week trend indicator.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (optional -- omit for cross-project velocity)',
              },
              weeks: {
                type: 'number',
                description: 'Number of weeks to include (default: 4, max: 52)',
              },
            },
          },
          handler: (args) => {
            const result = handleBriefVelocity(args as unknown as BriefVelocityInput);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          },
        },
        {
          name: 'igris_brief_similar',
          description: 'Find briefs that are semantically similar to a query. Uses vector embeddings to detect near-duplicate briefs. Returns matches above the cosine similarity threshold (default: 0.85).',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description: 'Brief title and/or problem description to search for similar briefs',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              threshold: {
                type: 'number',
                description: 'Minimum cosine similarity threshold (default: 0.85)',
              },
              limit: {
                type: 'number',
                description: 'Maximum results (default: 5)',
              },
            },
            required: ['query'],
          },
          handler: async (args) => handleBriefSimilar(args as unknown as BriefSimilarInput),
        },
        {
          name: 'igris_brief_backfill_embeddings',
          description: 'Batch-generate embeddings for existing briefs that lack them. Processes briefs in batches -- run multiple times to process all. Resumable: only processes briefs without embeddings.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              batch_size: {
                type: 'number',
                description: 'Number of briefs to process per batch (default: 50)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional -- omit to backfill all projects)',
              },
            },
            required: [],
          },
          handler: async (args) => handleBriefBackfillEmbeddings(args as unknown as BriefBackfillInput),
        },
        {
          name: 'igris_brief_claim',
          description: 'Atomically claim a brief for an Igris instance (FR-127 multi-harness gate). Performs a single conditional UPDATE on brief_status: the claim succeeds (claimed=true) when the brief is unclaimed or already held by the same instance (re-entrant), and fails (claimed=false, with held_by) when another instance holds it. claimed=false is a successful result — the gate outcome is data, not an error. Called automatically by /hunt before INIT; not invoked by hand.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID to claim (e.g., "FR-127")',
              },
              instance_id: {
                type: 'string',
                description: 'The claiming instance UUID (from igris_instance_heartbeat)',
              },
            },
            required: ['project', 'brief_id', 'instance_id'],
          },
          handler: (args) => {
            const result = handleBriefClaim(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('brief.claimed', {
                project: (args as Record<string, unknown>).project,
                brief_id: (args as Record<string, unknown>).brief_id,
                instance_id: (args as Record<string, unknown>).instance_id,
              });
            }
            return result;
          },
        },
        {
          name: 'igris_brief_release',
          description: 'Release a brief claim held by an Igris instance (FR-127 multi-harness gate). Ownership-scoped conditional UPDATE: only frees a claim the given instance holds, so a rested instance cannot free a brief a sibling re-claimed. Idempotent — releasing a brief with no claim (or held by another) returns released=false and is still a success. Called automatically by /rest and on brief completion; not invoked by hand.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID to release (e.g., "FR-127")',
              },
              instance_id: {
                type: 'string',
                description: 'The instance UUID — only releases if THIS instance holds the claim',
              },
            },
            required: ['project', 'brief_id', 'instance_id'],
          },
          handler: (args) => {
            const result = handleBriefRelease(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('brief.released', {
                project: (args as Record<string, unknown>).project,
                brief_id: (args as Record<string, unknown>).brief_id,
                instance_id: (args as Record<string, unknown>).instance_id,
              });
            }
            return result;
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'brief.synced', description: 'A brief status was synced' },
          { name: 'brief.created', description: 'A new brief was synced for the first time' },
          { name: 'brief.completed', description: 'A brief status transitioned to a terminal state (Done or Archived)' },
          { name: 'brief.similar_detected', description: 'Similar briefs were detected during creation' },
          // FR-127: orphan emits (no listeners yet) — extension point for a
          // future claim-activity dashboard. Permitted, as instance.heartbeat
          // already demonstrates.
          { name: 'brief.claimed', description: 'A brief was atomically claimed by an instance (FR-127)' },
          { name: 'brief.released', description: 'A brief claim was released by an instance (FR-127)' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Briefs component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
