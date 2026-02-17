/**
 * Igris Brain — Memory Tools
 *
 * Provides persistent learning storage, full-text search, and contextual
 * recall across projects. Backed by SQLite FTS5 for relevance-ranked retrieval.
 *
 * Tools:
 * - igris_memory_store: Store a learning in the knowledge DB
 * - igris_memory_search: Full-text search across learnings
 * - igris_memory_recall: Contextual retrieval for current project + global
 * - igris_pattern_suggest: Suggest relevant patterns for current context
 *
 * Internal functions:
 * - promoteToGlobal: Auto-promote local learnings to global when found in 2+ projects
 *
 * @module tools/memory
 * @author Fifty.ai
 */

import { getDb, BRAIN_DIR } from '../db.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Sanitize a string for use in FTS5 MATCH queries.
 * FTS5 treats characters like commas, colons, parentheses, and quotes as
 * operators. This function strips them and joins words with spaces so FTS5
 * treats the input as a simple OR query of individual tokens.
 */
function sanitizeFts5Query(input: string): string {
  // Remove FTS5 special characters: " ( ) * : , + - ^
  const cleaned = input.replace(/[",():*+\-^]/g, ' ');
  // Collapse whitespace and trim
  return cleaned.replace(/\s+/g, ' ').trim();
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
}

/** Input shape for igris_memory_search */
interface MemorySearchInput {
  query: string;
  project?: string;
  scope?: 'local' | 'global';
  limit?: number;
}

/** Input shape for igris_memory_recall */
interface MemoryRecallInput {
  project: string;
  context: string;
  limit?: number;
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
  return null;
}

function handleMemoryStore(args: MemoryStoreInput): { content: { type: string; text: string }[] } {
  const validationError = validateMemoryInput(args);
  if (validationError) {
    return { content: [{ type: 'text', text: `Validation error: ${validationError}` }] };
  }

  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO learnings (project, category, title, content, tags, tech_stack, source_brief, scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    args.project,
    args.category,
    args.title,
    args.content,
    args.tags ?? '',
    args.tech_stack ?? '',
    args.source_brief ?? '',
    args.scope ?? 'local'
  );

  // After storing, check if any local learnings should be promoted to global
  const promoted = promoteToGlobal();
  const promotedNote = promoted > 0 ? `\nAuto-promoted: ${promoted} learning(s) to global scope` : '';

  return {
    content: [{
      type: 'text',
      text: `Learning stored successfully.\n\nID: ${result.lastInsertRowid}\nProject: ${args.project}\nCategory: ${args.category}\nTitle: ${args.title}\nScope: ${args.scope ?? 'local'}${promotedNote}`,
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

  let sql = `
    SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
           l.tech_stack, l.scope, l.source_brief, l.confidence,
           l.created_at, l.access_count,
           rank
    FROM learnings_fts fts
    JOIN learnings l ON l.id = fts.rowid
    WHERE learnings_fts MATCH ?
  `;

  const params: (string | number)[] = [sanitizeFts5Query(args.query)];

  if (args.project) {
    sql += ' AND l.project = ?';
    params.push(args.project);
  }

  if (args.scope === 'global') {
    sql += " AND l.scope = 'global'";
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

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
    return [
      `--- Result ${i + 1} ---`,
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
      `Created: ${row.created_at}`,
      `Access Count: ${row.access_count}`,
      `Rank: ${row.rank}`,
    ].join('\n');
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
 * Retrieves project-local learnings matching the context via FTS5,
 * combined with global-scope learnings. Increments access_count and
 * updates last_accessed_at for returned results.
 *
 * @param args - Recall parameters with project and context
 * @returns MCP-formatted response with relevant learnings
 */
function handleMemoryRecall(args: MemoryRecallInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const limit = args.limit ?? 5;

  // Combine project-local and global learnings matching context
  const sql = `
    SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
           l.tech_stack, l.scope, l.source_brief, l.confidence,
           l.created_at, l.access_count,
           rank
    FROM learnings_fts fts
    JOIN learnings l ON l.id = fts.rowid
    WHERE learnings_fts MATCH ?
      AND (l.project = ? OR l.scope = 'global')
    ORDER BY rank
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(sanitizeFts5Query(args.context), args.project, limit) as Record<string, unknown>[];

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No relevant learnings found for project "${args.project}" with context "${args.context}".`,
      }],
    };
  }

  // Update access counts for returned results
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

  updateAll(rows.map(r => r.id));

  const results = rows.map((row, i) => {
    return [
      `--- Recall ${i + 1} ---`,
      `ID: ${row.id}`,
      `Project: ${row.project}`,
      `Category: ${row.category}`,
      `Title: ${row.title}`,
      `Content: ${row.content}`,
      `Tags: ${row.tags || '(none)'}`,
      `Scope: ${row.scope}`,
      `Confidence: ${row.confidence}`,
      `Rank: ${row.rank}`,
    ].join('\n');
  });

  return {
    content: [{
      type: 'text',
      text: `Recalled ${rows.length} relevant learning(s) for "${args.project}":\n\n${results.join('\n\n')}`,
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
  let learningSql = `
    SELECT l.id, l.project, l.category, l.title, l.content, l.tags,
           l.tech_stack, l.scope, l.confidence, l.access_count,
           rank
    FROM learnings_fts fts
    JOIN learnings l ON l.id = fts.rowid
    WHERE learnings_fts MATCH ?
      AND (l.project = ? OR l.scope = 'global')
  `;
  const learningParams: (string | number)[] = [sanitizeFts5Query(args.context), args.project];

  if (args.tech_stack) {
    learningSql += ' AND l.tech_stack LIKE ?';
    learningParams.push(`%${args.tech_stack}%`);
  }

  learningSql += ' ORDER BY rank LIMIT 10';

  let learningRows: Record<string, unknown>[] = [];
  try {
    learningRows = db.prepare(learningSql).all(...learningParams) as Record<string, unknown>[];
  } catch (_err) {
    // FTS5 match may fail on certain query syntax; treat as no results
    learningRows = [];
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

/**
 * Promote local learnings to global scope when they appear in 2+ projects.
 *
 * Finds learnings where scope='local' that share the same title across
 * multiple distinct projects. Updates their scope to 'global'.
 *
 * Called internally after storing a new learning (not an MCP tool).
 *
 * @returns The number of learnings promoted to global scope
 */
function promoteToGlobal(): number {
  const db = getDb();

  // Find titles that exist in 2+ distinct projects with local scope
  const titlesToPromote = db.prepare(`
    SELECT title
    FROM learnings
    WHERE scope = 'local'
    GROUP BY title
    HAVING COUNT(DISTINCT project) >= 2
  `).all() as Record<string, unknown>[];

  if (titlesToPromote.length === 0) {
    return 0;
  }

  const updateStmt = db.prepare(`
    UPDATE learnings
    SET scope = 'global'
    WHERE title = ? AND scope = 'local'
  `);

  let promotedCount = 0;
  const promoteAll = db.transaction((titles: Record<string, unknown>[]) => {
    for (const row of titles) {
      const result = updateStmt.run(row.title as string);
      promotedCount += result.changes;
    }
  });

  promoteAll(titlesToPromote);

  return promotedCount;
}

export { handleMemoryStore, handleMemorySearch, handleMemoryRecall, handlePatternSuggest, promoteToGlobal };
export type { MemoryStoreInput, MemorySearchInput, MemoryRecallInput, PatternSuggestInput };
