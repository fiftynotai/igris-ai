/**
 * Brain Engine v7.0 -- Cache Component Handlers
 *
 * Handler functions for the filesystem projection. Writes markdown
 * files from brain DB into ~/.igris/projects/{project}/ so that agents
 * can read briefs/sessions without querying the MCP server.
 *
 * @module engine/components/cache/handlers
 * @author fifty.dev
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getDb } from '../../../db.js';
import type { ToolResult } from '../../types.js';
import { errorResult, successResult } from '../../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a resolved path stays within the expected base directory.
 * Prevents path traversal attacks via malicious project slugs or filenames.
 */
function safePath(base: string, ...segments: string[]): string {
  for (const seg of segments) {
    if (seg.includes('..') || seg.includes('/') || seg.includes('\\')) {
      throw new Error(`Invalid path segment: ${seg}`);
    }
  }
  const resolved = path.resolve(base, ...segments);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error(`Path traversal detected: ${segments.join('/')}`);
  }
  return resolved;
}

/** Projection root at call time: $IGRIS_BRAIN_DIR/projects, else ~/.igris/projects. */
export function cacheRoot(): string {
  const dir = process.env.IGRIS_BRAIN_DIR;
  return dir ? path.join(dir, 'projects') : path.join(os.homedir(), '.igris', 'projects');
}

/** `YYYY-MM-DD HH:MM:SS` (UTC) or ISO → epoch ms; NaN when unparseable. */
function dbTimeMs(stamp: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp) ? `${stamp.replace(' ', 'T')}Z` : stamp);
}

/**
 * The file classes this module projects. TD-460 added the second: the
 * classifier body below stays ONE function (TD-414's actual requirement —
 * "the classifier is the ONE place the rule lives"), so the class picks the
 * subdirectory rather than a second copy of the comparison picking it.
 */
export type ProjectionClass = 'briefs' | 'context';

export function briefCachePath(project: string, filename: string): string {
  return safePath(safePath(cacheRoot(), project), 'briefs', filename);
}

/** TD-460: the context-doc directory, guarded — the reconciler scans it. */
export function contextDocDir(project: string): string {
  return safePath(safePath(cacheRoot(), project), 'context');
}

/** TD-460: the context-doc sibling of briefCachePath, same traversal guard. */
export function contextDocPath(project: string, filename: string): string {
  return safePath(contextDocDir(project), filename);
}

export type DiskEditState = 'absent' | 'same' | 'local-newer' | 'brain-newer';

/**
 * Disk copy vs brain row (TD-414); an unparseable stamp reads 'local-newer'.
 * `klass` defaults to 'briefs', so both pre-TD-460 call sites are unchanged.
 */
export function diskEditState(
  project: string,
  filename: string,
  row: { content: string; updated_at: string },
  klass: ProjectionClass = 'briefs',
): DiskEditState {
  const file = klass === 'context' ? contextDocPath(project, filename) : briefCachePath(project, filename);
  if (!existsSync(file)) return 'absent';
  if (readFileSync(file, 'utf-8') === row.content) return 'same';
  const brainMs = dbTimeMs(row.updated_at);
  return Number.isNaN(brainMs) || statSync(file).mtimeMs > brainMs ? 'local-newer' : 'brain-newer';
}

export type ProjectionOutcome = 'written' | 'skipped-same' | 'refused-local-newer' | 'no-row';

interface BriefFileRow {
  filename: string;
  content: string;
  updated_at: string;
}

/** The ONE brain→disk brief writer. `force` is the only override. */
function projectBriefFile(project: string, row: BriefFileRow, force = false): ProjectionOutcome {
  const state = force ? 'brain-newer' : diskEditState(project, row.filename, row);
  if (state === 'same') return 'skipped-same';
  if (state === 'local-newer') return 'refused-local-newer';
  ensureCacheDir(project);
  writeFileSync(briefCachePath(project, row.filename), row.content, 'utf-8');
  return 'written';
}

export type ContextProjectionOutcome =
  | 'written'
  | 'backed-up-and-written'
  | 'skipped-same'
  | 'local-newer';

export interface ContextFileRow {
  key: string;
  content: string;
  updated_at: string;
}

/**
 * TD-460: copy the current disk bytes aside before a brain-newer overwrite.
 * A SIBLING directory, deliberately not `context/.backup/` — readContextDocs
 * (export.ts) and the dashboard glob `context/` flat, and a backup that turns
 * up in an inventory is a bug waiting to be filed. FR-230's backupContextDoc
 * is the same idea on the bundle path. Returns null when there is nothing to
 * back up (the `force`-over-absent case).
 */
export function backupContextDocDisk(project: string, filename: string): string | null {
  const src = contextDocPath(project, filename);
  if (!existsSync(src)) return null;
  const dir = safePath(safePath(cacheRoot(), project), 'context-backups');
  mkdirSync(dir, { recursive: true });
  const dest = safePath(dir, `${filename}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  writeFileSync(dest, readFileSync(src));
  return dest;
}

/**
 * The ONE brain→disk context-doc writer (TD-460) — the sibling of
 * projectBriefFile, sharing its classifier and its traversal guard (L-815:
 * two-copy state has one writer).
 *
 * ONE row of the action table is INVERTED against the brief writer, and it is
 * the point of the design: a brief is brain-canonical, so a newer disk copy is
 * REFUSED and frozen; a context doc is disk-AUTHORED (five skills write these
 * files with ordinary writes, three of them through no brain tool at all), so
 * a newer disk copy is left alone here and ABSORBED into the row by the
 * caller. Inheriting refuse-and-freeze verbatim would make the replica rot
 * while looking healthy — the TD-460 defect one layer up.
 *
 * A brain-newer overwrite is the only destructive operation in the design, and
 * it is preceded by a backup, which is what makes LWW acceptable here: the
 * losing prose survives on the machine that authored it, named and timestamped.
 */
export function projectContextFile(
  project: string,
  row: ContextFileRow,
  force = false,
): ContextProjectionOutcome {
  const state = force ? 'brain-newer' : diskEditState(project, row.key, row, 'context');
  if (state === 'same') return 'skipped-same';
  if (state === 'local-newer') return 'local-newer';
  const backup = state === 'brain-newer' ? backupContextDocDisk(project, row.key) : null;
  ensureCacheDir(project);
  writeFileSync(contextDocPath(project, row.key), row.content, 'utf-8');
  return backup ? 'backed-up-and-written' : 'written';
}

// ---------------------------------------------------------------------------
// ensureCacheDir
// ---------------------------------------------------------------------------

/**
 * Create cache directories for a project.
 *
 * Ensures ~/.igris/projects/{project}/briefs/, session/ and (TD-460) context/
 * exist — a fresh machine materialises a replicated doc into a directory that
 * is already there.
 *
 * @param project - Project slug
 * @returns The project cache root path
 */
export function ensureCacheDir(project: string): string {
  const projectCacheRoot = safePath(cacheRoot(), project);
  mkdirSync(path.join(projectCacheRoot, 'briefs'), { recursive: true });
  mkdirSync(path.join(projectCacheRoot, 'session'), { recursive: true });
  mkdirSync(path.join(projectCacheRoot, 'context'), { recursive: true });
  return projectCacheRoot;
}

// ---------------------------------------------------------------------------
// cacheBrief
// ---------------------------------------------------------------------------

/**
 * Project one brief from the DB to the filesystem (guarded, TD-414).
 *
 * @param project - Project slug
 * @param briefId - Brief ID (e.g. "BR-008")
 */
export function cacheBrief(project: string, briefId: string): ProjectionOutcome {
  const db = getDb();
  const row = db.prepare(
    'SELECT filename, content, updated_at FROM brief_files WHERE project = ? AND brief_id = ?'
  ).get(project, briefId) as BriefFileRow | undefined;

  if (!row) return 'no-row';
  return projectBriefFile(project, row);
}

// ---------------------------------------------------------------------------
// cacheSessionFile
// ---------------------------------------------------------------------------

/**
 * Write a single session file from the DB to the filesystem cache.
 *
 * Queries session_files for the given project+filename. Writes content
 * to ~/.igris/projects/{project}/session/{filename}. Skips silently
 * if no row is found.
 *
 * @param project - Project slug
 * @param filename - Session filename (e.g. "CURRENT_SESSION.md")
 */
export function cacheSessionFile(project: string, filename: string): void {
  const db = getDb();
  const row = db.prepare(
    'SELECT content FROM session_files WHERE project = ? AND filename = ?'
  ).get(project, filename) as { content: string } | undefined;

  if (!row) return;

  const projectRoot = ensureCacheDir(project);
  writeFileSync(safePath(projectRoot, 'session', filename), row.content, 'utf-8');
}

// ---------------------------------------------------------------------------
// handleCacheRebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild the filesystem cache for a project.
 *
 * Required: project (string)
 * Optional: scope ('briefs' | 'sessions' | 'all', default 'all'),
 *           force (boolean: overwrite local brief files even when newer)
 *
 * Queries all brief_files and/or session_files for the project
 * and writes each to the cache directory.
 */
export function handleCacheRebuild(args: Record<string, unknown>): ToolResult {
  const project = args.project as string | undefined;
  if (!project) {
    return errorResult('Missing required field: project');
  }

  const scope = (args.scope as string | undefined) ?? 'all';
  const validScopes = ['briefs', 'sessions', 'all'];
  if (!validScopes.includes(scope)) {
    return errorResult(`Invalid scope: ${scope}. Must be one of: ${validScopes.join(', ')}`);
  }

  const force = args.force === true;
  const db = getDb();
  ensureCacheDir(project);

  let briefsCached = 0;
  let briefsSkipped = 0;
  let sessionsCached = 0;

  if (scope === 'briefs' || scope === 'all') {
    const briefs = db.prepare(
      'SELECT brief_id, filename, content, updated_at FROM brief_files WHERE project = ?'
    ).all(project) as (BriefFileRow & { brief_id: string })[];

    for (const brief of briefs) {
      if (projectBriefFile(project, brief, force) === 'refused-local-newer') briefsSkipped++;
      else briefsCached++;
    }
  }

  if (scope === 'sessions' || scope === 'all') {
    const sessions = db.prepare(
      'SELECT filename, content FROM session_files WHERE project = ?'
    ).all(project) as { filename: string; content: string }[];

    const projectRoot = safePath(cacheRoot(), project);
    for (const session of sessions) {
      writeFileSync(safePath(projectRoot, 'session', session.filename), session.content, 'utf-8');
      sessionsCached++;
    }
  }

  return successResult(JSON.stringify({
    project,
    scope,
    briefs_cached: briefsCached,
    briefs_skipped: briefsSkipped,
    sessions_cached: sessionsCached,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// handleCacheClean
// ---------------------------------------------------------------------------

/**
 * Remove the filesystem cache for a project.
 *
 * Required: project (string)
 *
 * Deletes ~/.igris/projects/{project}/ recursively.
 */
export function handleCacheClean(args: Record<string, unknown>): ToolResult {
  const project = args.project as string | undefined;
  if (!project || typeof project !== 'string') {
    return errorResult('Required parameter "project" is missing');
  }

  const projectCachePath = safePath(cacheRoot(), project);
  rmSync(projectCachePath, { recursive: true, force: true });

  return successResult(JSON.stringify({
    project,
    path: projectCachePath,
    message: 'Cache directory removed',
  }, null, 2));
}
