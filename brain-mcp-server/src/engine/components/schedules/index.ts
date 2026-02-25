/**
 * Brain Engine v5.0 — Schedules Component
 *
 * Wraps the schedule management handlers as a BrainComponent.
 * Provides 7 MCP tools for schedule CRUD, enable/disable,
 * fire-now, and deletion.
 *
 * Includes an in-process daemon that fires schedules on their
 * cron-defined intervals using smart-sleep via setTimeout.
 *
 * Emits: schedule.created, schedule.enabled, schedule.disabled,
 *        schedule.deleted, schedule.fire_now, schedule.run_start,
 *        schedule.run_complete
 * Listens: engine.ready (to capture dispatchTool reference)
 *
 * @module engine/components/schedules
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
  EventPayload,
} from '../../types.js';
import { scheduleMigrations } from './schema.js';
import {
  handleScheduleCreate,
  handleScheduleList,
  handleScheduleGet,
  handleScheduleEnable,
  handleScheduleDisable,
  handleScheduleFireNow,
  handleScheduleDelete,
  setHandlerContext,
} from './handlers.js';
import { startDaemon } from './daemon.js';
import type { DaemonHandle } from './daemon.js';

export function createSchedulesComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _daemon: DaemonHandle | null = null;
  let _dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

  /** Handler for engine.ready event — capture the gateway dispatch function */
  function onEngineReady(payload: EventPayload): void {
    const dispatch = payload.data.dispatch as
      | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    if (dispatch) {
      _dispatchTool = dispatch;
      _ctx?.log.info('Captured gateway dispatch for schedule execution');
    }
  }

  return {
    name: 'schedules',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return scheduleMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_schedule_create
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_create',
          description: 'Create a new scheduled job. Supports cron expressions (5-field), multiple handler types (mcp-tool, shell, noop), and optional project scoping.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              name: {
                type: 'string',
                description: 'Schedule name (human-readable)',
              },
              cron_expr: {
                type: 'string',
                description: 'Cron expression (5-field: minute hour day-of-month month day-of-week). Note: uses AND logic when both day-of-month and day-of-week are specified (differs from POSIX OR semantics). Examples: "0 * * * *" (hourly), "30 2 * * 1" (Mon 2:30am)',
              },
              handler_type: {
                type: 'string',
                enum: ['mcp-tool', 'shell', 'noop'],
                description: 'Handler type: mcp-tool (call an MCP tool), shell (run a command — WARNING: executes arbitrary commands via /bin/sh, only use in trusted environments), noop (no-op for testing)',
              },
              description: {
                type: 'string',
                description: 'Schedule description (optional)',
              },
              handler_config: {
                type: 'object',
                description: 'Handler configuration. For mcp-tool: { tool: "tool_name", args: {} }. For shell: { command: "..." }. (optional)',
              },
              enabled: {
                type: 'boolean',
                description: 'Whether the schedule is enabled (default: true)',
              },
              project_slug: {
                type: 'string',
                description: 'Project slug to scope this schedule to (optional)',
              },
              tags: {
                type: 'array',
                description: 'Tags for categorization (optional)',
                items: { type: 'string' },
              },
              max_retries: {
                type: 'number',
                description: 'Maximum retry attempts on failure (default: 0)',
              },
              timeout_ms: {
                type: 'number',
                description: 'Timeout in milliseconds for handler execution (default: 30000)',
              },
            },
            required: ['name', 'cron_expr', 'handler_type'],
          },
          handler: (args) => {
            const result = handleScheduleCreate(args);
            if (!result.isError) {
              if (_daemon) _daemon.recalculate();
              // Parse result to get schedule_id for event payload
              try {
                const data = JSON.parse(result.content[0].text);
                _ctx?.bus.emit('schedule.created', {
                  schedule_id: data.schedule?.id,
                  name: args.name as string,
                  cron_expr: args.cron_expr as string,
                });
              } catch { /* event emission is best-effort */ }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_schedule_list
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_list',
          description: 'List schedules with optional filters. Includes run stats (run_count, last_status) for each schedule.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              enabled: {
                type: 'boolean',
                description: 'Filter by enabled status (optional)',
              },
              project_slug: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              tag: {
                type: 'string',
                description: 'Filter by tag (optional)',
              },
              limit: {
                type: 'number',
                description: 'Max results (default: 25)',
              },
              offset: {
                type: 'number',
                description: 'Offset for pagination (default: 0)',
              },
            },
          },
          handler: (args) => handleScheduleList(args),
        },

        // -----------------------------------------------------------------
        // igris_schedule_get
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_get',
          description: 'Get a single schedule with its recent run history (last 10 runs).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              schedule_id: {
                type: 'string',
                description: 'Schedule ID (e.g. "sch-a1b2c3d4")',
              },
            },
            required: ['schedule_id'],
          },
          handler: (args) => handleScheduleGet(args),
        },

        // -----------------------------------------------------------------
        // igris_schedule_enable
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_enable',
          description: 'Enable a schedule. Recomputes next_run_at based on the cron expression.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              schedule_id: {
                type: 'string',
                description: 'Schedule ID to enable',
              },
            },
            required: ['schedule_id'],
          },
          handler: (args) => {
            const result = handleScheduleEnable(args);
            if (!result.isError) {
              if (_daemon) _daemon.recalculate();
              _ctx?.bus.emit('schedule.enabled', {
                schedule_id: args.schedule_id as string,
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_schedule_disable
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_disable',
          description: 'Disable a schedule. Stops it from firing until re-enabled.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              schedule_id: {
                type: 'string',
                description: 'Schedule ID to disable',
              },
            },
            required: ['schedule_id'],
          },
          handler: (args) => {
            const result = handleScheduleDisable(args);
            if (!result.isError) {
              if (_daemon) _daemon.recalculate();
              _ctx?.bus.emit('schedule.disabled', {
                schedule_id: args.schedule_id as string,
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_schedule_fire_now
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_fire_now',
          description: 'Immediately fire a schedule, creating a run record. Executes the handler synchronously and returns the result.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              schedule_id: {
                type: 'string',
                description: 'Schedule ID to fire immediately',
              },
            },
            required: ['schedule_id'],
          },
          handler: (args) => handleScheduleFireNow(args),
        },

        // -----------------------------------------------------------------
        // igris_schedule_delete
        // -----------------------------------------------------------------
        {
          name: 'igris_schedule_delete',
          description: 'Delete a schedule and all its run history. This action is irreversible.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              schedule_id: {
                type: 'string',
                description: 'Schedule ID to delete',
              },
            },
            required: ['schedule_id'],
          },
          handler: (args) => {
            const result = handleScheduleDelete(args);
            if (!result.isError) {
              if (_daemon) _daemon.recalculate();
              // Parse result to get schedule name for event payload
              try {
                const data = JSON.parse(result.content[0].text);
                _ctx?.bus.emit('schedule.deleted', {
                  schedule_id: args.schedule_id as string,
                  name: data.name,
                });
              } catch { /* event emission is best-effort */ }
            }
            return result;
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'schedule.created', description: 'A new schedule was created' },
          { name: 'schedule.enabled', description: 'A schedule was enabled' },
          { name: 'schedule.disabled', description: 'A schedule was disabled' },
          { name: 'schedule.deleted', description: 'A schedule was deleted' },
          { name: 'schedule.fire_now', description: 'A schedule was manually fired' },
          { name: 'schedule.run_start', description: 'A schedule run started (daemon)' },
          { name: 'schedule.run_complete', description: 'A schedule run completed' },
        ],
        listens: [
          { name: 'engine.ready', description: 'Capture gateway dispatch for mcp-tool handler execution' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;

      // Wire event listener for engine.ready
      ctx.bus.on('engine.ready', onEngineReady);

      // Set handler context for event emission and dispatch
      setHandlerContext({
        bus: ctx.bus,
        getDispatch: () => _dispatchTool,
      });

      // Start the daemon
      _daemon = startDaemon({
        getDispatch: () => _dispatchTool,
        bus: ctx.bus,
      });

      ctx.log.info('Schedules component initialized (daemon started)');
    },

    destroy(): void {
      if (_daemon) {
        _daemon.stop();
        _daemon = null;
      }
      if (_ctx) {
        _ctx.bus.off('engine.ready', onEngineReady);
      }
      _ctx = null;
      _dispatchTool = null;
    },
  };
}
