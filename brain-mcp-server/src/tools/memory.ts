/**
 * Igris Brain — Memory Tools
 *
 * Provides persistent learning storage, full-text search, hybrid search
 * (BM25 + vector via sqlite-vec), and contextual recall across projects.
 * Backed by SQLite FTS5 for BM25 retrieval and sqlite-vec for vector KNN.
 *
 * Tools:
 * - igris_memory_store: Store a learning in the knowledge DB (auto-embeds)
 * - igris_memory_search: Full-text search across learnings (with pagination)
 * - igris_memory_recall: Contextual retrieval for current project + global
 * - igris_memory_get: Fetch full content of a single learning by ID
 * - igris_memory_hybrid_search: RRF-fused BM25 + vector search
 * - igris_memory_backfill_embeddings: Batch-embed learnings missing embeddings
 * - igris_memory_update: Edit fields of an existing learning (TD-171 M1)
 * - igris_memory_delete: Hard-DELETE a learning + emit bus event (TD-171 M1)
 * - igris_memory_dashboard: Aggregate counts + recent stats (TD-171 M1; canonical _dashboard shape)
 * - igris_pattern_suggest: Suggest relevant patterns for current context
 *
 * Internal functions:
 * - promoteToGlobal: Auto-promote local learnings to global when found in 2+ projects
 *
 * @module tools/memory
 * @author fifty.dev
 */

import { getDb, BRAIN_DIR } from '../db.js';
import { sanitizeFts5Query } from '../utils/fts5.js';
import { generateEmbedding, embeddingToBuffer, processInBatches, EMBEDDING_MODEL } from '../utils/embeddings.js';
import { isVectorSearchAvailable, insertEmbedding, vectorSearch } from '../utils/vector-search.js';
import type { VectorSearchResult } from '../utils/vector-search.js';
import { computeRRF } from '../utils/hybrid-search.js';
import type { SourceExtractor } from '../engine/components/perception/types.js';
import * as fs from 'fs';
import * as path from 'path';

/** Max query length for hybrid search */
const MAX_QUERY_LENGTH = 10000;

/**
 * Compute Jaccard similarity between two comma-separated tech stack strings.
 *
 * Splits each string on commas, normalises to lowercase, and returns the
 * ratio of intersection size to union size. Returns 0 when either stack
 * is null/empty.
 *
 * @param stackA - First tech stack (comma-separated)
 * @param stackB - Second tech stack (comma-separated)
 * @returns Overlap score between 0 and 1
 */
function computeTechStackOverlap(stackA: string | null, stackB: string | null): number {
  if (!stackA || !stackB) return 0;
  const setA = new Set(stackA.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const setB = new Set(stackB.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** Input shape for igris_memory_store */
interface MemoryStoreInput {
  project: string;
  category: 'pattern' | 'decision' | 'discovery' | 'mistake' | 'optimization';
  title: string;
  content: string;
  tags?: string;
  tech_stack?: string;
  source_brief?: string;
  scope?: 'local' | 'global';
  provenance?: 'observed' | 'inferred' | 'synthesized' | 'ambiguous' | 'human_asserted';
  /**
   * Lifecycle gate for the perception channel (FR-109). Default `'approved'`
   * makes every existing call path opt-in to the conscious channel. Perception
   * extractors pass `'pending_review'` so candidates are hidden from default
   * recall/search until `igris_perception_approve` flips the flag.
   */
  review_status?: 'pending_review' | 'approved';
  /**
   * Which extractor produced this row (FR-109 + TD-066). Default `'manual'`
   * covers the conscious-channel use case where a human or agent calls the
   * tool directly. Perception extractors pass `'llm'`; the /harvest skill
   * passes `'distill'` (the enum value intentionally stays `'distill'` after
   * the /distill → /harvest rename — it is a persisted channel-tag, not the
   * skill name; renaming it would orphan stored rows).
   *
   * The TD-061 brief originally proposed a wider vocabulary including
   * `rule:learned_marker`, `rule:retry_chain`, `rule:blocker_resolution`,
   * `rule:error_fingerprint`, and `'subconscious'`. TD-066 deleted the rule
   * extractors (existing `rule:*` rows in production DBs remain readable —
   * read-only legacy), and `'subconscious'` is reserved for FR-118 which has
   * not landed. Validated against `VALID_SOURCE_EXTRACTOR` below; when FR-118
   * lands it MUST extend both `SourceExtractor` in
   * `engine/components/perception/types.ts` AND `VALID_SOURCE_EXTRACTOR` here
   * in the same change.
   */
  source_extractor?: SourceExtractor;
}

/** Input shape for igris_memory_search */
interface MemorySearchInput {
  query: string;
  project?: string;
  scope?: 'local' | 'global';
  limit?: number;
  offset?: number;
}

/** Input shape for igris_memory_recall */
interface MemoryRecallInput {
  project: string;
  context: string;
  limit?: number;
}

/** Input shape for igris_memory_get */
interface MemoryGetInput {
  id: number;
}

/** Input shape for igris_memory_mark_promoted (FR-200 M2) */
interface MemoryMarkPromotedInput {
  id: number;
  doc_path: string;
  doc_anchor?: string;
}

/** A BM25 result row from FTS5 */
interface Bm25Row {
  id: number;
  project: string;
  category: string;
  title: string;
  content: string;
  tags: string;
  tech_stack: string;
  scope: string;
  source_brief: string;
  confidence: number;
  created_at: string;
  access_count: number;
  rank: number;
  provenance: string;
  /**
   * FR-200 M2: the project-context doc (path[#anchor]) a learning's standard
   * was promoted into, or null/undefined when not promoted. Populated only on
   * the recall hydration paths that SELECT it (recall's BM25 + hybrid
   * `fullRows`); other Bm25Row producers leave it undefined.
   */
  promoted_to_doc?: string | null;
}

/**
 * Store a learning in the knowledge database.
 *
 * @param args - The learning data to store
 * @returns MCP-formatted response with the inserted learning ID
 */
/** Max content size: 1 MB */
const MAX_CONTENT_LENGTH = 1_048_576;
const MAX_PROJECT_LENGTH = 255;
const MAX_TITLE_LENGTH = 500;
const VALID_CATEGORIES = ['pattern', 'decision', 'discovery', 'mistake', 'optimization'];
/**
 * Provenance vocabulary for learnings (FR-107).
 *
 * Intentionally distinct from edges.VALID_PROVENANCE (`observed`, `backfill`,
 * `inferred`, `user`) — different domain (knowledge artifacts vs. graph
 * relationships). Do NOT extract a shared constant.
 *
 * See docs/architecture/provenance.md for semantics.
 */
const VALID_LEARNING_PROVENANCE = [
  'observed',
  'inferred',
  'synthesized',
  'ambiguous',
  'human_asserted',
] as const;

/**
 * Review-status vocabulary for learnings (FR-109 perception channel).
 *
 * Conscious-channel callers (everywhere except the perception ingest path)
 * default to `'approved'`. Perception extractors pass `'pending_review'` so
 * the learning stays hidden from default recall/search/hybrid/pattern_suggest
 * until a human approves it.
 *
 * Enum is enforced at the handler layer (here) instead of as a SQLite CHECK
 * constraint because ALTER TABLE cannot add CHECK constraints cleanly —
 * mirrors the FR-107 v14 pattern. The composite index
 * `idx_learnings_review_status(review_status, project)` keeps the lazy-on-read
 * filter cheap.
 */
const VALID_REVIEW_STATUS = ['pending_review', 'approved'] as const;

/**
 * Source-extractor vocabulary for learnings (FR-109 + TD-061 + TD-066).
 *
 * Mirrors `SourceExtractor` from `engine/components/perception/types.ts`
 * (post-TD-066: rule extractors removed). Legacy `rule:*` rows in production
 * DBs remain read-compatible — the validation here only gates the WRITE path
 * so a future typo (`'lmm'`, `'manaul'`) cannot land silently.
 *
 * The TD-061 brief proposed a broader vocabulary that included the
 * (since-deleted) `rule:*` extractors and a forward-looking `'subconscious'`
 * value for FR-118. We intentionally narrow to the current canonical 3 here.
 * If FR-118 lands and adds `'subconscious'`, extend BOTH this tuple AND
 * `SourceExtractor` in perception/types.ts in the same change so the contract
 * stays in sync.
 */
const VALID_SOURCE_EXTRACTOR = ['manual', 'llm', 'distill'] as const;

function validateMemoryInput(args: MemoryStoreInput): string | null {
  if (!args.project || args.project.length > MAX_PROJECT_LENGTH) {
    return `Invalid project: must be 1-${MAX_PROJECT_LENGTH} characters.`;
  }
  if (!args.title || args.title.length > MAX_TITLE_LENGTH) {
    return `Invalid title: must be 1-${MAX_TITLE_LENGTH} characters.`;
  }
  if (!args.content || args.content.length > MAX_CONTENT_LENGTH) {
    return `Invalid content: must be 1-${MAX_CONTENT_LENGTH} characters (1 MB max).`;
  }
  if (!VALID_CATEGORIES.includes(args.category)) {
    return `Invalid category: must be one of ${VALID_CATEGORIES.join(', ')}.`;
  }
  if (
    args.provenance !== undefined &&
    !(VALID_LEARNING_PROVENANCE as readonly string[]).includes(args.provenance)
  ) {
    return `Invalid provenance: must be one of ${VALID_LEARNING_PROVENANCE.join(', ')}.`;
  }
  if (
    args.review_status !== undefined &&
    !(VALID_REVIEW_STATUS as readonly string[]).includes(args.review_status)
  ) {
    return `Invalid review_status: must be one of ${VALID_REVIEW_STATUS.join(', ')}.`;
  }
  if (
    args.source_extractor !== undefined &&
    !(VALID_SOURCE_EXTRACTOR as readonly string[]).includes(args.source_extractor)
  ) {
    return `Invalid source_extractor: must be one of ${VALID_SOURCE_EXTRACTOR.join(', ')}.`;
  }
  return null;
}

async function handleMemoryStore(args: MemoryStoreInput): Promise<{ content: { type: string; text: string }[] }> {
  const validationError = validateMemoryInput(args);
  if (validationError) {
    return { content: [{ type: 'text', text: `Validation error: ${validationError}` }] };
  }

  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO learnings (project, category, title, content, tags, tech_stack, source_brief, scope, provenance, review_status, source_extractor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    args.project,
    args.category,
    args.title,
    args.content,
    args.tags ?? '',
    args.tech_stack ?? '',
    args.source_brief ?? '',
    args.scope ?? 'local',
    args.provenance ?? 'observed',
    args.review_status ?? 'approved',
    args.source_extractor ?? 'manual',
  );

  const learningId = result.lastInsertRowid as number;

  // Auto-embed: generate embedding and store in vec table (non-blocking on failure)
  // Note: pending_review rows are still embedded — approval is a status flip,
  // not a re-embed. Saves cost on the approval path.
  let embeddingNote = '';
  try {
    if (isVectorSearchAvailable(db)) {
      const embedding = await generateEmbedding(`${args.title} ${args.content}`);
      db.prepare('UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, learningId);
      insertEmbedding(db, learningId, embedding);
      embeddingNote = '\nEmbedding: generated';
    }
  } catch (err) {
    console.error('[memory] Auto-embed failed for learning', learningId, ':', err);
    embeddingNote = '\nEmbedding: skipped (will be generated on backfill)';
  }

  // After storing, check if any local learnings should be promoted to global.
  // Skip for pending_review rows — they aren't fully part of the conscious
  // channel yet, and we don't want to leak title-collisions across projects
  // before a human has approved the inference.
  const reviewStatus = args.review_status ?? 'approved';
  const promoted = reviewStatus === 'approved' ? promoteToGlobal() : 0;
  const promotedNote = promoted > 0 ? `\nAuto-promoted: ${promoted} learning(s) to global scope` : '';

  return {
    content: [{
      type: 'text',
      text: `Learning stored successfully.\n\nID: ${learningId}\nProject: ${args.project}\nCategory: ${args.category}\nTitle: ${args.title}\nScope: ${args.scope ?? 'local'}\nProvenance: ${args.provenance ?? 'observed'}\nReview status: ${reviewStatus}${embeddingNote}${promotedNote}`,
    }],
  };
}

/**
 * Full-text search across learnings using FTS5.
 *
 * Supports filtering by project, scope, and result limit.
 * When no project or scope is specified, searches across all learnings.
 *
 * @param args - Search parameters
 * @returns MCP-formatted response with matching learnings
 */
function handleMemorySearch(args: MemorySearchInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const limit = args.limit ?? 10;
  const offset = args.offset ?? 0;

  const sanitized = sanitizeFts5Query(args.query);
  if (!sanitized) {
    return {
      content: [{
        type: 'text',
        text: 'No learnings found matching the query.',
      }],
    };
  }

  // FR-109 default filter: pending_review learnings (perception-channel
  // candidates) are hidden from the conscious channel. Approval flips the
  // gate; rejection deletes the row.
  let sql = `
    SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
           l.tech_stack, l.scope, l.source_brief, l.confidence,
           l.created_at, l.access_count, l.provenance, l.promoted_to_doc,
           rank
    FROM learnings_fts fts
    JOIN learnings l ON l.id = fts.rowid
    WHERE learnings_fts MATCH ?
      AND l.review_status = 'approved'
  `;

  const params: (string | number)[] = [sanitized];

  if (args.project) {
    sql += ' AND l.project = ?';
    params.push(args.project);
  }

  if (args.scope === 'global') {
    sql += " AND l.scope = 'global'";
  }

  sql += ' ORDER BY rank LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No learnings found matching "${args.query}".`,
      }],
    };
  }

  const results = rows.map((row, i) => {
    // FR-200 M2 (one-fact-one-source): a promoted learning's standard now lives
    // in a project-context doc. Search must NOT re-emit the raw content (here it
    // would be the FULL untruncated body) — surface the doc pointer instead.
    // Gate matches handleMemoryRecall exactly: non-empty string => promoted.
    const promotedTo = typeof row.promoted_to_doc === 'string' && (row.promoted_to_doc as string).length > 0
      ? (row.promoted_to_doc as string)
      : null;
    const lines = [
      `--- Result ${i + 1} ---`,
      `ID: ${row.id}`,
      `Project: ${row.project}`,
      `Category: ${row.category}`,
      `Title: ${row.title}`,
    ];
    if (promotedTo) {
      lines.push(`Promoted: → ${promotedTo} (this standard now lives in the doc; see it there)`);
    } else {
      lines.push(`Content: ${row.content}`);
    }
    lines.push(
      `Tags: ${row.tags || '(none)'}`,
      `Tech Stack: ${row.tech_stack || '(none)'}`,
      `Scope: ${row.scope}`,
      `Source Brief: ${row.source_brief || '(none)'}`,
      `Confidence: ${row.confidence}`,
      `Provenance: ${row.provenance}`,
      `Created: ${row.created_at}`,
      `Access Count: ${row.access_count}`,
      `Rank: ${row.rank}`,
    );
    return lines.join('\n');
  });

  return {
    content: [{
      type: 'text',
      text: `Found ${rows.length} learning(s) matching "${args.query}":\n\n${results.join('\n\n')}`,
    }],
  };
}

/**
 * Contextual recall for the current project.
 *
 * Uses hybrid search (BM25 + vector via RRF) when available, with a 1.5x
 * boost for project-local results. Falls back to FTS5-only when sqlite-vec
 * is unavailable. Increments access_count and updates last_accessed_at for
 * returned results.
 *
 * @param args - Recall parameters with project and context
 * @returns MCP-formatted response with relevant learnings
 */
async function handleMemoryRecall(args: MemoryRecallInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const limit = args.limit ?? 5;

  const sanitized = sanitizeFts5Query(args.context);
  if (!sanitized) {
    return {
      content: [{
        type: 'text',
        text: `No relevant learnings found for project "${args.project}" with context "${args.context}".`,
      }],
    };
  }

  // --- 1. BM25 search via FTS5 (project-local + global scope) ---
  // FR-109 filter: pending_review rows excluded from conscious-channel recall.
  const bm25Sql = `
    SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
           l.tech_stack, l.scope, l.source_brief, l.confidence,
           l.created_at, l.access_count, l.provenance, l.promoted_to_doc,
           rank,
           (rank * 0.6 - l.confidence * 0.2 - MIN(l.access_count, 100) / 100.0 * 0.2) AS composite_score
    FROM learnings_fts fts
    JOIN learnings l ON l.id = fts.rowid
    WHERE learnings_fts MATCH ?
      AND (l.project = ? OR l.scope = 'global')
      AND l.review_status = 'approved'
    ORDER BY composite_score
    LIMIT ?
  `;

  let bm25Rows: Bm25Row[] = [];
  try {
    bm25Rows = db.prepare(bm25Sql).all(sanitized, args.project, limit * 2) as Bm25Row[];
  } catch {
    bm25Rows = [];
  }

  // --- 2. Vector search with graceful fallback ---
  let vecResults: VectorSearchResult[] = [];
  let vectorAvailable = false;

  try {
    if (isVectorSearchAvailable(db)) {
      const queryEmbedding = await generateEmbedding(args.context);
      vecResults = vectorSearch(db, queryEmbedding, limit * 2);
      vectorAvailable = true;

      // Filter vector results to project-local + global scope.
      // FR-109: also gate on review_status='approved' so pending_review rows
      // never bubble through the vector channel.
      if (vecResults.length > 0) {
        const ids = vecResults.map(r => r.rowid);
        const placeholders = ids.map(() => '?').join(',');
        const scopeRows = db.prepare(
          `SELECT id FROM learnings WHERE id IN (${placeholders}) AND (project = ? OR scope = 'global') AND review_status = 'approved'`,
        ).all(...ids, args.project) as { id: number }[];
        const scopeIdSet = new Set(scopeRows.map(r => r.id));
        vecResults = vecResults.filter(r => scopeIdSet.has(r.rowid));
      }
    }
  } catch (err) {
    console.error('[memory] Vector search failed in recall, using BM25 only:', err);
  }

  // --- 3. No results at all ---
  if (bm25Rows.length === 0 && vecResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No relevant learnings found for project "${args.project}" with context "${args.context}".`,
      }],
    };
  }

  // --- 4. Determine final ordering ---
  type RecallRow = Bm25Row & { rrf_score?: number; composite_score?: number };
  let finalRows: RecallRow[];
  let searchSource: string;

  // Query all project tech stacks and archetypes in one call for affinity boosts
  const projectStacks = new Map<string, string>();
  const projectArchetypes = new Map<string, string>();
  const stackRows = db.prepare(
    'SELECT slug, tech_stack, archetype FROM projects WHERE tech_stack IS NOT NULL OR archetype IS NOT NULL',
  ).all() as { slug: string; tech_stack: string; archetype: string | null }[];
  for (const sr of stackRows) {
    if (sr.tech_stack) projectStacks.set(sr.slug, sr.tech_stack);
    if (sr.archetype) projectArchetypes.set(sr.slug, sr.archetype);
  }
  const currentStack = projectStacks.get(args.project) ?? null;
  const currentArchetype = projectArchetypes.get(args.project) ?? null;

  if (vectorAvailable && vecResults.length > 0) {
    // Hybrid: RRF merge + project-local boost + tech stack affinity
    const rrfEntries = computeRRF(bm25Rows, vecResults);

    // Fetch full records for RRF results
    const topIds = rrfEntries.map(e => e.id);
    const placeholders = topIds.map(() => '?').join(',');
    // TD-059 sibling: defense-in-depth `review_status='approved'` filter on the
    // recall hydration path. The upstream `bm25Rows`/`vecResults` already
    // exclude pending_review rows via their query predicates, but a future
    // caller bypassing those upstream filters must not leak unapproved rows
    // through the hydration step. Kept symmetric with the same filter on the
    // hybrid_search hydration query below.
    const fullRows = db.prepare(
      `SELECT id, project, category, title, content, tags, tech_stack, scope,
              source_brief, confidence, created_at, access_count, provenance,
              promoted_to_doc
       FROM learnings
       WHERE id IN (${placeholders})
         AND review_status = 'approved'`,
    ).all(...topIds) as Bm25Row[];

    const rowMap = new Map<number, Bm25Row>();
    for (const row of fullRows) {
      rowMap.set(row.id, row);
    }

    // Apply boosts (stackable): 1.5x project-local, 1.3x tech-stack affinity, 1.2x archetype match
    for (const entry of rrfEntries) {
      const row = rowMap.get(entry.id);
      if (!row) continue;

      // Boost 1: project-local vs tech-stack affinity (mutually exclusive)
      if (row.project === args.project) {
        entry.score *= 1.5;
      } else if (currentStack) {
        const rowStack = projectStacks.get(row.project) ?? null;
        const overlap = computeTechStackOverlap(currentStack, rowStack);
        if (overlap >= 0.5) {
          entry.score *= 1.3;
        }
      }

      // Boost 2: archetype affinity (stacks with above)
      if (currentArchetype && currentArchetype !== 'unclassified' && row.project !== args.project) {
        const rowArchetype = projectArchetypes.get(row.project) ?? null;
        if (rowArchetype && rowArchetype === currentArchetype) {
          entry.score *= 1.2;
        }
      }
    }
    rrfEntries.sort((a, b) => b.score - a.score);

    // Build final rows in RRF order (skip entries without full row data)
    finalRows = [];
    for (const entry of rrfEntries.slice(0, limit)) {
      const row = rowMap.get(entry.id);
      if (row) {
        finalRows.push({ ...row, rrf_score: entry.score });
      }
    }

    searchSource = 'hybrid';
  } else {
    // BM25-only fallback
    finalRows = bm25Rows.slice(0, limit);
    searchSource = 'bm25-only';
  }

  if (finalRows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No relevant learnings found for project "${args.project}" with context "${args.context}".`,
      }],
    };
  }

  // --- 5. Update access counts ---
  // TD-092: this UPDATE is correct and load-bearing — it is what powers the
  // composite-ranking access_count boost (see line 414's `MIN(l.access_count, 100) / 100.0`)
  // and the recall telemetry. The bug observed in TD-092 ("access_count not
  // incrementing") was environmental: `igris-brain` MCP transport was registered
  // as `http` to the VPS, so the increment landed on the VPS DB while the
  // observer queried the local file. The SQL contract is enforced by the
  // regression tests in `__tests__/memory.test.ts` ("handleMemoryRecall — access_count telemetry").
  const updateStmt = db.prepare(`
    UPDATE learnings
    SET access_count = access_count + 1,
        last_accessed_at = datetime('now')
    WHERE id = ?
  `);

  const updateAll = db.transaction((ids: unknown[]) => {
    for (const id of ids) {
      updateStmt.run(id);
    }
  });

  updateAll(finalRows.map(r => r.id));

  // --- 6. Format results ---
  const results = finalRows.map((row, i) => {
    const fullContent = row.content as string;
    const truncated = fullContent.length > 200
      ? fullContent.substring(0, 200) + '...'
      : fullContent;
    // FR-200 M2 (one-fact-one-source): when a learning has been promoted into a
    // project-context doc, that doc now OWNS the standard. Recall must stop
    // double-surfacing the raw learning content — instead point the reader at
    // the doc. We replace the Content line with a Promoted pointer (and keep a
    // short stub so the row still reads), rather than printing the now-stale
    // full text. The learning row is never deleted; it remains a lineage stub.
    const promotedTo = typeof row.promoted_to_doc === 'string' && row.promoted_to_doc.length > 0
      ? row.promoted_to_doc
      : null;
    const lines = [
      `--- Recall ${i + 1} ---`,
      `ID: ${row.id}`,
      `Project: ${row.project}`,
      `Category: ${row.category}`,
      `Title: ${row.title}`,
    ];
    if (promotedTo) {
      lines.push(`Promoted: → ${promotedTo} (this standard now lives in the doc; see it there)`);
    } else {
      lines.push(`Content: ${truncated}`);
    }
    lines.push(
      `Tags: ${row.tags || '(none)'}`,
      `Scope: ${row.scope}`,
      `Confidence: ${row.confidence}`,
      `Provenance: ${row.provenance}`,
    );
    if (row.rrf_score !== undefined) {
      lines.push(`Score: ${(row.rrf_score as number).toFixed(6)}`);
    } else if (row.composite_score !== undefined) {
      lines.push(`Score: ${row.composite_score}`);
    }
    if (row.project === args.project) {
      lines.push('Boost: project-local');
    } else if (currentStack) {
      const rowStack = projectStacks.get(row.project) ?? null;
      if (computeTechStackOverlap(currentStack, rowStack) >= 0.5) {
        lines.push('Boost: tech-stack affinity');
      }
    }
    return lines.join('\n');
  });

  return {
    content: [{
      type: 'text',
      text: `Recalled ${finalRows.length} relevant learning(s) for "${args.project}" (${searchSource}, use igris_memory_get for full content):\n\n${results.join('\n\n')}`,
    }],
  };
}

/**
 * Fetch the full content of a single learning by ID.
 *
 * Designed for use after igris_memory_recall returns truncated previews.
 * Increments access_count and updates last_accessed_at.
 *
 * @param args - The learning ID to fetch
 * @returns MCP-formatted response with the full learning content
 */
function handleMemoryGet(args: MemoryGetInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // INTENTIONAL: no review_status filter — perception-review surface fetches pending rows by ID for approval UI
  const row = db.prepare(`
    SELECT id, project, category, title, content, tags,
           tech_stack, scope, source_brief, confidence,
           created_at, access_count, provenance
    FROM learnings
    WHERE id = ?
  `).get(args.id) as Record<string, unknown> | undefined;

  if (!row) {
    return {
      content: [{
        type: 'text',
        text: `Learning with ID ${args.id} not found.`,
      }],
    };
  }

  // Update access count
  db.prepare(`
    UPDATE learnings
    SET access_count = access_count + 1,
        last_accessed_at = datetime('now')
    WHERE id = ?
  `).run(args.id);

  const result = [
    `ID: ${row.id}`,
    `Project: ${row.project}`,
    `Category: ${row.category}`,
    `Title: ${row.title}`,
    `Content: ${row.content}`,
    `Tags: ${row.tags || '(none)'}`,
    `Tech Stack: ${row.tech_stack || '(none)'}`,
    `Scope: ${row.scope}`,
    `Source Brief: ${row.source_brief || '(none)'}`,
    `Confidence: ${row.confidence}`,
    `Provenance: ${row.provenance}`,
    `Created: ${row.created_at}`,
    `Access Count: ${(row.access_count as number) + 1}`,
  ].join('\n');

  return {
    content: [{
      type: 'text',
      text: result,
    }],
  };
}

/**
 * Mark a learning as promoted into a project-context doc (FR-200 M2).
 *
 * The memory→doc promotion pass (the `/promote` skill) calls this after
 * it has merged a hardened learning's standard into a `~/.igris/projects/{name}/
 * context/` doc and recorded a `derived_from` lineage edge. Setting
 * `promoted_to_doc` makes `handleMemoryRecall` surface a "Promoted → <doc>"
 * pointer instead of re-printing the now-doc-owned raw content
 * (one-fact-one-source — FR-196).
 *
 * This is a SEPARATE axis from `review_status` (a learning can be `approved`
 * AND promoted) — which is exactly why FR-200 added a dedicated column rather
 * than overloading the perception-channel review gate (see the FR-200 plan
 * Q3b). The learning row is NEVER deleted by promotion; it becomes a lineage
 * stub whose `promoted_to_doc` points readers at the doc.
 *
 * Parameterized throughout. Verifies the row exists first (mirrors
 * `handleMemoryUpdate`) so the caller gets a clear "not found" rather than a
 * silent zero-rows-changed. Idempotent: re-marking with a new doc path simply
 * overwrites the pointer and re-bumps `updated_at`.
 *
 * Returns `{ id, promoted_to_doc, updated_at }` JSON.
 *
 * @param args - The learning ID + target doc path + optional anchor
 * @returns MCP-formatted response with the promotion record
 */
function handleMemoryMarkPromoted(args: MemoryMarkPromotedInput): { content: { type: string; text: string }[] } {
  // Validate id (mirror handleMemoryUpdate's positive-int guard).
  if (typeof args.id !== 'number' || !Number.isInteger(args.id) || args.id <= 0) {
    return { content: [{ type: 'text', text: 'Validation error: id must be a positive integer.' }] };
  }

  // Validate doc_path: required, non-empty, bounded.
  if (typeof args.doc_path !== 'string' || args.doc_path.length === 0 || args.doc_path.length > MAX_TITLE_LENGTH) {
    return {
      content: [{
        type: 'text',
        text: `Validation error: doc_path must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`,
      }],
    };
  }

  // Validate doc_anchor when present (optional; bounded; no leading '#' needed —
  // we add the separator ourselves so callers pass the bare anchor).
  if (args.doc_anchor !== undefined) {
    if (typeof args.doc_anchor !== 'string' || args.doc_anchor.length === 0 || args.doc_anchor.length > MAX_TITLE_LENGTH) {
      return {
        content: [{
          type: 'text',
          text: `Validation error: doc_anchor, when provided, must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`,
        }],
      };
    }
  }

  const db = getDb();

  // Verify the row exists before the UPDATE (clear not-found vs silent no-op).
  const existing = db
    .prepare('SELECT id FROM learnings WHERE id = ?')
    .get(args.id) as { id: number } | undefined;
  if (!existing) {
    return { content: [{ type: 'text', text: `Learning with ID ${args.id} not found.` }] };
  }

  // Compose the pointer: doc_path, plus '#'+anchor when an anchor is given.
  // Strip a leading '#' the caller may have included so we never double it.
  const anchor = args.doc_anchor !== undefined ? args.doc_anchor.replace(/^#/, '') : '';
  const promotedToDoc = anchor.length > 0 ? `${args.doc_path}#${anchor}` : args.doc_path;

  // Bump updated_at to a fresh ISO timestamp (mirror handleMemoryUpdate — keeps
  // LWW sync resolution comparable with created_at's UTC datetime('now')).
  const updatedAt = new Date().toISOString();

  db.prepare('UPDATE learnings SET promoted_to_doc = ?, updated_at = ? WHERE id = ?')
    .run(promotedToDoc, updatedAt, args.id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ id: args.id, promoted_to_doc: promotedToDoc, updated_at: updatedAt }, null, 2),
    }],
  };
}

/** Input shape for igris_pattern_suggest */
interface PatternSuggestInput {
  project: string;
  context: string;
  tech_stack?: string;
}

/** Shape of a starter pattern loaded from JSON */
interface StarterPattern {
  id: string;
  name: string;
  category: string;
  tech_stack: string[];
  description: string;
  when_to_use: string;
  example: string;
}

/**
 * Suggest relevant patterns for the current context.
 *
 * Searches learnings via FTS5 matching the context, includes global-scope
 * patterns, and loads matching patterns from the starter-patterns JSON file.
 * Optionally filters by tech_stack.
 *
 * @param args - Project, context for matching, and optional tech_stack filter
 * @returns MCP-formatted response with suggested patterns
 */
function handlePatternSuggest(args: PatternSuggestInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // --- Search learnings via FTS5 ---
  const sanitized = sanitizeFts5Query(args.context);
  let learningRows: Record<string, unknown>[] = [];

  if (sanitized) {
    // FR-109 filter: hide pending_review rows from conscious pattern suggestions.
    let learningSql = `
      SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
             l.tech_stack, l.scope, l.confidence, l.access_count,
             rank
      FROM learnings_fts fts
      JOIN learnings l ON l.id = fts.rowid
      WHERE learnings_fts MATCH ?
        AND (l.project = ? OR l.scope = 'global')
        AND l.review_status = 'approved'
    `;
    const learningParams: (string | number)[] = [sanitized, args.project];

    if (args.tech_stack) {
      learningSql += ' AND l.tech_stack LIKE ?';
      learningParams.push(`%${args.tech_stack}%`);
    }

    learningSql += ' ORDER BY rank LIMIT 10';

    try {
      learningRows = db.prepare(learningSql).all(...learningParams) as Record<string, unknown>[];
    } catch (_err) {
      // FTS5 match may fail on certain query syntax; treat as no results
      learningRows = [];
    }
  }

  // --- Load starter patterns from JSON ---
  const patternsPath = path.join(BRAIN_DIR, 'memory', 'patterns', 'starter-patterns.json');
  let starterPatterns: StarterPattern[] = [];
  try {
    const raw = fs.readFileSync(patternsPath, 'utf-8');
    starterPatterns = JSON.parse(raw) as StarterPattern[];
  } catch (_err) {
    // File may not exist yet; that is fine
    starterPatterns = [];
  }

  // Filter starter patterns by tech_stack if provided
  if (args.tech_stack) {
    const stackLower = args.tech_stack.toLowerCase();
    starterPatterns = starterPatterns.filter(p =>
      p.tech_stack.some(t => t.toLowerCase().includes(stackLower))
    );
  }

  // Filter starter patterns by context relevance (simple substring match)
  const contextLower = args.context.toLowerCase();
  const contextWords = contextLower.split(/\s+/).filter(w => w.length > 2);
  const matchingPatterns = starterPatterns.filter(p => {
    const searchable = `${p.name} ${p.description} ${p.when_to_use} ${p.category}`.toLowerCase();
    return contextWords.some(word => searchable.includes(word));
  });

  // --- Format results ---
  const sections: string[] = [
    `# Pattern Suggestions for "${args.project}"`,
    `Context: ${args.context}`,
    args.tech_stack ? `Tech Stack Filter: ${args.tech_stack}` : '',
    '',
  ].filter(Boolean);

  // Learnings section
  if (learningRows.length > 0) {
    sections.push('## From Knowledge Base');
    sections.push('');
    learningRows.forEach((row, i) => {
      sections.push(`### ${i + 1}. ${row.title}`);
      sections.push(`- **Project:** ${row.project} | **Scope:** ${row.scope} | **Category:** ${row.category}`);
      sections.push(`- **Content:** ${row.content}`);
      if (row.tags) sections.push(`- **Tags:** ${row.tags}`);
      if (row.tech_stack) sections.push(`- **Tech Stack:** ${row.tech_stack}`);
      sections.push('');
    });
  }

  // Starter patterns section
  if (matchingPatterns.length > 0) {
    sections.push('## From Pattern Library');
    sections.push('');
    matchingPatterns.forEach((p, i) => {
      sections.push(`### ${i + 1}. ${p.name}`);
      sections.push(`- **Category:** ${p.category} | **Tech:** ${p.tech_stack.join(', ')}`);
      sections.push(`- **Description:** ${p.description}`);
      sections.push(`- **When to use:** ${p.when_to_use}`);
      sections.push(`- **Example:** \`${p.example}\``);
      sections.push('');
    });
  }

  if (learningRows.length === 0 && matchingPatterns.length === 0) {
    sections.push('No matching patterns found for this context.');
  } else {
    const total = learningRows.length + matchingPatterns.length;
    sections.push(`---`);
    sections.push(`Total suggestions: ${total} (${learningRows.length} from knowledge base, ${matchingPatterns.length} from pattern library)`);
  }

  return {
    content: [{
      type: 'text',
      text: sections.join('\n'),
    }],
  };
}

// ---------------------------------------------------------------------------
// Hybrid Search (BM25 + Vector via RRF)
// ---------------------------------------------------------------------------

/** Input shape for igris_memory_hybrid_search */
interface HybridSearchInput {
  query: string;
  project?: string;
  limit?: number;
  bm25_weight?: number;
  vector_weight?: number;
  rrf_k?: number;
}

/**
 * Hybrid search combining BM25 (FTS5) and vector KNN results via RRF.
 *
 * Falls back to BM25-only when sqlite-vec is unavailable or embedding fails.
 *
 * @param args - Search parameters including query, weights, and RRF constant
 * @returns MCP-formatted response with ranked results
 */
async function handleMemoryHybridSearch(args: HybridSearchInput): Promise<{ content: { type: string; text: string }[] }> {
  if (!args.query || args.query.length > MAX_QUERY_LENGTH) {
    return { content: [{ type: 'text', text: `Validation error: query must be 1-${MAX_QUERY_LENGTH} characters.` }] };
  }

  const db = getDb();
  const limit = args.limit ?? 10;
  const bm25Weight = args.bm25_weight ?? 0.5;
  const vectorWeight = args.vector_weight ?? 0.5;
  const k = args.rrf_k ?? 60;

  // --- 1. BM25 search via FTS5 ---
  const sanitized = sanitizeFts5Query(args.query);
  let bm25Rows: Bm25Row[] = [];

  if (sanitized) {
    // FR-109 filter: hybrid search is part of the conscious channel.
    // Pending_review rows must not surface here — only `igris_perception_*`
    // tools see them.
    let bm25Sql = `
      SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
             l.tech_stack, l.scope, l.source_brief, l.confidence,
             l.created_at, l.access_count, l.provenance, l.promoted_to_doc, rank
      FROM learnings_fts fts
      JOIN learnings l ON l.id = fts.rowid
      WHERE learnings_fts MATCH ?
        AND l.review_status = 'approved'
    `;
    const bm25Params: (string | number)[] = [sanitized];

    if (args.project) {
      bm25Sql += ' AND l.project = ?';
      bm25Params.push(args.project);
    }

    bm25Sql += ' ORDER BY rank LIMIT ?';
    bm25Params.push(limit * 2);

    try {
      bm25Rows = db.prepare(bm25Sql).all(...bm25Params) as Bm25Row[];
    } catch {
      bm25Rows = [];
    }
  }

  // --- 2. Vector search (with graceful fallback) ---
  let vecResults: VectorSearchResult[] = [];
  let vectorAvailable = false;

  try {
    if (isVectorSearchAvailable(db)) {
      const queryEmbedding = await generateEmbedding(args.query);
      vecResults = vectorSearch(db, queryEmbedding, limit * 2);
      vectorAvailable = true;

      // If project filter is set, filter vector results to matching project.
      // FR-109: always gate on review_status='approved' (whether or not the
      // caller passed a project filter) so pending_review rows are hidden
      // from the conscious channel via the vector path too.
      if (vecResults.length > 0) {
        const ids = vecResults.map(r => r.rowid);
        const placeholders = ids.map(() => '?').join(',');
        let filterSql = `SELECT id FROM learnings WHERE id IN (${placeholders}) AND review_status = 'approved'`;
        const filterParams: unknown[] = [...ids];
        if (args.project) {
          filterSql += ' AND project = ?';
          filterParams.push(args.project);
        }
        const filterRows = db.prepare(filterSql).all(...filterParams) as { id: number }[];
        const filterIdSet = new Set(filterRows.map(r => r.id));
        vecResults = vecResults.filter(r => filterIdSet.has(r.rowid));
      }
    }
  } catch (err) {
    console.error('[memory] Vector search failed, using BM25 only:', err);
  }

  // --- 3. No results at all ---
  if (bm25Rows.length === 0 && vecResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No learnings found matching "${args.query}".`,
      }],
    };
  }

  // --- 4. BM25-only fallback if vector unavailable ---
  if (!vectorAvailable || vecResults.length === 0) {
    const results = bm25Rows.slice(0, limit).map((row, i) => formatHybridResult(row, i, null, null, null));
    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} learning(s) matching "${args.query}" (BM25 only):\n\n${results.join('\n\n')}`,
      }],
    };
  }

  // --- 5. RRF merge ---
  const rrfEntries = computeRRF(bm25Rows, vecResults, bm25Weight, vectorWeight, k);
  const topEntries = rrfEntries.slice(0, limit);

  // Fetch full records for top results
  const topIds = topEntries.map(e => e.id);
  if (topIds.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No learnings found matching "${args.query}".`,
      }],
    };
  }

  const placeholders = topIds.map(() => '?').join(',');
  // TD-059: defense-in-depth `review_status='approved'` filter on the hybrid
  // search hydration path. `bm25Rows` and `vecResults` already exclude
  // pending_review rows upstream, but a future caller bypassing those filters
  // must not leak unapproved rows through this hydration step. Kept symmetric
  // with the same filter on the recall hydration query above.
  const fullRows = db.prepare(
    `SELECT id, project, category, title, content, tags, tech_stack, scope,
            source_brief, confidence, created_at, access_count, provenance,
            promoted_to_doc
     FROM learnings
     WHERE id IN (${placeholders})
       AND review_status = 'approved'`,
  ).all(...topIds) as Bm25Row[];

  // Build lookup by ID
  const rowMap = new Map<number, Bm25Row>();
  for (const row of fullRows) {
    rowMap.set(row.id, row);
  }

  // Format results in RRF order
  const results = topEntries.map((entry, i) => {
    const row = rowMap.get(entry.id);
    if (!row) return `--- Result ${i + 1} ---\nID: ${entry.id}\n(record not found)`;
    return formatHybridResult(row, i, entry.score, entry.bm25_rank, entry.vector_rank);
  });

  return {
    content: [{
      type: 'text',
      text: `Found ${results.length} learning(s) matching "${args.query}" (hybrid BM25 + vector):\n\n${results.join('\n\n')}`,
    }],
  };
}

/**
 * Format a single hybrid search result for display.
 */
function formatHybridResult(
  row: Bm25Row,
  index: number,
  rrfScore: number | null,
  bm25Rank: number | null,
  vectorRank: number | null,
): string {
  const fullContent = row.content;
  const truncated = fullContent.length > 300
    ? fullContent.substring(0, 300) + '...'
    : fullContent;

  // FR-200 M2 (one-fact-one-source): when the learning has been promoted into a
  // project-context doc, surface the doc pointer instead of re-emitting the raw
  // content. Covers BOTH hybrid_search code paths — this formatter is the sole
  // result renderer for the RRF-merged path AND the BM25-only fallback. Gate
  // matches handleMemoryRecall exactly: non-empty string => promoted.
  const promotedTo = typeof row.promoted_to_doc === 'string' && row.promoted_to_doc.length > 0
    ? row.promoted_to_doc
    : null;
  const lines = [
    `--- Result ${index + 1} ---`,
    `ID: ${row.id}`,
    `Project: ${row.project}`,
    `Category: ${row.category}`,
    `Title: ${row.title}`,
  ];
  if (promotedTo) {
    lines.push(`Promoted: → ${promotedTo} (this standard now lives in the doc; see it there)`);
  } else {
    lines.push(`Content: ${truncated}`);
  }
  lines.push(
    `Tags: ${row.tags || '(none)'}`,
    `Scope: ${row.scope}`,
    `Confidence: ${row.confidence}`,
    `Provenance: ${row.provenance}`,
  );

  if (rrfScore !== null) {
    lines.push(`RRF Score: ${rrfScore.toFixed(6)}`);
  }
  if (bm25Rank !== null) {
    lines.push(`BM25 Rank: ${bm25Rank}`);
  }
  if (vectorRank !== null) {
    lines.push(`Vector Rank: ${vectorRank}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Backfill Embeddings
// ---------------------------------------------------------------------------

/** Input shape for igris_memory_backfill_embeddings */
interface BackfillInput {
  batch_size?: number;
  project?: string;
}

/**
 * Batch-embed existing learnings that lack embeddings.
 *
 * Processes learnings where embedding IS NULL in batches, generating
 * embeddings and storing them in both the learnings.embedding column
 * and the learnings_vec virtual table.
 *
 * Resumable: only processes learnings without embeddings, so it can
 * be safely re-run after partial completion.
 *
 * @param args - Optional batch_size and project filter
 * @returns MCP-formatted response with processing summary
 */
async function handleMemoryBackfillEmbeddings(args: BackfillInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const batchSize = args.batch_size ?? 50;

  if (!isVectorSearchAvailable(db)) {
    return {
      content: [{
        type: 'text',
        text: 'Backfill skipped: sqlite-vec extension is not available. Vector search is disabled.',
      }],
    };
  }

  // INTENTIONAL: no review_status filter — backfills pending rows so they're searchable post-approval without re-embed cost
  let sql = 'SELECT id, title, content FROM learnings WHERE embedding IS NULL';
  const params: string[] = [];
  if (args.project) {
    sql += ' AND project = ?';
    params.push(args.project);
  }
  sql += ' ORDER BY id LIMIT ?';

  const learnings = db.prepare(sql).all(...params, batchSize) as { id: number; title: string; content: string }[];

  if (learnings.length === 0) {
    // Check total count to give context
    let countSql = 'SELECT COUNT(*) as total FROM learnings';
    const countParams: string[] = [];
    if (args.project) {
      countSql += ' WHERE project = ?';
      countParams.push(args.project);
    }
    const countRow = db.prepare(countSql).get(...countParams) as { total: number };

    return {
      content: [{
        type: 'text',
        text: `Backfill complete — all ${countRow.total} learnings already have embeddings.`,
      }],
    };
  }

  const startTime = Date.now();

  const { succeeded: processed, failed } = await processInBatches(
    learnings,
    async (learning) => {
      const embedding = await generateEmbedding(`${learning.title} ${learning.content}`);
      db.prepare('UPDATE learnings SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, learning.id);
      insertEmbedding(db, learning.id, embedding);
    },
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check remaining
  let remainingSql = 'SELECT COUNT(*) as remaining FROM learnings WHERE embedding IS NULL';
  const remainingParams: string[] = [];
  if (args.project) {
    remainingSql += ' AND project = ?';
    remainingParams.push(args.project);
  }
  const remainingRow = db.prepare(remainingSql).get(...remainingParams) as { remaining: number };

  return {
    content: [{
      type: 'text',
      text: `Backfill batch complete.\n\nProcessed: ${processed}\nFailed: ${failed}\nRemaining: ${remainingRow.remaining}\nTime: ${elapsed}s\n\n${remainingRow.remaining > 0 ? 'Run again to process more.' : 'All learnings now have embeddings.'}`,
    }],
  };
}

/**
 * Compute word-level Jaccard similarity between two strings.
 *
 * Splits both strings into lowercase word sets and returns the ratio
 * of intersection size to union size. Used for content similarity
 * checks during title-collision promotion.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns Similarity score between 0 and 1
 */
function wordJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 0));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 0));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Promote local learnings to global scope when they appear in 2+ projects.
 *
 * Finds learnings where scope='local' that share the same title (case-insensitive)
 * across multiple distinct projects. Requires >= 80% content similarity (Jaccard on
 * first 200 chars) before promoting, to avoid false promotions from title collisions
 * with different content.
 *
 * Called internally after storing a new learning (not an MCP tool).
 *
 * @returns The number of learnings promoted to global scope
 */
function promoteToGlobal(): number {
  const db = getDb();

  // Find titles (case-insensitive) that exist in 2+ distinct projects with
  // local scope.
  //
  // TD-060: also restrict to `review_status='approved'`. Without this filter,
  // a perception-channel `pending_review` row inserted directly via
  // `persistCandidate` (which bypasses `handleMemoryStore`'s approval guard at
  // the call site) could surface as a promotion candidate the next time any
  // OTHER `handleMemoryStore` call triggered `promoteToGlobal`. The filter
  // mirrors the symmetric one on `fetchByTitle` below — that one is what
  // actually drives the UPDATE so missing it is the live bug; this one is
  // symmetry so the candidate set never includes pending rows in the first
  // place.
  const titlesToPromote = db.prepare(`
    SELECT LOWER(title) AS lower_title
    FROM learnings
    WHERE scope = 'local'
      AND review_status = 'approved'
    GROUP BY LOWER(title)
    HAVING COUNT(DISTINCT project) >= 2
  `).all() as Record<string, unknown>[];

  if (titlesToPromote.length === 0) {
    return 0;
  }

  // For each candidate title, verify content similarity before promoting.
  // TD-060: `review_status='approved'` filter prevents pending rows from
  // being scope-flipped during promotion.
  const fetchByTitle = db.prepare(`
    SELECT id, content
    FROM learnings
    WHERE LOWER(title) = ?
      AND scope = 'local'
      AND review_status = 'approved'
  `);

  const updateStmt = db.prepare(`
    UPDATE learnings
    SET scope = 'global'
    WHERE id = ?
  `);

  let promotedCount = 0;
  const promoteAll = db.transaction((titles: Record<string, unknown>[]) => {
    for (const row of titles) {
      const lowerTitle = row.lower_title as string;
      const learnings = fetchByTitle.all(lowerTitle) as { id: number; content: string }[];

      if (learnings.length < 2) continue;

      // Check pairwise content similarity using first 200 chars
      // All pairs must meet 80% threshold for promotion
      const snippets = learnings.map(l => l.content.substring(0, 200));
      let allSimilar = true;

      for (let i = 0; i < snippets.length && allSimilar; i++) {
        for (let j = i + 1; j < snippets.length && allSimilar; j++) {
          if (wordJaccardSimilarity(snippets[i], snippets[j]) < 0.8) {
            allSimilar = false;
          }
        }
      }

      if (allSimilar) {
        for (const learning of learnings) {
          const result = updateStmt.run(learning.id);
          promotedCount += result.changes;
        }
      }
    }
  });

  promoteAll(titlesToPromote);

  return promotedCount;
}

// ---------------------------------------------------------------------------
// TD-171 M1 — igris_memory_update / igris_memory_delete / igris_memory_dashboard
// ---------------------------------------------------------------------------
//
// Three new tools added in TD-171 M1 against the existing learnings table.
// No schema migration is needed: the `updated_at` column has been part of
// the `learnings` table since db.ts v1 and is already declared in
// `SYNC_TABLES.learnings.columns` (`tools/sync.ts`). The component-level
// `memory/schema.ts` is intentionally NOT created — per L-142 we only add
// per-component schema files when there is a real migration to own.
//
// Dashboard output shape is the CANONICAL `_dashboard` shape that TD-171
// M2 (graph), M3 (project/perception/error), and M4 (goal/metrics) MUST
// mirror. Layout:
//   { totals: { total, by_<dimension>: { ... } },
//     recent: { last_n_days, stored, top_tags },
//     samples: [...] (omitted when summary_only=true)
//   }
//
// `_update` and `_delete` use parameterized queries throughout (security §7
// of coding_guidelines). Provenance is intentionally NOT updatable — flipping
// provenance after extraction breaks the audit trail (FR-107). Callers wanting
// to "fix" a wrong provenance must `_delete` and `_store` afresh.

/** Input shape for igris_memory_update */
interface MemoryUpdateInput {
  id: number;
  title?: string;
  content?: string;
  tags?: string;
  category?: 'pattern' | 'decision' | 'discovery' | 'mistake' | 'optimization';
  scope?: 'local' | 'global';
  confidence?: number;
}

/** Input shape for igris_memory_delete */
interface MemoryDeleteInput {
  id: number;
  reason?: string;
}

/** Input shape for igris_memory_dashboard */
interface MemoryDashboardInput {
  project?: string;
  summary_only?: boolean;
  days?: number;
}

/**
 * Update mutable fields of an existing learning (TD-171 M1).
 *
 * Only the fields listed in `MemoryUpdateInput` are updatable: title,
 * content, tags, category, scope, confidence. Provenance, review_status,
 * source_extractor, source_brief, project, tech_stack, created_at,
 * access_count, last_accessed_at, embedding, embedding_model,
 * seen_again_count, and last_seen_at are immutable through this surface
 * by design — they are either audit fields, lifecycle fields owned by
 * other tools (e.g. perception_approve flips review_status), or
 * derived telemetry. Callers wanting to "rewrite history" of any of
 * those fields must `_delete` + `_store` afresh.
 *
 * Bumps `updated_at` to the current ISO timestamp on every successful
 * update. `_update` is idempotent in the sense that updating with no
 * fields beyond `id` is a no-op error (caller passed a stub).
 *
 * Returns a JSON payload `{ id, updated_fields: [...], updated_at }` so
 * callers can confirm exactly which fields changed.
 *
 * @param args - The learning ID + optional new field values
 * @returns MCP-formatted response with the update summary
 */
function handleMemoryUpdate(args: MemoryUpdateInput): { content: { type: string; text: string }[] } {
  // Validate id
  if (typeof args.id !== 'number' || !Number.isInteger(args.id) || args.id <= 0) {
    return { content: [{ type: 'text', text: 'Validation error: id must be a positive integer.' }] };
  }

  // Validate enum-typed fields when present
  if (args.category !== undefined && !VALID_CATEGORIES.includes(args.category)) {
    return {
      content: [{
        type: 'text',
        text: `Validation error: category must be one of ${VALID_CATEGORIES.join(', ')}.`,
      }],
    };
  }
  if (args.scope !== undefined && args.scope !== 'local' && args.scope !== 'global') {
    return {
      content: [{ type: 'text', text: 'Validation error: scope must be "local" or "global".' }],
    };
  }
  if (args.confidence !== undefined) {
    if (typeof args.confidence !== 'number' || args.confidence < 0 || args.confidence > 1) {
      return {
        content: [{ type: 'text', text: 'Validation error: confidence must be a number between 0 and 1.' }],
      };
    }
  }
  if (args.title !== undefined && (args.title.length === 0 || args.title.length > MAX_TITLE_LENGTH)) {
    return {
      content: [{
        type: 'text',
        text: `Validation error: title must be 1-${MAX_TITLE_LENGTH} characters.`,
      }],
    };
  }
  if (args.content !== undefined && (args.content.length === 0 || args.content.length > MAX_CONTENT_LENGTH)) {
    return {
      content: [{
        type: 'text',
        text: `Validation error: content must be 1-${MAX_CONTENT_LENGTH} characters (1 MB max).`,
      }],
    };
  }

  const db = getDb();

  // Verify the row exists before any UPDATE (so the caller gets a clear
  // "not found" instead of a silent zero-rows-changed).
  const existing = db
    .prepare('SELECT id FROM learnings WHERE id = ?')
    .get(args.id) as { id: number } | undefined;
  if (!existing) {
    return { content: [{ type: 'text', text: `Learning with ID ${args.id} not found.` }] };
  }

  // Build dynamic SET clause. Only set fields the caller explicitly passed.
  const setClauses: string[] = [];
  const params: unknown[] = [];
  const updatedFields: string[] = [];

  if (args.title !== undefined) {
    setClauses.push('title = ?');
    params.push(args.title);
    updatedFields.push('title');
  }
  if (args.content !== undefined) {
    setClauses.push('content = ?');
    params.push(args.content);
    updatedFields.push('content');
  }
  if (args.tags !== undefined) {
    setClauses.push('tags = ?');
    params.push(args.tags);
    updatedFields.push('tags');
  }
  if (args.category !== undefined) {
    setClauses.push('category = ?');
    params.push(args.category);
    updatedFields.push('category');
  }
  if (args.scope !== undefined) {
    setClauses.push('scope = ?');
    params.push(args.scope);
    updatedFields.push('scope');
  }
  if (args.confidence !== undefined) {
    setClauses.push('confidence = ?');
    params.push(args.confidence);
    updatedFields.push('confidence');
  }

  if (setClauses.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'Validation error: no updatable fields provided. At least one of title/content/tags/category/scope/confidence must be set.',
      }],
    };
  }

  // Always bump updated_at to a fresh ISO timestamp. Using ISO 8601 (UTC)
  // for cross-machine consistency in sync_state — `created_at` defaults to
  // SQLite's `datetime('now')` which is also UTC, so the formats stay
  // comparable for LWW resolution.
  const updatedAt = new Date().toISOString();
  setClauses.push('updated_at = ?');
  params.push(updatedAt);

  // Final param: the WHERE id
  params.push(args.id);

  const sql = `UPDATE learnings SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...params);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ id: args.id, updated_fields: updatedFields, updated_at: updatedAt }, null, 2),
    }],
  };
}

/**
 * Hard-delete a learning by ID (TD-171 M1).
 *
 * Mirrors `igris_perception_reject`'s hard-DELETE semantics — there is no
 * soft-delete column on `learnings` (FR-116 may add one in the future; if
 * it does, this handler should switch to UPDATE rather than DELETE). The
 * delete cascades to:
 *   - `learnings_fts` (via the kept `learnings_ad` AFTER DELETE trigger).
 *   - `learnings_vec` (NOT cascaded — the `learnings_vec_ad` trigger was
 *     dropped in TD-098 because sqlite-vec rejects writes to vec0 virtual
 *     tables from inside trigger context under `PRAGMA trusted_schema = OFF`).
 *     Vec orphans are tolerable here: the `igris_memory_recall` and
 *     `_hybrid_search` paths re-hydrate from `learnings` and discard any
 *     vec hit whose `learnings.id` doesn't resolve. A future janitor pass
 *     can reap orphans if they accumulate. We do NOT mirror perception's
 *     transactional vec cleanup here because conscious-channel deletes are
 *     rare (a manual operator decision) — the complexity-vs-orphan trade
 *     favours the simpler path.
 *
 * Emits a `memory.deleted` bus event (wired in `engine/components/memory/index.ts`)
 * so future subscribers (e.g., a sync auto-push or audit log) can react.
 * Deletion is unconditional — we do NOT refuse to delete approved or
 * pending_review learnings; the operator decision-trigger entry in
 * brain_stewardship.md is the gate.
 *
 * Returns `{ deleted: true, id, reason }` JSON.
 *
 * @param args - The learning ID and optional reason for the audit log
 * @returns MCP-formatted response with the deletion summary
 */
function handleMemoryDelete(args: MemoryDeleteInput): { content: { type: string; text: string }[] } {
  if (typeof args.id !== 'number' || !Number.isInteger(args.id) || args.id <= 0) {
    return { content: [{ type: 'text', text: 'Validation error: id must be a positive integer.' }] };
  }

  const db = getDb();

  const existing = db
    .prepare('SELECT id, title FROM learnings WHERE id = ?')
    .get(args.id) as { id: number; title: string } | undefined;
  if (!existing) {
    return { content: [{ type: 'text', text: `Learning with ID ${args.id} not found.` }] };
  }

  db.prepare('DELETE FROM learnings WHERE id = ?').run(args.id);

  const reason = typeof args.reason === 'string' ? args.reason : '';

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ deleted: true, id: args.id, title: existing.title, reason }, null, 2),
    }],
  };
}

/**
 * Aggregate counts + recent stats over the learnings table (TD-171 M1).
 *
 * CANONICAL `_dashboard` shape — TD-171 M2/M3/M4 dashboards MUST mirror this
 * structure. Output:
 *   {
 *     totals: {
 *       total: N,
 *       by_category: { pattern: N, decision: N, ... },
 *       by_scope: { local: N, global: N },
 *       by_provenance: { observed: N, inferred: N, synthesized: N, ambiguous: N, human_asserted: N },
 *       by_review_status: { pending_review: N, approved: N }
 *     },
 *     recent: {
 *       last_n_days: <days>,
 *       stored: N,
 *       top_tags: [{ tag, count }, ...]
 *     },
 *     samples: [{ id, title, category, scope, created_at }, ...]   // omitted when summary_only=true
 *   }
 *
 * `pending_review` rows ARE memory data and DO appear in `by_review_status`
 * — they are the same `learnings` table, just gated from default recall.
 * `_dashboard` is unfiltered by review_status by design (you are sizing the
 * full memory footprint, not just the conscious channel). Per L-152 framing,
 * perception-engine-specific stats (run outcomes, dedup rediscoveries) are
 * NOT included here — those belong in M3's `igris_perception_dashboard`.
 *
 * Optional filters:
 *   - `project`: scope all aggregations (totals + recent + samples) to a
 *     single project. Omitted = cross-project.
 *   - `days`: window for `recent.stored` and top-tags. Default 30. Must be
 *     a non-negative number; 0 = "today only".
 *   - `summary_only`: when true, omit the `samples` array. Counts are still
 *     fully computed.
 *
 * @param args - Optional filters
 * @returns MCP-formatted response with the dashboard JSON
 */
function handleMemoryDashboard(args: MemoryDashboardInput): { content: { type: string; text: string }[] } {
  const days = args.days !== undefined ? Number(args.days) : 30;
  if (!Number.isFinite(days) || days < 0) {
    return { content: [{ type: 'text', text: 'Validation error: days must be a non-negative number.' }] };
  }
  const summaryOnly = args.summary_only === true;
  const projectFilter = typeof args.project === 'string' && args.project.length > 0 ? args.project : null;

  const db = getDb();

  // Build a project-filter fragment we can splice into each aggregation.
  // Parameterized — no string interpolation of project name.
  const projectWhere = projectFilter ? 'WHERE project = ?' : '';
  const projectParams: string[] = projectFilter ? [projectFilter] : [];

  // --- totals.total ---
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM learnings ${projectWhere}`)
    .get(...projectParams) as { n: number };

  // --- totals.by_category ---
  const categoryRows = db
    .prepare(`SELECT category, COUNT(*) AS n FROM learnings ${projectWhere} GROUP BY category`)
    .all(...projectParams) as { category: string; n: number }[];
  const byCategory: Record<string, number> = {};
  for (const c of VALID_CATEGORIES) byCategory[c] = 0;
  for (const r of categoryRows) byCategory[r.category] = r.n;

  // --- totals.by_scope ---
  const scopeRows = db
    .prepare(`SELECT scope, COUNT(*) AS n FROM learnings ${projectWhere} GROUP BY scope`)
    .all(...projectParams) as { scope: string; n: number }[];
  const byScope: Record<string, number> = { local: 0, global: 0 };
  for (const r of scopeRows) byScope[r.scope] = r.n;

  // --- totals.by_provenance ---
  const provRows = db
    .prepare(`SELECT provenance, COUNT(*) AS n FROM learnings ${projectWhere} GROUP BY provenance`)
    .all(...projectParams) as { provenance: string; n: number }[];
  const byProvenance: Record<string, number> = {};
  for (const p of VALID_LEARNING_PROVENANCE) byProvenance[p] = 0;
  for (const r of provRows) byProvenance[r.provenance] = r.n;

  // --- totals.by_review_status ---
  const reviewRows = db
    .prepare(`SELECT review_status, COUNT(*) AS n FROM learnings ${projectWhere} GROUP BY review_status`)
    .all(...projectParams) as { review_status: string; n: number }[];
  const byReviewStatus: Record<string, number> = { pending_review: 0, approved: 0 };
  for (const r of reviewRows) byReviewStatus[r.review_status] = r.n;

  // --- recent.stored (last `days` window) ---
  // SQLite `datetime('now', '-N days')` honours fractional days. `days = 0`
  // resolves to "now" so the window is empty — useful for an "any rows
  // logged today only" sanity probe (rows with created_at >= now() are
  // future-dated and shouldn't exist).
  const recentSql = projectFilter
    ? `SELECT COUNT(*) AS n FROM learnings WHERE project = ? AND created_at >= datetime('now', ?)`
    : `SELECT COUNT(*) AS n FROM learnings WHERE created_at >= datetime('now', ?)`;
  const recentParams: (string | number)[] = projectFilter
    ? [projectFilter, `-${days} days`]
    : [`-${days} days`];
  const recentRow = db.prepare(recentSql).get(...recentParams) as { n: number };

  // --- recent.top_tags ---
  // Tags are stored as a single comma-separated string. We split in TS
  // rather than relying on a SQLite extension. Cap the scan to reasonable
  // size to keep the dashboard fast on large DBs (project filter applies).
  const tagSql = projectFilter
    ? `SELECT tags FROM learnings WHERE project = ? AND created_at >= datetime('now', ?) AND tags IS NOT NULL AND tags <> ''`
    : `SELECT tags FROM learnings WHERE created_at >= datetime('now', ?) AND tags IS NOT NULL AND tags <> ''`;
  const tagParams: (string | number)[] = projectFilter
    ? [projectFilter, `-${days} days`]
    : [`-${days} days`];
  const tagRows = db.prepare(tagSql).all(...tagParams) as { tags: string }[];
  const tagCounts = new Map<string, number>();
  for (const r of tagRows) {
    const split = r.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    for (const t of split) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  // --- samples (omitted when summary_only) ---
  let samples: Record<string, unknown>[] = [];
  if (!summaryOnly) {
    const sampleSql = projectFilter
      ? `SELECT id, project, title, category, scope, provenance, review_status, created_at
         FROM learnings WHERE project = ? ORDER BY created_at DESC LIMIT 20`
      : `SELECT id, project, title, category, scope, provenance, review_status, created_at
         FROM learnings ORDER BY created_at DESC LIMIT 20`;
    samples = db.prepare(sampleSql).all(...projectParams) as Record<string, unknown>[];
  }

  const result: Record<string, unknown> = {
    totals: {
      total: totalRow.n,
      by_category: byCategory,
      by_scope: byScope,
      by_provenance: byProvenance,
      by_review_status: byReviewStatus,
    },
    recent: {
      last_n_days: days,
      stored: recentRow.n,
      top_tags: topTags,
    },
  };
  if (!summaryOnly) {
    result.samples = samples;
  }
  if (projectFilter) {
    result.project = projectFilter;
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

export {
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
  promoteToGlobal,
  wordJaccardSimilarity,
  computeTechStackOverlap,
};
export type {
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
};
