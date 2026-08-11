/**
 * BR-083 — attribute `entity_edges.from_project` / `to_project`, or refuse.
 *
 * WHAT "PROVABLE" MEANS HERE, AND WHY IT IS NOT A NEW RULE
 * -------------------------------------------------------
 * `resolveEdgeProjects(...).resolution === 'unique'`. That is the whole
 * definition. This script does not invent an attribution rule; it PERSISTS a
 * verdict the brain already computes on every `igris_graph_brain` call
 * (`whole-graph.ts`, FR-237). A rule invented for a backfill would be a rule
 * nothing else in the system agrees with, and the first disagreement would be
 * a wrong attribution nobody could trace.
 *
 * The classes, in FR-237's own branch numbering:
 *
 *   | class | branch | verdict     | written                                  |
 *   |-------|--------|-------------|------------------------------------------|
 *   | C1    | 1      | PROVABLE    | each endpoint's own project (a           |
 *   |       |        |             | cross-project pair here is LEGITIMATE    |
 *   |       |        |             | and is never forced intra-project)       |
 *   | C2    | 2      | PROVABLE    | the hinted project on BOTH sides         |
 *   | C3    | 4,|C|=1| PROVABLE    | the single shared project on both sides  |
 *   | C4    | 4,1<|C|<=8 | NULL    | FR-237 replicates for DISPLAY; storage   |
 *   |       |        |             | must not pick one of 2-8                 |
 *   | C5    | 4,|C|>8| NULL        | over the replica cap                     |
 *   | C6    | 3      | NULL        | one ambiguous, hint fails — every choice |
 *   |       |        |             | would be a fabricated cross-project      |
 *   |       |        |             | bridge                                   |
 *   | C7    | 4,|C|=0| NULL        | dangling; an integrity signal, reported  |
 *   |       |        |             | separately                               |
 *
 * A WRONG ATTRIBUTION IS WORSE THAN A NULL. That is the brief's ruling and it
 * is the reason C4-C7 are left NULL rather than guessed: a NULL says "the row
 * does not know", which every reader already handles; a wrong slug says
 * something false with full confidence. Widening the provable classes needs
 * its own brief and its own argument — do not do it here.
 *
 * DRY RUN IS THE DEFAULT AND THE REPORT IS THE POINT
 * -------------------------------------------------
 * Every decision, attributed or refused, is written to a JSONL report. The
 * operator reads the counts BEFORE anything is applied. `--apply` additionally
 * requires `--snapshot <path>` naming a verified backup, so "I had a backup"
 * is an argument the command line can check rather than a memory.
 *
 * Writes go through `UPDATE entity_edges SET from_project=?, to_project=?
 * WHERE id=?` — never `handleEdgeCreate`. The rows already exist; re-inserting
 * would churn `created_at` and enqueue the whole table onto the sync queue.
 *
 * Usage:
 *   npx tsx scripts/backfill_entity_edge_projects.ts --db /tmp/snap.db
 *   npx tsx scripts/backfill_entity_edge_projects.ts --db /tmp/snap.db --verbose
 *   npx tsx scripts/backfill_entity_edge_projects.ts --db <path> --apply \
 *       --snapshot <verified-backup-path>
 *   npx tsx scripts/backfill_entity_edge_projects.ts ... --report /tmp/r.jsonl
 *
 * @module scripts/backfill_entity_edge_projects
 * @author fifty.dev
 */

import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  loadGraphInputs,
  resolveEdgeProjects,
} from '../src/engine/components/edges/whole-graph.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The class a source row landed in. C1-C3 attribute; C4-C7 refuse. */
export type BackfillClass = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';

/** One line of the JSONL report — one per SOURCE row, no exceptions. */
export interface BackfillDecision {
  edge_id: number;
  from: [string, string];
  to: [string, string];
  class: BackfillClass;
  verdict: 'attributed' | 'unattributable';
  /** FR-237's own resolution word, quoted rather than re-derived. */
  resolution: string;
  /** `|C|` as FR-237 counted it. */
  candidates: number;
  from_project: string | null;
  to_project: string | null;
  /** Only on a refusal: FR-237's reason, in its vocabulary. */
  reason?: string;
}

/** Per-class counts plus the two totals the operator actually reads. */
export interface BackfillHistogram {
  source_edges: number;
  attributed: number;
  unattributable: number;
  by_class: Record<BackfillClass, number>;
  /** Rows that ALREADY carried both qualifiers and were left alone. */
  already_qualified: number;
}

/** A minimal `entity_edges` row, as this script reads it. */
interface EdgeRowLite {
  id: number;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  edge_type: string;
  from_project: string | null;
  to_project: string | null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Map ONE row onto its class, using FR-237's verdict and nothing else.
 *
 * The `resolution` / `candidateCount` pair is FR-237's, unmodified. The class
 * letters exist only to make the report readable — every branch below reads a
 * field the shipped resolver set, so this function cannot disagree with the
 * brain about an attribution. If it ever does, the resolver moved and this is
 * a bug, not a policy difference.
 */
export function classifyResolved(
  resolution: string,
  candidateCount: number,
  fromAmbiguous: boolean,
  toAmbiguous: boolean,
): BackfillClass {
  if (resolution === 'unique') {
    if (!fromAmbiguous && !toAmbiguous) return 'C1';
    if (fromAmbiguous !== toAmbiguous) return 'C2';
    return 'C3';
  }
  if (resolution === 'replicated') return 'C4';
  if (resolution === 'over_replicated') return 'C5';
  if (resolution === 'ambiguous_unresolved') return 'C6';
  if (resolution === 'dangling') return 'C7';
  // Unreachable unless `ResolvedEdge['resolution']` gained a member. Refusing
  // is the only safe default: an unknown verdict must never attribute.
  void candidateCount;
  return 'C6';
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  dbPath: string;
  apply: boolean;
  reportPath: string | null;
  verbose: boolean;
}

export interface RunResult {
  histogram: BackfillHistogram;
  decisions: BackfillDecision[];
}

/**
 * Classify (and optionally apply) every non-soft-deleted `entity_edges` row.
 *
 * The project index is built by `buildBrainGraph` itself so the index this
 * script resolves against is byte-for-byte the one `igris_graph_brain` uses —
 * building a second one here would be the invented rule this brief forbids,
 * one level down.
 *
 * @param db - An OPEN handle. The caller owns read-only vs read-write; this
 *             function issues UPDATEs only when `apply` is true.
 */
export function runBackfill(db: Database.Database, opts: RunOptions): RunResult {
  // THE SAME loader `buildBrainGraph` uses, called rather than re-implemented.
  // `edge_resolution` in the brain and this report therefore describe the same
  // index and the same rule, by construction.
  const missingTables: string[] = [];
  const { index } = loadGraphInputs(db, missingTables);
  if (missingTables.length > 0) {
    console.error(`[backfill] degraded — absent tables: ${missingTables.join(', ')}`);
  }

  const rows = db
    .prepare(
      `SELECT id, from_type, from_id, to_type, to_id, edge_type,
              from_project, to_project
       FROM entity_edges
       WHERE COALESCE(json_extract(metadata, '$.deleted'), 0) = 0
       ORDER BY id ASC`,
    )
    .all() as EdgeRowLite[];

  const histogram: BackfillHistogram = {
    source_edges: rows.length,
    attributed: 0,
    unattributable: 0,
    already_qualified: 0,
    by_class: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, C6: 0, C7: 0 },
  };

  const decisions: BackfillDecision[] = [];
  const update = db.prepare(
    'UPDATE entity_edges SET from_project = ?, to_project = ? WHERE id = ?',
  );

  for (const row of rows) {
    if (row.from_project !== null && row.to_project !== null) {
      // Already qualified — minted after edges@4, or a previous run. Never
      // re-decided: this script's job is to fill NULLs, not to second-guess a
      // writer that knew more than an inference can.
      histogram.already_qualified += 1;
      continue;
    }

    // Resolve as if UNQUALIFIED, so a half-qualified row is decided by the
    // ladder rather than short-circuiting on its own partial answer.
    const resolved = resolveEdgeProjects(
      {
        from_type: row.from_type,
        from_id: row.from_id,
        to_type: row.to_type,
        to_id: row.to_id,
        from_project: null,
        to_project: null,
      },
      index,
      DEFAULT_MAX_EDGE_REPLICAS,
    );

    const fromSet = index.get(`${row.from_type}:${row.from_id}`) ?? [];
    const toSet = index.get(`${row.to_type}:${row.to_id}`) ?? [];
    const cls = classifyResolved(
      resolved.resolution,
      resolved.candidateCount,
      fromSet.length > 1,
      toSet.length > 1,
    );
    histogram.by_class[cls] += 1;

    const provable = resolved.resolution === 'unique' && resolved.instances.length === 1;
    const inst = provable ? resolved.instances[0] : null;

    // A `unique` instance may legitimately carry a NULL on one or both sides
    // (a concept endpoint, a goal with no `project_slug`). Writing NULL over
    // NULL is a no-op, so only a row that gains at least one non-null slug is
    // counted as ATTRIBUTED — otherwise the headline would credit itself for
    // decisions that changed nothing.
    const gains =
      inst !== null && (inst.fromProject !== null || inst.toProject !== null);

    const decision: BackfillDecision = {
      edge_id: row.id,
      from: [row.from_type, row.from_id],
      to: [row.to_type, row.to_id],
      class: cls,
      verdict: gains ? 'attributed' : 'unattributable',
      resolution: resolved.resolution,
      candidates: resolved.candidateCount,
      from_project: gains ? (inst as { fromProject: string | null }).fromProject : null,
      to_project: gains ? (inst as { toProject: string | null }).toProject : null,
      ...(gains ? {} : { reason: provable ? 'no_project_on_either_endpoint' : resolved.resolution }),
    };
    decisions.push(decision);

    if (gains) {
      histogram.attributed += 1;
      if (opts.apply) {
        update.run(decision.from_project, decision.to_project, row.id);
      }
    } else {
      histogram.unattributable += 1;
    }
  }

  if (opts.reportPath) {
    writeFileSync(opts.reportPath, '');
    for (const d of decisions) appendFileSync(opts.reportPath, `${JSON.stringify(d)}\n`);
  }

  return { histogram, decisions };
}

/** FR-237's own default. Quoted, not re-chosen — the cap defines class C5. */
const DEFAULT_MAX_EDGE_REPLICAS = 8;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parse argv into {@link RunOptions} plus the `--snapshot` guard value. */
export function parseArgs(argv: string[]): RunOptions & { snapshot: string | null } {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };
  return {
    dbPath: get('--db') ?? '',
    apply: argv.includes('--apply'),
    reportPath: get('--report'),
    verbose: argv.includes('--verbose'),
    snapshot: get('--snapshot'),
  };
}

/** Print the histogram plus the full unattributable list (AC-4). */
function printReport(result: RunResult, opts: RunOptions): void {
  const h = result.histogram;
  const pct = (n: number): string =>
    h.source_edges === 0 ? '0.0%' : `${((n / h.source_edges) * 100).toFixed(1)}%`;

  console.log('\n=== BR-083 backfill — classification ===');
  console.log(`source rows (non-soft-deleted): ${h.source_edges}`);
  console.log(`already qualified (skipped):    ${h.already_qualified}`);
  console.log(`ATTRIBUTED:                     ${h.attributed}  (${pct(h.attributed)})`);
  console.log(`UNATTRIBUTABLE (left NULL):     ${h.unattributable}  (${pct(h.unattributable)})`);
  console.log('\nby class:');
  const labels: Record<BackfillClass, string> = {
    C1: 'br1  neither endpoint ambiguous        PROVABLE',
    C2: 'br2  owner hint applies                PROVABLE',
    C3: 'br4  both ambiguous, |C| = 1           PROVABLE',
    C4: 'br4  both ambiguous, 1 < |C| <= 8      NULL',
    C5: 'br4  both ambiguous, |C| > 8           NULL',
    C6: 'br3  one ambiguous, hint fails         NULL',
    C7: 'br4  |C| = 0, dangling                 NULL',
  };
  for (const k of Object.keys(labels) as BackfillClass[]) {
    console.log(`  ${k}  ${labels[k]}  ${String(h.by_class[k]).padStart(5)}`);
  }

  const refused = result.decisions.filter((d) => d.verdict === 'unattributable');
  console.log(`\nfull unattributable list (${refused.length}):`);
  for (const d of refused) {
    console.log(
      `  #${d.edge_id}  ${d.from[0]}:${d.from[1]} -> ${d.to[0]}:${d.to[1]}` +
        `  [${d.class}] ${d.reason ?? d.resolution} |C|=${d.candidates}`,
    );
  }

  if (opts.verbose) {
    console.log('\nattributed:');
    for (const d of result.decisions.filter((x) => x.verdict === 'attributed')) {
      console.log(
        `  #${d.edge_id}  ${d.from[0]}:${d.from[1]} -> ${d.to[0]}:${d.to[1]}` +
          `  [${d.class}] ${d.from_project ?? 'NULL'} / ${d.to_project ?? 'NULL'}`,
      );
    }
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.dbPath) {
    console.error('ERROR: --db <path> is required. This script never opens the live brain by default.');
    process.exit(2);
  }
  if (!existsSync(opts.dbPath)) {
    console.error(`ERROR: no such database: ${opts.dbPath}`);
    process.exit(2);
  }
  if (opts.apply && !opts.snapshot) {
    console.error(
      'ERROR: --apply requires --snapshot <path> naming a VERIFIED backup.\n' +
        'A backup nobody named is not a backup — it is a hope.',
    );
    process.exit(2);
  }
  if (opts.apply && opts.snapshot && !existsSync(opts.snapshot)) {
    console.error(`ERROR: --snapshot names a file that does not exist: ${opts.snapshot}`);
    process.exit(2);
  }

  const db = new Database(opts.dbPath, { readonly: !opts.apply, fileMustExist: true });
  try {
    const result = runBackfill(db, opts);
    printReport(result, opts);
    console.log(
      opts.apply
        ? `\nAPPLIED ${result.histogram.attributed} attributions to ${opts.dbPath}`
        : '\nDRY RUN — nothing was written. Re-run with --apply --snapshot <verified backup> to write.',
    );
    if (opts.reportPath) console.log(`report: ${opts.reportPath}`);
  } finally {
    db.close();
  }
}

// Only run when invoked directly, never on import (the test imports runBackfill).
if (process.argv[1] && process.argv[1].includes('backfill_entity_edge_projects')) {
  main();
}
