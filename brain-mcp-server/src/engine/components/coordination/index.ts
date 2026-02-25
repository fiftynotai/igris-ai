/**
 * Brain Engine v5.0 — Coordination Component
 *
 * Wraps the autonomous coordination handlers as a BrainComponent.
 * Provides 6 MCP tools for agent capability management, priority
 * adjustment, configuration, and audit trail.
 *
 * Self-healing: listens for task.failed events and creates diagnostic
 * child tasks when autonomous mode and self-healing are enabled.
 *
 * Emits: coordination.adjustment, coordination.self_heal
 * Listens: task.failed, engine.ready
 *
 * @module engine/components/coordination
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
import { getDb } from '../../../db.js';
import { initCoordinationSchema } from './schema.js';
import {
  handleAgentCapabilitySet,
  handleAgentCapabilityList,
  handleAdjustPriorities,
  handleCoordinationConfigSet,
  handleCoordinationConfigGet,
  handleAuditList,
} from './handlers.js';

export function createCoordinationComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;
  let _dispatchTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

  /** Handler for engine.ready event -- capture the gateway dispatch function */
  function onEngineReady(payload: EventPayload): void {
    const dispatch = payload.data.dispatch as
      | ((name: string, args: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    if (dispatch) {
      _dispatchTool = dispatch;
      _ctx?.log.info('Captured gateway dispatch for coordination');

      // Check if autonomous mode is enabled and create priority adjustment schedule
      try {
        const db = getDb();
        const autonomousRow = db.prepare(
          "SELECT value FROM coordination_config WHERE key = 'autonomous_enabled'"
        ).get() as { value: string } | undefined;

        if (autonomousRow?.value === 'true') {
          // Check if schedule already exists
          const existing = db.prepare(
            "SELECT id FROM schedules WHERE name = 'autonomous-priority-adjust'"
          ).get() as { id: string } | undefined;

          if (!existing && _dispatchTool) {
            _dispatchTool('igris_schedule_create', {
              name: 'autonomous-priority-adjust',
              cron_expr: '0 * * * *', // Every hour
              handler_type: 'mcp-tool',
              handler_config: {
                tool: 'igris_coordination_adjust_priorities',
                args: {},
              },
              description: 'Autonomous priority adjustment (hourly)',
              tags: ['coordination', 'autonomous'],
            }).then(() => {
              _ctx?.log.info('Created autonomous priority adjustment schedule');
            }).catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              _ctx?.log.warn(`Failed to create priority adjustment schedule: ${message}`);
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        _ctx?.log.warn(`Error checking autonomous mode: ${message}`);
      }
    }
  }

  /**
   * Handler for task.failed events -- self-healing logic.
   *
   * When a task fails:
   * 1. Check if autonomous_enabled and self_healing_enabled are both true
   * 2. Check if retry_count < max_retries on the failed task
   * 3. If both true, create a diagnostic child task
   * 4. Log the decision in autonomous_decisions
   */
  function onTaskFailed(payload: EventPayload): void {
    if (!_ctx || !_dispatchTool) return;

    const { taskId, reason, retryCount, maxRetries } = payload.data as {
      taskId?: string;
      reason?: string;
      retryCount?: number;
      maxRetries?: number;
    };

    if (!taskId) return;

    try {
      const db = getDb();

      // Check coordination config
      const autonomousRow = db.prepare(
        "SELECT value FROM coordination_config WHERE key = 'autonomous_enabled'"
      ).get() as { value: string } | undefined;

      const selfHealRow = db.prepare(
        "SELECT value FROM coordination_config WHERE key = 'self_healing_enabled'"
      ).get() as { value: string } | undefined;

      const autonomousEnabled = autonomousRow?.value === 'true';
      const selfHealEnabled = selfHealRow?.value === 'true';

      if (!autonomousEnabled || !selfHealEnabled) return;

      // Check retry budget
      const currentRetries = retryCount ?? 0;
      const maxRetryLimit = maxRetries ?? 3;

      if (currentRetries >= maxRetryLimit) {
        _ctx.log.info(
          `Task ${taskId} exceeded max retries (${currentRetries}/${maxRetryLimit}), skipping self-heal`
        );
        return;
      }

      // Get the failed task for context
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
      if (!task) return;

      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

      // Log the self-healing decision
      db.prepare(`
        INSERT INTO autonomous_decisions (decision_type, task_id, detail, created_at)
        VALUES ('self_heal', ?, ?, ?)
      `).run(
        taskId,
        `Creating diagnostic child task for failed task "${task.title}". Reason: ${reason ?? 'unknown'}. Retry ${currentRetries}/${maxRetryLimit}.`,
        timestamp,
      );

      // Create diagnostic child task via dispatchTool
      _dispatchTool('igris_task_create', {
        task_type: 'system',
        scope: (task.scope as string) || 'system',
        title: `Diagnose failure: ${task.title}`,
        description: `Diagnostic task for failed task ${taskId}. Failure reason: ${reason ?? 'unknown'}. Investigate and fix the root cause, then retry the parent task.`,
        parent_id: taskId,
        project_slug: (task.project_slug as string) || null,
        priority: Math.max(1, ((task.priority as number) || 3) - 1),
        created_by: 'coordination',
        required_capabilities: ['debug', 'diagnose', 'fix'],
        metadata: {
          diagnostic: true,
          parent_failure_reason: reason ?? 'unknown',
          parent_retry_count: currentRetries,
        },
      }).then(() => {
        _ctx?.bus.emit('coordination.self_heal', {
          taskId,
          reason: reason ?? 'unknown',
          retryCount: currentRetries,
        });
        _ctx?.log.info(`Created diagnostic child task for failed task ${taskId}`);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        _ctx?.log.error(`Failed to create diagnostic task for ${taskId}: ${message}`);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      _ctx?.log.error(`Self-healing error for task ${taskId}: ${message}`);
    }
  }

  return {
    name: 'coordination',
    version: '1.0.0',
    depends: ['tasks'],

    schema(): Migration[] {
      // Coordination tables are created by the tasks v2 migration.
      // The coordination component only seeds data, which happens in init().
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_agent_capability_set
        // -----------------------------------------------------------------
        {
          name: 'igris_agent_capability_set',
          description: 'Set capabilities for an agent (replaces all existing). Used for capability-based task matching in igris_task_next.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agent: {
                type: 'string',
                description: 'Agent name (e.g. "forger", "sentinel")',
              },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of capabilities (e.g. ["code", "refactor", "document"])',
              },
            },
            required: ['agent', 'capabilities'],
          },
          handler: (args) => handleAgentCapabilitySet(args),
        },

        // -----------------------------------------------------------------
        // igris_agent_capability_list
        // -----------------------------------------------------------------
        {
          name: 'igris_agent_capability_list',
          description: 'List agent capabilities, optionally filtered by agent. Returns capabilities grouped by agent name.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agent: {
                type: 'string',
                description: 'Filter by agent name (optional). Omit to list all agents.',
              },
            },
          },
          handler: (args) => handleAgentCapabilityList(args),
        },

        // -----------------------------------------------------------------
        // igris_coordination_adjust_priorities
        // -----------------------------------------------------------------
        {
          name: 'igris_coordination_adjust_priorities',
          description: 'Run the autonomous priority adjustment algorithm. Boosts overdue tasks, unblocks stale blocked tasks, and adjusts priorities. Logs all changes in the audit trail.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              dry_run: {
                type: 'boolean',
                description: 'If true, report what would change without making changes (default: false)',
              },
            },
          },
          handler: (args) => handleAdjustPriorities(args),
        },

        // -----------------------------------------------------------------
        // igris_coordination_config_set
        // -----------------------------------------------------------------
        {
          name: 'igris_coordination_config_set',
          description: 'Set a coordination configuration value. Keys: autonomous_enabled, max_retries_default, priority_ceiling, priority_floor, self_healing_enabled.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              key: {
                type: 'string',
                description: 'Configuration key',
              },
              value: {
                type: 'string',
                description: 'Configuration value (stored as string)',
              },
            },
            required: ['key', 'value'],
          },
          handler: (args) => handleCoordinationConfigSet(args),
        },

        // -----------------------------------------------------------------
        // igris_coordination_config_get
        // -----------------------------------------------------------------
        {
          name: 'igris_coordination_config_get',
          description: 'Get coordination configuration. Provide a key to get a single value, or omit to get all configuration.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              key: {
                type: 'string',
                description: 'Configuration key (optional). Omit to get all config.',
              },
            },
          },
          handler: (args) => handleCoordinationConfigGet(args),
        },

        // -----------------------------------------------------------------
        // igris_coordination_audit
        // -----------------------------------------------------------------
        {
          name: 'igris_coordination_audit',
          description: 'Query the autonomous decisions audit trail. Filter by decision_type, task_id, agent, or time range.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              decision_type: {
                type: 'string',
                description: 'Filter by decision type (e.g. "assignment", "self_heal", "overdue_boost") (optional)',
              },
              task_id: {
                type: 'string',
                description: 'Filter by task ID (optional)',
              },
              agent: {
                type: 'string',
                description: 'Filter by agent name (optional)',
              },
              since: {
                type: 'string',
                description: 'Only show decisions after this ISO datetime (optional)',
              },
              limit: {
                type: 'number',
                description: 'Max results (default: 50)',
              },
            },
          },
          handler: (args) => handleAuditList(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'coordination.adjustment', description: 'Priority adjustment was performed' },
          { name: 'coordination.self_heal', description: 'Self-healing diagnostic task was created for a failed task' },
        ],
        listens: [
          { name: 'task.failed', description: 'React to task failures with self-healing logic' },
          { name: 'engine.ready', description: 'Capture gateway dispatch and check autonomous mode' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;

      // Wire event listeners
      ctx.bus.on('engine.ready', onEngineReady);
      ctx.bus.on('task.failed', onTaskFailed);

      // Seed default data
      try {
        initCoordinationSchema();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`Failed to seed coordination defaults: ${message}`);
      }

      ctx.log.info('Coordination component initialized');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('engine.ready', onEngineReady);
        _ctx.bus.off('task.failed', onTaskFailed);
      }
      _ctx = null;
      _dispatchTool = null;
    },
  };
}
