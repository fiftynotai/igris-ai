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
 * @author Fifty.ai
 */

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

export { handleSessionSync, handleSessionRecall };
export type { SessionSyncInput, SessionRecallInput };
