/**
 * Igris Brain -- Session Tools
 *
 * Provides cross-project session sync and recall.
 * Sessions are snapshots of what a developer was working on,
 * synced to the brain on /rest and recalled on /awaken.
 *
 * Tools:
 * - igris_session_sync: Store session snapshot on /rest
 * - igris_session_recall: Recall recent sessions across projects
 *
 * @module tools/sessions
 * @author fifty.dev
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db.js';

/** Input shape for igris_session_sync */
interface SessionSyncInput {
  project: string;
  brief_id?: string;
  phase?: string;
  mode?: string;
  summary: string;
}

/** Input shape for igris_session_recall */
interface SessionRecallInput {
  days?: number;
}

/**
 * Sync a session snapshot to the brain.
 *
 * Closes any existing open session for the project before creating a new one.
 * Called by /rest to record what the developer was working on.
 *
 * @param args - Session data to sync
 * @returns MCP-formatted response confirming the sync
 */
function handleSessionSync(args: SessionSyncInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // Close any existing open session for this project
  db.prepare(
    'UPDATE sessions SET ended_at = datetime(\'now\') WHERE project = ? AND ended_at IS NULL'
  ).run(args.project);

  // Insert new session
  const result = db.prepare(`
    INSERT INTO sessions (project, brief_id, phase, mode, summary)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    args.project,
    args.brief_id ?? null,
    args.phase ?? null,
    args.mode ?? null,
    args.summary
  );

  return {
    content: [{
      type: 'text',
      text: [
        'Session synced successfully.',
        '',
        `ID: ${result.lastInsertRowid}`,
        `Project: ${args.project}`,
        args.brief_id ? `Brief: ${args.brief_id}` : null,
        args.phase ? `Phase: ${args.phase}` : null,
        args.mode ? `Mode: ${args.mode}` : null,
        `Summary: ${args.summary}`,
      ].filter(Boolean).join('\n'),
    }],
  };
}

/**
 * Recall recent sessions across all projects.
 *
 * Called by /awaken to show cross-project context. Returns sessions
 * grouped by day for easy scanning.
 *
 * @param args - Optional days parameter (default: 7)
 * @returns MCP-formatted response with session history
 */
function handleSessionRecall(args: SessionRecallInput): { content: { type: string; text: string }[] } {
  const db = getDb();
  const days = args.days ?? 7;

  const rows = db.prepare(`
    SELECT s.project, s.brief_id, s.phase, s.mode, s.summary,
           s.started_at, s.ended_at,
           p.name as project_name
    FROM sessions s
    LEFT JOIN projects p ON p.slug = s.project
    WHERE s.started_at >= datetime('now', '-' || ? || ' days')
    ORDER BY s.started_at DESC
  `).all(days) as Record<string, unknown>[];

  if (rows.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No sessions found in the last ${days} days.`,
      }],
    };
  }

  // Group by date
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const date = (row.started_at as string).substring(0, 10);
    if (!grouped.has(date)) {
      grouped.set(date, []);
    }
    grouped.get(date)!.push(row);
  }

  // Format output
  const sections: string[] = [`# Cross-Project Session History (last ${days} days)`, ''];

  for (const [date, sessions] of grouped) {
    sections.push(`## ${date}`);
    for (const s of sessions) {
      const name = s.project_name || s.project;
      const briefPart = s.brief_id ? ` [${s.brief_id}]` : '';
      const phasePart = s.phase ? `, ${s.phase}` : '';
      sections.push(`- **${name}** (${s.project}): ${s.summary}${briefPart}${phasePart}`);
    }
    sections.push('');
  }

  return {
    content: [{
      type: 'text',
      text: sections.join('\n'),
    }],
  };
}

/** Input shape for igris_session_file_get */
interface SessionFileGetInput {
  project: string;
  filename: string;
}

/** Input shape for igris_session_file_update */
interface SessionFileUpdateInput {
  project: string;
  filename: string;
  content: string;
}

/**
 * Get a single session file by project and filename.
 *
 * @param args - Project slug and filename
 * @returns MCP-formatted response with session file data
 */
function handleSessionFileGet(args: SessionFileGetInput): { content: { type: string; text: string }[] } {
  if (!args.project || !args.filename) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project" and "filename" are required.',
      }],
    };
  }

  const db = getDb();

  const row = db.prepare(`
    SELECT content, content_hash, updated_at
    FROM session_files
    WHERE project = ? AND filename = ?
  `).get(args.project, args.filename) as { content: string; content_hash: string; updated_at: string } | undefined;

  if (!row) {
    return {
      content: [{
        type: 'text',
        text: `Session file not found: ${args.filename} in project ${args.project}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        project: args.project,
        filename: args.filename,
        content: row.content,
        content_hash: row.content_hash,
        updated_at: row.updated_at,
      }, null, 2),
    }],
  };
}

/**
 * Create or update a session file.
 *
 * Upserts into session_files with a SHA-256 content hash.
 * Generates a UUID for new rows.
 *
 * @param args - Project slug, filename, and content
 * @returns MCP-formatted response confirming the upsert
 */
function handleSessionFileUpdate(args: SessionFileUpdateInput): { content: { type: string; text: string }[] } {
  if (!args.project || !args.filename || !args.content) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project", "filename", and "content" are required.',
      }],
    };
  }

  const db = getDb();
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const id = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  db.prepare(`
    INSERT INTO session_files (id, project, filename, content, content_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, filename) DO UPDATE SET
      content = excluded.content,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(id, args.project, args.filename, args.content, contentHash, now);

  return {
    content: [{
      type: 'text',
      text: [
        'Session file updated successfully.',
        '',
        `Project: ${args.project}`,
        `Filename: ${args.filename}`,
        `Content hash: ${contentHash.substring(0, 12)}...`,
        `Size: ${args.content.length} chars`,
      ].join('\n'),
    }],
  };
}

export { handleSessionSync, handleSessionRecall, handleSessionFileGet, handleSessionFileUpdate };
export type { SessionSyncInput, SessionRecallInput, SessionFileGetInput, SessionFileUpdateInput };
