/**
 * Brain Engine v7.0 -- Monitoring Component
 *
 * Logs all orphan engine events (schedules, cache, coordination) into
 * an event_log table for observability and audit purposes.
 *
 * Provides 2 MCP tools:
 * - igris_event_log: Query the event log with filters
 * - igris_event_log_cleanup: Purge old event log entries
 *
 * Emits: (none)
 * Listens: schedule.created, schedule.enabled, schedule.disabled,
 *          schedule.deleted, schedule.fire_now, schedule.run_start,
 *          schedule.run_complete, cache.rebuilt, cache.cleaned,
 *          coordination.self_heal, task.created, task.assigned,
 *          task.completed, task.blocked, task.unblocked,
 *          task.failed, task.claimed, brief.synced, brief.created,
 *          brief.completed, session.synced, session.file.updated,
 *          instance.heartbeat, memory.stored, error.stored,
 *          project.registered, metrics.recorded,
 *          subconscious.run_start, subconscious.run_complete,
 *          subconscious.suggestion_emitted,
 *          subconscious.suggestion_suppressed,
 *          subconscious.suggestion_verified,
 *          subconscious.suggestion_rejected_by_verifier,
 *          subconscious.bootstrap_failed,
 *          perception.run_started, perception.run_succeeded,
 *          perception.run_failed, perception.run_skipped
 *
 * @module engine/components/monitoring
 * @author fifty.dev
 */

import * as os from 'node:os';
import { getDb } from '../../../db.js';
import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
  EventPayload,
} from '../../types.js';
import { errMsg } from '../../helpers.js';
import { monitoringMigrations } from './schema.js';
import { handleEventLogQuery, handleEventLogCleanup } from './handlers.js';

// ---------------------------------------------------------------------------
// Event-to-component mapping
// ---------------------------------------------------------------------------

/** Static map from event name to the component that emits it */
const EVENT_COMPONENT_MAP: Record<string, string> = {
  'schedule.created': 'schedules',
  'schedule.enabled': 'schedules',
  'schedule.disabled': 'schedules',
  'schedule.deleted': 'schedules',
  'schedule.fire_now': 'schedules',
  'schedule.run_start': 'schedules',
  'schedule.run_complete': 'schedules',
  'cache.rebuilt': 'cache',
  'cache.cleaned': 'cache',
  'coordination.self_heal': 'coordination',
  'task.created': 'tasks',
  'task.assigned': 'tasks',
  'task.completed': 'tasks',
  'task.blocked': 'tasks',
  'task.unblocked': 'tasks',
  'task.failed': 'tasks',
  'task.claimed': 'tasks',
  'brief.synced': 'briefs',
  'brief.created': 'briefs',
  'brief.completed': 'briefs',
  'session.synced': 'sessions',
  'session.file.updated': 'sessions',
  'instance.heartbeat': 'instances',
  'memory.stored': 'memory',
  'error.stored': 'errors',
  'project.registered': 'projects',
  'metrics.recorded': 'metrics',
  'subconscious.run_start': 'subconscious',
  'subconscious.run_complete': 'subconscious',
  'subconscious.suggestion_emitted': 'subconscious',
  'subconscious.suggestion_suppressed': 'subconscious',
  'subconscious.suggestion_verified': 'subconscious',
  'subconscious.suggestion_rejected_by_verifier': 'subconscious',
  'subconscious.bootstrap_failed': 'subconscious',
  'perception.run_started': 'perception',
  'perception.run_succeeded': 'perception',
  'perception.run_failed': 'perception',
  'perception.run_skipped': 'perception',
};

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createMonitoringComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _hostname: string = '';

  /**
   * Generic event handler -- logs any received event into event_log.
   *
   * Derives the component name from EVENT_COMPONENT_MAP,
   * extracts project_slug from payload data, and inserts a row.
   * Wrapped in try/catch -- never throws.
   */
  function onEventReceived(payload: EventPayload): void {
    try {
      const db = getDb();
      const eventName = payload.event;
      const component = EVENT_COMPONENT_MAP[eventName] ?? 'unknown';
      const projectSlug =
        (payload.data.project as string) ??
        (payload.data.project_slug as string) ??
        null;
      const instanceId =
        (payload.data.instance_id as string) ??
        (payload.data.machine_hostname as string) ??
        null;

      db.prepare(
        `INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        eventName,
        component,
        JSON.stringify(payload.data),
        _hostname,
        projectSlug,
        instanceId,
        payload.timestamp,
      );
    } catch (err) {
      _ctx?.log.error(`Failed to log event ${payload.event}: ${errMsg(err)}`);
    }
  }

  return {
    name: 'monitoring',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return monitoringMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_event_log
        // -----------------------------------------------------------------
        {
          name: 'igris_event_log',
          description: 'Query the engine event log. Supports filtering by event name, component, project, and time range. Returns paginated results.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              event_name: {
                type: 'string',
                description: 'Filter by event name (e.g. "schedule.created")',
              },
              component: {
                type: 'string',
                description: 'Filter by source component (e.g. "schedules", "cache", "coordination")',
              },
              project_slug: {
                type: 'string',
                description: 'Filter by project slug',
              },
              since: {
                type: 'string',
                description: 'Only show events after this ISO datetime',
              },
              until: {
                type: 'string',
                description: 'Only show events before this ISO datetime',
              },
              limit: {
                type: 'number',
                description: 'Max results per page (default: 100, max: 1000)',
              },
              offset: {
                type: 'number',
                description: 'Offset for pagination (default: 0)',
              },
            },
          },
          handler: (args) => handleEventLogQuery(args),
        },

        // -----------------------------------------------------------------
        // igris_event_log_cleanup
        // -----------------------------------------------------------------
        {
          name: 'igris_event_log_cleanup',
          description: 'Delete old event log entries. Removes events older than the specified retention period.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              retention_days: {
                type: 'number',
                description: 'Number of days to retain (default: 30, minimum: 1)',
              },
            },
          },
          handler: (args) => handleEventLogCleanup(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [],
        listens: [
          { name: 'schedule.created', description: 'Log schedule creation events' },
          { name: 'schedule.enabled', description: 'Log schedule enable events' },
          { name: 'schedule.disabled', description: 'Log schedule disable events' },
          { name: 'schedule.deleted', description: 'Log schedule deletion events' },
          { name: 'schedule.fire_now', description: 'Log manual schedule fire events' },
          { name: 'schedule.run_start', description: 'Log schedule run start events' },
          { name: 'schedule.run_complete', description: 'Log schedule run completion events' },
          { name: 'cache.rebuilt', description: 'Log cache rebuild events' },
          { name: 'cache.cleaned', description: 'Log cache clean events' },
          { name: 'coordination.self_heal', description: 'Log coordination self-healing events' },
          { name: 'task.created', description: 'Log task creation events' },
          { name: 'task.assigned', description: 'Log task assignment events' },
          { name: 'task.completed', description: 'Log task completion events' },
          { name: 'task.blocked', description: 'Log task blocked events' },
          { name: 'task.unblocked', description: 'Log task unblocked events' },
          { name: 'task.failed', description: 'Log task failure events' },
          { name: 'task.claimed', description: 'Log task claimed events' },
          { name: 'brief.synced', description: 'Log brief sync events' },
          { name: 'brief.created', description: 'Log brief creation events' },
          { name: 'brief.completed', description: 'Log brief completion events' },
          { name: 'session.synced', description: 'Log session sync events' },
          { name: 'session.file.updated', description: 'Log session file update events' },
          { name: 'instance.heartbeat', description: 'Log instance heartbeat events' },
          { name: 'memory.stored', description: 'Log memory storage events' },
          { name: 'error.stored', description: 'Log error storage events' },
          { name: 'project.registered', description: 'Log project registration events' },
          { name: 'metrics.recorded', description: 'Log metrics recording events' },
          { name: 'subconscious.run_start', description: 'Log subconscious detector run start events' },
          { name: 'subconscious.run_complete', description: 'Log subconscious detector run completion events' },
          { name: 'subconscious.suggestion_emitted', description: 'Log subconscious suggestion emission events' },
          { name: 'subconscious.suggestion_suppressed', description: 'Log subconscious suggestion suppression events (dismiss-loop)' },
          { name: 'subconscious.suggestion_verified', description: 'Log subconscious LLM-verified conflict suggestion events (FR-108)' },
          { name: 'subconscious.suggestion_rejected_by_verifier', description: 'Log subconscious LLM-rejected heuristic conflict events (FR-108)' },
          { name: 'subconscious.bootstrap_failed', description: 'Log subconscious schedule bootstrap failures (TD-053)' },
          { name: 'perception.run_started', description: 'Log perception extraction run start events (TD-074)' },
          { name: 'perception.run_succeeded', description: 'Log perception extraction run success events (TD-074)' },
          { name: 'perception.run_failed', description: 'Log perception extraction run failure events (TD-074)' },
          { name: 'perception.run_skipped', description: 'Log perception extraction run skipped events (TD-074)' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;

      // Cache hostname for event logging
      _hostname = os.hostname();

      // Wire all event listeners -- EXPLICIT per-event calls for regex-based integrity tests
      ctx.bus.on('schedule.created', onEventReceived);
      ctx.bus.on('schedule.enabled', onEventReceived);
      ctx.bus.on('schedule.disabled', onEventReceived);
      ctx.bus.on('schedule.deleted', onEventReceived);
      ctx.bus.on('schedule.fire_now', onEventReceived);
      ctx.bus.on('schedule.run_start', onEventReceived);
      ctx.bus.on('schedule.run_complete', onEventReceived);
      ctx.bus.on('cache.rebuilt', onEventReceived);
      ctx.bus.on('cache.cleaned', onEventReceived);
      ctx.bus.on('coordination.self_heal', onEventReceived);
      ctx.bus.on('task.created', onEventReceived);
      ctx.bus.on('task.assigned', onEventReceived);
      ctx.bus.on('task.completed', onEventReceived);
      ctx.bus.on('task.blocked', onEventReceived);
      ctx.bus.on('task.unblocked', onEventReceived);
      ctx.bus.on('task.failed', onEventReceived);
      ctx.bus.on('task.claimed', onEventReceived);
      ctx.bus.on('brief.synced', onEventReceived);
      ctx.bus.on('brief.created', onEventReceived);
      ctx.bus.on('brief.completed', onEventReceived);
      ctx.bus.on('session.synced', onEventReceived);
      ctx.bus.on('session.file.updated', onEventReceived);
      ctx.bus.on('instance.heartbeat', onEventReceived);
      ctx.bus.on('memory.stored', onEventReceived);
      ctx.bus.on('error.stored', onEventReceived);
      ctx.bus.on('project.registered', onEventReceived);
      ctx.bus.on('metrics.recorded', onEventReceived);
      ctx.bus.on('subconscious.run_start', onEventReceived);
      ctx.bus.on('subconscious.run_complete', onEventReceived);
      ctx.bus.on('subconscious.suggestion_emitted', onEventReceived);
      ctx.bus.on('subconscious.suggestion_suppressed', onEventReceived);
      ctx.bus.on('subconscious.suggestion_verified', onEventReceived);
      ctx.bus.on('subconscious.suggestion_rejected_by_verifier', onEventReceived);
      ctx.bus.on('subconscious.bootstrap_failed', onEventReceived);
      ctx.bus.on('perception.run_started', onEventReceived);
      ctx.bus.on('perception.run_succeeded', onEventReceived);
      ctx.bus.on('perception.run_failed', onEventReceived);
      ctx.bus.on('perception.run_skipped', onEventReceived);

      // Run retention cleanup on init (purge events older than 30 days)
      try {
        const db = getDb();
        const result = db.prepare(
          `DELETE FROM event_log WHERE created_at < datetime('now', '-30 days')`
        ).run();
        if (result.changes > 0) {
          ctx.log.info(`Purged ${result.changes} event log entries older than 30 days`);
        }
      } catch (err) {
        ctx.log.warn(`Retention cleanup failed: ${errMsg(err)}`);
      }

      ctx.log.info('Monitoring component initialized');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('schedule.created', onEventReceived);
        _ctx.bus.off('schedule.enabled', onEventReceived);
        _ctx.bus.off('schedule.disabled', onEventReceived);
        _ctx.bus.off('schedule.deleted', onEventReceived);
        _ctx.bus.off('schedule.fire_now', onEventReceived);
        _ctx.bus.off('schedule.run_start', onEventReceived);
        _ctx.bus.off('schedule.run_complete', onEventReceived);
        _ctx.bus.off('cache.rebuilt', onEventReceived);
        _ctx.bus.off('cache.cleaned', onEventReceived);
        _ctx.bus.off('coordination.self_heal', onEventReceived);
        _ctx.bus.off('task.created', onEventReceived);
        _ctx.bus.off('task.assigned', onEventReceived);
        _ctx.bus.off('task.completed', onEventReceived);
        _ctx.bus.off('task.blocked', onEventReceived);
        _ctx.bus.off('task.unblocked', onEventReceived);
        _ctx.bus.off('task.failed', onEventReceived);
        _ctx.bus.off('task.claimed', onEventReceived);
        _ctx.bus.off('brief.synced', onEventReceived);
        _ctx.bus.off('brief.created', onEventReceived);
        _ctx.bus.off('brief.completed', onEventReceived);
        _ctx.bus.off('session.synced', onEventReceived);
        _ctx.bus.off('session.file.updated', onEventReceived);
        _ctx.bus.off('instance.heartbeat', onEventReceived);
        _ctx.bus.off('memory.stored', onEventReceived);
        _ctx.bus.off('error.stored', onEventReceived);
        _ctx.bus.off('project.registered', onEventReceived);
        _ctx.bus.off('metrics.recorded', onEventReceived);
        _ctx.bus.off('subconscious.run_start', onEventReceived);
        _ctx.bus.off('subconscious.run_complete', onEventReceived);
        _ctx.bus.off('subconscious.suggestion_emitted', onEventReceived);
        _ctx.bus.off('subconscious.suggestion_suppressed', onEventReceived);
        _ctx.bus.off('subconscious.suggestion_verified', onEventReceived);
        _ctx.bus.off('subconscious.suggestion_rejected_by_verifier', onEventReceived);
        _ctx.bus.off('subconscious.bootstrap_failed', onEventReceived);
        _ctx.bus.off('perception.run_started', onEventReceived);
        _ctx.bus.off('perception.run_succeeded', onEventReceived);
        _ctx.bus.off('perception.run_failed', onEventReceived);
        _ctx.bus.off('perception.run_skipped', onEventReceived);
      }
      _ctx = null;
    },
  };
}
