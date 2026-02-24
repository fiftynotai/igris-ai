/**
 * Brain Engine v5.0 — Memory Component
 *
 * Wraps the existing memory tool handlers as a BrainComponent.
 * Provides: igris_memory_store, igris_memory_search, igris_memory_recall,
 *           igris_pattern_suggest
 *
 * @module engine/components/memory
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
  handleMemoryStore,
  handleMemorySearch,
  handleMemoryRecall,
  handlePatternSuggest,
} from '../../../tools/memory.js';
import type {
  MemoryStoreInput,
  MemorySearchInput,
  MemoryRecallInput,
  PatternSuggestInput,
} from '../../../tools/memory.js';

export function createMemoryComponent(): BrainComponent {
  let _ctx: ComponentContext | null = null;

  return {
    name: 'memory',
    version: '1.0.0',
    depends: [],

    schema(): Migration[] {
      // Migrations handled by legacy db.ts migrateSchema()
      // Component declares ownership but does not re-run them
      return [];
    },

    tools(): ToolDefinition[] {
      return [
        {
          name: 'igris_memory_store',
          description: 'Store a learning in the Igris knowledge database. Use this to persist patterns, decisions, discoveries, mistakes, and optimizations for future recall.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug (e.g., "igris-ai", "my-app")',
              },
              category: {
                type: 'string',
                enum: ['pattern', 'decision', 'discovery', 'mistake', 'optimization'],
                description: 'Category of the learning',
              },
              title: {
                type: 'string',
                description: 'Short descriptive title for the learning',
              },
              content: {
                type: 'string',
                description: 'Full content/description of the learning',
              },
              tags: {
                type: 'string',
                description: 'Comma-separated tags (e.g., "sqlite,fts5,performance")',
              },
              tech_stack: {
                type: 'string',
                description: 'Technologies involved (e.g., "typescript,sqlite")',
              },
              source_brief: {
                type: 'string',
                description: 'Brief ID that generated this learning (e.g., "BR-008")',
              },
              scope: {
                type: 'string',
                enum: ['local', 'global'],
                description: 'Scope: "local" for project-specific, "global" for cross-project relevance. Default: "local"',
              },
            },
            required: ['project', 'category', 'title', 'content'],
          },
          handler: (args) => {
            const result = handleMemoryStore(args as unknown as MemoryStoreInput);
            _ctx?.bus.emit('memory.stored', { project: (args as Record<string, unknown>).project });
            return result;
          },
        },
        {
          name: 'igris_memory_search',
          description: 'Full-text search across all learnings in the Igris knowledge database. Supports filtering by project and scope. Returns results ranked by relevance.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: {
                type: 'string',
                description: 'Search query (FTS5 syntax supported: AND, OR, NOT, phrases)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional — omit for cross-project search)',
              },
              scope: {
                type: 'string',
                enum: ['local', 'global'],
                description: 'Filter by scope: "global" for cross-project learnings only (optional)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
            },
            required: ['query'],
          },
          handler: (args) => handleMemorySearch(args as unknown as MemorySearchInput),
        },
        {
          name: 'igris_memory_recall',
          description: 'Contextual recall of relevant learnings for the current project. Combines project-local and global learnings matching the given context. Updates access counts for returned results.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to recall learnings for',
              },
              context: {
                type: 'string',
                description: 'What you are currently working on — used for FTS5 relevance matching',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 5)',
              },
            },
            required: ['project', 'context'],
          },
          handler: (args) => handleMemoryRecall(args as unknown as MemoryRecallInput),
        },
        {
          name: 'igris_pattern_suggest',
          description: 'Suggest relevant patterns for the current context. Searches learnings via FTS5, includes global-scope patterns, and loads matching patterns from the starter-patterns library. Optionally filters by tech stack.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              project: {
                type: 'string',
                description: 'Project slug to search patterns for',
              },
              context: {
                type: 'string',
                description: 'What you are currently working on — used for pattern matching',
              },
              tech_stack: {
                type: 'string',
                description: 'Filter by technology (e.g., "typescript", "sqlite") — optional',
              },
            },
            required: ['project', 'context'],
          },
          handler: (args) => handlePatternSuggest(args as unknown as PatternSuggestInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          { name: 'memory.stored', description: 'A new learning was stored' },
          { name: 'memory.promoted', description: 'A learning was promoted to global scope' },
        ],
        listens: [],
      };
    },

    init(ctx: ComponentContext): void {
      _ctx = ctx;
      ctx.log.info('Memory component initialized');
    },

    destroy(): void {
      _ctx = null;
    },
  };
}
