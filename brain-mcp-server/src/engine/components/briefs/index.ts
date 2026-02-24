/**
 * Brain Engine v5.0 — Briefs Component
 *
 * Wraps the existing brief tool handlers as a BrainComponent.
 * Provides: igris_brief_sync, igris_brief_dashboard
 *
 * @module engine/components/briefs
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import { handleBriefSync, handleBriefDashboard } from '../../../tools/briefs.js';
import type { BriefSyncInput, BriefDashboardInput } from '../../../tools/briefs.js';

export function createBriefsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'briefs',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_brief_sync',
          description: 'Sync a brief status change to the Igris brain. Called when brief status changes during /hunt, /rest, or /archive. Uses upsert to maintain one record per project+brief_id.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug',
              },
              brief_id: {
                type: 'string',
                description: 'Brief ID (e.g., "BR-008", "MG-010")',
              },
              brief_type: {
                type: 'string',
                description: 'Brief type (e.g., "Bug", "Migration", "Feature")',
              },
              title: {
                type: 'string',
                description: 'Brief title',
              },
              status: {
                type: 'string',
                description: 'Brief status (e.g., "Ready", "In Progress", "Done")',
              },
              priority: {
                type: 'string',
                description: 'Priority level (e.g., "P0", "P1-High")',
              },
              effort: {
                type: 'string',
                description: 'Effort estimate (e.g., "S-Small", "L-Large")',
              },
              phase: {
                type: 'string',
                description: 'Current workflow phase (e.g., "BUILDING", "TESTING")',
              },
            },
            required: ['project', 'brief_id', 'title', 'status'],
          },
          handler: (args) => {
            const result = handleBriefSync(args as unknown as BriefSyncInput);
            _ctx?.bus.emit('brief.synced', {
              project: (args as Record<string, unknown>).project,
              brief_id: (args as Record<string, unknown>).brief_id,
            });
            return result;
          },
        },
        {
          name: 'igris_brief_dashboard',
          description: 'Display a cross-project brief dashboard showing all tracked briefs with status counts. Supports filtering by status and project.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              status: {
                type: 'string',
                description: 'Filter by brief status (optional)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
            },
          },
          handler: (args) => handleBriefDashboard(args as unknown as BriefDashboardInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'brief.synced', description: 'A brief status was synced' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Briefs component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
