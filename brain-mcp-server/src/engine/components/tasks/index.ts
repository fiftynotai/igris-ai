/**
 * Brain Engine v7.0 — Tasks Component
 *
 * Wraps the task management handlers as a BrainComponent.
 * Provides 13 MCP tools for task CRUD, dependency management,
 * agent assignment, atomic claim, smart next-task selection,
 * fail/retry, and structured result storage.
 *
 * Emits: task.created, task.assigned, task.completed, task.claimed,
 *        task.blocked, task.unblocked, task.failed
 * Listens: brief.created, brief.completed
 *
 * @module engine/components/tasks
 * @author fifty.dev
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
import { errMsg } from '../../helpers.js';
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
  handleTaskFail,
  handleTaskRetry,
  handleTaskClaim,
  handleTaskResultAdd,
  handleTaskResultGet,
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
      _ctx.log.error(`Failed to auto-create task for brief ${brief_id}: ${errMsg(err)}`);
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
        "SELECT id, project_slug FROM tasks WHERE brief_id = ? AND status != 'done' AND status != 'cancelled' LIMIT 1"
      ).get(brief_id) as { id: string; project_slug?: string } | undefined;

      if (task) {
        const result = handleTaskComplete({ task_id: task.id, result: 'Brief completed' });
        if (!result.isError) {
          _ctx.bus.emit('task.completed', { task_id: task.id, brief_id, source: 'brief.completed', project_slug: task.project_slug ?? payload.data.project });
          _ctx.log.info(`Auto-completed task ${task.id} for brief ${brief_id}`);
        }
      }
    } catch (err) {
      _ctx.log.error(`Failed to auto-complete task for brief ${brief_id}: ${errMsg(err)}`);
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
            additionalProperties: false,
            properties: {
              task_type: {
                type: 'string',
                enum: ['brief', 'operational', 'personal', 'system', 'dev', 'content', 'social-media', 'media-gen', 'research'],
                description: 'Task type: brief (linked to a brief), operational (workflow task), personal (user task), system (internal), dev (code implementation), content (writing/docs), social-media (social posts), media-gen (AI media generation), research (investigation/analysis)',
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
                enum: ['pending', 'active', 'blocked', 'done', 'cancelled', 'failed'],
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
              required_capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capabilities required to work on this task (e.g. ["code", "test"]). Used by task_next to match agents. (optional)',
              },
              max_retries: {
                type: 'number',
                description: 'Maximum retry attempts if the task fails (default: 3)',
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
            additionalProperties: false,
            properties: {
              status: {
                type: 'string',
                enum: ['pending', 'active', 'blocked', 'done', 'cancelled', 'failed'],
                description: 'Filter by status (optional)',
              },
              task_type: {
                type: 'string',
                enum: ['brief', 'operational', 'personal', 'system', 'dev', 'content', 'social-media', 'media-gen', 'research'],
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
              brief_id: {
                type: 'string',
                description: 'Filter by linked brief ID, e.g. "BR-008" (optional)',
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
            additionalProperties: false,
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
            additionalProperties: false,
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
        // igris_task_claim
        // -----------------------------------------------------------------
        {
          name: 'igris_task_claim',
          description: 'Atomically claim a specific task by ID for an agent. Fails if task is not in pending status. Creates an assignment record and sets status to active in a single transaction.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to claim (e.g. "t-a1b2c3d4")',
              },
              agent: {
                type: 'string',
                description: 'Agent name claiming the task (e.g. "forger", "sentinel")',
              },
            },
            required: ['task_id', 'agent'],
          },
          handler: (args) => {
            const result = handleTaskClaim(args);
            if (!result.isError && _ctx) {
              _ctx.bus.emit('task.claimed', {
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
            additionalProperties: false,
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
              // Extract project_slug from result for event enrichment
              let projectSlug: string | undefined;
              try {
                const parsed = JSON.parse(result.content[0].text) as { task?: { project_slug?: string }; unblocked?: string[] };
                projectSlug = parsed.task?.project_slug ?? undefined;

                // Emit unblocked events for newly unblocked tasks
                if (parsed.unblocked) {
                  for (const unblockedId of parsed.unblocked) {
                    _ctx.bus.emit('task.unblocked', { task_id: unblockedId });
                  }
                }
              } catch {
                // Ignore parse errors — events are best-effort
              }

              _ctx.bus.emit('task.completed', {
                task_id: args.task_id,
                project_slug: projectSlug,
              });
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
            additionalProperties: false,
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
          description: 'Find the highest-priority unblocked, non-deferred, pending task. Optionally auto-assigns to an agent. Supports capability-based matching. Ideal for agents picking up work.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              agent: {
                type: 'string',
                description: 'Agent name — if provided, auto-assigns the found task. Also used to look up capabilities from agent_capabilities table if capabilities param is omitted. (optional)',
              },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'Explicit capability list to match against task required_capabilities. Overrides agent_capabilities lookup. (optional)',
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
                enum: ['brief', 'operational', 'personal', 'system', 'dev', 'content', 'social-media', 'media-gen', 'research'],
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
            additionalProperties: false,
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
                enum: ['pending', 'active', 'blocked', 'done', 'cancelled', 'failed'],
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

        // -----------------------------------------------------------------
        // igris_task_fail
        // -----------------------------------------------------------------
        {
          name: 'igris_task_fail',
          description: 'Mark a task as failed with a reason. Increments retry_count and records fail_reason. The coordination component can listen for task.failed events to trigger self-healing.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to mark as failed',
              },
              reason: {
                type: 'string',
                description: 'Reason for the failure',
              },
            },
            required: ['task_id', 'reason'],
          },
          handler: (args) => {
            const result = handleTaskFail(args);
            if (!result.isError && _ctx) {
              try {
                const parsed = JSON.parse(result.content[0].text) as {
                  task?: { retry_count?: number; max_retries?: number };
                };
                _ctx.bus.emit('task.failed', {
                  taskId: args.task_id,
                  reason: args.reason,
                  retryCount: parsed.task?.retry_count ?? 0,
                  maxRetries: parsed.task?.max_retries ?? 3,
                });
              } catch {
                // Best-effort event emission
                _ctx.bus.emit('task.failed', {
                  taskId: args.task_id,
                  reason: args.reason,
                });
              }
            }
            return result;
          },
        },

        // -----------------------------------------------------------------
        // igris_task_retry
        // -----------------------------------------------------------------
        {
          name: 'igris_task_retry',
          description: 'Retry a failed task by resetting its status to pending. Only works on tasks in failed status. Optionally merge fix_context into metadata.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to retry',
              },
              fix_context: {
                type: 'string',
                description: 'Context about the fix to merge into task metadata (optional)',
              },
            },
            required: ['task_id'],
          },
          handler: (args) => handleTaskRetry(args),
        },

        // -----------------------------------------------------------------
        // igris_task_result_add
        // -----------------------------------------------------------------
        {
          name: 'igris_task_result_add',
          description: 'Add a structured result to a task (task_id, result_type, content, file_path?, metadata?)',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to attach the result to',
              },
              result_type: {
                type: 'string',
                enum: ['commit', 'file', 'text', 'image', 'url', 'json', 'error'],
                description: 'Type of result: commit (SHA), file (generated file), text (summary), image (image path), url (link), json (structured data), error (error output)',
              },
              content: {
                type: 'string',
                description: 'Result content (e.g. commit SHA, file path, text summary, JSON string)',
              },
              file_path: {
                type: 'string',
                description: 'Associated file path, if applicable (optional)',
              },
              metadata: {
                type: 'object',
                description: 'Additional metadata as JSON object (optional)',
              },
            },
            required: ['task_id', 'result_type', 'content'],
          },
          handler: (args) => handleTaskResultAdd(args),
        },

        // -----------------------------------------------------------------
        // igris_task_result_get
        // -----------------------------------------------------------------
        {
          name: 'igris_task_result_get',
          description: 'Get all results for a task, optionally filtered by result_type',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              task_id: {
                type: 'string',
                description: 'Task ID to get results for',
              },
              result_type: {
                type: 'string',
                enum: ['commit', 'file', 'text', 'image', 'url', 'json', 'error'],
                description: 'Filter by result type (optional)',
              },
            },
            required: ['task_id'],
          },
          handler: (args) => handleTaskResultGet(args),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          // Orphan: task lifecycle extension point — for future workflow automation
          { name: 'task.created', description: 'A new task was created' },
          // Orphan: task lifecycle extension point — for future workflow automation
          { name: 'task.assigned', description: 'A task was assigned to an agent' },
          { name: 'task.claimed', description: 'A task was atomically claimed by an agent' },
          // Orphan: task lifecycle extension point — for future workflow automation
          { name: 'task.completed', description: 'A task was marked as done' },
          // Orphan: task lifecycle extension point — for future workflow automation
          { name: 'task.blocked', description: 'A dependency was added, blocking a task' },
          // Orphan: task lifecycle extension point — for future workflow automation
          { name: 'task.unblocked', description: 'A task became unblocked (all deps done)' },
          { name: 'task.failed', description: 'A task was marked as failed (triggers self-healing)' },
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
