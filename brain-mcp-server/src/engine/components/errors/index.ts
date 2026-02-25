/**
 * Brain Engine v5.0 — Errors Component
 *
 * Wraps the existing error tool handlers as a BrainComponent.
 * Provides: igris_error_lookup
 *
 * @module engine/components/errors
 * @author Fifty.ai
 */

import type {
  BrainComponent,
  ComponentContext,
  Migration,
  ToolDefinition,
  EventDef,
} from '../../types.js';
import { handleErrorLookup } from '../../../tools/errors.js';
import type { ErrorLookupInput } from '../../../tools/errors.js';

export function createErrorsComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'errors',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_error_lookup',
          description: 'Look up known solutions for an error, or store a new error/solution pair. Uses fingerprinting to match errors regardless of file paths or line numbers. When called without a solution, searches for matching errors. When called with a solution, stores or updates the error record.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              message: {
                type: 'string',
                description: 'The error message to look up or store',
              },
              project: {
                type: 'string',
                description: 'Project slug where the error occurred',
              },
              solution: {
                type: 'string',
                description: 'The solution to store for this error (optional — omit to search)',
              },
            },
            required: ['message', 'project'],
          },
          handler: (args) => {
            const result = handleErrorLookup(args as unknown as ErrorLookupInput);
            if ((args as Record<string, unknown>).solution) {
              _ctx?.bus.emit('error.stored', { project: (args as Record<string, unknown>).project });
            }
            return result;
          },
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          // Orphan: sync auto-push extension point — will be consumed when sync auto-push is implemented
          { name: 'error.stored', description: 'An error solution was stored or updated' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Errors component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
