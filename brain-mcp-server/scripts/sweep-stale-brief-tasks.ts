/**
 * One-shot sweep: close coordination tasks for briefs that are Done/Archived
 * but whose linked task is still in a non-terminal state.
 *
 * Historical rows exist because:
 *   - The `brief.completed` event listener in `tasks/index.ts` was added after
 *     several briefs had already transitioned.
 *   - Prior to TD-042, `brief.completed` was only emitted on Done transitions,
 *     not Archived — so briefs that went straight to Archived left dangling tasks.
 *   - Cross-VPS sync lag or listener failures can occasionally leave stale rows.
 *
 * Usage:
 *   pnpm sweep-tasks                       # scan and close all stale rows across projects
 *   pnpm sweep-tasks --dry-run             # preview without modifying
 *   pnpm sweep-tasks --project <slug>      # limit to a single project
 *   pnpm sweep-tasks --dry-run --project igris-ai
 *
 * Closes tasks via `handleTaskComplete` so downstream listeners (monitoring,
 * unblocking cascade) fire exactly as they would for a normal completion.
 *
 * @module scripts/sweep-stale-brief-tasks
 * @author fifty.dev
 */

import Database from 'better-sqlite3';
import { getDb } from '../src/db.js';
import { handleTaskComplete } from '../src/engine/components/tasks/handlers.js';

/** A stale task row: linked brief is Done/Archived but task is not done/cancelled */
export interface StaleRow {
  task_id: string;
  brief_id: string;
  project_slug: string;
  brief_status: string;
  task_status: string;
}

/** Outcome summary for a sweep run */
export interface SweepResult {
  found: number;
  completed: number;
  skipped: number;
  skippedDetails: Array<{ task_id: string; reason: string }>;
}

/**
 * Find all coordination tasks whose linked brief is in a terminal state
 * (Done/Archived) but whose own status is still non-terminal.
 *
 * Scoped to `task_type = 'brief'` — operational/personal tasks are unaffected.
 *
 * @param db - Database connection (pass explicitly for testability)
 * @param projectFilter - Optional project slug to restrict the scan
 * @returns Array of stale rows ordered by project then brief_id
 */
export function findStale(db: Database.Database, projectFilter?: string): StaleRow[] {
  const where = projectFilter ? 'AND t.project_slug = ?' : '';
  const params = projectFilter ? [projectFilter] : [];
  return db.prepare(`
    SELECT t.id AS task_id,
           t.brief_id,
           t.project_slug,
           bs.status AS brief_status,
           t.status AS task_status
    FROM tasks t
    JOIN brief_status bs
      ON bs.brief_id = t.brief_id
     AND bs.project = t.project_slug
    WHERE t.task_type = 'brief'
      AND t.status NOT IN ('done','cancelled')
      AND bs.status IN ('Done','Archived')
      ${where}
    ORDER BY t.project_slug, t.brief_id
  `).all(...params) as StaleRow[];
}

/**
 * Sweep stale tasks: finds them and completes each via handleTaskComplete.
 *
 * `handleTaskComplete` is idempotent — if another caller (e.g. the listener)
 * already completed a row between findStale() and now, the call returns a
 * benign "already done" success. We still count those as completed since the
 * end-state is correct.
 *
 * @param db - Database connection
 * @param dryRun - If true, only reports what would change; no writes
 * @param projectFilter - Optional project slug scope
 * @param log - Optional logger for per-row output (defaults to console)
 * @returns Summary of the sweep outcome
 */
export function sweepStale(
  db: Database.Database,
  dryRun: boolean = false,
  projectFilter?: string,
  log: (msg: string) => void = console.log,
): SweepResult {
  const stale = findStale(db, projectFilter);
  const result: SweepResult = {
    found: stale.length,
    completed: 0,
    skipped: 0,
    skippedDetails: [],
  };

  if (dryRun) {
    for (const row of stale) {
      log(`  [DRY] t=${row.task_id} brief=${row.brief_id} project=${row.project_slug} brief_status=${row.brief_status} task_status=${row.task_status}`);
    }
    return result;
  }

  for (const row of stale) {
    const res = handleTaskComplete({
      task_id: row.task_id,
      result: `Retroactive sweep (TD-042): brief ${row.brief_id} is ${row.brief_status}`,
    });

    if (res.isError) {
      result.skipped++;
      const reason = res.content[0]?.text ?? 'unknown error';
      result.skippedDetails.push({ task_id: row.task_id, reason });
      log(`  SKIP ${row.task_id}: ${reason}`);
    } else {
      result.completed++;
      log(`  OK ${row.task_id} (${row.brief_id} in ${row.project_slug})`);
    }
  }

  return result;
}

/**
 * CLI entry point: parses args, opens the production brain DB, and runs sweep.
 * Errors exit with code 1; normal runs exit 0.
 *
 * Note: The tasks/brief_status tables are created by the brain engine's
 * component migrations, not by `db.ts`'s core migrations. This script relies
 * on the brain having been booted at least once so the schema exists. If it
 * hasn't, we detect the missing tables and exit with a clear message.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const projectIdx = process.argv.indexOf('--project');
  const projectFilter = projectIdx >= 0 ? process.argv[projectIdx + 1] : undefined;

  if (projectIdx >= 0 && !projectFilter) {
    console.error('Error: --project requires a slug argument (e.g. --project igris-ai)');
    process.exit(1);
  }

  const db = getDb();

  // Sanity-check required tables exist before we try to run the JOIN.
  const required = ['tasks', 'brief_status'] as const;
  for (const table of required) {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(table) as { name: string } | undefined;
    if (!row) {
      console.error(
        `Error: required table "${table}" not found in brain DB.\n` +
        `This usually means the brain engine has not yet been booted on this machine.\n` +
        `Start the MCP server once to apply component migrations, then re-run the sweep.`,
      );
      process.exit(1);
    }
  }

  const scope = projectFilter ? ` in ${projectFilter}` : '';
  const mode = dryRun ? ' (dry-run)' : '';

  console.log(`Scanning for stale brief-linked tasks${scope}${mode}...`);
  const result = sweepStale(db, dryRun, projectFilter);

  console.log('');
  console.log(`Found ${result.found} stale task(s)${scope}.`);
  if (!dryRun) {
    console.log(`Summary: ${result.completed} completed, ${result.skipped} skipped.`);
  }
}

// Run main only when invoked as the CLI entry point, not when imported by tests.
// Compares the module URL to the entry file; tests import by relative path and
// do not pass `sweep-stale-brief-tasks` as argv[1], so main() is skipped.
const entryPoint = process.argv[1] ?? '';
const isDirectRun = /sweep-stale-brief-tasks(\.ts|\.js)?$/.test(entryPoint);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
