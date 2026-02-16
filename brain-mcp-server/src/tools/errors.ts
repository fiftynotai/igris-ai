/**
 * Igris Brain — Error Tools
 *
 * Provides error fingerprinting, solution storage, and lookup.
 * Normalizes error messages to create stable fingerprints that match
 * across different file paths, line numbers, and hex addresses.
 *
 * Tools:
 * - igris_error_lookup: Look up or store error solutions
 *
 * @module tools/errors
 * @author Fifty.ai
 */

import { getDb } from '../db.js';

/**
 * Sanitize a string for use in FTS5 MATCH queries.
 */
function sanitizeFts5Query(input: string): string {
  const cleaned = input.replace(/[",():*+\-^]/g, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

/** Input shape for igris_error_lookup */
interface ErrorLookupInput {
  message: string;
  project: string;
  solution?: string;
}

/**
 * Create a simple numeric hash from a string.
 * No cryptographic guarantees -- just deterministic fingerprinting.
 *
 * @param str - The string to hash
 * @returns A base-36 string representation of the hash
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalize an error message for fingerprinting.
 *
 * Strips file paths, line/column numbers, hex addresses, and long hashes
 * so that the same logical error produces the same fingerprint regardless
 * of which file or line it occurred on.
 *
 * @param message - Raw error message
 * @returns Normalized message string
 */
function normalizeErrorMessage(message: string): string {
  return message
    .replace(/\/[\w/.-]+/g, '<path>')
    .replace(/:\d+:\d+/g, ':<line>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{6,}\b/gi, '<hash>');
}

/**
 * Create a fingerprint for an error message.
 *
 * @param message - Raw error message
 * @returns Fingerprint string
 */
function createFingerprint(message: string): string {
  const normalized = normalizeErrorMessage(message);
  return simpleHash(normalized);
}

/**
 * Look up or store an error solution.
 *
 * When `solution` is provided, upserts the error record (inserts new or
 * increments occurrence_count and updates the solution for existing).
 * When no solution is provided, searches by fingerprint first, then
 * falls back to FTS5 full-text search.
 *
 * @param args - Error lookup parameters
 * @returns MCP-formatted response with results
 */
function handleErrorLookup(args: ErrorLookupInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const fingerprint = createFingerprint(args.message);

  if (args.solution) {
    // Upsert mode: store or update the error solution
    const existing = db.prepare(
      'SELECT id, occurrence_count FROM errors WHERE fingerprint = ? AND project = ?'
    ).get(fingerprint, args.project) as { id: number; occurrence_count: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE errors
        SET solution = ?,
            occurrence_count = occurrence_count + 1,
            last_seen_at = datetime('now')
        WHERE id = ?
      `).run(args.solution, existing.id);

      return {
        content: [{
          type: 'text',
          text: `Error solution updated.\n\nID: ${existing.id}\nFingerprint: ${fingerprint}\nOccurrences: ${existing.occurrence_count + 1}\nSolution: ${args.solution}`,
        }],
      };
    } else {
      const result = db.prepare(`
        INSERT INTO errors (project, fingerprint, message, solution)
        VALUES (?, ?, ?, ?)
      `).run(args.project, fingerprint, args.message, args.solution);

      return {
        content: [{
          type: 'text',
          text: `Error solution stored.\n\nID: ${result.lastInsertRowid}\nFingerprint: ${fingerprint}\nProject: ${args.project}\nSolution: ${args.solution}`,
        }],
      };
    }
  }

  // Lookup mode: search for matching error solutions

  // First try exact fingerprint match
  const exactMatch = db.prepare(`
    SELECT id, project, fingerprint, message, solution, context, occurrence_count,
           first_seen_at, last_seen_at, resolved_at
    FROM errors
    WHERE fingerprint = ?
    ORDER BY occurrence_count DESC
    LIMIT 5
  `).all(fingerprint) as Record<string, unknown>[];

  if (exactMatch.length > 0) {
    const results = exactMatch.map((row, i) => {
      return [
        `--- Match ${i + 1} (fingerprint) ---`,
        `ID: ${row.id}`,
        `Project: ${row.project}`,
        `Message: ${row.message}`,
        `Solution: ${row.solution || '(no solution recorded)'}`,
        `Occurrences: ${row.occurrence_count}`,
        `First Seen: ${row.first_seen_at}`,
        `Last Seen: ${row.last_seen_at}`,
        `Resolved: ${row.resolved_at || 'No'}`,
      ].join('\n');
    });

    return {
      content: [{
        type: 'text',
        text: `Found ${exactMatch.length} matching error(s) by fingerprint:\n\n${results.join('\n\n')}`,
      }],
    };
  }

  // Fallback to FTS5 search
  const ftsResults = db.prepare(`
    SELECT e.id, e.project, e.fingerprint, e.message, e.solution, e.context,
           e.occurrence_count, e.first_seen_at, e.last_seen_at, e.resolved_at,
           rank
    FROM errors_fts fts
    JOIN errors e ON e.id = fts.rowid
    WHERE errors_fts MATCH ?
    ORDER BY rank
    LIMIT 5
  `).all(sanitizeFts5Query(args.message)) as Record<string, unknown>[];

  if (ftsResults.length > 0) {
    const results = ftsResults.map((row, i) => {
      return [
        `--- Match ${i + 1} (FTS) ---`,
        `ID: ${row.id}`,
        `Project: ${row.project}`,
        `Message: ${row.message}`,
        `Solution: ${row.solution || '(no solution recorded)'}`,
        `Occurrences: ${row.occurrence_count}`,
        `Rank: ${row.rank}`,
      ].join('\n');
    });

    return {
      content: [{
        type: 'text',
        text: `Found ${ftsResults.length} similar error(s) via full-text search:\n\n${results.join('\n\n')}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `No matching error found.\n\nFingerprint searched: ${fingerprint}\nMessage: ${args.message}\n\nTo store a solution for this error, call igris_error_lookup again with the "solution" parameter.`,
    }],
  };
}

export { handleErrorLookup };
export type { ErrorLookupInput };
