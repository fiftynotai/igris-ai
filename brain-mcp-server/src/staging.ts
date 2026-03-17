/**
 * Staging File Processor
 *
 * Processes JSON files from ~/.igris/staging/{project}/ directory.
 * Files are created by the post_session_sync.sh hook on SessionEnd.
 * Processed files are deleted after successful ingestion.
 *
 * Supported staging file types:
 * - "learning": Insert into learnings table
 * - "learning_file": Parse LEARNINGS.md content and insert
 * - "error": Insert into errors table
 * - "metric": Insert into agent_metrics table
 * - "decision_file": Parse DECISIONS.md content and insert as learnings
 *
 * @module staging
 * @author Fifty.ai
 */

import { getDb, BRAIN_DIR } from './db.js';
import { errMsg } from './engine/helpers.js';
import * as fs from 'fs';
import * as path from 'path';

/** Shape of a staging file's JSON content */
interface StagingFile {
  type: string;
  project: string;
  data?: Record<string, unknown>;
  source?: string;
  content?: string;
  timestamp?: string;
}

/**
 * Process all pending staging files.
 *
 * Scans ~/.igris/staging/ for subdirectories (project slugs), then
 * processes each JSON file found within. Successfully processed files
 * are deleted. Errors are logged to stderr but do not halt processing.
 */
function processStagingFiles(): void {
  const stagingDir = path.join(BRAIN_DIR, 'staging');

  if (!fs.existsSync(stagingDir)) {
    return;
  }

  let totalProcessed = 0;
  let totalErrors = 0;

  const projectDirs = fs.readdirSync(stagingDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const projectDir of projectDirs) {
    const projectPath = path.join(stagingDir, projectDir.name);
    const files = fs.readdirSync(projectPath)
      .filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(projectPath, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const staging = JSON.parse(raw) as StagingFile;

        processStagingEntry(staging, projectDir.name);
        // Only delete after successful DB insert
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          console.error(`[staging] Failed to delete ${filePath}: ${errMsg(unlinkErr)}`);
        }
        totalProcessed++;
      } catch (err) {
        console.error(`[staging] Error processing ${filePath}: ${errMsg(err)}`);
        totalErrors++;
      }
    }
  }

  if (totalProcessed > 0 || totalErrors > 0) {
    console.error(`[staging] Processed ${totalProcessed} file(s), ${totalErrors} error(s)`);
  }
}

/**
 * Process a single staging entry and insert into the appropriate table.
 *
 * @param entry - Parsed staging file content
 * @param projectSlug - The project slug (from directory name)
 */
function processStagingEntry(entry: StagingFile, projectSlug: string): void {
  const db = getDb();
  const project = entry.project || projectSlug;

  switch (entry.type) {
    case 'learning': {
      const data = entry.data ?? {};
      db.prepare(`
        INSERT INTO learnings (project, category, title, content, tags, tech_stack, source_brief, scope)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project,
        data.category ?? 'discovery',
        data.title ?? 'Staged learning',
        data.content ?? '',
        data.tags ?? '',
        data.tech_stack ?? '',
        data.source_brief ?? '',
        data.scope ?? 'local'
      );
      break;
    }

    case 'learning_file': {
      // Raw LEARNINGS.md content -- store as a single discovery learning
      db.prepare(`
        INSERT INTO learnings (project, category, title, content, tags, scope)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        project,
        'discovery',
        `Session learnings from ${entry.source ?? 'LEARNINGS.md'}`,
        entry.content ?? '',
        'session-sync',
        'local'
      );
      break;
    }

    case 'decision_file': {
      // Raw DECISIONS.md content -- store as a decision learning
      db.prepare(`
        INSERT INTO learnings (project, category, title, content, tags, scope)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        project,
        'decision',
        `Session decisions from ${entry.source ?? 'DECISIONS.md'}`,
        entry.content ?? '',
        'session-sync',
        'local'
      );
      break;
    }

    case 'error': {
      const data = entry.data ?? {};
      db.prepare(`
        INSERT INTO errors (project, fingerprint, message, solution, context)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        project,
        data.fingerprint ?? '',
        data.message ?? '',
        data.solution ?? '',
        data.context ?? ''
      );
      break;
    }

    case 'metric': {
      const data = entry.data ?? {};
      db.prepare(`
        INSERT INTO agent_metrics (project, agent, brief_id, action, result, duration_ms, retry_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        project,
        data.agent ?? 'unknown',
        data.brief_id ?? '',
        data.action ?? 'unknown',
        data.result ?? 'success',
        data.duration_ms ?? 0,
        data.retry_count ?? 0
      );
      break;
    }

    default:
      console.error(`[staging] Unknown staging type: ${entry.type}`);
  }
}

export { processStagingFiles };
