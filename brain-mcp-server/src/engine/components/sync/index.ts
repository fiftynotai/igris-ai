/**
 * Brain Engine v5.0 — Sync Component
 *
 * Wraps the existing sync tool handlers as a BrainComponent.
 * Provides: igris_brain_push, igris_brain_pull, igris_sync_queue_status,
 *           igris_sync_queue_drain, igris_brief_file_sync,
 *           igris_session_file_sync, igris_session_file_pull,
 *           igris_definition_sync, igris_definition_pull,
 *           igris_file_push, igris_file_pull
 *
 * @module engine/components/sync
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
  handleBrainPush,
  handleBrainPull,
  handleSyncQueueStatus,
  handleSyncQueueDrain,
  handleBriefFileSync,
  handleSessionFileSync,
  handleSessionFilePull,
  handleDefinitionSync,
  handleDefinitionPull,
  handleFilePush,
  handleFilePull,
} from '../../../tools/sync.js';
import type {
  BrainPushInput,
  BrainPullInput,
  SyncQueueDrainInput,
  BriefFileSyncInput,
  SessionFileSyncInput,
  SessionFilePullInput,
  DefinitionSyncInput,
  DefinitionPullInput,
  FilePushInput,
  FilePullInput,
} from '../../../tools/sync.js';

export function createSyncComponent(): BrainComponent {
  return {
    name: 'sync',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_brain_push',
          description: 'Push local brain changes to a remote brain server. Syncs learnings, errors, projects, sessions, brief_status, agent_metrics changed since last push. Uses last-write-wins for conflict resolution.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server (e.g., "https://brain.example.com")',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['remote_url', 'api_key'],
          },
          handler: (args) => handleBrainPush(args as unknown as BrainPushInput),
        },
        {
          name: 'igris_brain_pull',
          description: 'Pull remote brain changes to local brain. Syncs all tables changed since last pull. Uses last-write-wins for conflict resolution.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server (e.g., "https://brain.example.com")',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['remote_url', 'api_key'],
          },
          handler: (args) => handleBrainPull(args as unknown as BrainPullInput),
        },
        {
          name: 'igris_sync_queue_status',
          description: 'Show the current sync queue status. Displays pending, retrying, sent, and failed counts plus per-table breakdown of actionable items.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
          },
          handler: () => handleSyncQueueStatus(),
        },
        {
          name: 'igris_sync_queue_drain',
          description: 'Process pending sync queue items by pushing them to the remote brain. Retries failed push operations with exponential backoff tracking.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['remote_url', 'api_key'],
          },
          handler: (args) => handleSyncQueueDrain(args as unknown as SyncQueueDrainInput),
        },
        {
          name: 'igris_brief_file_sync',
          description: 'Sync a brief file content to the brain. Computes content hash and upserts into brief_files table. Use this to store the full markdown content of brief files for cross-device access.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "FR-026")',
              },
              filename: {
                type: 'string',
                description: 'Brief filename (e.g., "FR-026-feature-name.md")',
              },
              content: {
                type: 'string',
                description: 'Full markdown content of the brief file',
              },
            },
            required: ['project', 'brief_id', 'filename', 'content'],
          },
          handler: (args) => handleBriefFileSync(args as unknown as BriefFileSyncInput),
        },
        {
          name: 'igris_session_file_sync',
          description: 'Sync a session file content to the brain. Stores session files (CURRENT_SESSION.md, BLOCKERS.md, etc.) for cross-device access.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              filename: {
                type: 'string',
                description: 'Session filename (e.g., "CURRENT_SESSION.md")',
              },
              content: {
                type: 'string',
                description: 'Full content of the session file',
              },
            },
            required: ['project', 'filename', 'content'],
          },
          handler: (args) => handleSessionFileSync(args as unknown as SessionFileSyncInput),
        },
        {
          name: 'igris_session_file_pull',
          description: 'Pull all session files for a project from the brain. Returns all stored session files with their content.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to pull session files for',
              },
            },
            required: ['project'],
          },
          handler: (args) => handleSessionFilePull(args as unknown as SessionFilePullInput),
        },
        {
          name: 'igris_definition_sync',
          description: 'Sync a definition file (agent, skill, rule, or prompt) to the brain. Stores the full content for cross-device and cross-project sharing.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              type: {
                type: 'string',
                enum: ['agent', 'skill', 'rule', 'prompt'],
                description: 'Definition type',
              },
              name: {
                type: 'string',
                description: 'Definition name (e.g., "forger", "hunt", "01-igris-init")',
              },
              filename: {
                type: 'string',
                description: 'Filename (e.g., "forger.md", "SKILL.md")',
              },
              content: {
                type: 'string',
                description: 'Full content of the definition file',
              },
              version: {
                type: 'string',
                description: 'Version string (optional)',
              },
            },
            required: ['type', 'name', 'filename', 'content'],
          },
          handler: (args) => handleDefinitionSync(args as unknown as DefinitionSyncInput),
        },
        {
          name: 'igris_definition_pull',
          description: 'Pull definitions from the brain. Optionally filter by timestamp to get only recently updated definitions.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              since: {
                type: 'string',
                description: 'ISO timestamp — only return definitions updated after this time (optional)',
              },
            },
          },
          handler: (args) => handleDefinitionPull(args as unknown as DefinitionPullInput),
        },
        {
          name: 'igris_file_push',
          description: 'Push a flat file (events.jsonl, agent-metrics.json, budget.json) to the remote brain server via HTTP. Updates sync_state for dashboard tracking.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_type: {
                type: 'string',
                enum: ['events', 'agent_metrics', 'budget'],
                description: 'File type: "events" for events.jsonl (cost tracking), "agent_metrics" for agent-metrics.json (agent stats), "budget" for budget.json (daily budget thresholds)',
              },
              content: {
                type: 'string',
                description: 'Full file content to push',
              },
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server (e.g., "https://brain.example.com")',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['file_type', 'content', 'remote_url', 'api_key'],
          },
          handler: (args) => handleFilePush(args as unknown as FilePushInput),
        },
        {
          name: 'igris_file_pull',
          description: 'Pull a flat file from the remote brain server.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              file_type: {
                type: 'string',
                enum: ['events', 'agent_metrics', 'budget'],
                description: 'File type: "events" for events.jsonl, "agent_metrics" for agent-metrics.json, "budget" for budget.json',
              },
              remote_url: {
                type: 'string',
                description: 'URL of the remote brain server',
              },
              api_key: {
                type: 'string',
                description: 'API key for authenticating with the remote brain server',
              },
            },
            required: ['file_type', 'remote_url', 'api_key'],
          },
          handler: (args) => handleFilePull(args as unknown as FilePullInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [],
        listens: [
          { name: 'memory.stored', description: 'Queue for remote sync' },
          { name: 'error.stored', description: 'Queue for remote sync' },
          { name: 'project.registered', description: 'Queue for remote sync' },
          { name: 'session.synced', description: 'Queue for remote sync' },
          { name: 'brief.synced', description: 'Queue for remote sync' },
          { name: 'instance.heartbeat', description: 'Queue for remote sync' },
          { name: 'metrics.recorded', description: 'Queue for remote sync' },
          { name: 'task.created', description: 'Queue for remote sync' },
          { name: 'task.completed', description: 'Queue for remote sync' },
          { name: 'task.assigned', description: 'Queue for remote sync' },
        ],
      };
    },

    init(ctx: ComponentContext): void {
      // Sync component listens to domain events for future auto-sync capability
      // For Phase 1, these listeners are wired but do not trigger auto-push
      ctx.log.info('Sync component initialized');
    },

    destroy(): void {
      // No resources to clean up
    },
  };
}
