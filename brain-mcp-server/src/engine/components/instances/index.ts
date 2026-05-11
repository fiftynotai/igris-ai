/**
 * Brain Engine v5.0 — Instances Component
 *
 * Wraps the existing instance tool handlers and agent event handler
 * as a BrainComponent.
 * Provides: igris_instance_heartbeat, igris_instance_list, igris_instance_remove,
 *           igris_agent_event
 *
 * @module engine/components/instances
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import {
  handleInstanceHeartbeat,
  handleInstanceList,
  handleInstanceRemove,
} from '../../../tools/instances.js';
import type {
  InstanceHeartbeatInput,
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
      ];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_instance_heartbeat',
          description: 'Register or update a live Igris instance in the brain. Called on /awaken to register, and during /hunt to update current brief/phase. Returns the instance ID for subsequent heartbeats.',
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
                description: 'Existing instance ID for heartbeat updates (omit for new registration)',
              },
              capabilities: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of capabilities this instance can handle (e.g., ["code", "test", "research"]). When provided, upserts into agent_capabilities table keyed by instance_id.',
              },
            },
            required: ['machine_hostname'],
          },
          handler: (args) => {
            const result = handleInstanceHeartbeat(args as unknown as InstanceHeartbeatInput);
            _ctx?.bus.emit('instance.heartbeat', {
              machine_hostname: (args as Record<string, unknown>).machine_hostname,
              project_slug: (args as Record<string, unknown>).project_slug,
              instance_id: (args as Record<string, unknown>).instance_id,
            });
            return result;
          },
        },
        {
          name: 'igris_instance_list',
          description: 'List all active Igris instances across machines. Auto-marks instances with no heartbeat for 45+ minutes as stale. Purges instances stale for >4 hours.',
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
                description: 'Instance ID from heartbeat registration',
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
          // Orphan: sync auto-push extension point — will be consumed when sync auto-push is implemented
          { name: 'instance.heartbeat', description: 'An instance heartbeat was received' },
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
