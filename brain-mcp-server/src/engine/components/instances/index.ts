/**
 * Brain Engine v7.0 — Instances Component
 *
 * Wraps the existing instance tool handlers and agent event handler
 * as a BrainComponent.
 * Provides: igris_instance_state,
 *           igris_instance_list, igris_instance_remove,
 *           igris_agent_event
 *
 * @module engine/components/instances
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
  handleInstanceState,
  handleInstanceList,
  handleInstanceRemove,
} from '../../../tools/instances.js';
import type {
  InstanceStateInput,
  InstanceListInput,
  InstanceRemoveInput,
} from '../../../tools/instances.js';
import { handleAgentEvent } from '../../../tools/agent_events.js';
import type { AgentEventInput } from '../../../tools/agent_events.js';

export function createInstancesComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'instances',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [
        {
          version: 1,
          description: 'Create agent_events table (idempotent with legacy v9)',
          sql: `
            CREATE TABLE IF NOT EXISTS agent_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instance_id TEXT NOT NULL,
                agent TEXT NOT NULL,
                event_type TEXT NOT NULL CHECK (event_type IN ('start', 'stop', 'error', 'retry')),
                phase TEXT,
                brief_id TEXT,
                duration_ms INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cache_read INTEGER DEFAULT 0,
                cache_create INTEGER DEFAULT 0,
                result TEXT,
                error_message TEXT,
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_agent_events_instance ON agent_events(instance_id);
            CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent);
            CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);
          `,
        },
        {
          version: 2,
          description: 'Add instance liveness metadata columns (FR-190)',
          sql: `
            CREATE TABLE IF NOT EXISTS instances (
                id TEXT PRIMARY KEY,
                machine_hostname TEXT NOT NULL,
                machine_os TEXT,
                project_slug TEXT,
                project_path TEXT,
                current_brief TEXT,
                current_phase TEXT,
                current_task TEXT,
                status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
                started_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
                metadata TEXT DEFAULT '{}'
            );
            ALTER TABLE instances ADD COLUMN harness TEXT;
            ALTER TABLE instances ADD COLUMN harness_session_id TEXT;
            ALTER TABLE instances ADD COLUMN owner_pid INTEGER;
            ALTER TABLE instances ADD COLUMN owner_started_at TEXT;
            ALTER TABLE instances ADD COLUMN liveness_method TEXT;
            ALTER TABLE instances ADD COLUMN liveness_status TEXT;
            ALTER TABLE instances ADD COLUMN liveness_checked_at TEXT;
            ALTER TABLE instances ADD COLUMN lease_expires_at TEXT;
            ALTER TABLE instances ADD COLUMN state_updated_at TEXT;
            CREATE INDEX IF NOT EXISTS idx_instances_owner_pid ON instances(owner_pid);
            CREATE INDEX IF NOT EXISTS idx_instances_lease ON instances(lease_expires_at);
          `,
        },
      ];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_instance_state',
          description: 'Register or update an Igris instance state row. This records activity/display/lease metadata only; same-machine liveness uses PID/start-time and cross-machine coordination uses leases/claims.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              machine_hostname: {
                type: 'string',
                description: 'Hostname of the machine running this instance',
              },
              machine_os: {
                type: 'string',
                description: 'Operating system (e.g., "darwin", "linux")',
              },
              project_slug: {
                type: 'string',
                description: 'Project slug (e.g., "igris-ai")',
              },
              project_path: {
                type: 'string',
                description: 'Absolute path to the project directory',
              },
              current_brief: {
                type: 'string',
                description: 'Currently active brief ID (e.g., "FR-026")',
              },
              current_phase: {
                type: 'string',
                description: 'Current workflow phase (e.g., "BUILDING")',
              },
              current_task: {
                type: 'string',
                description: 'Description of current task',
              },
              instance_id: {
                type: 'string',
                description: 'Existing instance ID for state updates (omit for new registration)',
              },
              harness: {
                type: 'string',
                description: 'Harness driving this instance (codex, claude, gemini, opencode, antigravity, unknown)',
              },
              harness_session_id: {
                type: 'string',
                description: 'Harness-native session/thread id when available',
              },
              owner_pid: {
                type: 'number',
                description: 'Same-machine owner process PID for liveness proof',
              },
              owner_started_at: {
                type: 'string',
                description: 'Owner process start time; paired with PID to defeat PID reuse',
              },
              liveness_method: {
                type: 'string',
                description: 'Liveness method used for this row, e.g. pid_start_time, remote, none',
              },
              liveness_status: {
                type: 'string',
                description: 'Last known liveness classification',
              },
              liveness_checked_at: {
                type: 'string',
                description: 'Timestamp of the last liveness classification',
              },
              lease_expires_at: {
                type: 'string',
                description: 'Remote-visible work lease expiry for cross-machine coordination',
              },
            },
            required: ['machine_hostname'],
          },
          handler: (args) => {
            const result = handleInstanceState(args as unknown as InstanceStateInput);
            _ctx?.bus.emit('instance.state_updated', {
              machine_hostname: (args as Record<string, unknown>).machine_hostname,
              project_slug: (args as Record<string, unknown>).project_slug,
              instance_id: (args as Record<string, unknown>).instance_id,
            });
            return result;
          },
        },
        {
          name: 'igris_instance_list',
          description: 'List Igris instances across machines. Listing does not mark stale or purge based on activity age.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              status: {
                type: 'string',
                enum: ['active', 'idle', 'stale', 'all'],
                description: 'Filter by instance status (optional — omit or "all" to list everything)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              include_stale: {
                type: 'boolean',
                description: 'Include stale instances in results (default: false)',
              },
            },
          },
          handler: (args) => handleInstanceList(args as unknown as InstanceListInput),
        },
        {
          name: 'igris_instance_remove',
          description: 'Remove an Igris instance from the registry. Called on /rest to deregister cleanly.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              instance_id: {
                type: 'string',
                description: 'The instance ID to remove',
              },
            },
            required: ['instance_id'],
          },
          handler: (args) => handleInstanceRemove(args as unknown as InstanceRemoveInput),
        },
        {
          name: 'igris_agent_event',
          description: 'Record an agent lifecycle event for live dashboard tracking. Called during /hunt workflow at each agent phase transition.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              instance_id: {
                type: 'string',
                description: 'Instance ID from session registration',
              },
              agent: {
                type: 'string',
                description: 'Agent name: architect, forger, sentinel, warden, mender, seeker, sage',
              },
              event_type: {
                type: 'string',
                enum: ['start', 'stop', 'error', 'retry'],
                description: 'Event lifecycle type',
              },
              phase: {
                type: 'string',
                description: 'Hunt phase: PLANNING, BUILDING, TESTING, REVIEWING, DOCUMENTING',
              },
              brief_id: {
                type: 'string',
                description: 'Active brief ID',
              },
              duration_ms: {
                type: 'number',
                description: 'Elapsed time in milliseconds (for stop/error events)',
              },
              input_tokens: {
                type: 'number',
                description: 'Input tokens consumed',
              },
              output_tokens: {
                type: 'number',
                description: 'Output tokens consumed',
              },
              cache_read: {
                type: 'number',
                description: 'Cache read tokens consumed',
              },
              cache_create: {
                type: 'number',
                description: 'Cache create tokens consumed',
              },
              result: {
                type: 'string',
                description: 'Result summary (for stop events)',
              },
              error_message: {
                type: 'string',
                description: 'Error details (for error events)',
              },
              metadata: {
                type: 'string',
                description: 'Additional metadata as JSON string (default: "{}")',
              },
            },
            required: ['instance_id', 'agent', 'event_type'],
          },
          handler: (args) => handleAgentEvent(args as unknown as AgentEventInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'instance.state_updated', description: 'An instance state row was updated' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Instances component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
