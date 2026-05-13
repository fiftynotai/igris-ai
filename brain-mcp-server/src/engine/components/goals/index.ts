/**
 * Brain Engine v7.0 — Goals Component
 *
 * Outcome-level entities distinct from briefs (FR-110). A goal is a "what
 * we're trying to achieve" with a deadline, status lifecycle, and optional
 * cross-project scope; a brief is a "thing we're doing" — a unit of work.
 * Goal-to-brief linkage rides on the existing `entity_edges` table via the
 * already-registered `serves_goal` edge type and `goal` entity type from
 * FR-105.
 *
 * Provides 5 MCP tools:
 *   - igris_goal_create   — server-side GL-XXX allocation
 *   - igris_goal_list     — filtered query (project, status, upcoming_days)
 *   - igris_goal_get      — goal + serving briefs/learnings
 *   - igris_goal_update   — partial patch with status->achieved auto-stamp
 *   - igris_goal_progress — count-based completion across serving briefs
 *
 * Emits: goal.created, goal.updated, goal.achieved
 * Listens: (none in Phase 1 — listeners deferred to FR-106 subconscious)
 *
 * @module engine/components/goals
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  EventDef,
  Migration,
  ToolDefinition,
} from '../../types.js';
import { goalMigrations } from './schema.js';
import {
  handleGoalCreate,
  handleGoalList,
  handleGoalGet,
  handleGoalUpdate,
  handleGoalProgress,
  VALID_GOAL_STATUSES,
} from './handlers.js';

/**
 * Build the goals component instance.
 *
 * Registered in `engine/index.ts` after `createEdgesComponent` — there is
 * no formal `depends` declaration because both components share the
 * SQLite connection and goal queries fall back to zero-row results when
 * `entity_edges` is empty. Ordering matters only for boot stability:
 * edges should run its v1 migration first so the JOIN target exists.
 */
export function createGoalsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'goals',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return goalMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_goal_create
        // -----------------------------------------------------------------
        {
          name: 'igris_goal_create',
          description:
            'Create a new goal (outcome-level entity). Auto-allocates the next sequential GL-XXX id server-side. Use this when the user describes an outcome with a deadline, not a unit of work — register a brief instead for tasks. The project field is optional — omit or pass null for cross-project goals.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug (omit for cross-project goals)',
              },
              title: {
                type: 'string',
                description: 'Goal title (e.g. "Ship v6.1")',
              },
              description: {
                type: 'string',
                description: 'Optional longer description',
              },
              outcome: {
                type: 'string',
                description: 'Free-text outcome statement (what success looks like)',
              },
              deadline: {
                type: 'string',
                description: 'Optional ISO-8601 date (YYYY-MM-DD or full timestamp)',
              },
              status: {
                type: 'string',
                enum: [...VALID_GOAL_STATUSES],
                description: 'Initial status (default "active")',
              },
              priority: {
                type: 'string',
                description: 'Priority label (default "P2-Medium")',
              },
              metadata: {
                type: 'object',
                description: 'Free-form metadata stored as JSON',
              },
            },
            required: ['title', 'outcome'],
          },
          handler: (args) => {
            const result = handleGoalCreate(args);
            if (!result.isError && _ctx) {
              // Parse the goal_id back out of the result so we don't have
              // to re-query. successResult bodies are JSON.
              try {
                const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
                  goal?: { goal_id?: string; project_slug?: string | null; title?: string };
                };
                _ctx.bus.emit('goal.created', {
                  goal_id: parsed.goal?.goal_id ?? '',
                  project_slug: parsed.goal?.project_slug ?? null,
                  title: parsed.goal?.title ?? '',
                });
              } catch {
                // If parsing fails the create still succeeded; surface
                // a generic event rather than swallowing.
                _ctx.bus.emit('goal.created', {});
              }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_goal_list
        // -----------------------------------------------------------------
        {
          name: 'igris_goal_list',
          description:
            'List goals with optional filters. Supports project, status, upcoming_days (active goals with deadlines within N days), limit (default 25), and offset. Each row includes serving_briefs_count via subquery on entity_edges. Sort: deadline ASC NULLS LAST, then created_at DESC.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Filter by project slug (omit for cross-project listing)',
              },
              status: {
                type: 'string',
                enum: [...VALID_GOAL_STATUSES],
                description: 'Filter by goal status',
              },
              upcoming_days: {
                type: 'integer',
                description:
                  'When set, restrict to active goals with deadlines within N days. Use 14 in /awaken.',
              },
              limit: {
                type: 'integer',
                description: 'Maximum goals to return (default 25, max 1000)',
              },
              offset: {
                type: 'integer',
                description: 'Pagination offset (default 0)',
              },
            },
          },
          handler: (args) => handleGoalList(args),
        },

        // -----------------------------------------------------------------
        // igris_goal_get
        // -----------------------------------------------------------------
        {
          name: 'igris_goal_get',
          description:
            'Get a single goal by goal_id along with the briefs that serve it (via serves_goal edges) and a count of serving learnings. Returns isError if the goal does not exist.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              goal_id: {
                type: 'string',
                description: 'Goal id (e.g. "GL-001")',
              },
            },
            required: ['goal_id'],
          },
          handler: (args) => handleGoalGet(args),
        },

        // -----------------------------------------------------------------
        // igris_goal_update
        // -----------------------------------------------------------------
        {
          name: 'igris_goal_update',
          description:
            "Patch any subset of a goal's fields. Status transitions to 'achieved' auto-set achieved_at; reverting from 'achieved' clears it. Emits goal.updated on any change, plus goal.achieved on the achieved transition.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              goal_id: { type: 'string', description: 'Goal id (e.g. "GL-001")' },
              title: { type: 'string' },
              description: { type: 'string' },
              outcome: { type: 'string' },
              deadline: { type: 'string', description: 'ISO-8601 date or null to clear' },
              status: { type: 'string', enum: [...VALID_GOAL_STATUSES] },
              priority: { type: 'string' },
              project: { type: 'string' },
              metadata: { type: 'object' },
            },
            required: ['goal_id'],
          },
          handler: (args) => {
            const result = handleGoalUpdate(args);
            if (!result.isError && _ctx) {
              try {
                const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
                  updated?: boolean;
                  achieved_now?: boolean;
                  goal?: { goal_id?: string; status?: string };
                };
                if (parsed.updated) {
                  _ctx.bus.emit('goal.updated', {
                    goal_id: parsed.goal?.goal_id ?? (args.goal_id as string),
                    status: parsed.goal?.status ?? '',
                  });
                  if (parsed.achieved_now) {
                    _ctx.bus.emit('goal.achieved', {
                      goal_id: parsed.goal?.goal_id ?? (args.goal_id as string),
                    });
                  }
                }
              } catch {
                // No-op: update succeeded but payload couldn't be parsed.
              }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_goal_progress
        // -----------------------------------------------------------------
        {
          name: 'igris_goal_progress',
          description:
            "Compute completion progress for a goal based on briefs that serve it (via serves_goal edges). Returns counts by bucket (total/done/in_progress/pending) and completion_pct (done/total, or null when total=0). \"Done\" = brief.status IN ('Done', 'Archived'). Soft-deleted edges are excluded. Learnings surface as a count only; they have no terminal status.",
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              goal_id: {
                type: 'string',
                description: 'Goal id (e.g. "GL-001")',
              },
            },
            required: ['goal_id'],
          },
          handler: (args) => handleGoalProgress(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'goal.created', description: 'A new goal was created' },
          { name: 'goal.updated', description: 'An existing goal was patched' },
          {
            name: 'goal.achieved',
            description: "A goal's status transitioned to 'achieved' (fired alongside goal.updated)",
          },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Goals component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
