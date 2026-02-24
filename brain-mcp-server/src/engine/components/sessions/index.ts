/**
 * Brain Engine v5.0 — Sessions Component
 *
 * Wraps the existing session tool handlers as a BrainComponent.
 * Provides: igris_session_sync, igris_session_recall
 *
 * @module engine/components/sessions
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import { handleSessionSync, handleSessionRecall } from '../../../tools/sessions.js';
import type { SessionSyncInput, SessionRecallInput } from '../../../tools/sessions.js';

export function createSessionsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'sessions',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_session_sync',
          description: 'Sync a session snapshot to the Igris brain. Called by /rest to record what you were working on. Closes any existing open session for the project before creating a new one.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Active brief ID (optional)',
              },
              phase: {
                type: 'string',
                description: 'Current workflow phase (optional)',
              },
              mode: {
                type: 'string',
                description: 'Session mode (e.g., "HUNT", "REST")',
              },
              summary: {
                type: 'string',
                description: 'Brief description of work done this session',
              },
            },
            required: ['project', 'summary'],
          },
          handler: (args) => {
            const result = handleSessionSync(args as unknown as SessionSyncInput);
            _ctx?.bus.emit('session.synced', { project: (args as Record<string, unknown>).project });
            return result;
          },
        },
        {
          name: 'igris_session_recall',
          description: 'Recall recent sessions across all projects. Called by /awaken to show cross-project context. Returns sessions grouped by day.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              days: {
                type: 'number',
                description: 'Number of days to look back (default: 7)',
              },
            },
          },
          handler: (args) => handleSessionRecall(args as unknown as SessionRecallInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'session.synced', description: 'A session was synced to the brain' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Sessions component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
