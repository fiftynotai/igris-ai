/**
 * TD-057 — Backfill entity_edges from existing brief markdown.
 *
 * Scans every row in `brief_files.content` for relationship signals and
 * emits the corresponding `entity_edges` rows via `handleEdgeCreate`. The
 * handler is idempotent via the UNIQUE constraint over (from_type, from_id,
 * to_type, to_id, edge_type), so re-running this script produces zero new
 * inserts. Edges are tagged `provenance='backfill'` so analytics can
 * distinguish backfilled from runtime-created edges.
 *
 * Patterns detected (all anchored to bold labels to avoid prose false positives):
 *   **Parent Brief:** XX-NNN     -> parent_of   (we are the child; edge written child -> parent)
 *   **Hard:** XX-NNN[, XX-NNN]   -> depends_on
 *   **Soft:** XX-NNN[, XX-NNN]   -> related_to
 *   **Blocks:** XX-NNN[, XX-NNN] -> blocks       (this brief blocks listed)
 *   **Blocked by:** XX-NNN       -> blocks       (REVERSE: listed brief blocks this)
 *   **Supersedes:** XX-NNN       -> supersedes
 *   **Goal:** GL-NNN             -> serves_goal  (to_type='goal', conf=1.0)
 *
 * Usage:
 *   npx tsx scripts/backfill_brief_edges.ts                       # all projects, write
 *   npx tsx scripts/backfill_brief_edges.ts --dry-run             # preview only
 *   npx tsx scripts/backfill_brief_edges.ts --project igris-ai
 *   npx tsx scripts/backfill_brief_edges.ts --verbose             # log every match
 *   npx tsx scripts/backfill_brief_edges.ts --db /tmp/test.db     # override DB path
 *
 * Concurrency note: re-running concurrently is safe — UNIQUE constraint
 * guarantees idempotency at the DB level. Two parallel workers will
 * produce the union of their inserts with zero duplicates.
 *
 * @module scripts/backfill_brief_edges
 * @author fifty.dev
 */

import Database from 'better-sqlite3';
import { getDb } from '../src/db.js';
import { handleEdgeCreate } from '../src/engine/components/edges/handlers.js';
import { extractParentBriefId } from '../src/tools/briefs.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A relationship signal extracted from a single brief's markdown body. */
export interface EdgeSignal {
  /** Source entity id of the edge. */
  fromId: string;
  /** Target entity id of the edge. */
  toId: string;
  /** Target entity type ('brief' for FR/TD/etc., 'goal' for GL-NNN). */
  toType: 'brief' | 'goal';
  /** Catalog edge type from VALID_EDGE_TYPES. */
  edgeType: 'parent_of' | 'depends_on' | 'related_to' | 'blocks' | 'supersedes' | 'serves_goal';
  /** Confidence in [0, 1]. Always 1.0 for label-anchored extraction. */
  confidence: number;
  /** Markdown label that triggered the match (for traceability in metadata). */
  label: string;
}

/** Outcome summary for a backfill run. */
export interface BackfillResult {
  /** Number of brief_files rows scanned. */
  scanned: number;
  /** Total signals extracted across all briefs. */
  signalsFound: number;
  /** Edges newly inserted into entity_edges. */
  inserted: number;
  /** Signals that were already present (handler returned created=false). */
  alreadyPresent: number;
  /** Soft warnings (target absent from brief_status, edge_type rejected, etc.). */
  warnings: Array<{ briefId: string; message: string }>;
  /** Hard errors (handler returned isError for non-warning reasons). */
  errors: Array<{ briefId: string; message: string }>;
}

/** A row from brief_files. */
interface BriefFileRow {
  brief_id: string;
  project: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Regex configuration
// ---------------------------------------------------------------------------

/**
 * Label-pattern table for non-parent, non-goal extractions.
 *
 * Each entry maps a markdown label (`**Hard:**`, etc.) to the catalog
 * edge_type it should produce. `reverse` flips the from/to direction —
 * used by `Blocked by:` which means "the listed brief blocks me", not
 * "I block the listed brief".
 */
interface LabelPattern {
  label: string;
  edgeType: EdgeSignal['edgeType'];
  reverse: boolean;
}

const LABEL_PATTERNS: LabelPattern[] = [
  { label: 'Hard',       edgeType: 'depends_on', reverse: false },
  { label: 'Soft',       edgeType: 'related_to', reverse: false },
  { label: 'Blocks',     edgeType: 'blocks',     reverse: false },
  { label: 'Blocked by', edgeType: 'blocks',     reverse: true  },
  { label: 'Supersedes', edgeType: 'supersedes', reverse: false },
];

/**
 * Brief id pattern. Matches the canonical Igris brief-id format:
 * 2-3 uppercase letters, hyphen, 1+ digits. Examples: FR-105, TD-057, BR-9.
 *
 * NOTE: This deliberately matches goal ids too (GL-NNN), so callers must
 * route on the GL- prefix to choose to_type.
 */
const ID_RE = /[A-Z]{2,3}-\d+/g;

/** A goal id always starts with GL-. Anything else is a brief id. */
function isGoalId(id: string): boolean {
  return id.startsWith('GL-');
}

/**
 * Build a label-anchored regex: `**Label:** ID[(sep)ID]*`.
 *
 * The `\*\*` literals are required so prose mentions of "hard" or "blocks"
 * never match. The capture is strictly an ID list: one id, then zero or
 * more (separator + id). Separator is whitespace and/or comma, optionally
 * with the literal word "and" — so `FR-1, FR-2`, `FR-1 FR-2`, and
 * `FR-1 and FR-2` all parse. Anything outside this grammar (parens, prose,
 * periods, em dashes) terminates the capture so trailing prose can't bleed
 * in and inject phantom ids — the failure mode warden caught for TD-057,
 * e.g. `**Hard:** FR-001 (waiting for FR-200 redesign)` previously fished
 * BOTH FR-001 and FR-200 out of the open-ended capture.
 *
 * Separator regex: `\s+(?:(?:,|and)\s+)?` requires at least one whitespace
 * and lets an optional comma or "and" sit between the whitespace runs. This
 * accepts `FR-1, FR-2` (whitespace before AND after the comma is allowed),
 * `FR-1 FR-2`, `FR-1 and FR-2`. It rejects `FR-1.FR-2` (no whitespace) and
 * anything where prose words sit between the ids.
 *
 * Flags: `g` (global) for multiple labels per file; `i` (case-insensitive)
 * tolerates `**hard:**` or `**HARD:**`.
 */
function buildLabelRegex(label: string): RegExp {
  const escaped = label.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(
    `\\*\\*${escaped}:\\*\\*\\s*([A-Z]{2,3}-\\d+(?:\\s*(?:,|\\band\\b)?\\s*[A-Z]{2,3}-\\d+)*)`,
    'gi',
  );
}

/**
 * Goal label is unique enough to warrant its own regex. Same shape as
 * `buildLabelRegex` but the capture is restricted to GL-\d+ ids so that
 * trailing prose can't fish brief ids into a goal context (or vice versa).
 * For example `**Goal:** GL-001 — relates to milestone GL-002` must yield
 * exactly one signal (GL-001), never GL-002.
 *
 * Note on misformatted input: a brief like `**Goal:** FR-100, GL-001`
 * will produce zero signals (the regex requires the first id to be GL-).
 * This is stricter than the legacy loose grammar but matches the TD-057
 * warden directive: the goal label is reserved for goal targets and
 * misformatting is the brief author's error, not something we silently
 * recover from.
 */
const GOAL_LABEL_RE = /\*\*Goal:\*\*\s*(GL-\d+(?:\s*(?:,|\band\b)?\s*GL-\d+)*)/gi;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract every (fromId, toId, edgeType) signal from one brief's body.
 *
 * Reuses `extractParentBriefId` for the canonical `**Parent Brief:**`
 * header (which already handles bold/heading variants), then runs
 * label-anchored regexes for the other five patterns + the goal pattern.
 *
 * Self-loops (fromId === toId) are filtered here so the handler never
 * sees them — keeps logs clean even though the handler would also reject.
 *
 * @param briefId - The id of the brief whose body we're scanning. Used as
 *   from_id for non-parent edges and as the child of parent_of.
 * @param content - Raw markdown of the brief body.
 * @returns Zero or more signals; never null/undefined.
 */
export function extractSignals(briefId: string, content: string): EdgeSignal[] {
  const signals: EdgeSignal[] = [];
  if (!content) return signals;

  // ---------------------------------------------------------------------
  // 1. Parent Brief (reuses existing tolerant parser)
  //
  // extractParentBriefId returns the parent id. Edge direction per
  // edges/index.ts:onBriefCreated and the auto-edge hook: from=child,
  // to=parent, edge_type='parent_of'. We mirror that exactly so backfill
  // and runtime produce identical edges.
  // ---------------------------------------------------------------------
  const parentId = extractParentBriefId(content);
  if (parentId && parentId !== briefId) {
    signals.push({
      fromId: briefId,
      toId: parentId,
      toType: 'brief',
      edgeType: 'parent_of',
      confidence: 1.0,
      label: '**Parent Brief:**',
    });
  }

  // ---------------------------------------------------------------------
  // 2. Label-anchored brief-target patterns (Hard/Soft/Blocks/Blocked by/
  //    Supersedes). Each capture is split on ID_RE so comma-, space-, or
  //    "and"-separated lists all parse. GL- ids are skipped here because
  //    only **Goal:** legitimately points at a goal.
  // ---------------------------------------------------------------------
  for (const pattern of LABEL_PATTERNS) {
    const re = buildLabelRegex(pattern.label);
    const matches = content.matchAll(re);
    for (const match of matches) {
      const idList = match[1] ?? '';
      const ids = idList.match(ID_RE) ?? [];
      for (const id of ids) {
        if (isGoalId(id)) continue;        // GL-NNN belongs only under **Goal:**
        if (id === briefId) continue;      // self-loop suppression

        // Resolve direction: `Blocked by:` reverses (listed brief -> us).
        const fromId = pattern.reverse ? id : briefId;
        const toId = pattern.reverse ? briefId : id;

        signals.push({
          fromId,
          toId,
          toType: 'brief',
          edgeType: pattern.edgeType,
          confidence: 1.0,
          label: `**${pattern.label}:**`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // 3. Goal label (**Goal:** GL-NNN). Routes to to_type='goal'. Brief ids
  //    on this line (typo'd e.g. **Goal:** FR-001) are silently skipped —
  //    the brief is misformatted, not a backfill bug.
  // ---------------------------------------------------------------------
  const goalMatches = content.matchAll(GOAL_LABEL_RE);
  for (const match of goalMatches) {
    const idList = match[1] ?? '';
    const ids = idList.match(ID_RE) ?? [];
    for (const id of ids) {
      if (!isGoalId(id)) continue;         // only GL- ids are real goal targets
      // Goal ids cannot self-loop with a brief id — different namespaces.
      signals.push({
        fromId: briefId,
        toId: id,
        toType: 'goal',
        edgeType: 'serves_goal',
        confidence: 1.0,
        label: '**Goal:**',
      });
    }
  }

  return dedupeSignals(signals);
}

/**
 * Deduplicate signals by (fromId, toId, edgeType).
 *
 * Two distinct labels can extract the same edge (e.g. `**Hard:** FR-1` and
 * `**Soft:** FR-1` would both produce edges to FR-1; the first survives).
 * Without this, the handler would still dedup via UNIQUE — but we want the
 * `signalsFound` counter to reflect *unique* signals so the report numbers
 * line up with `inserted + alreadyPresent`.
 */
function dedupeSignals(signals: EdgeSignal[]): EdgeSignal[] {
  const seen = new Set<string>();
  const out: EdgeSignal[] = [];
  for (const s of signals) {
    const key = `${s.fromId}|${s.toType}|${s.toId}|${s.edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Persist one signal via `handleEdgeCreate`.
 *
 * The handler is idempotent (INSERT OR IGNORE on UNIQUE) and returns
 * `{created: false}` for rows that already exist. We surface that flag
 * back so the caller can split inserted vs alreadyPresent counts.
 *
 * On handler error we return the message; callers decide warning vs error.
 *
 * @returns `{created: true}` for fresh inserts, `{created: false}` for
 *   pre-existing rows, or `{error: '...'}` for handler-level failures.
 */
export function writeSignal(signal: EdgeSignal): { created?: boolean; error?: string } {
  const result = handleEdgeCreate({
    from_type: 'brief',
    from_id: signal.fromId,
    to_type: signal.toType,
    to_id: signal.toId,
    edge_type: signal.edgeType,
    confidence: signal.confidence,
    provenance: 'backfill',
    metadata: {
      source: 'backfill',
      label: signal.label,
    },
  });

  if (result.isError) {
    return { error: result.content[0]?.text ?? 'unknown handler error' };
  }

  // Handler payload shape: { id, created, edge }. We only need `created`.
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { created?: boolean };
    return { created: parsed.created === true };
  } catch (err) {
    return { error: `failed to parse handler response: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Iterate every `brief_files` row, extract signals, and write them.
 *
 * Streaming-friendly: we use prepare().iterate() instead of all() so the
 * memory footprint stays small even for large brief sets. Errors during
 * extraction or write are accumulated as warnings/errors rather than
 * aborting — a single broken brief should not stop the backfill.
 *
 * @param db - Live SQLite connection (pass explicitly for testability).
 * @param dryRun - If true, extraction runs but no DB writes happen.
 * @param projectFilter - Optional project slug; if undefined, all projects.
 * @param log - Logger for verbose output. Caller controls verbosity by
 *   passing `() => {}` to silence per-signal logs.
 * @returns Summary counts and warning/error lists.
 */
export function runBackfill(
  db: Database.Database,
  dryRun: boolean,
  projectFilter: string | undefined,
  log: (msg: string) => void = console.log,
): BackfillResult {
  const result: BackfillResult = {
    scanned: 0,
    signalsFound: 0,
    inserted: 0,
    alreadyPresent: 0,
    warnings: [],
    errors: [],
  };

  // ---------------------------------------------------------------------
  // Optional project_slug index for warning emission. We pre-load every
  // (project, brief_id) into a Set so each lookup is O(1). The set is
  // bounded by the number of briefs in the system (low thousands) so
  // memory is not a concern.
  // ---------------------------------------------------------------------
  const knownBriefs = loadKnownBriefSet(db);

  const where = projectFilter ? 'WHERE project = ?' : '';
  const params = projectFilter ? [projectFilter] : [];
  // Use .all() rather than .iterate(): better-sqlite3 holds the connection
  // open while an iterator is active, blocking any write inside the loop
  // (handleEdgeCreate does INSERTs). The brief_files row count is bounded
  // (low thousands per project), so the memory cost of materializing all
  // rows up front is negligible compared to the correctness win.
  const stmt = db.prepare<unknown[], BriefFileRow>(
    `SELECT brief_id, project, content
       FROM brief_files
       ${where}
       ORDER BY project, brief_id`,
  );
  const rows = stmt.all(...params);

  for (const row of rows) {
    result.scanned++;

    let signals: EdgeSignal[];
    try {
      signals = extractSignals(row.brief_id, row.content);
    } catch (err) {
      result.errors.push({
        briefId: row.brief_id,
        message: `extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (signals.length === 0) continue;
    result.signalsFound += signals.length;

    for (const signal of signals) {
      // Soft warning: edge points at an unknown brief. Brief id targets
      // only — goals are not in brief_status, and the FR-target case is
      // the one we care about (typos, archived briefs, etc.).
      if (signal.toType === 'brief' && !knownBriefs.has(signal.toId)) {
        result.warnings.push({
          briefId: row.brief_id,
          message: `target ${signal.toId} (${signal.edgeType}) not found in brief_status`,
        });
      }

      if (dryRun) {
        log(`  [DRY] ${signal.fromId} -[${signal.edgeType}]-> ${signal.toId} (${signal.label})`);
        continue;
      }

      const writeRes = writeSignal(signal);
      if (writeRes.error) {
        // Handler-level errors are warnings, not aborts. The most common
        // source is enum drift — surfaced verbosely so the operator can
        // patch the script if vocabulary changes upstream.
        result.warnings.push({
          briefId: row.brief_id,
          message: `${signal.fromId} -[${signal.edgeType}]-> ${signal.toId}: ${writeRes.error}`,
        });
        continue;
      }

      if (writeRes.created === true) {
        result.inserted++;
        log(`  OK ${signal.fromId} -[${signal.edgeType}]-> ${signal.toId}`);
      } else {
        result.alreadyPresent++;
      }
    }
  }

  return result;
}

/**
 * Load a Set of every known brief id from `brief_status` for cheap target
 * existence checks. Keys are bare brief ids (FR-105), not (project, id) —
 * the brief id namespace is global enough that a "target FR-105 not found"
 * warning is meaningful even without project scoping.
 */
function loadKnownBriefSet(db: Database.Database): Set<string> {
  const out = new Set<string>();
  // brief_status is a documented dependency of this script; if it's
  // missing the table-existence guard in main() will already have
  // exited. In tests, schemas may be partial — guard defensively.
  const tableRow = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='brief_status'",
  ).get() as { name: string } | undefined;
  if (!tableRow) return out;

  const rows = db.prepare<unknown[], { brief_id: string }>(
    'SELECT DISTINCT brief_id FROM brief_status',
  ).all();
  for (const row of rows) out.add(row.brief_id);
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * CLI argument shape parsed from process.argv.
 */
interface CliArgs {
  dryRun: boolean;
  projectFilter: string | undefined;
  dbPathOverride: string | undefined;
  verbose: boolean;
}

/**
 * Parse process.argv (or any string array) into a CliArgs struct.
 * Exported for unit tests so the parser is exercised directly without
 * spawning a subprocess.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const dryRun = argv.includes('--dry-run');
  const verbose = argv.includes('--verbose');

  const projectIdx = argv.indexOf('--project');
  const projectFilter = projectIdx >= 0 ? argv[projectIdx + 1] : undefined;
  if (projectIdx >= 0 && (!projectFilter || projectFilter.startsWith('--'))) {
    throw new Error('--project requires a slug argument (e.g. --project igris-ai)');
  }

  const dbIdx = argv.indexOf('--db');
  const dbPathOverride = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;
  if (dbIdx >= 0 && (!dbPathOverride || dbPathOverride.startsWith('--'))) {
    throw new Error('--db requires a path argument');
  }

  return { dryRun, projectFilter, dbPathOverride, verbose };
}

/**
 * CLI entry point. Parses args, opens the brain DB, and runs backfill.
 * Errors exit with code 1; normal runs exit 0. Mirrors the
 * sweep-stale-brief-tasks.ts pattern of pre-flight table checks so a
 * fresh / non-booted brain emits a helpful error rather than a SQL stack.
 */
async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return; // help TS narrow
  }

  // --db override is honored by setting the env var that getDb() reads,
  // BEFORE the first call. better-sqlite3 has no global rebind hook, so
  // any later --db flag would be ignored — handled at parse time.
  if (args.dbPathOverride) {
    process.env.IGRIS_DB_PATH = args.dbPathOverride;
  }

  const db = getDb();

  // Pre-flight: required tables must exist. Mirrors the guard in
  // sweep-stale-brief-tasks.ts. If brief_files or entity_edges is
  // missing the brain has not been booted on this machine.
  const required = ['brief_files', 'entity_edges'] as const;
  for (const table of required) {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(table) as { name: string } | undefined;
    if (!row) {
      console.error(
        `Error: required table "${table}" not found in brain DB.\n` +
        `This usually means the brain engine has not yet been booted on this machine.\n` +
        `Start the MCP server once to apply component migrations, then re-run the backfill.`,
      );
      process.exit(1);
      return;
    }
  }

  const scope = args.projectFilter ? ` (project=${args.projectFilter})` : '';
  const mode = args.dryRun ? ' (dry-run)' : '';
  console.log(`Backfilling brief edges${scope}${mode}...`);

  // Verbose mode forwards extraction logs; default mode silences per-row
  // output and just prints the summary.
  const log = args.verbose ? console.log : () => {};
  const result = runBackfill(db, args.dryRun, args.projectFilter, log);

  console.log('');
  console.log(`Scanned:           ${result.scanned} brief(s)`);
  console.log(`Edges extracted:   ${result.signalsFound}`);
  if (args.dryRun) {
    console.log(`(dry-run — no inserts performed)`);
  } else {
    console.log(`Edges inserted:    ${result.inserted} (backfilled)`);
    console.log(`Skipped (dup):     ${result.alreadyPresent}`);
  }
  if (result.warnings.length > 0) {
    console.log(`Warnings:          ${result.warnings.length}`);
    for (const w of result.warnings) {
      console.log(`  - ${w.briefId}: ${w.message}`);
    }
  }
  if (result.errors.length > 0) {
    console.log(`Errors:            ${result.errors.length}`);
    for (const e of result.errors) {
      console.log(`  - ${e.briefId}: ${e.message}`);
    }
  }
}

// Run main only when invoked as the CLI entry point, not when imported
// by tests. Tests import the module by path and never have
// `backfill_brief_edges` as argv[1].
const entryPoint = process.argv[1] ?? '';
const isDirectRun = /backfill_brief_edges(\.ts|\.js)?$/.test(entryPoint);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
