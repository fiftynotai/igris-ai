/**
 * Brain Engine v7.0 — Memory Component
 *
 * Wraps the existing memory tool handlers as a BrainComponent.
 * Provides: igris_memory_store, igris_memory_search, igris_memory_recall,
 *           igris_memory_get, igris_memory_hybrid_search,
 *           igris_memory_backfill_embeddings,
 *           igris_memory_update, igris_memory_delete, igris_memory_dashboard
 *           (TD-171 M1), igris_pattern_suggest
 *
 * @module engine/components/memory
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
  handleMemoryStore,
  handleMemorySearch,
  handleMemoryRecall,
  handleMemoryGet,
  handleMemoryMarkPromoted,
  handleMemoryHybridSearch,
  handleMemoryBackfillEmbeddings,
  handleMemoryUpdate,
  handleMemoryDelete,
  handleMemoryDashboard,
  handlePatternSuggest,
} from '../../../tools/memory.js';
import type {
  MemoryStoreInput,
  MemorySearchInput,
  MemoryRecallInput,
  MemoryGetInput,
  MemoryMarkPromotedInput,
  HybridSearchInput,
  BackfillInput,
  MemoryUpdateInput,
  MemoryDeleteInput,
  MemoryDashboardInput,
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
            additionalProperties: false,
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
              provenance: {
                type: 'string',
                enum: ['observed', 'inferred', 'synthesized', 'ambiguous', 'human_asserted'],
                description: 'Origin and trust level of this learning. Defaults to "observed". See docs/architecture/provenance.md.',
              },
              review_status: {
                type: 'string',
                enum: ['pending_review', 'approved'],
                description: 'Lifecycle gate for the perception channel (FR-109). Default "approved". Perception extractors pass "pending_review" so candidates are hidden from default recall/search until approved.',
              },
              source_extractor: {
                type: 'string',
                description: 'Which extractor produced this row (FR-109 + TD-066). Default "manual" for direct tool calls; perception passes "llm"; /distill passes "distill". Validated against VALID_SOURCE_EXTRACTOR.',
              },
            },
            required: ['project', 'category', 'title', 'content'],
          },
          handler: async (args) => {
            const result = await handleMemoryStore(args as unknown as MemoryStoreInput);
            _ctx?.bus.emit('memory.stored', { project: (args as Record<string, unknown>).project });
            return result;
          },
        },
        {
          name: 'igris_memory_search',
          description: 'Full-text search across all learnings in the Igris knowledge database. Supports filtering by project and scope. Returns results ranked by relevance.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
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
              offset: {
                type: 'number',
                description: 'Number of results to skip for pagination (default: 0)',
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
            additionalProperties: false,
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
          handler: async (args) => handleMemoryRecall(args as unknown as MemoryRecallInput),
        },
        {
          name: 'igris_memory_get',
          description: 'Fetch the full content of a single learning by ID. Use after igris_memory_recall returns truncated previews to get the complete content of a specific learning.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'number',
                description: 'The learning ID to fetch (from recall or search results)',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleMemoryGet(args as unknown as MemoryGetInput),
        },
        {
          name: 'igris_memory_mark_promoted',
          description: 'Mark a learning as promoted into a project-context doc (FR-200 M2). Sets promoted_to_doc (path[#anchor]) so igris_memory_recall surfaces a "Promoted → <doc>" pointer instead of re-printing the now-doc-owned content (one-fact-one-source). Called by /distill promote AFTER merging the standard into the doc and recording a derived_from lineage edge. The learning row is never deleted — it becomes a lineage stub. Separate axis from review_status.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'number',
                description: 'Learning ID to mark as promoted',
              },
              doc_path: {
                type: 'string',
                description: 'Target doc path the standard was merged into (e.g. "igris-ai:context/coding_guidelines.md" or the on-disk path under ~/.igris/projects/{name}/context/)',
              },
              doc_anchor: {
                type: 'string',
                description: 'Optional heading anchor within the doc (bare slug; a leading "#" is stripped). Appended as "#<anchor>" to the pointer.',
              },
            },
            required: ['id', 'doc_path'],
          },
          handler: (args) => {
            const result = handleMemoryMarkPromoted(args as unknown as MemoryMarkPromotedInput);
            // Emit only when the handler actually marked a row (avoid emitting on
            // validation errors / not-found). The success payload is JSON
            // carrying "promoted_to_doc"; errors are plain "Validation error:" /
            // "not found." text, so the marker is unambiguous.
            const text = result.content[0]?.text ?? '';
            if (text.includes('"promoted_to_doc"')) {
              _ctx?.bus.emit('memory.promoted', {
                id: (args as Record<string, unknown>).id,
                doc_path: (args as Record<string, unknown>).doc_path,
              });
            }
            return result;
          },
        },
        {
          name: 'igris_memory_hybrid_search',
          description: 'Hybrid search combining BM25 (keyword) and vector (semantic) results via Reciprocal Rank Fusion. Falls back to BM25-only if vector search is unavailable. Use this for the best search quality — it finds results that match both keywords and meaning.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                description: 'Search query — used for both FTS5 keyword matching and semantic vector search',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional — omit for cross-project search)',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results (default: 10)',
              },
              bm25_weight: {
                type: 'number',
                description: 'Weight for BM25 keyword results in RRF fusion (default: 0.5)',
              },
              vector_weight: {
                type: 'number',
                description: 'Weight for vector semantic results in RRF fusion (default: 0.5)',
              },
              rrf_k: {
                type: 'number',
                description: 'RRF constant — higher values reduce the influence of rank position (default: 60)',
              },
            },
            required: ['query'],
          },
          handler: async (args) => handleMemoryHybridSearch(args as unknown as HybridSearchInput),
        },
        {
          name: 'igris_memory_backfill_embeddings',
          description: 'Batch-generate embeddings for existing learnings that lack them. Processes learnings in batches — run multiple times to process all. Resumable: only processes learnings without embeddings.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              batch_size: {
                type: 'number',
                description: 'Number of learnings to process per batch (default: 50)',
              },
              project: {
                type: 'string',
                description: 'Filter by project slug (optional — omit to backfill all projects)',
              },
            },
            required: [],
          },
          handler: async (args) => handleMemoryBackfillEmbeddings(args as unknown as BackfillInput),
        },
        {
          name: 'igris_pattern_suggest',
          description: 'Suggest relevant patterns for the current context. Searches learnings via FTS5, includes global-scope patterns, and loads matching patterns from the starter-patterns library. Optionally filters by tech stack.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
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
        // -------------------------------------------------------------------
        // TD-171 M1 — update / delete / dashboard
        // -------------------------------------------------------------------
        {
          name: 'igris_memory_update',
          description: 'Update mutable fields of an existing learning (title, content, tags, category, scope, confidence). Bumps updated_at. Provenance, review_status, and source_extractor are intentionally immutable through this surface — _delete + _store afresh if you need to rewrite them.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'number',
                description: 'Learning ID to update',
              },
              title: {
                type: 'string',
                description: 'Optional new title',
              },
              content: {
                type: 'string',
                description: 'Optional new content',
              },
              tags: {
                type: 'string',
                description: 'Optional comma-separated tags (replaces existing)',
              },
              category: {
                type: 'string',
                enum: ['pattern', 'decision', 'discovery', 'mistake', 'optimization'],
                description: 'Optional new category',
              },
              scope: {
                type: 'string',
                enum: ['local', 'global'],
                description: 'Optional new scope',
              },
              confidence: {
                type: 'number',
                description: 'Optional new confidence (0-1)',
              },
            },
            required: ['id'],
          },
          handler: (args) => handleMemoryUpdate(args as unknown as MemoryUpdateInput),
        },
        {
          name: 'igris_memory_delete',
          description: 'Hard-delete a learning by ID and emit a memory.deleted bus event. Mirrors igris_perception_reject delete semantics. Use when a learning is provably wrong or duplicates a higher-quality entry; prefer igris_memory_update for fixable rows.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              id: {
                type: 'number',
                description: 'Learning ID to delete',
              },
              reason: {
                type: 'string',
                description: 'Optional human-readable reason for the audit log',
              },
            },
            required: ['id'],
          },
          handler: async (args) => {
            const result = handleMemoryDelete(args as unknown as MemoryDeleteInput);
            // Only emit when the handler actually deleted (avoid emitting on
            // validation errors / not-found). Look for the JSON marker in the
            // text payload — same shape every successful delete returns.
            const text = result.content[0]?.text ?? '';
            if (text.includes('"deleted": true')) {
              const id = (args as Record<string, unknown>).id;
              const reason = (args as Record<string, unknown>).reason;
              _ctx?.bus.emit('memory.deleted', {
                id,
                reason: typeof reason === 'string' ? reason : '',
              });
            }
            return result;
          },
        },
        {
          name: 'igris_memory_dashboard',
          description: 'Aggregate counts (by_category, by_scope, by_provenance, by_review_status) plus recent storage stats and top tags over the learnings table. CANONICAL _dashboard shape — TD-171 M2/M3/M4 mirror this structure. Honors summary_only to skip the samples array.',
          inputSchema: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              project: {
                type: 'string',
                description: 'Optional project filter; omit for cross-project view',
              },
              summary_only: {
                type: 'boolean',
                description: 'Counts only, no samples. Default false.',
              },
              days: {
                type: 'number',
                description: 'Time window for "recent" stats (and top_tags). Default 30. Must be non-negative.',
              },
            },
            required: [],
          },
          handler: (args) => handleMemoryDashboard(args as unknown as MemoryDashboardInput),
        },
      ];
    },

    events(): { emits: EventDef[]; listens: EventDef[] } {
      return {
        emits: [
          // Orphan: sync auto-push extension point — will be consumed when sync auto-push is implemented
          { name: 'memory.stored', description: 'A new learning was stored' },
          // TD-171 M1: emitted by igris_memory_delete after a successful hard-DELETE.
          // Payload: { id: number, reason: string }. Currently no in-process
          // listener — same orphan extension-point pattern as memory.stored.
          { name: 'memory.deleted', description: 'A learning was hard-deleted via igris_memory_delete' },
          // FR-200 M2: emitted by igris_memory_mark_promoted after a learning's
          // standard was promoted into a project-context doc. Payload:
          // { id: number, doc_path: string }. Orphan extension-point (no
          // in-process listener yet) — same pattern as memory.stored/deleted.
          { name: 'memory.promoted', description: 'A learning was promoted to a doc via igris_memory_mark_promoted' },
          // Note: promoteToGlobal() runs inline in handleMemoryStore and results are included in the response text. No separate event needed.
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
