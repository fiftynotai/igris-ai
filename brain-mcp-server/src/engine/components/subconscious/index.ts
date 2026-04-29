/**
 * Brain Engine v5.0 — Subconscious Component
 *
 * Passive observer (FR-106). Phase 1 shipped two deterministic detectors
 * (`stalled`, `gap`), four MCP tools, and a self-bootstrapping cron
 * schedule (`subconscious_engine`) that fires the pipeline every six
 * hours. Phase 2 adds `conflict` and `pattern` detectors plus
 * `pattern_observations` for 3-run smoothing — same component surface,
 * no new MCP tools, no new event names.
 *
 * Component contract:
 *   - schema()   : suggestions + dismissed_patterns (v1) +
 *                  pattern_observations (v2).
 *   - tools()    : 4 MCP tools — list/dismiss/acted/run.
 *   - events()   : emits run_start, run_complete, suggestion_emitted,
 *                  suggestion_suppressed; listens engine.ready.
 *   - init()     : sets handler context; on engine.ready, dispatches
 *                  `igris_schedule_create` if the schedule isn't already
 *                  present (idempotent).
 *
 * Scheduler bootstrap (FR-106 plan, Concern 3):
 *   The schedules component supports `handler_type: 'mcp-tool'` with
 *   `handler_config: { tool, args }` — that's the supported invocation
 *   path. We dispatch the create through the gateway `dispatch` captured
 *   off `engine.ready`, never via the raw schedules handler, so the
 *   normal schedule-creation events fire.
 *
 * @module engine/components/subconscious
 * @author Fifty.ai
 */

import { getDb } from '../../../db.js';
import type {
  BrainComponent,
  ComponentContext,
  EventDef,
  EventPayload,
  Migration,
  ToolDefinition,
} from '../../types.js';
import { errMsg } from '../../helpers.js';
import { subconsciousMigrations } from './schema.js';
import {
  handleSuggestionList,
  handleSuggestionDismiss,
  handleSuggestionActed,
  handleSubconsciousRun,
  setHandlerContext,
  VALID_PRIORITIES,
  VALID_SOURCE_MODULES,
  VALID_STATUSES,
} from './handlers.js';
import { DEFAULT_DETECTOR_CONFIG } from './types.js';

/** The well-known name used to detect an existing schedule on init. */
const SCHEDULE_NAME = 'subconscious_engine';
/** Every six hours: minute=0 every 6th hour every day. */
const SCHEDULE_CRON_EXPR = '0 */6 * * *';

export function createSubconsciousComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

  /**
   * Capture the gateway dispatcher off `engine.ready`. Once we have it,
   * register the cron schedule (idempotently) so the daemon picks it
   * up on its next polling tick.
   */
  function onEngineReady(payload: EventPayload): void {
    const dispatch = payload.data.dispatch as
      | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    if (!dispatch) return;
    _dispatchTool = dispatch;
    void ensureScheduleExists();
  }

  /**
   * Idempotent schedule bootstrap. Reads the `schedules` table directly
   * (the table is owned by the schedules component but reading is
   * cross-component-safe), and dispatches `igris_schedule_create` only
   * if no row matches `name = subconscious_engine`. Re-running init is a
   * no-op.
   *
   * Note we use the gateway dispatch (not handleScheduleCreate
   * directly) so the schedules component's own event emissions and
   * daemon recalculation fire.
   */
  async function ensureScheduleExists(): Promise<void> {
    if (!_ctx || !_dispatchTool) return;
    try {
      const db = getDb();
      const existing = db
        .prepare(`SELECT 1 FROM schedules WHERE name = ? LIMIT 1`)
        .get(SCHEDULE_NAME) as { 1: number } | undefined;
      if (existing) {
        _ctx.log.info(`Schedule "${SCHEDULE_NAME}" already exists; skipping bootstrap`);
        return;
      }
    } catch (err) {
      // schedules table missing — boot order will fix this on next start.
      _ctx.log.warn(`Could not query schedules table: ${errMsg(err)}`);
      return;
    }

    try {
      await _dispatchTool('igris_schedule_create', {
        name: SCHEDULE_NAME,
        description: 'FR-106 subconscious engine: passive detector pipeline (every 6h)',
        cron_expr: SCHEDULE_CRON_EXPR,
        handler_type: 'mcp-tool',
        handler_config: { tool: 'igris_subconscious_run', args: {} },
        enabled: true,
        tags: ['subconscious', 'fr-106'],
      });
      _ctx.log.info(`Bootstrapped schedule: ${SCHEDULE_NAME} (${SCHEDULE_CRON_EXPR})`);
    } catch (err) {
      _ctx.log.warn(`Failed to bootstrap schedule "${SCHEDULE_NAME}": ${errMsg(err)}`);
    }
  }

  return {
    name: 'subconscious',
    version: '1.1.0',
    depends: [],

    schema(): Migration[] {
      return subconsciousMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_suggestion_list
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_list',
          description:
            'List subconscious-engine suggestions with optional filters. Default sort: priority (high>medium>low) then created_at DESC. Use status="pending" + limit=3 in /awaken to render the top actionable items.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              status: {
                type: 'string',
                enum: [...VALID_STATUSES],
                description: 'Filter by status (pending, dismissed, acted)',
              },
              project_slug: {
                type: 'string',
                description: 'Filter by project slug',
              },
              source_module: {
                type: 'string',
                enum: [...VALID_SOURCE_MODULES],
                description: 'Filter by detector module (stalled, conflict, gap, pattern)',
              },
              priority: {
                type: 'string',
                enum: [...VALID_PRIORITIES],
                description: 'Filter by priority (high, medium, low)',
              },
              limit: {
                type: 'integer',
                description: 'Maximum suggestions to return (default 25, max 1000)',
              },
              offset: {
                type: 'integer',
                description: 'Pagination offset (default 0)',
              },
            },
          },
          handler: (args) => handleSuggestionList(args),
        },

        // -----------------------------------------------------------------
        // igris_suggestion_dismiss
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_dismiss',
          description:
            'Mark a suggestion as dismissed. The optional reason feeds the dismiss-reason learning loop: future suggestions with the same evidence signature will be suppressed once the dismiss count crosses the configured threshold (default 2 dismisses).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: {
                type: 'integer',
                description: 'Suggestion id (positive integer)',
              },
              reason: {
                type: 'string',
                description: 'Optional free-text reason recorded for the learning loop',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleSuggestionDismiss(args),
        },

        // -----------------------------------------------------------------
        // igris_suggestion_acted
        // -----------------------------------------------------------------
        {
          name: 'igris_suggestion_acted',
          description:
            "Mark a suggestion as acted on. Optional brief_id records which brief the user opened in response. Acted does NOT feed the suppression loop — it is a positive signal.",
          inputSchema: {
            type: 'object' as const,
            properties: {
              id: {
                type: 'integer',
                description: 'Suggestion id (positive integer)',
              },
              brief_id: {
                type: 'string',
                description: 'Optional brief id linking the action that resolved the suggestion',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleSuggestionActed(args),
        },

        // -----------------------------------------------------------------
        // igris_subconscious_run
        // -----------------------------------------------------------------
        {
          name: 'igris_subconscious_run',
          description:
            'Run the subconscious detector pipeline once. Invoked by the cron schedule "subconscious_engine" every 6 hours; also fireable manually for debugging or immediate sweep. Returns counts of emitted/suppressed suggestions broken down by module.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
          handler: (args) => handleSubconsciousRun(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          {
            name: 'subconscious.run_start',
            description: 'A subconscious detector run started',
          },
          {
            name: 'subconscious.run_complete',
            description: 'A subconscious detector run completed (with counts)',
          },
          {
            name: 'subconscious.suggestion_emitted',
            description: 'A new suggestion was persisted',
          },
          {
            name: 'subconscious.suggestion_suppressed',
            description: 'A candidate suggestion was suppressed by the dismiss-reason learning loop',
          },
        ],
        listens: [
          {
            name: 'engine.ready',
            description: 'Capture gateway dispatch and bootstrap the cron schedule',
          },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.bus.on('engine.ready', onEngineReady);
      setHandlerContext({ bus: ctx.bus, config: DEFAULT_DETECTOR_CONFIG });
      ctx.log.info('Subconscious component initialized');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('engine.ready', onEngineReady);
      }
      _ctx = null;
      _dispatchTool = null;
    },
  };
}
