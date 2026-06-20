/**
 * Igris Brain — Registry Tools
 *
 * Provides CRUD for reusable templates and modules in the brain's registry.
 * Entries use GitHub URLs as primary paths, with optional local fallback.
 *
 * Tools:
 * - igris_registry_add: Register a template or module
 * - igris_registry_search: Search registry by keyword, type, framework, archetype
 * - igris_registry_get: Get full details of a registry entry
 * - igris_registry_list: List entries with optional filters
 * - igris_registry_remove: Soft-delete or hard-delete an entry
 * - igris_registry_update: Partial update of an existing entry
 *
 * @module tools/registry
 * @author fifty.dev
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { sanitizeFts5Query } from '../utils/fts5.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input shape for igris_registry_add */
export interface RegistryAddInput {
  id?: string;
  name: string;
  type: 'template' | 'module';
  archetype?: string;
  framework?: string;
  github_repo: string;
  github_path?: string;
  github_branch?: string;
  description?: string;
  install_command?: string;
  standalone?: boolean;
  parent_template?: string;
  tags?: string;
  rebrand_checklist?: string;
  source_project?: string;
  status?: 'available' | 'deprecated' | 'draft';
  // FR-198 asset-reference columns (the "lego" catalog generalization)
  when_to_use?: string;
  source?: string;
  source_ref?: string;
}

/** Input shape for igris_registry_search */
export interface RegistrySearchInput {
  query: string;
  type?: 'template' | 'module';
  framework?: string;
  archetype?: string;
  limit?: number;
}

/** Input shape for igris_registry_get */
export interface RegistryGetInput {
  id: string;
}

/** Input shape for igris_registry_list */
export interface RegistryListInput {
  type?: 'template' | 'module';
  archetype?: string;
  framework?: string;
  status?: 'available' | 'deprecated' | 'draft';
  limit?: number;
}

/** Input shape for igris_registry_remove */
export interface RegistryRemoveInput {
  id: string;
  hard_delete?: boolean;
}

/** Input shape for igris_registry_update */
export interface RegistryUpdateInput {
  id: string;
  name?: string;
  type?: 'template' | 'module';
  archetype?: string;
  framework?: string;
  github_repo?: string;
  github_path?: string;
  github_branch?: string;
  description?: string;
  install_command?: string;
  standalone?: boolean;
  parent_template?: string;
  tags?: string;
  rebrand_checklist?: string;
  source_project?: string;
  status?: 'available' | 'deprecated' | 'draft';
  // FR-198 asset-reference columns
  when_to_use?: string;
  source?: string;
  source_ref?: string;
}

/** Row shape from registry table */
interface RegistryRow {
  id: string;
  name: string;
  type: string;
  archetype: string | null;
  framework: string | null;
  github_repo: string;
  github_path: string | null;
  github_branch: string;
  description: string | null;
  install_command: string | null;
  standalone: number;
  parent_template: string | null;
  tags: string;
  rebrand_checklist: string | null;
  source_project: string | null;
  status: string;
  // FR-198 asset-reference columns (nullable on all pre-FR-198 rows)
  when_to_use: string | null;
  source: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a registry entry for MCP output.
 */
function formatEntry(row: RegistryRow): string {
  const lines = [
    `ID: ${row.id}`,
    `Name: ${row.name}`,
    `Type: ${row.type}`,
    `Archetype: ${row.archetype ?? '(none)'}`,
    `Framework: ${row.framework ?? '(none)'}`,
    `GitHub: ${row.github_repo}${row.github_path ? `/${row.github_path}` : ''}`,
    `Branch: ${row.github_branch}`,
    `Source: ${row.source ?? '(none)'}${row.source_ref ? ` (${row.source_ref})` : ''}`,
    `Description: ${row.description ?? '(none)'}`,
    `When to use: ${row.when_to_use ?? '(none)'}`,
    `Install: ${row.install_command ?? '(none)'}`,
    `Standalone: ${row.standalone ? 'yes' : 'no'}`,
    `Parent Template: ${row.parent_template ?? '(none)'}`,
    `Tags: ${row.tags}`,
    `Source Project: ${row.source_project ?? '(none)'}`,
    `Status: ${row.status}`,
    `Created: ${row.created_at}`,
    `Updated: ${row.updated_at}`,
  ];
  if (row.rebrand_checklist) {
    lines.push(`Rebrand Checklist: ${row.rebrand_checklist}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Register a template or module in the registry.
 *
 * @param args - Registry entry data
 * @returns MCP-formatted response with the created entry
 */
function handleRegistryAdd(args: RegistryAddInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const id = args.id ?? randomUUID();

  // Check for duplicate ID
  const existing = db.prepare('SELECT id FROM registry WHERE id = ?').get(id) as { id: string } | undefined;
  if (existing) {
    return {
      content: [{
        type: 'text',
        text: `Error: Registry entry with ID "${id}" already exists. Use a different ID or remove the existing entry first.`,
      }],
    };
  }

  db.prepare(`
    INSERT INTO registry (id, name, type, archetype, framework, github_repo, github_path,
      github_branch, description, install_command, standalone, parent_template,
      tags, rebrand_checklist, source_project, status,
      when_to_use, source, source_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    args.name,
    args.type,
    args.archetype ?? null,
    args.framework ?? null,
    args.github_repo,
    args.github_path ?? null,
    args.github_branch ?? 'main',
    args.description ?? null,
    args.install_command ?? null,
    args.standalone !== false ? 1 : 0,
    args.parent_template ?? null,
    args.tags ?? '[]',
    args.rebrand_checklist ?? null,
    args.source_project ?? null,
    args.status ?? 'available',
    args.when_to_use ?? null,
    args.source ?? null,
    args.source_ref ?? null,
  );

  const row = db.prepare('SELECT * FROM registry WHERE id = ?').get(id) as RegistryRow;

  return {
    content: [{
      type: 'text',
      text: `Registry entry added successfully.\n\n${formatEntry(row)}`,
    }],
  };
}

/**
 * Search the registry by keyword with optional filters.
 *
 * Uses FTS5 for keyword matching on name, description, tags, and framework.
 * Additional filters narrow results by type, framework, and archetype.
 *
 * @param args - Search parameters
 * @returns MCP-formatted response with matching entries
 */
function handleRegistrySearch(args: RegistrySearchInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const limit = args.limit ?? 10;

  const sanitized = sanitizeFts5Query(args.query);
  if (!sanitized) {
    return {
      content: [{
        type: 'text',
        text: `No registry entries found for query "${args.query}".`,
      }],
    };
  }

  // FTS5 search joined with registry table for filtering
  let sql = `
    SELECT r.*
    FROM registry_fts fts
    JOIN registry r ON r.rowid = fts.rowid
    WHERE registry_fts MATCH ?
      AND r.status = 'available'
  `;
  const params: (string | number)[] = [sanitized];

  if (args.type) {
    sql += ' AND r.type = ?';
    params.push(args.type);
  }
  if (args.framework) {
    sql += ' AND r.framework = ?';
    params.push(args.framework);
  }
  if (args.archetype) {
    sql += ' AND r.archetype = ?';
    params.push(args.archetype);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  let rows: RegistryRow[];
  try {
    rows = db.prepare(sql).all(...params) as RegistryRow[];
  } catch (err) {
    console.error('[registry] FTS5 search error:', err);
    rows = [];
  }

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No registry entries found for query "${args.query}".`,
      }],
    };
  }

  const entries = rows.map((row, i) => `### ${i + 1}. ${row.name}\n${formatEntry(row)}`);

  return {
    content: [{
      type: 'text',
      text: `# Registry Search Results\n\nFound ${rows.length} entries for "${args.query}"\n\n${entries.join('\n\n---\n\n')}`,
    }],
  };
}

/**
 * Get full details of a single registry entry.
 *
 * @param args - Entry ID
 * @returns MCP-formatted response with entry details
 */
function handleRegistryGet(args: RegistryGetInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  const row = db.prepare('SELECT * FROM registry WHERE id = ?').get(args.id) as RegistryRow | undefined;

  if (!row) {
    return {
      content: [{
        type: 'text',
        text: `Registry entry "${args.id}" not found.`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `# Registry Entry: ${row.name}\n\n${formatEntry(row)}`,
    }],
  };
}

/**
 * List registry entries with optional filters.
 *
 * @param args - Filter parameters
 * @returns MCP-formatted response with entry list
 */
function handleRegistryList(args: RegistryListInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const limit = args.limit ?? 25;
  const status = args.status ?? 'available';

  let sql = 'SELECT * FROM registry WHERE status = ?';
  const params: (string | number)[] = [status];

  if (args.type) {
    sql += ' AND type = ?';
    params.push(args.type);
  }
  if (args.archetype) {
    sql += ' AND archetype = ?';
    params.push(args.archetype);
  }
  if (args.framework) {
    sql += ' AND framework = ?';
    params.push(args.framework);
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as RegistryRow[];

  if (rows.length === 0) {
    const filters = [
      args.type ? `type=${args.type}` : '',
      args.archetype ? `archetype=${args.archetype}` : '',
      args.framework ? `framework=${args.framework}` : '',
      `status=${status}`,
    ].filter(Boolean).join(', ');
    return {
      content: [{
        type: 'text',
        text: `No registry entries found (filters: ${filters}).`,
      }],
    };
  }

  const header = '| ID | Name | Type | Archetype | Framework | Status |';
  const separator = '|----|------|------|-----------|-----------|--------|';
  const tableRows = rows.map(row =>
    `| ${row.id.substring(0, 8)}... | ${row.name} | ${row.type} | ${row.archetype ?? '-'} | ${row.framework ?? '-'} | ${row.status} |`
  );

  return {
    content: [{
      type: 'text',
      text: `# Registry\n\nFound ${rows.length} entries\n\n${header}\n${separator}\n${tableRows.join('\n')}`,
    }],
  };
}

/**
 * Remove a registry entry.
 *
 * By default, performs a soft delete (sets status to 'deprecated').
 * Pass hard_delete=true to permanently remove the entry.
 *
 * @param args - Entry ID and deletion mode
 * @returns MCP-formatted response with result
 */
function handleRegistryRemove(args: RegistryRemoveInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  const existing = db.prepare('SELECT id, name FROM registry WHERE id = ?').get(args.id) as { id: string; name: string } | undefined;
  if (!existing) {
    return {
      content: [{
        type: 'text',
        text: `Registry entry "${args.id}" not found.`,
      }],
    };
  }

  if (args.hard_delete) {
    db.prepare('DELETE FROM registry WHERE id = ?').run(args.id);
    return {
      content: [{
        type: 'text',
        text: `Registry entry "${existing.name}" (${args.id}) permanently deleted.`,
      }],
    };
  }

  db.prepare(
    "UPDATE registry SET status = 'deprecated', updated_at = datetime('now') WHERE id = ?"
  ).run(args.id);

  return {
    content: [{
      type: 'text',
      text: `Registry entry "${existing.name}" (${args.id}) marked as deprecated.`,
    }],
  };
}

/**
 * Update an existing registry entry.
 *
 * Only fields provided in the input are modified; others are preserved.
 * The updated_at timestamp is always refreshed.
 *
 * @param args - Entry ID and fields to update
 * @returns MCP-formatted response with the updated entry
 */
function handleRegistryUpdate(args: RegistryUpdateInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  const existing = db.prepare('SELECT * FROM registry WHERE id = ?').get(args.id) as RegistryRow | undefined;
  if (!existing) {
    return {
      content: [{
        type: 'text',
        text: `Registry entry "${args.id}" not found.`,
      }],
    };
  }

  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (args.name !== undefined) { updates.push('name = ?'); params.push(args.name); }
  if (args.type !== undefined) { updates.push('type = ?'); params.push(args.type); }
  if (args.archetype !== undefined) { updates.push('archetype = ?'); params.push(args.archetype); }
  if (args.framework !== undefined) { updates.push('framework = ?'); params.push(args.framework); }
  if (args.github_repo !== undefined) { updates.push('github_repo = ?'); params.push(args.github_repo); }
  if (args.github_path !== undefined) { updates.push('github_path = ?'); params.push(args.github_path); }
  if (args.github_branch !== undefined) { updates.push('github_branch = ?'); params.push(args.github_branch); }
  if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
  if (args.install_command !== undefined) { updates.push('install_command = ?'); params.push(args.install_command); }
  if (args.standalone !== undefined) { updates.push('standalone = ?'); params.push(args.standalone ? 1 : 0); }
  if (args.parent_template !== undefined) { updates.push('parent_template = ?'); params.push(args.parent_template); }
  if (args.tags !== undefined) { updates.push('tags = ?'); params.push(args.tags); }
  if (args.rebrand_checklist !== undefined) { updates.push('rebrand_checklist = ?'); params.push(args.rebrand_checklist); }
  if (args.source_project !== undefined) { updates.push('source_project = ?'); params.push(args.source_project); }
  if (args.status !== undefined) { updates.push('status = ?'); params.push(args.status); }
  if (args.when_to_use !== undefined) { updates.push('when_to_use = ?'); params.push(args.when_to_use); }
  if (args.source !== undefined) { updates.push('source = ?'); params.push(args.source); }
  if (args.source_ref !== undefined) { updates.push('source_ref = ?'); params.push(args.source_ref); }

  if (updates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No fields to update.',
      }],
    };
  }

  // Always refresh the updated_at timestamp
  updates.push("updated_at = datetime('now')");
  params.push(args.id);

  db.prepare(`UPDATE registry SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare('SELECT * FROM registry WHERE id = ?').get(args.id) as RegistryRow;

  return {
    content: [{
      type: 'text',
      text: `Registry entry updated successfully.\n\n${formatEntry(row)}`,
    }],
  };
}

export {
  handleRegistryAdd,
  handleRegistrySearch,
  handleRegistryGet,
  handleRegistryList,
  handleRegistryRemove,
  handleRegistryUpdate,
};
