/**
 * Brain Engine v5.0 -- Cache Component Handlers
 *
 * Handler functions for filesystem cache generation. Writes markdown
 * files from brain DB into ~/.igris/cache/{project}/ so that agents
 * can read briefs/sessions without querying the MCP server.
 *
 * @module engine/components/cache/handlers
 * @author Fifty.ai
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

/** Root cache directory: ~/.igris/cache */
const CACHE_ROOT = path.join(os.homedir(), '.igris', 'cache');

// ---------------------------------------------------------------------------
// ensureCacheDir
// ---------------------------------------------------------------------------

/**
 * Create cache directories for a project.
 *
 * Ensures ~/.igris/cache/{project}/briefs/ and
 * ~/.igris/cache/{project}/session/ exist.
 *
 * @param project - Project slug
 * @returns The project cache root path
 */
export function ensureCacheDir(project: string): string {
  const projectCacheRoot = safePath(CACHE_ROOT, project);
  mkdirSync(path.join(projectCacheRoot, 'briefs'), { recursive: true });
  mkdirSync(path.join(projectCacheRoot, 'session'), { recursive: true });
  return projectCacheRoot;
}

// ---------------------------------------------------------------------------
// cacheBrief
// ---------------------------------------------------------------------------

/**
 * Write a single brief from the DB to the filesystem cache.
 *
 * Queries brief_files for the given project+briefId. Writes content
 * to ~/.igris/cache/{project}/briefs/{filename}. Skips silently
 * if no row is found.
 *
 * @param project - Project slug
 * @param briefId - Brief ID (e.g. "BR-008")
 */
export function cacheBrief(project: string, briefId: string): void {
  const db = getDb();
  const row = db.prepare(
    'SELECT filename, content FROM brief_files WHERE project = ? AND brief_id = ?'
  ).get(project, briefId) as { filename: string; content: string } | undefined;

  if (!row) return;

  const cacheRoot = ensureCacheDir(project);
  writeFileSync(safePath(cacheRoot, 'briefs', row.filename), row.content, 'utf-8');
}

// ---------------------------------------------------------------------------
// cacheSessionFile
// ---------------------------------------------------------------------------

/**
 * Write a single session file from the DB to the filesystem cache.
 *
 * Queries session_files for the given project+filename. Writes content
 * to ~/.igris/cache/{project}/session/{filename}. Skips silently
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

  const cacheRoot = ensureCacheDir(project);
  writeFileSync(safePath(cacheRoot, 'session', filename), row.content, 'utf-8');
}

// ---------------------------------------------------------------------------
// handleCacheRebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild the filesystem cache for a project.
 *
 * Required: project (string)
 * Optional: scope ('briefs' | 'sessions' | 'all', default 'all')
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

  const db = getDb();
  ensureCacheDir(project);

  let briefsCached = 0;
  let sessionsCached = 0;

  if (scope === 'briefs' || scope === 'all') {
    const briefs = db.prepare(
      'SELECT brief_id, filename, content FROM brief_files WHERE project = ?'
    ).all(project) as { brief_id: string; filename: string; content: string }[];

    const cacheRoot = safePath(CACHE_ROOT, project);
    for (const brief of briefs) {
      writeFileSync(safePath(cacheRoot, 'briefs', brief.filename), brief.content, 'utf-8');
      briefsCached++;
    }
  }

  if (scope === 'sessions' || scope === 'all') {
    const sessions = db.prepare(
      'SELECT filename, content FROM session_files WHERE project = ?'
    ).all(project) as { filename: string; content: string }[];

    const cacheRoot = safePath(CACHE_ROOT, project);
    for (const session of sessions) {
      writeFileSync(safePath(cacheRoot, 'session', session.filename), session.content, 'utf-8');
      sessionsCached++;
    }
  }

  return successResult(JSON.stringify({
    project,
    scope,
    briefs_cached: briefsCached,
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
 * Deletes ~/.igris/cache/{project}/ recursively.
 */
export function handleCacheClean(args: Record<string, unknown>): ToolResult {
  const project = args.project as string | undefined;
  if (!project || typeof project !== 'string') {
    return errorResult('Required parameter "project" is missing');
  }

  const projectCachePath = safePath(CACHE_ROOT, project);
  rmSync(projectCachePath, { recursive: true, force: true });

  return successResult(JSON.stringify({
    project,
    path: projectCachePath,
    message: 'Cache directory removed',
  }, null, 2));
}
