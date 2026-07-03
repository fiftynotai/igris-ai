/**
 * Brain Engine v7.1 — Subconscious digest builder (FR-118 M2).
 *
 * `buildDigest(db, project)` produces a DETERMINISTIC, bounded snapshot of
 * brain state — the INPUT slot (`buildContext`) of the subconscious cognition
 * instance. It is PURE with respect to the LLM: no model call, no mutation,
 * only `SELECT`s + an optional `git log` snapshot. The result is the untrusted
 * data the prompt wraps in `<digest>…</digest>` (FR-108 injection defence) and
 * the validator cross-checks citations against (the hallucination guard).
 *
 * Determinism (the golden-file contract):
 *   - every query has an explicit, total `ORDER BY` (no implicit rowid order);
 *   - row counts are bounded by `DIGEST_LIMITS`;
 *   - the `git log` snapshot is INJECTABLE (`deps.gitLog`) so the golden test
 *     pins it; the default shells out and tolerates a no-git tree (returns an
 *     empty `recent_commits` array — never throws);
 *   - the serialized digest is hard-capped at `DIGEST_MAX_BYTES` (200KB) — if
 *     the body exceeds it, the largest sections are trimmed and a `truncated`
 *     flag + `size_hint` record what happened.
 *
 * The digest is the model's ENTIRE view of the brain — it never reaches the
 * live DB (R-BRAIN-LEAK: the backend runs the LLM in an isolated HOME with an
 * empty MCP config). So the digest must carry every signal the model needs to
 * reason: open briefs (with staleness), recent learnings, open suggestions
 * (to avoid re-proposing), per-project activity, and the recent commit log.
 *
 * @module engine/components/subconscious/digest
 * @author fifty.dev
 */

import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Per-section row caps. Tuned to keep the serialized digest comfortably under
 * `DIGEST_MAX_BYTES` for a realistic brain while still giving the model a
 * representative window. The caps are part of the golden-file contract — a
 * change here changes the byte-stable digest, so bump the golden fixture.
 */
export const DIGEST_LIMITS = {
  /** Open (non-terminal) briefs, oldest-stale first. */
  open_briefs: 60,
  /** Most-recent approved learnings. */
  recent_learnings: 40,
  /** Currently-pending suggestions (so the model does not re-propose them). */
  open_suggestions: 60,
  /** Per-project activity rows. */
  projects: 40,
  /** Recent commit log entries. */
  recent_commits: 40,
} as const;

/** Hard cap on the serialized digest (UTF-8 bytes). The plan's ≤200KB bound. */
export const DIGEST_MAX_BYTES = 200 * 1024;

/** Statuses treated as "terminal" — excluded from the open-briefs section. */
const TERMINAL_BRIEF_STATUSES = ['Done', 'Archived', 'Cancelled', 'Closed'];

// ---------------------------------------------------------------------------
// Digest shape
// ---------------------------------------------------------------------------

/** One open brief row in the digest. */
export interface DigestBrief {
  brief_id: string;
  project: string;
  title: string;
  status: string;
  priority: string | null;
  /** Whole days since `updated_at` (staleness signal for the stalled-kind suggestion). */
  days_since_update: number;
}

/** One recent learning row in the digest. */
export interface DigestLearning {
  id: number;
  project: string;
  category: string;
  title: string;
  confidence: number;
}

/** One open (pending) suggestion already queued — the model must not re-propose it. */
export interface DigestOpenSuggestion {
  id: number;
  source_module: string;
  project_slug: string | null;
  title: string;
}

/** Per-project activity row. */
export interface DigestProject {
  slug: string;
  status: string;
  open_briefs: number;
  learnings: number;
  /** Whole days since the most-recent learning/brief activity, or null if none. */
  days_since_activity: number | null;
}

/** One recent commit. */
export interface DigestCommit {
  hash: string;
  subject: string;
}

/** A size accounting hint surfaced to the prompt + the engine's bytes gate. */
export interface DigestSizeHint {
  /** Serialized digest size in UTF-8 bytes. */
  bytes: number;
  /** True when a section was trimmed to fit `DIGEST_MAX_BYTES`. */
  truncated: boolean;
}

/** The full deterministic brain digest the subconscious extractor reasons over. */
export interface BrainDigest {
  /** The project this digest was scoped to (or 'all' for the whole brain). */
  scope: string;
  /** ISO-ish generation timestamp from the DB clock (deterministic in tests via SQL). */
  generated_at: string;
  open_briefs: DigestBrief[];
  recent_learnings: DigestLearning[];
  open_suggestions: DigestOpenSuggestion[];
  projects: DigestProject[];
  recent_commits: DigestCommit[];
  size_hint: DigestSizeHint;
}

// ---------------------------------------------------------------------------
// Injectable seams (so the golden-file test is deterministic)
// ---------------------------------------------------------------------------

/** Seams the digest builder reaches OUT through (default: real impls). */
export interface BuildDigestDeps {
  /**
   * Return the recent commit log for the brain repo. Defaults to a `git log`
   * shell-out that tolerates a non-git tree (empty array, never throws). The
   * golden test injects a fixed list so the digest is byte-stable.
   */
  gitLog?: (limit: number) => DigestCommit[];
  /**
   * The directory to run `git log` in (defaults to the process cwd). Injectable
   * so a test can point at a fixture repo or force the no-git path.
   */
  repoDir?: string;
  /**
   * The generation timestamp. Defaults to the DB clock (`datetime('now')`) so
   * the value matches the row timestamps' resolution. Injectable for the
   * golden test (a fixed string yields a byte-stable digest).
   */
  now?: string;
}

// ---------------------------------------------------------------------------
// git log (default seam)
// ---------------------------------------------------------------------------

/**
 * Default `git log` snapshot. Runs `git log --oneline -n <limit>` in `repoDir`
 * and parses `<hash> <subject>` per line. Tolerates EVERYTHING: no git binary,
 * not a repo, an empty repo — all yield `[]` (never throws). The subprocess is
 * hard-bounded (small `maxBuffer`, no shell) so a pathological repo can't hang
 * or blow memory.
 */
export function defaultGitLog(limit: number, repoDir?: string): DigestCommit[] {
  try {
    const out = execFileSync(
      'git',
      ['log', `--max-count=${limit}`, '--pretty=format:%h %s'],
      {
        cwd: repoDir ?? process.cwd(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      },
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const sp = line.indexOf(' ');
        if (sp === -1) return { hash: line, subject: '' };
        return { hash: line.slice(0, sp), subject: line.slice(sp + 1) };
      });
  } catch {
    // No git, not a repo, empty repo, timeout — all tolerated.
    return [];
  }
}

// ---------------------------------------------------------------------------
// SQL section builders (deterministic — explicit total ORDER BY everywhere)
// ---------------------------------------------------------------------------

function selectOpenBriefs(db: Database.Database, project: string): DigestBrief[] {
  const placeholders = TERMINAL_BRIEF_STATUSES.map(() => '?').join(', ');
  const projectClause = project === 'all' ? '' : 'AND project = ?';
  const params: unknown[] = [...TERMINAL_BRIEF_STATUSES];
  if (project !== 'all') params.push(project);
  params.push(DIGEST_LIMITS.open_briefs);
  // Tie-break on brief_id so equal-age briefs sort deterministically.
  const rows = db
    .prepare(
      `SELECT brief_id, project, title, status, priority,
              CAST(julianday('now') - julianday(updated_at) AS INTEGER) AS days_since_update
         FROM brief_status
        WHERE status NOT IN (${placeholders})
          ${projectClause}
        ORDER BY days_since_update DESC, brief_id ASC
        LIMIT ?`,
    )
    .all(...params) as Array<{
    brief_id: string;
    project: string;
    title: string;
    status: string;
    priority: string | null;
    days_since_update: number | null;
  }>;
  return rows.map((r) => ({
    brief_id: r.brief_id,
    project: r.project,
    title: r.title,
    status: r.status,
    priority: r.priority,
    days_since_update: r.days_since_update ?? 0,
  }));
}

function selectRecentLearnings(db: Database.Database, project: string): DigestLearning[] {
  const projectClause = project === 'all' ? '' : 'AND project = ?';
  const params: unknown[] = [];
  if (project !== 'all') params.push(project);
  params.push(DIGEST_LIMITS.recent_learnings);
  // review_status filter is optional (the column lands in db.ts v15). Use a
  // tolerant predicate: include rows where review_status is 'approved' OR the
  // column is absent (NULL coalesces to 'approved' for back-compat).
  const rows = db
    .prepare(
      `SELECT id, project, category, title, confidence
         FROM learnings
        WHERE COALESCE(review_status, 'approved') = 'approved'
          ${projectClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params) as DigestLearning[];
  return rows.map((r) => ({
    id: r.id,
    project: r.project,
    category: r.category,
    title: r.title,
    confidence: r.confidence,
  }));
}

function selectOpenSuggestions(
  db: Database.Database,
  project: string,
): DigestOpenSuggestion[] {
  const projectClause = project === 'all' ? '' : 'AND project_slug = ?';
  const params: unknown[] = [];
  if (project !== 'all') params.push(project);
  params.push(DIGEST_LIMITS.open_suggestions);
  const rows = db
    .prepare(
      `SELECT id, source_module, project_slug, title
         FROM suggestions
        WHERE status = 'pending'
          ${projectClause}
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(...params) as DigestOpenSuggestion[];
  return rows;
}

function selectProjects(db: Database.Database, project: string): DigestProject[] {
  const projectClause = project === 'all' ? '' : 'WHERE p.slug = ?';
  const placeholders = TERMINAL_BRIEF_STATUSES.map(() => '?').join(', ');
  // Bind order MUST match the SQL TEXT order, not the logical reading: the
  // `b.status NOT IN (?,?,?,?)` placeholders sit in the SELECT subquery (FIRST
  // in text), THEN the outer `WHERE p.slug = ?`, THEN the LIMIT.
  const orderedParams: unknown[] = [...TERMINAL_BRIEF_STATUSES];
  if (project !== 'all') orderedParams.push(project);
  orderedParams.push(DIGEST_LIMITS.projects);
  const rows = db
    .prepare(
      `SELECT
          p.slug AS slug,
          p.status AS status,
          (SELECT COUNT(*) FROM brief_status b
             WHERE b.project = p.slug AND b.status NOT IN (${placeholders})) AS open_briefs,
          (SELECT COUNT(*) FROM learnings l WHERE l.project = p.slug) AS learnings,
          (SELECT CAST(julianday('now') - julianday(MAX(l.created_at)) AS INTEGER)
             FROM learnings l WHERE l.project = p.slug) AS days_since_activity
         FROM projects p
         ${projectClause}
        ORDER BY p.slug ASC
        LIMIT ?`,
    )
    .all(...orderedParams) as Array<{
    slug: string;
    status: string;
    open_briefs: number;
    learnings: number;
    days_since_activity: number | null;
  }>;
  return rows.map((r) => ({
    slug: r.slug,
    status: r.status,
    open_briefs: r.open_briefs,
    learnings: r.learnings,
    days_since_activity: r.days_since_activity,
  }));
}

function selectNow(db: Database.Database): string {
  const row = db.prepare(`SELECT datetime('now') AS now`).get() as { now: string };
  return row.now;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** Compute the serialized byte size of a digest body (excludes size_hint itself). */
function serializedBytes(digest: Omit<BrainDigest, 'size_hint'>): number {
  return Buffer.byteLength(JSON.stringify(digest), 'utf-8');
}

/**
 * Build a deterministic, bounded brain digest for `project` ('all' = whole
 * brain). Pure (no LLM, no mutation). Each section is independently fail-soft:
 * a missing table (a partial/fixture schema) yields an empty section rather
 * than throwing, so the digest is always producible.
 *
 * Size discipline: after assembling all sections we measure the serialized
 * size; if it exceeds `DIGEST_MAX_BYTES` we trim the largest sections (commits,
 * then learnings, then suggestions, then briefs) until it fits, recording
 * `truncated: true` in `size_hint`. The cap is a hard upper bound on what the
 * LLM call carries — it never blocks producing *a* digest.
 *
 * @param db      the brain DB (read-only use)
 * @param project the project slug, or 'all' for the whole brain
 * @param deps    injectable seams (gitLog / repoDir / now) — defaults to real impls
 */
export function buildDigest(
  db: Database.Database,
  project: string,
  deps: BuildDigestDeps = {},
): BrainDigest {
  const scope = project && project.length > 0 ? project : 'all';

  const safe = <T>(fn: () => T[], _label: string): T[] => {
    try {
      return fn();
    } catch {
      // Missing table / partial schema — return an empty section. The digest
      // must always be producible (the engine's bytes gate decides emptiness).
      return [];
    }
  };

  const now =
    deps.now ??
    (() => {
      try {
        return selectNow(db);
      } catch {
        return '';
      }
    })();

  const gitLog = deps.gitLog ?? ((limit: number) => defaultGitLog(limit, deps.repoDir));

  const body: Omit<BrainDigest, 'size_hint'> = {
    scope,
    generated_at: now,
    open_briefs: safe(() => selectOpenBriefs(db, scope), 'open_briefs'),
    recent_learnings: safe(() => selectRecentLearnings(db, scope), 'recent_learnings'),
    open_suggestions: safe(() => selectOpenSuggestions(db, scope), 'open_suggestions'),
    projects: safe(() => selectProjects(db, scope), 'projects'),
    recent_commits: safe(() => gitLog(DIGEST_LIMITS.recent_commits), 'recent_commits'),
  };

  // Size discipline — trim largest sections until under the cap.
  let truncated = false;
  let bytes = serializedBytes(body);
  const trimOrder: Array<keyof Omit<BrainDigest, 'size_hint' | 'scope' | 'generated_at'>> = [
    'recent_commits',
    'recent_learnings',
    'open_suggestions',
    'open_briefs',
    'projects',
  ];
  for (const section of trimOrder) {
    if (bytes <= DIGEST_MAX_BYTES) break;
    // Halve the section repeatedly until it (or the whole digest) fits.
    while (bytes > DIGEST_MAX_BYTES && body[section].length > 0) {
      const next = Math.floor(body[section].length / 2);
      body[section] = body[section].slice(0, next) as never;
      truncated = true;
      bytes = serializedBytes(body);
    }
  }

  return {
    ...body,
    size_hint: { bytes, truncated },
  };
}
