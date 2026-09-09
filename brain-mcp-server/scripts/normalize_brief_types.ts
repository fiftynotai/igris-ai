#!/usr/bin/env tsx
/**
 * TD-328 — brief_type vocabulary backfill / report.
 *
 * Plans (and optionally applies) the same three fold classes the v22 migration
 * applies, and prints EVERY proposed row change before any write. This is the
 * reviewable artifact AC-2 requires: "a dry-run reports every proposed row
 * change before any write".
 *
 * DRY-RUN IS THE DEFAULT, AND IT IS ENFORCED BY THE CONNECTION, NOT BY A FLAG
 * CHECK. A dry-run opens the database `readonly: true`, so a write is refused by
 * SQLite itself rather than by a branch someone can later reorder.
 *
 *   THIS SCRIPT DELIBERATELY DOES NOT CALL `getDb()`. That was a real defect,
 *   not a style preference: `getDb()` (`src/db.ts`) opens read-write, sets
 *   `journal_mode = WAL` (a write), and runs `migrateSchema()` — so on any DB
 *   below v22 the *default, supposedly read-only* invocation would apply
 *   v18…v22, fold every row, and THEN report a near-empty plan under the words
 *   "nothing was written". That defeats the whole AC-2 workflow (point `--db` at
 *   a v21 snapshot, review the plan, then apply), and pointing `--db` at
 *   `knowledge.db.pre-v22.bak` would have MIGRATED THE UNDO FILE — the one
 *   artifact the reversibility story depends on holding pre-fold spellings.
 *   Opening the path directly skips `migrateSchema` entirely.
 *
 *   ⚠ NOTE THE INVERSION: the neighbouring `scripts/backfill_brief_edges.ts`
 *   defaults to WRITE and takes `--dry-run` to opt OUT. This script does the
 *   opposite, deliberately (memory #208): edge backfill is additive and
 *   reversible by deletion, whereas a brief_type fold is DESTRUCTIVE — the old
 *   spelling is unrecoverable from the row itself. Two neighbouring scripts
 *   with opposite defaults is confusing, so it is called out here rather than
 *   left for the next reader to discover the hard way.
 *
 * The fold tables are IMPORTED from `src/tools/brief-normalize.ts` — the single
 * source of truth shared with the write boundary and the v22 migration. There
 * is no second hand-copied list.
 *
 * Column discipline: only `brief_status.brief_type` is ever written. Never
 * content, title, status, phase, claimed_by, embedding — and never
 * `updated_at` (it is an LWW sync column; bumping it would make folded local
 * rows fight an un-migrated remote brain).
 *
 * Usage:
 *   npx tsx scripts/normalize_brief_types.ts                  # dry-run (default)
 *   npx tsx scripts/normalize_brief_types.ts --json out.json  # + machine-readable plan
 *   npx tsx scripts/normalize_brief_types.ts --project igris-ai
 *   npx tsx scripts/normalize_brief_types.ts --db /tmp/snap.db
 *   npx tsx scripts/normalize_brief_types.ts --apply          # WRITES
 *
 * @module scripts/normalize_brief_types
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  CANONICAL_BRIEF_TYPES,
  BRIEF_TYPE_ALIASES,
  BRIEF_TYPE_COMPOUND_FOLDS,
  BRIEF_ID_PREFIX_TYPES,
  isCanonicalBriefType,
} from '../src/tools/brief-normalize.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why a row is being changed (or deliberately not changed). */
export type ChangeReason =
  | 'alias'
  | 'case'
  | 'compound-recoverable'
  | 'prefix-inference';

/** One proposed `brief_type` change. */
export interface PlannedChange {
  project: string;
  brief_id: string;
  from: string | null;
  to: string;
  reason: ChangeReason;
  /** Human-readable justification, printed verbatim in the report. */
  detail: string;
}

/** A value left as-is, with the reason it was not folded. */
export interface UnfoldedValue {
  value: string | null;
  count: number;
  brief_ids: string[];
  reason: string;
}

/** The full reviewable plan. */
export interface NormalizationPlan {
  changes: PlannedChange[];
  unfolded: UnfoldedValue[];
  distinctBefore: number;
  distinctAfter: number;
  rowsTotal: number;
  /** Compound-row census for the D4 escalation tripwire. */
  compoundRows: number;
}

interface StatusRow {
  project: string;
  brief_id: string;
  brief_type: string | null;
  title: string;
}

// ---------------------------------------------------------------------------
// Planning (pure — never writes)
// ---------------------------------------------------------------------------

/**
 * Space-padded lowercase haystack for the D4 qualifier check.
 *
 * CLOSE TO the v22 migration's SQL, but NOT identical, and the divergence is
 * worth knowing: this joins the title and ALL `brief_files` rows into ONE
 * string, so a token can match ACROSS the title/content boundary or across two
 * content rows. The SQL tests `title` and each `brief_files.content` row
 * SEPARATELY. This version is therefore very slightly more permissive — it can
 * report a fold the migration would not make. Harmless on the live corpus (no
 * row's verdict differed) and it errs toward reporting rather than toward a
 * silent difference, but do not treat the two as interchangeable when
 * reconciling a plan against what v22 actually did.
 */
function haystack(title: string, contents: string[]): string {
  return ` ${[title, ...contents].join(' ').toLowerCase()} `;
}

/**
 * Build the fold plan for a DB. PURE with respect to the database — it only
 * SELECTs. `applyPlan` is the only function that writes.
 */
export function planNormalization(
  db: Database.Database,
  projectFilter?: string,
): NormalizationPlan {
  const where = projectFilter ? 'WHERE project = ?' : '';
  const params = projectFilter ? [projectFilter] : [];
  const rows = db
    .prepare(
      `SELECT project, brief_id, brief_type, title FROM brief_status ${where}
         ORDER BY project, brief_id`,
    )
    .all(...params) as StatusRow[];

  const haveBriefFiles =
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brief_files'`)
      .get() !== undefined;
  const contentStmt = haveBriefFiles
    ? db.prepare(
        `SELECT content FROM brief_files WHERE project = ? AND brief_id = ?`,
      )
    : undefined;

  const canonicalByLower = new Map(
    CANONICAL_BRIEF_TYPES.map((t) => [t.toLowerCase(), t] as const),
  );

  const changes: PlannedChange[] = [];
  const unfoldedBuckets = new Map<string | null, UnfoldedValue>();
  let compoundRows = 0;

  const noteUnfolded = (value: string | null, briefId: string, reason: string): void => {
    // A Map keys on `null` natively, so no sentinel is needed. This deliberately
  // avoids a NUL byte: grep/ripgrep classify any NUL-bearing file as BINARY and
  // silently skip it, and this repo's review discipline is grep-driven.
  const key = value;
    const bucket = unfoldedBuckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.brief_ids.push(briefId);
    } else {
      unfoldedBuckets.set(key, { value, count: 1, brief_ids: [briefId], reason });
    }
  };

  for (const row of rows) {
    const raw = row.brief_type;

    // --- (C) NULL rows: prefix inference (D5) ------------------------------
    if (raw === null || raw.trim() === '') {
      const dash = row.brief_id.indexOf('-');
      const prefix = dash > 0 ? row.brief_id.slice(0, dash).toUpperCase() : '';
      const inferred = BRIEF_ID_PREFIX_TYPES[prefix];
      if (inferred) {
        changes.push({
          project: row.project,
          brief_id: row.brief_id,
          from: raw,
          to: inferred,
          reason: 'prefix-inference',
          detail: `mint prefix ${prefix}- decodes to ${inferred}`,
        });
      } else if (prefix === 'BR') {
        noteUnfolded(
          raw,
          row.brief_id,
          'BR- is ambiguous for rows minted before TD-331: the prefix meant ' +
            'EITHER bug or feature at the time, so inference would mistype an ' +
            'unknown number of features. TD-331 made the mint map 1:1 ' +
            '(bug -> BR, feature -> FR), which caps this set but cannot ' +
            'resolve the rows already in it',
        );
      } else {
        noteUnfolded(
          raw,
          row.brief_id,
          `"${prefix || row.brief_id}" is not a /register mint prefix (foreign or malformed id)`,
        );
      }
      continue;
    }

    const key = raw.trim().toLowerCase();

    // --- (A) unconditional alias fold --------------------------------------
    const alias = BRIEF_TYPE_ALIASES[key];
    if (alias) {
      changes.push({
        project: row.project,
        brief_id: row.brief_id,
        from: raw,
        to: alias,
        reason: 'alias',
        detail: `unambiguous spelling of ${alias}`,
      });
      continue;
    }

    // --- (A2) canonical case-fold ------------------------------------------
    const canonical = canonicalByLower.get(key);
    if (canonical) {
      if (canonical !== raw) {
        changes.push({
          project: row.project,
          brief_id: row.brief_id,
          from: raw,
          to: canonical,
          reason: 'case',
          detail: `case/whitespace variant of canonical ${canonical}`,
        });
      }
      continue; // already canonical → nothing to report
    }

    // --- (B) gated compound fold (D4) --------------------------------------
    const compound = BRIEF_TYPE_COMPOUND_FOLDS[key];
    if (compound) {
      compoundRows += 1;
      const contents = contentStmt
        ? (contentStmt.all(row.project, row.brief_id) as Array<{ content: string }>).map(
            (r) => r.content,
          )
        : [];
      const hay = haystack(row.title, contents);
      const hit = compound.tokens.find((t) => hay.includes(t));
      if (hit) {
        changes.push({
          project: row.project,
          brief_id: row.brief_id,
          from: raw,
          to: compound.head,
          reason: 'compound-recoverable',
          detail: `qualifier "${hit.trim()}" survives in the row's own title/content — folding to the head type loses nothing recoverable`,
        });
      } else {
        noteUnfolded(
          raw,
          row.brief_id,
          `qualifier ${compound.tokens.map((t) => `"${t.trim()}"`).join('/')} does NOT appear in ` +
            "this row's title or content — folding would destroy it (D4 gate)",
        );
      }
      continue;
    }

    // --- everything else: read-widen, reported -----------------------------
    if (key === 'bug/feature') {
      compoundRows += 1;
      noteUnfolded(raw, row.brief_id, 'compound with NO head type — genuinely two types');
    } else if (key === 'br') {
      noteUnfolded(
        raw,
        row.brief_id,
        'BR predates TD-331: the prefix meant either kind at mint time, and this ' +
          'table decodes IDs that already exist, so no key can recover it',
      );
    } else {
      noteUnfolded(
        raw,
        row.brief_id,
        'no defensible fold target — folding would be inventing, not normalising',
      );
    }
  }

  // Distinct-value census, before and after.
  //
  // NULL_SENTINEL stands in for a SQL NULL inside a Set of strings, so the census
  // counts "has no type" as ONE bucket rather than collapsing it into whatever the
  // empty string would collide with. U+241F is the PRINTABLE GLYPH for a unit
  // separator, not a control character: an earlier revision used a literal NUL
  // byte here, which made grep and ripgrep classify this whole file as BINARY and
  // silently skip it — in a repo whose review discipline is class-greps, a file
  // the greps cannot read is a blind spot. Keep every sentinel in this file
  // printable for that reason.
  const NULL_SENTINEL = '␟<null>';
  const distinctBefore = new Set(rows.map((r) => r.brief_type ?? NULL_SENTINEL)).size;
  const changeById = new Map(changes.map((c) => [`${c.project}\u001F${c.brief_id}`, c.to]));
  const distinctAfter = new Set(
    rows.map(
      (r) =>
        changeById.get(`${r.project}\u001F${r.brief_id}`) ?? r.brief_type ?? NULL_SENTINEL,
    ),
  ).size;

  return {
    changes,
    unfolded: [...unfoldedBuckets.values()].sort((a, b) => b.count - a.count),
    distinctBefore,
    distinctAfter,
    rowsTotal: rows.length,
    compoundRows,
  };
}

// ---------------------------------------------------------------------------
// Apply (the ONLY writer)
// ---------------------------------------------------------------------------

/**
 * Apply a plan. Writes `brief_status.brief_type` and NOTHING else — in
 * particular `updated_at` is left alone (LWW sync column). One transaction.
 *
 * @returns the number of rows actually changed.
 */
export function applyPlan(db: Database.Database, plan: NormalizationPlan): number {
  let changed = 0;
  const stmt = db.prepare(
    `UPDATE brief_status SET brief_type = ? WHERE project = ? AND brief_id = ?`,
  );
  db.transaction(() => {
    for (const c of plan.changes) {
      changed += stmt.run(c.to, c.project, c.brief_id).changes;
    }
  })();
  return changed;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Render the plan as the human-reviewable report (groups A–E). */
export function renderReport(plan: NormalizationPlan, apply: boolean): string {
  const out: string[] = [];
  const byReason = (r: ChangeReason): PlannedChange[] =>
    plan.changes.filter((c) => c.reason === r);

  const section = (title: string, list: PlannedChange[]): void => {
    out.push('');
    out.push(`${title}  (${list.length} row(s))`);
    out.push('-'.repeat(78));
    if (list.length === 0) {
      out.push('  (none)');
      return;
    }
    for (const c of list) {
      out.push(
        `  ${c.project}/${c.brief_id}  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`,
      );
      out.push(`      reason: ${c.detail}`);
    }
  };

  out.push('='.repeat(78));
  out.push(
    `TD-328 brief_type normalization plan  [${apply ? 'APPLY' : 'DRY-RUN (no writes)'}]`,
  );
  out.push('='.repeat(78));

  section('(A) UNCONDITIONAL ALIAS FOLDS', byReason('alias'));
  section('(A2) CANONICAL CASE-FOLDS', byReason('case'));
  section('(B) COMPOUND FOLDS — qualifier proven recoverable (D4)', byReason('compound-recoverable'));
  section('(C) NULL PREFIX INFERENCES (D5)', byReason('prefix-inference'));

  out.push('');
  out.push(`(D) LEFT UNFOLDED — reported, not folded  (${plan.unfolded.length} value(s))`);
  out.push('-'.repeat(78));
  if (plan.unfolded.length === 0) {
    out.push('  (none)');
  } else {
    for (const u of plan.unfolded) {
      const label = u.value === null ? '<NULL>' : JSON.stringify(u.value);
      out.push(`  ${label}  x${u.count}  [${u.brief_ids.join(', ')}]`);
      out.push(`      reason: ${u.reason}`);
    }
  }

  const nonCanonicalAfter = plan.unfolded.filter(
    (u) => u.value !== null && !isCanonicalBriefType(u.value),
  ).length;

  out.push('');
  out.push('(E) TOTALS');
  out.push('-'.repeat(78));
  out.push(`  rows scanned:            ${plan.rowsTotal}`);
  out.push(`  rows to change:          ${plan.changes.length}`);
  out.push(`  rows unchanged:          ${plan.rowsTotal - plan.changes.length}`);
  out.push(`  distinct values before:  ${plan.distinctBefore}`);
  out.push(`  distinct values after:   ${plan.distinctAfter}`);
  out.push(`  non-canonical remaining: ${nonCanonicalAfter}`);
  out.push(`  compound rows:           ${plan.compoundRows}`);

  // D4 escalation tripwire — the same threshold recorded in
  // core/enforcement/brief-type-vocabulary.md.
  const pct = plan.rowsTotal > 0 ? (plan.compoundRows / plan.rowsTotal) * 100 : 0;
  if (plan.compoundRows > 25 || pct > 5) {
    out.push('');
    out.push(
      `  !! D4 ESCALATION TRIPWIRE: ${plan.compoundRows} compound rows (${pct.toFixed(2)}% of corpus)`,
    );
    out.push('     exceeds the >25-rows / >5% threshold. FILE THE `brief_subtype` COLUMN BRIEF.');
  }

  if (!apply) {
    out.push('');
    out.push('  DRY-RUN — nothing was written. Re-run with --apply to commit these changes.');
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  /** TRUE unless --apply was passed. Dry-run is the DEFAULT (#208). */
  dryRun: boolean;
  projectFilter?: string;
  dbPathOverride?: string;
  jsonOut?: string;
}

/** Parse argv. Throws on a malformed flag. */
export function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} requires an argument`);
    return v;
  };

  // Dry-run is the DEFAULT; --apply is the only way to write.
  return {
    dryRun: !args.includes('--apply'),
    projectFilter: valueOf('--project'),
    dbPathOverride: valueOf('--db'),
    jsonOut: valueOf('--json'),
  };
}

/**
 * Resolve the DB path WITHOUT importing `getDb()`.
 *
 * Mirrors the first, second and last tiers of `src/db.ts#resolveDbPath`
 * (exported since TD-426; the `IGRIS_BRAIN_DIR` tier is not needed by a `--db`
 * script): explicit `--db` wins, then `IGRIS_DB_PATH`, then the default brain
 * path. Reproduced here on purpose — importing from `db.ts` would drag in the
 * migration side effect this script exists to avoid.
 */
export function resolveDbPath(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const env = process.env.IGRIS_DB_PATH;
  if (env && env.length > 0) return env;
  return path.join(os.homedir(), '.igris', 'memory', 'knowledge.db');
}

/**
 * The whole CLI, as a callable so the DRY-RUN-WRITES-NOTHING guarantee can be
 * tested at the layer that actually opens the connection. Testing only
 * `planNormalization` would leave the guard one layer below the claim.
 *
 * @returns the process exit code (0 ok, 1 error)
 */
export async function runCli(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const dbPath = resolveDbPath(args.dbPathOverride);
  if (!fs.existsSync(dbPath)) {
    console.error(`Error: brain DB not found at ${dbPath}`);
    return 1;
  }

  // THE LOAD-BEARING LINE. `readonly` in dry-run means SQLite refuses writes at
  // the connection, so the "nothing was written" claim is enforced by the
  // database rather than asserted by this file. Opening the path directly (vs.
  // getDb()) also skips migrateSchema — see the module docstring.
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: args.dryRun });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Error: could not open ${dbPath}${args.dryRun ? ' read-only' : ''}: ${msg}\n` +
        'If the DB is in WAL mode, a read-only open needs the sibling -shm/-wal\n' +
        'files to be readable. Copy the whole set, or snapshot with\n' +
        `  sqlite3 "file:${dbPath}?mode=ro" "VACUUM INTO '/tmp/snapshot.db'"`,
    );
    return 1;
  }

  try {
    const required = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brief_status'`)
      .get() as { name: string } | undefined;
    if (!required) {
      console.error(
        `Error: required table "brief_status" not found in ${dbPath}.\n` +
          'This usually means the brain engine has not yet been booted on this machine.\n' +
          'Start the MCP server once to create the schema, then re-run.',
      );
      return 1;
    }

    const plan = planNormalization(db, args.projectFilter);
    console.log(renderReport(plan, !args.dryRun));

    if (args.jsonOut) {
      fs.writeFileSync(args.jsonOut, JSON.stringify(plan, null, 2));
      console.log(`Plan written to ${args.jsonOut}`);
    }

    if (!args.dryRun) {
      const changed = applyPlan(db, plan);
      console.log(`APPLIED — ${changed} row(s) updated (brief_type only).`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// Only run when invoked directly, so the planner can be unit-tested.
if (process.argv[1] && process.argv[1].endsWith('normalize_brief_types.ts')) {
  void runCli(process.argv).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
