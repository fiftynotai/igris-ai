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
import { handleErrorLookup, handleErrorSimilar, handleErrorBackfillEmbeddings } from '../../../tools/errors.js';
import type { ErrorLookupInput, ErrorSimilarInput, ErrorBackfillInput } from '../../../tools/errors.js';

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
          handler: async (args) => {
            const result = await handleErrorLookup(args as unknown as ErrorLookupInput);
            if ((args as Record<string, unknown>).solution) {
              _ctx?.bus.emit('error.stored', { project: (args as Record<string, unknown>).project });
            }
            return result;
          },
        },
        {
          name: 'igris_error_similar',
          description: 'Find semantically similar errors using hybrid BM25 + vector search. Uses both keyword matching and meaning-based similarity to find related errors across projects. Falls back to BM25-only if vector search is unavailable.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              message: {
                type: 'string',
                description: 'Error message to find semantically similar errors',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional)',
              },
              limit: {
                type: 'number',
                description: 'Maximum results (default: 10)',
              },
              include_cross_project: {
                type: 'boolean',
                description: 'Include results from other projects (default: true)',
              },
            },
            required: ['message'],
          },
          handler: async (args) => handleErrorSimilar(args as unknown as ErrorSimilarInput),
        },
        {
          name: 'igris_error_backfill_embeddings',
          description: 'Batch-generate embeddings for existing errors that lack them. Only processes errors with solutions. Resumable: only processes errors without embeddings.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              batch_size: {
                type: 'number',
                description: 'Number of errors to process per batch (default: 50)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional -- omit to backfill all projects)',
              },
            },
            required: [],
          },
          handler: async (args) => handleErrorBackfillEmbeddings(args as unknown as ErrorBackfillInput),
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
