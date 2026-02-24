/**
 * Brain Engine v5.0 — Tasks Component
 *
 * Wraps the task management handlers as a BrainComponent.
 * Provides 8 MCP tools for task CRUD, dependency management,
 * agent assignment, and smart next-task selection.
 *
 * Emits: task.created, task.assigned, task.completed, task.blocked, task.unblocked
 * Listens: brief.created, brief.completed
 *
 * @module engine/components/tasks
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
import { taskMigrations } from './schema.js';
import {
  handleTaskCreate,
  handleTaskList,
  handleTaskGet,
  handleTaskAssign,
  handleTaskComplete,
  handleTaskBlock,
  handleTaskNext,
  handleTaskUpdate,
} from './handlers.js';

export function createTasksComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  /** Handler for brief.created events — auto-create a linked task */
  function onBriefCreated(payload: EventPayload): void {
    if (!_ctx) return;
    const { brief_id, project, title } = payload.data;
    if (!brief_id || !title) return;

    try {
      const result = handleTaskCreate({
        task_type: 'brief',
        scope: 'project',
        title: `Brief: ${title}`,
        brief_id,
        project_slug: project ?? null,
        created_by: 'system',
      });

      if (!result.isError) {
        _ctx.bus.emit('task.created', {
          brief_id,
          project: project ?? null,
          source: 'brief.created',
        });
        _ctx.log.info(`Auto-created task for brief ${brief_id}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      _ctx.log.error(`Failed to auto-create task for brief ${brief_id}: ${message}`);
    }
  }

  /** Handler for brief.completed events — auto-complete the linked task */
  function onBriefCompleted(payload: EventPayload): void {
    if (!_ctx) return;
    const { brief_id } = payload.data;
    if (!brief_id) return;

    try {
      const db = getDb();

      // Find the linked task
      const task = db.prepare(
        "SELECT id FROM tasks WHERE brief_id = ? AND status != 'done' AND status != 'cancelled' LIMIT 1"
      ).get(brief_id) as { id: string } | undefined;

      if (task) {
        const result = handleTaskComplete({ task_id: task.id, result: 'Brief completed' });
        if (!result.isError) {
          _ctx.bus.emit('task.completed', { task_id: task.id, brief_id, source: 'brief.completed' });
          _ctx.log.info(`Auto-completed task ${task.id} for brief ${brief_id}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      _ctx.log.error(`Failed to auto-complete task for brief ${brief_id}: ${message}`);
    }
  }

  return {
    name: 'tasks',
    version: '1.0.0',
    depends: ['briefs'],

    schema(): Migration[] {
      return taskMigrations;
    },

    tools(): ToolDefinition[] {
      return [
        // -----------------------------------------------------------------
        // igris_task_create
        // -----------------------------------------------------------------
        {
          name: 'igris_task_create',
          description: 'Create a new task in the brain. Tasks can be linked to briefs, assigned to agents, and organized with dependencies. Priority 1 (highest) to 5 (lowest).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task_type: {
                type: 'string',
                enum: ['brief', 'operational', 'personal', 'system'],
                description: 'Task type: brief (linked to a brief), operational (workflow task), personal (user task), system (internal)',
              },
              title: {
                type: 'string',
                description: 'Task title',
              },
              scope: {
                type: 'string',
                enum: ['project', 'personal', 'system'],
                description: 'Task scope: project (specific project), personal (user-level), system (brain-level)',
              },
              description: {
                type: 'string',
                description: 'Detailed task description (optional)',
              },
              brief_id: {
                type: 'string',
                description: 'Linked brief ID, e.g. "BR-008" (optional)',
              },
              project_slug: {
                type: 'string',
                description: 'Project slug (optional)',
              },
              parent_id: {
                type: 'string',
                description: 'Parent task ID for subtasks (optional)',
              },
              priority: {
                type: 'number',
                description: 'Priority 1-5 (1=highest, default=3)',
              },
              status: {
                type: 'string',
                enum: ['pending', 'active', 'blocked', 'done', 'cancelled'],
                description: 'Initial status (default: pending)',
              },
              assignee: {
                type: 'string',
                description: 'Assigned agent name (optional)',
              },
              due_at: {
                type: 'string',
                description: 'Due date in ISO format (optional)',
              },
              defer_until: {
                type: 'string',
                description: 'Defer task until this ISO datetime (optional)',
              },
              created_by: {
                type: 'string',
                description: 'Who created the task (optional)',
              },
              metadata: {
                type: 'object',
                description: 'Additional metadata as JSON object (optional)',
              },
            },
            required: ['task_type', 'title', 'scope'],
          },
          handler: (args) => {
            const result = handleTaskCreate(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('task.created', {
                task_type: args.task_type,
                title: args.title,
                scope: args.scope,
                brief_id: args.brief_id ?? null,
                project_slug: args.project_slug ?? null,
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_task_list
        // -----------------------------------------------------------------
        {
          name: 'igris_task_list',
          description: 'List tasks with optional filters. Returns tasks ordered by priority (ascending) then creation date.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              status: {
                type: 'string',
                enum: ['pending', 'active', 'blocked', 'done', 'cancelled'],
                description: 'Filter by status (optional)',
              },
              task_type: {
                type: 'string',
                enum: ['brief', 'operational', 'personal', 'system'],
                description: 'Filter by task type (optional)',
              },
              scope: {
                type: 'string',
                enum: ['project', 'personal', 'system'],
                description: 'Filter by scope (optional)',
              },
              project_slug: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              assignee: {
                type: 'string',
                description: 'Filter by assigned agent (optional)',
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
          handler: (args) => handleTaskList(args),
        },

        // -----------------------------------------------------------------
        // igris_task_get
        // -----------------------------------------------------------------
        {
          name: 'igris_task_get',
          description: 'Get a single task with its dependencies and assignment history.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID (e.g. "t-a1b2c3d4")',
              },
            },
            required: ['task_id'],
          },
          handler: (args) => handleTaskGet(args),
        },

        // -----------------------------------------------------------------
        // igris_task_assign
        // -----------------------------------------------------------------
        {
          name: 'igris_task_assign',
          description: 'Assign an agent to a task. Updates task status to active and records the assignment.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to assign',
              },
              agent: {
                type: 'string',
                description: 'Agent name (e.g. "forger", "sentinel")',
              },
            },
            required: ['task_id', 'agent'],
          },
          handler: (args) => {
            const result = handleTaskAssign(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('task.assigned', {
                task_id: args.task_id,
                agent: args.agent,
              });
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_task_complete
        // -----------------------------------------------------------------
        {
          name: 'igris_task_complete',
          description: 'Mark a task as done. Checks for newly unblocked dependent tasks. Returns the completed task and any unblocked task IDs.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to complete',
              },
              result: {
                type: 'string',
                description: 'Completion result/notes (optional)',
              },
            },
            required: ['task_id'],
          },
          handler: (args) => {
            const result = handleTaskComplete(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('task.completed', {
                task_id: args.task_id,
              });

              // Emit unblocked events for newly unblocked tasks
              try {
                const parsed = JSON.parse(result.content[0].text) as { unblocked?: string[] };
                if (parsed.unblocked) {
                  for (const unblockedId of parsed.unblocked) {
                    _ctx.bus.emit('task.unblocked', { task_id: unblockedId });
                  }
                }
              } catch {
                // Ignore parse errors — events are best-effort
              }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_task_block
        // -----------------------------------------------------------------
        {
          name: 'igris_task_block',
          description: 'Add or remove a dependency between tasks. Performs cycle detection to prevent circular dependencies. Adding a dependency to an undone task marks the dependent as blocked.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task_id: {
                type: 'string',
                description: 'The task that depends on another',
              },
              depends_on: {
                type: 'string',
                description: 'The task being depended on',
              },
              action: {
                type: 'string',
                enum: ['add', 'remove'],
                description: 'Action to perform (default: add)',
              },
            },
            required: ['task_id', 'depends_on'],
          },
          handler: (args) => {
            const result = handleTaskBlock(args);
            if (!result.isError && _ctx) {
              const action = (args.action as string | undefined) ?? 'add';
              if (action === 'add') {
                _ctx.bus.emit('task.blocked', {
                  task_id: args.task_id,
                  depends_on: args.depends_on,
                });
              } else {
                // Check if the removal unblocked the task
                try {
                  const parsed = JSON.parse(result.content[0].text) as { task?: { status?: string } };
                  if (parsed.task?.status === 'pending') {
                    _ctx.bus.emit('task.unblocked', { task_id: args.task_id });
                  }
                } catch {
                  // Ignore parse errors
                }
              }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_task_next
        // -----------------------------------------------------------------
        {
          name: 'igris_task_next',
          description: 'Find the highest-priority unblocked, non-deferred, pending task. Optionally auto-assigns to an agent. Ideal for agents picking up work.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              agent: {
                type: 'string',
                description: 'Agent name — if provided, auto-assigns the found task (optional)',
              },
              project_slug: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              scope: {
                type: 'string',
                enum: ['project', 'personal', 'system'],
                description: 'Filter by scope (optional)',
              },
              task_type: {
                type: 'string',
                enum: ['brief', 'operational', 'personal', 'system'],
                description: 'Filter by task type (optional)',
              },
            },
          },
          handler: (args) => {
            const result = handleTaskNext(args);
            if (!result.isError && _ctx && args.agent) {
              try {
                const parsed = JSON.parse(result.content[0].text) as { task?: { id?: string } | null };
                if (parsed.task?.id) {
                  _ctx.bus.emit('task.assigned', {
                    task_id: parsed.task.id,
                    agent: args.agent,
                    source: 'task_next',
                  });
                }
              } catch {
                // Ignore parse errors
              }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_task_update
        // -----------------------------------------------------------------
        {
          name: 'igris_task_update',
          description: 'Update one or more fields on a task. Always updates the updated_at timestamp.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to update',
              },
              title: {
                type: 'string',
                description: 'New title (optional)',
              },
              description: {
                type: 'string',
                description: 'New description (optional)',
              },
              priority: {
                type: 'number',
                description: 'New priority 1-5 (optional)',
              },
              status: {
                type: 'string',
                enum: ['pending', 'active', 'blocked', 'done', 'cancelled'],
                description: 'New status (optional)',
              },
              due_at: {
                type: 'string',
                description: 'New due date in ISO format (optional)',
              },
              defer_until: {
                type: 'string',
                description: 'Defer until this ISO datetime (optional)',
              },
              metadata: {
                type: 'object',
                description: 'New metadata object (optional)',
              },
              scope: {
                type: 'string',
                enum: ['project', 'personal', 'system'],
                description: 'New scope (optional)',
              },
              assignee: {
                type: 'string',
                description: 'New assignee (optional)',
              },
            },
            required: ['task_id'],
          },
          handler: (args) => handleTaskUpdate(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'task.created', description: 'A new task was created' },
          { name: 'task.assigned', description: 'A task was assigned to an agent' },
          { name: 'task.completed', description: 'A task was marked as done' },
          { name: 'task.blocked', description: 'A dependency was added, blocking a task' },
          { name: 'task.unblocked', description: 'A task became unblocked (all deps done)' },
        ],
        listens: [
          { name: 'brief.created', description: 'Auto-create a linked task when a brief is synced for the first time' },
          { name: 'brief.completed', description: 'Auto-complete the linked task when a brief is marked Done' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;

      // Wire event listeners
      ctx.bus.on('brief.created', onBriefCreated);
      ctx.bus.on('brief.completed', onBriefCompleted);

      ctx.log.info('Tasks component initialized');
    },

    destroy(): void {
      if (_ctx) {
        _ctx.bus.off('brief.created', onBriefCreated);
        _ctx.bus.off('brief.completed', onBriefCompleted);
      }
      _ctx = null;
    },
  };
}
