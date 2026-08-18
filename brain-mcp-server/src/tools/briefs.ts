/**
 * Igris Brain -- Brief Tools
 *
 * Provides cross-project brief status tracking and dashboard.
 * Brief status is synced during /hunt, /rest, and /archive to
 * enable portfolio-wide brief visibility.
 *
 * Tools:
 * - igris_brief_sync: Store brief status change
 * - igris_brief_dashboard: Cross-project brief dashboard
 *
 * @module tools/briefs
 * @author fifty.dev
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db.js';
// FR-240 D1 — the pure `db`-param read layer. This file is the MCP WRAPPER over
// it; `briefs-read.ts` holds the SQL and imports no singleton, which is what
// lets the FR-238 dashboard reach the same queries with its own read-only
// handle. Do not move query logic back up here.
import { listBriefs, getBrief, searchBriefsByVector } from './briefs-read.js';
import {
  normalizePhase,
  normalizePriority,
  normalizeBriefType,
  normalizeStatus,
  nonCanonicalBriefTypeNote,
  nonCanonicalPriorityNote,
  nonCanonicalStatusNote,
  isTerminalBriefStatus,
} from './brief-normalize.js';
import { generateEmbedding, embeddingToBuffer, processInBatches, EMBEDDING_MODEL } from '../utils/embeddings.js';
import { isVectorSearchAvailable, insertEmbeddingInto, vectorSearchFrom } from '../utils/vector-search.js';
import { l2ToCosine } from '../utils/hybrid-search.js';

/** Input shape for igris_brief_sync */
interface BriefSyncInput {
  project: string;
  brief_id: string;
  brief_type?: string;
  title: string;
  status: string;
  priority?: string;
  effort?: string;
  phase?: string;
}

/** Input shape for igris_brief_dashboard */
interface BriefDashboardInput {
  status?: string;
  project?: string;
  summary_only?: boolean;
}

/** Input shape for igris_brief_get */
interface BriefGetInput {
  project: string;
  brief_id: string;
}

/** Input shape for igris_brief_list */
interface BriefListInput {
  project?: string;
  status?: string;
  brief_type?: string;
  priority?: string;
  include_content?: boolean;
  limit?: number;
  offset?: number;
}

/** Input shape for igris_brief_create */
interface BriefCreateInput {
  project: string;
  brief_id: string;
  title: string;
  content: string;
  filename?: string;
  brief_type?: string;
  status?: string;
  priority?: string;
  effort?: string;
  phase?: string;
  /**
   * Explicit parent brief id (e.g. "FR-051"). When omitted the briefs
   * component falls back to scanning the markdown for a `**Parent Brief:**`
   * header. Surfaced in the brief.created event payload so the edges
   * component can auto-create a parent_of edge (FR-105).
   */
  parent_brief?: string;
}

/**
 * Extract a parent brief id from markdown content.
 *
 * Recognizes the canonical Igris brief header format `**Parent Brief:** FR-XXX`
 * (and a few common variants: `Parent: FR-XXX`, `## Parent: FR-XXX`).
 * Returns the first match or null. Used by the briefs component to enrich
 * the brief.created event payload (FR-105 hook target).
 *
 * Exported for unit tests.
 */
export function extractParentBriefId(content: string): string | null {
  if (!content) return null;
  // Tolerant pattern: optional bold/heading prefix, "Parent" optionally
  // followed by " Brief", a colon, optional closing bold stars, then a
  // brief id (FR-/BR-/TD-/MG- + digits). In markdown bold the colon lives
  // BEFORE the closing `**` (`**Parent Brief:**`), so the colon is matched
  // before the optional trailing `\*?\*?`.
  const re = /(?:\*\*|^|\n)\s*(?:#+\s*)?\*?\*?Parent(?:\s+Brief)?:\*?\*?\s*([A-Z]{2,3}-\d+)/im;
  const match = re.exec(content);
  return match ? match[1] : null;
}

/** Input shape for igris_brief_update */
interface BriefUpdateInput {
  project: string;
  brief_id: string;
  content?: string;
  title?: string;
  status?: string;
  priority?: string;
  effort?: string;
  phase?: string;
  brief_type?: string;
  filename?: string;
}

/**
 * Resolve the ONE acceptance-criteria parser (TD-325).
 *
 * `core/scripts/brief_ac_check.sh` is the single implementation of the checkbox
 * grammar; `/hunt`, the commit-msg gate, the L3 validator and this note all read
 * it. Reimplementing the grammar in TypeScript here would create a SECOND
 * parser — and a second parser means a second population, which is the precise
 * failure TD-325 exists to remove (the cognition queue was a 45%-coverage index
 * of the same signal, and a cleared queue read as "handled"). So the note shells
 * out to the shared script rather than re-deriving its verdict.
 *
 * Path: the TD-096 runtime mirror at `~/.igris/core/scripts/`, which is the
 * stable location for a `core/` script at runtime. `IGRIS_AC_CHECK` overrides it
 * — that is what keeps the unit test hermetic instead of depending on whatever
 * the operator's mirror happens to contain.
 *
 * @returns an absolute path, or null when no parser is installed (fail-open)
 */
function resolveAcCheckScript(): string | null {
  const explicit = process.env.IGRIS_AC_CHECK;
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  const mirrored = join(homedir(), '.igris', 'core', 'scripts', 'brief_ac_check.sh');
  return existsSync(mirrored) ? mirrored : null;
}

/**
 * The AC-completion OBSERVER note (TD-325) — the fourth sibling of the three
 * `nonCanonical*Note` calls below. Informs; never rejects, never alters what
 * was stored.
 *
 * WHY THIS IS AN OBSERVER AND NOT A GATE — the argument, not the assumption.
 * Both of `/hunt`'s terminal syncs run AFTER the commit has landed: Phase 7
 * orders 7.1 phase=COMMITTING, 7.2 `git commit`, 7.4 status=Done, 7.5 sync;
 * Phase 8.2 then syncs phase=COMPLETE. A rejecting gate here cannot un-close
 * anything — it can only refuse to RECORD something already true in the world.
 * Refusing at 7.5 leaves a landed commit with the store saying open (C3
 * "committed-but-open"); refusing at 8.2 manufactures C1 "Done-but-not-COMPLETE"
 * — the exact contradiction TD-257 shipped that second sync to eliminate — and
 * TD-311 then forbids resolving C1 by editing brief data, so the operator is
 * trapped in a state the system will not let them leave. Either key makes the
 * store LESS truthful, which is the failure class TD-311 exists to prevent.
 *
 * The refusal therefore lives UPSTREAM of the commit, in
 * `scripts/git-hooks/commit-msg`, keyed on the `closes #<ID>` footer.
 *
 * Guarded on the STORED status (like its three siblings), TERMINAL only: a
 * mid-hunt sync says nothing, because unticked criteria mid-build are normal.
 *
 * Every failure mode returns null: no parser installed, no `brief_files` row,
 * no `brief_files` TABLE, a parser that hangs, a parser that errors. This runs
 * inside a WRITE path and must never be able to throw.
 *
 * @param db - the open brain handle (the row is already written when this runs)
 * @param project - project slug
 * @param briefId - brief id
 * @param storedStatus - the status as STORED, not the raw argument
 * @returns the note text, or null when there is nothing to say
 */
export function acGateNote(
  db: DatabaseType.Database,
  project: string,
  briefId: string,
  storedStatus: string | null | undefined,
): string | null {
  try {
    if (!isTerminalBriefStatus(storedStatus)) return null;

    const script = resolveAcCheckScript();
    if (script === null) return null;

    // Wrapped separately: a brain without `brief_files` (an old schema, a
    // partially-migrated remote) must be silent, not throw.
    let content: string | null = null;
    try {
      const row = db
        .prepare('SELECT content FROM brief_files WHERE project = ? AND brief_id = ? LIMIT 1')
        .get(project, briefId) as { content?: string } | undefined;
      content = row?.content ?? null;
    } catch {
      return null;
    }
    if (!content) return null;

    // The parser exits 1 on FAIL, which makes execFileSync throw; its stdout is
    // carried on the error object. Both paths are read the same way.
    let out = '';
    try {
      out = execFileSync('bash', [script, '--brief-id', briefId, '-'], {
        input: content,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? '';
    }

    const headline = out.split('\n', 1)[0] ?? '';
    if (!headline.includes('VERDICT=FAIL')) return null;

    return (
      `NOTE: ${briefId} reached a terminal status with unmet acceptance criteria.\n` +
      `      ${headline.trim()}\n` +
      '      The brief was stored EXACTLY as synced — this informs, it does not\n' +
      '      reject (TD-325). Resolve each criterion in the brief itself: tick it\n' +
      '      with cited evidence, or defer it explicitly as\n' +
      '      `- [~] **DEFERRED: <why>** -> TD-XXX`. A tick you cannot evidence is\n' +
      '      the record-invention TD-311 forbids.'
    );
  } catch {
    return null;
  }
}

/**
 * Sync a brief status change to the brain.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE to maintain one record per
 * project+brief_id without destroying columns not in the INSERT.
 * Called when brief status changes during /hunt, /rest, or /archive.
 *
 * @param args - Brief status data to sync
 * @returns MCP-formatted response confirming the sync
 */
function handleBriefSync(args: BriefSyncInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // TD-333: `status` is the canonical build-state source and had no normalizer
  // until now. The `?? args.status` tail is not defensive noise: normalizeStatus
  // returns null ONLY for a null/undefined input, so this preserves the
  // pre-TD-333 binding EXACTLY for a caller that omitted the (schema-required)
  // field, instead of turning it into a NOT NULL constraint error.
  const storedStatus = normalizeStatus(args.status) ?? args.status;

  // Same shape for the two sibling vocabulary fields, so every echo below can
  // report the STORED value rather than the raw argument. These must be
  // guarded on the STORED value, not the arg: the unset family ('Unset', '')
  // is TRUTHY but folds to null, so an inline
  // `args.priority ? \`Priority: ${normalizePriority(args.priority)}\``
  // would print the literal `Priority: null`. Hoisting also collapses what
  // were three separate normalizePriority(args.priority) calls (the insert,
  // the note, and the echo) into one.
  const storedPriority = normalizePriority(args.priority);
  const storedPhase = normalizePhase(args.phase);
  const storedBriefType = normalizeBriefType(args.brief_type);

  db.prepare(`
    INSERT INTO brief_status
      (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project, brief_id) DO UPDATE SET
      brief_type = excluded.brief_type,
      title = excluded.title,
      status = excluded.status,
      priority = excluded.priority,
      effort = excluded.effort,
      phase = excluded.phase,
      updated_at = excluded.updated_at
  `).run(
    args.project,
    args.brief_id,
    // TD-238: normalize metadata only (phase/brief_type/priority); never content.
    storedBriefType,
    args.title,
    storedStatus,
    storedPriority,
    args.effort ?? null,
    storedPhase
  );

  // TD-328 D6(c) / TD-338 / TD-333: report a non-canonical STORED value back to
  // the caller, for each of the three vocabulary fields. Informs; never rejects,
  // never alters what was stored. `nonCanonicalPriorityNote` shipped with
  // TD-338 and had ZERO callers until TD-333 wired it here.
  const typeNote = nonCanonicalBriefTypeNote(storedBriefType);
  const priorityNote = nonCanonicalPriorityNote(storedPriority);
  const statusNote = nonCanonicalStatusNote(storedStatus);
  // TD-325: the fourth note. Same posture as the three above — guarded on the
  // STORED value, informs without rejecting — but it reads the brief's CONTENT
  // rather than a metadata field, so it needs the db handle and the ids. It is
  // the accumulation net for a close that never produces a commit (/archive, a
  // direct sync, the dashboard, remote sync), which the commit-msg gate is
  // structurally unable to see. See acGateNote for why it does not reject.
  const acNote = acGateNote(db, args.project, args.brief_id, storedStatus);

  return {
    content: [{
      type: 'text',
      text: [
        'Brief status synced successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Title: ${args.title}`,
        // TD-333: echo what was STORED, not the raw argument. This line printed
        // `args.status` before, so a caller that synced `Completed` was told
        // `Status: Completed` while the row held `Done` — a response that
        // contradicts the store is worse than no response at all. The same was
        // true one line down for `priority` and `phase`, which echoed raw while
        // storing normalized, so they now follow the same rule. `effort` is
        // stored verbatim (no normalizer), so echoing the arg IS the stored
        // value there.
        `Status: ${storedStatus}`,
        storedPriority ? `Priority: ${storedPriority}` : null,
        args.effort ? `Effort: ${args.effort}` : null,
        storedPhase ? `Phase: ${storedPhase}` : null,
        typeNote ? `\n${typeNote}` : null,
        priorityNote ? `\n${priorityNote}` : null,
        statusNote ? `\n${statusNote}` : null,
        acNote ? `\n${acNote}` : null,
      ].filter(Boolean).join('\n'),
    }],
  };
}

/**
 * Display a cross-project brief dashboard.
 *
 * Shows all tracked briefs with status counts. Supports filtering
 * by status and project.
 *
 * @param args - Optional filters for status and project
 * @returns MCP-formatted response with dashboard
 */
function handleBriefDashboard(args: BriefDashboardInput): { content: { type: string; text: string }[] } {
  const db = getDb();

  // Build WHERE clause for main query
  const conditions: string[] = [];
  const params: string[] = [];

  if (args.status) {
    conditions.push('bs.status = ?');
    params.push(args.status);
  }
  if (args.project) {
    conditions.push('bs.project = ?');
    params.push(args.project);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Summary counts (project filter only, not status filter)
  const summaryConditions: string[] = [];
  const summaryParams: string[] = [];
  if (args.project) {
    summaryConditions.push('project = ?');
    summaryParams.push(args.project);
  }
  const summaryWhere = summaryConditions.length > 0 ? `WHERE ${summaryConditions.join(' AND ')}` : '';

  const summaryCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM brief_status
    ${summaryWhere}
    GROUP BY status
    ORDER BY count DESC
  `).all(...summaryParams) as Record<string, unknown>[];

  if (summaryCounts.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No briefs tracked. Brief status is synced when briefs change status during /hunt, /rest, or /archive.',
      }],
    };
  }

  // Format summary by status
  const summaryLines = summaryCounts.map(s => `- ${s.status}: ${s.count}`);

  // Priority breakdown (project filter only, not status filter)
  const priorityCounts = db.prepare(`
    SELECT priority, COUNT(*) as count
    FROM brief_status
    ${summaryWhere}
    GROUP BY priority
    ORDER BY count DESC
  `).all(...summaryParams) as Record<string, unknown>[];

  const priorityLines = priorityCounts.map(p => `- ${p.priority || 'Unset'}: ${p.count}`);

  // Total count
  const totalCount = summaryCounts.reduce((sum, s) => sum + (s.count as number), 0);

  // Build filter description
  const filters: string[] = [];
  if (args.status) filters.push(`status=${args.status}`);
  if (args.project) filters.push(`project=${args.project}`);
  const filterDesc = filters.length > 0 ? ` (filtered: ${filters.join(', ')})` : '';

  // If summary_only, return just the counts — no full brief table
  if (args.summary_only) {
    return {
      content: [{
        type: 'text',
        text: [
          `# Brief Dashboard Summary${filterDesc}`,
          '',
          `Total: ${totalCount}`,
          '',
          '## By Status',
          ...summaryLines,
          '',
          '## By Priority',
          ...priorityLines,
        ].join('\n'),
      }],
    };
  }

  // Full dashboard: query all briefs for the table
  const rows = db.prepare(`
    SELECT bs.project, bs.brief_id, bs.brief_type, bs.title, bs.status,
           bs.priority, bs.effort, bs.phase, bs.updated_at,
           p.name as project_name
    FROM brief_status bs
    LEFT JOIN projects p ON p.slug = bs.project
    ${whereClause}
    ORDER BY bs.updated_at DESC
  `).all(...params) as Record<string, unknown>[];

  // Format table
  const header = '| Project | Brief | Type | Title | Status | Priority | Phase | Updated |';
  const separator = '|---------|-------|------|-------|--------|----------|-------|---------|';
  const tableRows = rows.map(r =>
    `| ${r.project_name || r.project} | ${r.brief_id} | ${r.brief_type || '-'} | ${r.title} | ${r.status} | ${r.priority || '-'} | ${r.phase || '-'} | ${r.updated_at} |`
  );

  return {
    content: [{
      type: 'text',
      text: [
        `# Cross-Project Brief Dashboard${filterDesc}`,
        '',
        '## Summary',
        ...summaryLines,
        '',
        '## By Priority',
        ...priorityLines,
        '',
        `## Briefs (${rows.length})`,
        header,
        separator,
        ...tableRows,
      ].join('\n'),
    }],
  };
}

/**
 * Get a single brief by project and brief_id.
 *
 * JOINs brief_files and brief_status to return content + metadata.
 * Falls back to brief_status alone when no brief_files row exists.
 *
 * @param args - Project slug and brief ID
 * @returns MCP-formatted response with brief data
 */
function handleBriefGet(args: BriefGetInput): { content: { type: string; text: string }[] } {
  if (!args.project || !args.brief_id) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project" and "brief_id" are required.',
      }],
    };
  }

  // FR-240 D1: the SQL lives in `briefs-read.ts#getBrief` so the dashboard can
  // reach the SAME query with its own read-only handle. This wrapper owns only
  // the handle, the validation above, and the wire format below.
  const record = getBrief(getDb(), args.project, args.brief_id);

  if (record === null) {
    return {
      content: [{
        type: 'text',
        text: `Brief not found: ${args.brief_id} in project ${args.project}`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(record, null, 2),
    }],
  };
}

/**
 * List briefs with optional filters.
 *
 * Supports filtering by project, status, brief_type, and priority.
 * Optionally includes full content via LEFT JOIN to brief_files.
 *
 * @param args - Optional filters and include_content flag
 * @returns MCP-formatted response with brief array
 */
function handleBriefList(args: BriefListInput): { content: { type: string; text: string }[] } {
  // FR-240 D1: pagination resolution, filter binding and the SELECTs all live
  // in `briefs-read.ts#listBriefs`. The returned object IS the wire payload —
  // its key order is the contract the calling SKILLS parse (see briefs-read.ts's
  // note on how to re-derive that list rather than trust it), and
  // `__tests__/wrapper-wire-parity.test.ts` pins it.
  const result = listBriefs(getDb(), {
    project: args.project,
    status: args.status,
    brief_type: args.brief_type,
    priority: args.priority,
    include_content: args.include_content,
    limit: args.limit,
    offset: args.offset,
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
  };
}

/**
 * The next unused id in a brief id's own prefix family, or null when the id is
 * not of the form `PREFIX-NNN`.
 *
 * TD-395. The collision refusal below is only useful if it also hands back the
 * id to re-mint on: a caller made to re-derive it re-runs the very read that
 * lost the race. Counted over BOTH tables — a body-less `brief_status` row
 * (what `igris_brief_sync` and a remote pull leave behind) still holds its id,
 * and handing that id out as free would mint the next collision.
 *
 * The width of the incoming id is preserved, so `TD-0001` yields `TD-0002`.
 * `Math.max(max, incoming)` keeps the helper total for a caller that asks
 * about an id which is not stored at all; on the refusal path the colliding id
 * is present by construction, so `max` already covers it.
 *
 * Exported for the unit tests in `__tests__/brief-create-collision.test.ts`.
 */
export function nextFreeBriefId(
  db: DatabaseType.Database,
  project: string,
  briefId: string,
): string | null {
  const shape = /^([A-Za-z]+)-(\d+)$/.exec(briefId);
  if (!shape) return null;
  const [, prefix, digits] = shape;
  const like = `${prefix}-%`;

  const rows = db.prepare(`
    SELECT brief_id FROM brief_status WHERE project = ? AND brief_id LIKE ?
    UNION
    SELECT brief_id FROM brief_files  WHERE project = ? AND brief_id LIKE ?
  `).all(project, like, project, like) as { brief_id: string }[];

  let max = 0;
  for (const row of rows) {
    const found = /^[A-Za-z]+-(\d+)$/.exec(row.brief_id);
    if (found) max = Math.max(max, Number(found[1]));
  }

  const next = Math.max(max, Number(digits)) + 1;
  return `${prefix}-${String(next).padStart(digits.length, '0')}`;
}

/**
 * Create a new brief with content and metadata.
 *
 * Inserts into both brief_files and brief_status inside ONE transaction, then
 * auto-embeds the brief for similarity search and warns if similar briefs are
 * detected (>= 0.85 cosine similarity).
 *
 * REFUSES (TD-395) when a row already exists for (project, brief_id) whose
 * content hash DIFFERS — that is a minting collision, and both statements
 * below are upserts, so without the refusal the existing brief is destroyed
 * silently. An identical re-create still succeeds.
 *
 * @param args - Brief data including project, brief_id, title, content
 * @returns MCP-formatted response confirming creation, or the refusal
 */
async function handleBriefCreate(args: BriefCreateInput): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  if (!args.project || !args.brief_id || !args.title || !args.content) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project", "brief_id", "title", and "content" are required.',
      }],
    };
  }

  const db = getDb();
  const contentHash = createHash('sha256').update(args.content).digest('hex');
  const fileId = randomUUID();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const filename = args.filename ?? `${args.brief_id}.md`;
  // TD-333: normalize at the MINT surface too. `?? 'Ready'` runs FIRST so an
  // omitted status still defaults exactly as before, then the default (which is
  // canonical) passes through the normalizer unchanged.
  const status = normalizeStatus(args.status ?? 'Ready') ?? 'Ready';

  // TD-395 — the create-collision guard, and the ONLY early return between here
  // and the transaction, so a refusal leaves both tables untouched.
  //
  // Keyed on CONTENT, deliberately: an identical re-create is a replay, not a
  // collision, and `/register` plus the offline `sync data` drain depend on it
  // succeeding. A matching hash with different metadata also upserts — that is
  // the metadata-only repair path TD-402's recovery needed, and it can lose no
  // content. A `brief_status` row with no `brief_files` row is likewise not
  // guarded: it holds no content to destroy, and refusing there would break the
  // legitimate "status arrived first (remote pull / `igris_brief_sync`), body
  // follows" path.
  const existingFile = db.prepare(
    'SELECT content_hash FROM brief_files WHERE project = ? AND brief_id = ?',
  ).get(args.project, args.brief_id) as { content_hash: string } | undefined;

  if (existingFile && existingFile.content_hash !== contentHash) {
    const existingStatus = db.prepare(
      'SELECT title FROM brief_status WHERE project = ? AND brief_id = ?',
    ).get(args.project, args.brief_id) as { title: string } | undefined;
    const freeId = nextFreeBriefId(db, args.project, args.brief_id);

    return {
      isError: true,
      content: [{
        type: 'text',
        text: [
          `Refused: brief id collision. ${args.brief_id} already exists in ${args.project} with DIFFERENT content.`,
          '',
          `Existing title: ${existingStatus?.title ?? '(brief_status has no row for this id)'}`,
          `Existing content hash: ${existingFile.content_hash.substring(0, 12)}`,
          `Your content hash:     ${contentHash.substring(0, 12)}`,
          '',
          'Nothing was written. brief_files and brief_status both still hold the',
          'existing brief. Another session minted this id between your read and',
          'your write (TD-395).',
          '',
          freeId
            ? `Re-mint on the next free id: ${freeId}`
            : `${args.brief_id} is not a PREFIX-NNN id, so no successor can be derived — pick a free id yourself.`,
          'Then call igris_brief_create again with that brief_id. Re-creating the',
          'SAME content under this id is not a collision and still succeeds.',
        ].join('\n'),
      }],
    };
  }

  db.transaction(() => {
    // Upsert brief_files
    db.prepare(`
      INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, brief_id) DO UPDATE SET
        filename = excluded.filename,
        content = excluded.content,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(fileId, args.project, args.brief_id, filename, args.content, contentHash, now);

    // Upsert brief_status
    db.prepare(`
      INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, brief_id) DO UPDATE SET
        brief_type = excluded.brief_type,
        title = excluded.title,
        status = excluded.status,
        priority = excluded.priority,
        effort = excluded.effort,
        phase = excluded.phase,
        updated_at = excluded.updated_at
    `).run(
      args.project,
      args.brief_id,
      // TD-238: normalize metadata only (phase/brief_type/priority); content
      // (the brief_files INSERT above) is never touched.
      normalizeBriefType(args.brief_type),
      args.title,
      status,
      normalizePriority(args.priority),
      args.effort ?? null,
      normalizePhase(args.phase),
      now
    );
  })();

  // Get the brief_status.id (integer PK) for embedding storage
  const statusRow = db.prepare(
    'SELECT id FROM brief_status WHERE project = ? AND brief_id = ?',
  ).get(args.project, args.brief_id) as { id: number } | undefined;

  // Auto-embed and similarity check (non-blocking on failure)
  let embeddingNote = '';
  let similarityWarning = '';

  try {
    if (statusRow && isVectorSearchAvailable(db)) {
      const textToEmbed = extractBriefProblem(args.title, args.content);
      const embedding = await generateEmbedding(textToEmbed);

      // Store embedding in brief_status
      db.prepare('UPDATE brief_status SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, statusRow.id);

      // Insert into briefs_vec
      insertEmbeddingInto(db, 'briefs_vec', statusRow.id, embedding);
      embeddingNote = '\nEmbedding: generated';

      // Check for similar briefs
      const vecResults = vectorSearchFrom(db, 'briefs_vec', embedding, 10);
      const similarBriefs: { brief_id: string; title: string; similarity: number }[] = [];

      for (const result of vecResults) {
        // Skip self
        if (result.rowid === statusRow.id) continue;

        const similarity = l2ToCosine(result.distance);
        if (similarity >= 0.85) {
          const row = db.prepare(
            'SELECT brief_id, title FROM brief_status WHERE id = ?',
          ).get(result.rowid) as { brief_id: string; title: string } | undefined;
          if (row) {
            similarBriefs.push({
              brief_id: row.brief_id,
              title: row.title,
              similarity,
            });
          }
        }
      }

      if (similarBriefs.length > 0) {
        const warnings = similarBriefs.map(
          b => `- ${b.brief_id}: ${b.title} (similarity: ${b.similarity.toFixed(4)})`,
        );
        similarityWarning = `\n\nWARNING: ${similarBriefs.length} similar brief(s) detected (similarity >= 0.85):\n${warnings.join('\n')}`;
      }
    }
  } catch (err) {
    console.error('[briefs] Auto-embed failed for brief', args.brief_id, ':', err);
    embeddingNote = '\nEmbedding: skipped (will be generated on backfill)';
  }

  // TD-328 D6(c): the mint surface is where a 51st spelling is born, so this is
  // the highest-value place to report one. Informs; never rejects. TD-333 adds
  // the status twin and wires TD-338's priority twin, which had no callers.
  const typeNote = nonCanonicalBriefTypeNote(normalizeBriefType(args.brief_type));
  const priorityNote = nonCanonicalPriorityNote(normalizePriority(args.priority));
  const statusNote = nonCanonicalStatusNote(status);

  return {
    content: [{
      type: 'text',
      text: [
        'Brief created successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Title: ${args.title}`,
        `Status: ${status}`,
        `Content hash: ${contentHash.substring(0, 12)}...`,
        `Size: ${args.content.length} chars`,
      ].join('\n') + embeddingNote + similarityWarning +
        (typeNote ? `\n\n${typeNote}` : '') +
        (priorityNote ? `\n\n${priorityNote}` : '') +
        (statusNote ? `\n\n${statusNote}` : ''),
    }],
  };
}

/**
 * Update an existing brief's content and/or metadata.
 *
 * Only updates fields that are provided. Uses a transaction to update
 * brief_files (if content provided) and brief_status (if metadata provided).
 * Uses a whitelist for brief_status columns to prevent SQL injection.
 *
 * @param args - Project, brief_id, and optional fields to update
 * @returns MCP-formatted response confirming what was updated
 */
function handleBriefUpdate(args: BriefUpdateInput): { content: { type: string; text: string }[] } {
  if (!args.project || !args.brief_id) {
    return {
      content: [{
        type: 'text',
        text: 'Error: "project" and "brief_id" are required.',
      }],
    };
  }

  const db = getDb();

  // Check brief exists in either table
  const existsInFiles = db.prepare(
    'SELECT 1 FROM brief_files WHERE project = ? AND brief_id = ?'
  ).get(args.project, args.brief_id);

  const existsInStatus = db.prepare(
    'SELECT 1 FROM brief_status WHERE project = ? AND brief_id = ?'
  ).get(args.project, args.brief_id);

  if (!existsInFiles && !existsInStatus) {
    return {
      content: [{
        type: 'text',
        text: `Brief not found: ${args.brief_id} in project ${args.project}`,
      }],
    };
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const updated: string[] = [];

  db.transaction(() => {
    // Update brief_files if content or filename provided
    if (args.content !== undefined || args.filename !== undefined) {
      if (args.content !== undefined) {
        const contentHash = createHash('sha256').update(args.content).digest('hex');

        if (existsInFiles) {
          // Update existing row
          const setClauses: string[] = ['content = ?', 'content_hash = ?', 'updated_at = ?'];
          const setValues: unknown[] = [args.content, contentHash, now];

          if (args.filename !== undefined) {
            setClauses.push('filename = ?');
            setValues.push(args.filename);
          }

          db.prepare(`
            UPDATE brief_files SET ${setClauses.join(', ')}
            WHERE project = ? AND brief_id = ?
          `).run(...setValues, args.project, args.brief_id);
        } else {
          // Insert new row
          const fileId = randomUUID();
          const filename = args.filename ?? `${args.brief_id}.md`;
          db.prepare(`
            INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(fileId, args.project, args.brief_id, filename, args.content, contentHash, now);
        }
        updated.push('content');
      } else if (args.filename !== undefined && existsInFiles) {
        db.prepare(`
          UPDATE brief_files SET filename = ?, updated_at = ?
          WHERE project = ? AND brief_id = ?
        `).run(args.filename, now, args.project, args.brief_id);
        updated.push('filename');
      }
    }

    // Update brief_status if metadata fields provided
    // Whitelist of allowed columns to prevent SQL injection.
    // TD-238 + TD-333: normalize the four VOCABULARY fields
    // (phase/brief_type/priority/status) and ONLY when the field was actually
    // provided — preserve partial-update semantics (an undefined field stays
    // undefined so the loop below skips it; never turn a not-provided field
    // into an explicit null write). CONTENT and TITLE are still never
    // normalized: they are free text with no canonical vocabulary. `status`
    // WAS in that sentence until TD-333 gave it one.
    const allowedColumns: Record<string, unknown> = {
      title: args.title,
      status: args.status !== undefined ? normalizeStatus(args.status) : undefined,
      priority: args.priority !== undefined ? normalizePriority(args.priority) : undefined,
      effort: args.effort,
      phase: args.phase !== undefined ? normalizePhase(args.phase) : undefined,
      brief_type: args.brief_type !== undefined ? normalizeBriefType(args.brief_type) : undefined,
    };

    const setClauses: string[] = [];
    const setValues: unknown[] = [];

    for (const [col, val] of Object.entries(allowedColumns)) {
      if (val !== undefined) {
        setClauses.push(`${col} = ?`);
        setValues.push(val);
        updated.push(col);
      }
    }

    if (setClauses.length > 0) {
      setClauses.push('updated_at = ?');
      setValues.push(now);

      if (existsInStatus) {
        db.prepare(`
          UPDATE brief_status SET ${setClauses.join(', ')}
          WHERE project = ? AND brief_id = ?
        `).run(...setValues, args.project, args.brief_id);
      } else {
        // Insert a new brief_status row with provided fields
        db.prepare(`
          INSERT INTO brief_status (project, brief_id, title, status, priority, effort, phase, brief_type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          args.project,
          args.brief_id,
          args.title ?? '',
          // TD-333: same shape as `_create` — default first, then normalize.
          normalizeStatus(args.status ?? 'Ready') ?? 'Ready',
          // TD-238: normalize metadata only (phase/brief_type/priority/status).
          normalizePriority(args.priority),
          args.effort ?? null,
          normalizePhase(args.phase),
          normalizeBriefType(args.brief_type),
          now
        );
        updated.push('brief_status (created)');
      }
    }
  })();

  if (updated.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No fields to update for brief ${args.brief_id} in project ${args.project}. Provide at least one field to update.`,
      }],
    };
  }

  // TD-328 D6(c): only when the field was actually part of this update —
  // re-typing a brief is the other way a non-canonical value enters the store.
  // TD-333 adds the status and priority twins on the same "only if provided"
  // condition, so an update that never mentions a field says nothing about it.
  const typeNote =
    args.brief_type !== undefined
      ? nonCanonicalBriefTypeNote(normalizeBriefType(args.brief_type))
      : null;
  const priorityNote =
    args.priority !== undefined
      ? nonCanonicalPriorityNote(normalizePriority(args.priority))
      : null;
  const statusNote =
    args.status !== undefined ? nonCanonicalStatusNote(normalizeStatus(args.status)) : null;

  return {
    content: [{
      type: 'text',
      text: [
        'Brief updated successfully.',
        '',
        `Project: ${args.project}`,
        `Brief: ${args.brief_id}`,
        `Updated fields: ${updated.join(', ')}`,
        typeNote ? `\n${typeNote}` : null,
        priorityNote ? `\n${priorityNote}` : null,
        statusNote ? `\n${statusNote}` : null,
      ].filter(Boolean).join('\n'),
    }],
  };
}

// ---------------------------------------------------------------------------
// Brief Velocity (FR-079)
// ---------------------------------------------------------------------------

/** Input shape for brief velocity query */
interface BriefVelocityInput {
  /** Optional project slug filter */
  project?: string;
  /** Number of weeks to include (default 4, max 52) */
  weeks?: number;
}

/** Output shape for brief velocity query */
interface BriefVelocityOutput {
  project: string | null;
  weeks: number;
  weekly: { week: string; completed: number }[];
  completion_rate: { done: number; total: number; percentage: number };
  trend: { current_week: number; previous_week: number; change_pct: number | null; direction: string } | null;
}

/**
 * Compute brief completion velocity metrics.
 *
 * Returns weekly completion counts, overall completion rate, and a week-over-week
 * trend indicator. All queries use parameterized statements against `brief_status`.
 */
function handleBriefVelocity(input?: BriefVelocityInput): BriefVelocityOutput {
  const db = getDb();
  const projectFilter = input?.project;
  const weeks = Math.min(52, Math.max(1, input?.weeks ?? 4));

  // Build optional project filter clause
  const projectCondition = projectFilter ? ' AND project = ?' : '';
  const projectParams = projectFilter ? [projectFilter] : [];

  // 1. Weekly completions — Done briefs grouped by ISO week, last N weeks
  const weeklyRows = db.prepare(
    `SELECT strftime('%Y-W%W', updated_at) AS week, COUNT(*) AS completed
     FROM brief_status
     WHERE status = 'Done'
       AND updated_at >= datetime('now', '-' || ? || ' days')${projectCondition}
     GROUP BY week
     ORDER BY week ASC`
  ).all(weeks * 7, ...projectParams) as { week: string; completed: number }[];

  // 2. Completion rate — Done vs total (optionally filtered by project)
  const totalRow = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'Done' THEN 1 ELSE 0 END) AS done,
       COUNT(*) AS total
     FROM brief_status
     WHERE 1=1${projectCondition}`
  ).get(...projectParams) as { done: number; total: number } | undefined;

  const done = totalRow?.done ?? 0;
  const total = totalRow?.total ?? 0;
  const percentage = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;

  // 3. Trend — compare last 7 days vs 7-14 days ago
  const currentWeekRow = db.prepare(
    `SELECT COUNT(*) AS count FROM brief_status
     WHERE status = 'Done'
       AND updated_at >= datetime('now', '-7 days')${projectCondition}`
  ).get(...projectParams) as { count: number } | undefined;

  const previousWeekRow = db.prepare(
    `SELECT COUNT(*) AS count FROM brief_status
     WHERE status = 'Done'
       AND updated_at >= datetime('now', '-14 days')
       AND updated_at < datetime('now', '-7 days')${projectCondition}`
  ).get(...projectParams) as { count: number } | undefined;

  const currentWeek = currentWeekRow?.count ?? 0;
  const previousWeek = previousWeekRow?.count ?? 0;

  let trend: BriefVelocityOutput['trend'] = null;
  if (currentWeek > 0 || previousWeek > 0) {
    let changePct: number | null = null;
    let direction = 'flat';
    if (previousWeek > 0) {
      changePct = Math.round(((currentWeek - previousWeek) / previousWeek) * 1000) / 10;
      direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
    } else if (currentWeek > 0) {
      // Previous week was zero, current is positive — "up" but no meaningful percentage
      changePct = null;
      direction = 'up';
    }
    trend = { current_week: currentWeek, previous_week: previousWeek, change_pct: changePct, direction };
  }

  return {
    project: projectFilter ?? null,
    weeks,
    weekly: weeklyRows,
    completion_rate: { done, total, percentage },
    trend,
  };
}

// ---------------------------------------------------------------------------
// Brief Similarity Detection (FR-094)
// ---------------------------------------------------------------------------

/** Input shape for igris_brief_similar */
interface BriefSimilarInput {
  query: string;
  project?: string;
  threshold?: number;
  limit?: number;
}

/** Input shape for backfill tools */
interface BriefBackfillInput {
  batch_size?: number;
  project?: string;
}

/**
 * Extract the problem/intent text from a brief's content for embedding.
 *
 * Looks for a `## Problem` or `## Problem Statement` section and extracts
 * the text up to the next heading. Falls back to the first 500 characters
 * of content if no structured section is found.
 *
 * @param title - The brief title
 * @param content - The full brief content (markdown)
 * @returns Combined text suitable for embedding
 */
function extractBriefProblem(title: string, content: string): string {
  // Try to find ## Problem or ## Problem Statement section
  const problemMatch = content.match(
    /##\s+Problem(?:\s+Statement)?\s*\n([\s\S]*?)(?=\n##\s|\n---\s|$)/i,
  );

  const problemText = problemMatch
    ? problemMatch[1].trim()
    : content.substring(0, 500).trim();

  return `${title} ${problemText}`;
}

/**
 * Find briefs that are semantically similar to a query — MCP wrapper.
 *
 * FR-246 D1-b: the query body moved DOWN to
 * `briefs-read.ts#searchBriefsByVector`; this handler keeps exactly two things,
 * which is what a wrapper is for — it resolves the handle and it renders the
 * prose. Every sentence below is byte-identical to the pre-extraction version
 * and is pinned by `__tests__/wrapper-wire-parity.test.ts`, because `/register`
 * reads this output to decide whether a brief is a duplicate.
 *
 * **This tool stays PURE VECTOR** while `/api/briefs/search` is hybrid. The
 * reason is in the threshold: it accepts a candidate at cosine similarity
 * `>= 0.85`, and a BM25 hit has no cosine similarity to compare. Adding a
 * lexical arm here would not "improve" dup detection, it would feed it rows it
 * cannot score. See the FR-246 note at the head of the reader pair.
 *
 * @param args - Search parameters
 * @returns MCP-formatted response with similar briefs
 */
async function handleBriefSimilar(args: BriefSimilarInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const threshold = args.threshold ?? 0.85;
  const limit = args.limit ?? 5;

  const result = await searchBriefsByVector(db, {
    query: args.query,
    project: args.project,
    threshold,
    limit,
  });

  const say = (text: string) => ({ content: [{ type: 'text', text }] });

  switch (result.status) {
    case 'vector_unavailable':
      return say('Brief similarity search unavailable: sqlite-vec extension is not loaded.');

    case 'vector_table_absent':
      // The one NEW sentence (see `BriefVectorSearchResult`'s doc comment): this
      // state used to throw, so no consumer can have depended on the old output.
      return say('Brief similarity search unavailable: briefs_vec index is absent on this brain.');

    case 'embeddings_unavailable':
      // BR-070: a clean capability message rather than a leaked
      // ERR_MODULE_NOT_FOUND.
      return say('Brief similarity search unavailable: embeddings backend not loaded (semantic search disabled, keyword search still available).');

    case 'embedding_failed':
      return say(`Failed to generate embedding for query: ${result.error}`);

    case 'no_vector_hits':
      return say('No similar briefs found.');

    case 'below_threshold':
      return say(`No briefs found above similarity threshold (${threshold}).`);

    case 'ok': {
      const results = result.matches.map((match) => {
        const row = match.row ?? {};
        return [
          `--- Similarity: ${match.similarity.toFixed(4)} ---`,
          `Brief: ${row.brief_id}`,
          `Project: ${row.project}`,
          `Title: ${row.title}`,
          `Status: ${row.status}`,
          `Priority: ${row.priority || '(none)'}`,
          `Type: ${row.brief_type || '(none)'}`,
        ].join('\n');
      });

      if (results.length === 0) {
        // Reached when a project filter dropped every threshold-passing row.
        return say(
          args.project
            ? `No similar briefs found in project "${args.project}" above threshold (${threshold}).`
            : `No briefs found above similarity threshold (${threshold}).`,
        );
      }

      return say(
        `Found ${results.length} similar brief(s) (threshold >= ${threshold}):\n\n${results.join('\n\n')}`,
      );
    }
  }
}

/**
 * Batch-embed existing briefs that lack embeddings.
 *
 * Processes briefs where brief_status.embedding IS NULL in batches,
 * generating embeddings from brief_files content and storing them in
 * both the brief_status.embedding column and the briefs_vec virtual table.
 *
 * @param args - Optional batch_size and project filter
 * @returns MCP-formatted response with processing summary
 */
async function handleBriefBackfillEmbeddings(args: BriefBackfillInput): Promise<{ content: { type: string; text: string }[] }> {
  const db = getDb();
  const batchSize = args.batch_size ?? 50;

  if (!isVectorSearchAvailable(db)) {
    return {
      content: [{
        type: 'text',
        text: 'Backfill skipped: sqlite-vec extension is not available. Vector search is disabled.',
      }],
    };
  }

  let sql = `
    SELECT bs.id, bs.brief_id, bs.title, bf.content
    FROM brief_status bs
    JOIN brief_files bf ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bs.embedding IS NULL
  `;
  const params: unknown[] = [];
  if (args.project) {
    sql += ' AND bs.project = ?';
    params.push(args.project);
  }
  sql += ' ORDER BY bs.id LIMIT ?';

  const briefs = db.prepare(sql).all(...params, batchSize) as { id: number; brief_id: string; title: string; content: string }[];

  if (briefs.length === 0) {
    let countSql = `
      SELECT COUNT(*) as total
      FROM brief_status bs
      JOIN brief_files bf ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    `;
    const countParams: unknown[] = [];
    if (args.project) {
      countSql += ' WHERE bs.project = ?';
      countParams.push(args.project);
    }
    const countRow = db.prepare(countSql).get(...countParams) as { total: number };

    return {
      content: [{
        type: 'text',
        text: `Backfill complete -- all ${countRow.total} briefs already have embeddings.`,
      }],
    };
  }

  const startTime = Date.now();

  const { succeeded: processed, failed } = await processInBatches(
    briefs,
    async (brief) => {
      const textToEmbed = extractBriefProblem(brief.title, brief.content);
      const embedding = await generateEmbedding(textToEmbed);
      db.prepare('UPDATE brief_status SET embedding = ?, embedding_model = ? WHERE id = ?')
        .run(embeddingToBuffer(embedding), EMBEDDING_MODEL, brief.id);
      insertEmbeddingInto(db, 'briefs_vec', brief.id, embedding);
    },
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check remaining
  let remainingSql = `
    SELECT COUNT(*) as remaining
    FROM brief_status bs
    JOIN brief_files bf ON bs.project = bf.project AND bs.brief_id = bf.brief_id
    WHERE bs.embedding IS NULL
  `;
  const remainingParams: unknown[] = [];
  if (args.project) {
    remainingSql += ' AND bs.project = ?';
    remainingParams.push(args.project);
  }
  const remainingRow = db.prepare(remainingSql).get(...remainingParams) as { remaining: number };

  return {
    content: [{
      type: 'text',
      text: `Backfill batch complete.\n\nProcessed: ${processed}\nFailed: ${failed}\nRemaining: ${remainingRow.remaining}\nTime: ${elapsed}s\n\n${remainingRow.remaining > 0 ? 'Run again to process more.' : 'All briefs now have embeddings.'}`,
    }],
  };
}

export {
  handleBriefSync,
  handleBriefDashboard,
  handleBriefGet,
  handleBriefList,
  handleBriefCreate,
  handleBriefUpdate,
  handleBriefVelocity,
  handleBriefSimilar,
  handleBriefBackfillEmbeddings,
  extractBriefProblem,
};
export type {
  BriefSyncInput,
  BriefDashboardInput,
  BriefGetInput,
  BriefListInput,
  BriefCreateInput,
  BriefUpdateInput,
  BriefVelocityInput,
  BriefVelocityOutput,
  BriefSimilarInput,
  BriefBackfillInput,
};
