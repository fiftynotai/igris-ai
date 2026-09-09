#!/usr/bin/env node
/**
 * TD-402 — fold three `projects` rows describing one directory into one slug.
 *
 * `~/StudioProjects/fifty_eco_system` was registered three times on 2026-07-04,
 * inside 420 ms, under three spellings of ONE directory (`registered_at` read off
 * the pre-apply backup on 2026-08-17): the directory basename VERBATIM
 * (`fifty_eco_system`), that same basename hyphen-normalised
 * (`fifty-eco-system`), and the root `pubspec.yaml` package name — which is
 * `fifty_flutter_kit` — hyphen-normalised (`fifty-flutter-kit`). There was NO
 * purely manifest-derived slug: `fifty_flutter_kit` itself was never a row, so
 * the third spelling is manifest-derived AND hyphen-normalised, not a third
 * independent derivation. Two of the three are unreachable: `igris detect`
 * derives the slug from the directory basename, so it only ever produces
 * `fifty_eco_system`.
 *
 * WHY PLAIN ESM AND NOT tsx
 * ------------------------
 * `node_modules/tsx` is not installed in this worktree and installing anything
 * is forbidden for this brief (`cli/package.json`'s postinstall rebuilds the MCP
 * bundle that every live `brain-mcp-server/dist/index.js` process holds open).
 * That is the PROPERTY; the count is a `ps` reading that rots. On 2026-08-17 it
 * was 10 — 9 on this worktree's bundle and 1 on the `gl012` sibling worktree's —
 * and it changes with every harness start and stop. This file is therefore `.mjs` and
 * resolves `better-sqlite3` + `sqlite-vec` through `createRequire` against
 * `cli/dist/brain-mcp-server/node_modules/` — the same binding the running MCP
 * servers use. Run it with node 24; node 22 fails to dlopen that binding
 * (NODE_MODULE_VERSION 127 vs 137 — TD-398).
 *
 * WHY NOT /usr/bin/sqlite3
 * ------------------------
 * The `briefs_vec_ad` trigger on `brief_status` deletes from `briefs_vec`, a
 * `vec0` virtual table the system sqlite3 cannot load. The statement aborts with
 * `Parse error: no such module: vec0`, and inside a `BEGIN…COMMIT` script the
 * surrounding statements still commit — which half-applied a change on this DB
 * on 2026-08-17. This script asserts `sqliteVec.load` succeeded and that
 * `SELECT count(*) FROM briefs_vec` answers BEFORE it opens a transaction.
 *
 * RE-KEY, DO NOT DELETE-AND-REINSERT
 * ----------------------------------
 * FIRST, the shape of the collision, because "conflict" below does not mean what
 * a reader would guess. ALL 36 stranded briefs share a `brief_id` with a live
 * `fifty_eco_system` brief (36 of 36, measured on the pre-apply backup). The
 * discriminator this script actually uses is the BODY: 2 of the 36 have a
 * `brief_files` row and are re-keyed onto a free id, the other 34 have none and
 * are deleted against a live counterpart that does. So the exactly-true sentence
 * is "only 2 stranded briefs had a body", never "there were 2 id conflicts".
 *
 * The re-key is an UPDATE rather than a delete-and-reinsert because of TRIGGER
 * CHURN, and specifically because the churn is not symmetric. A DELETE on
 * `brief_status` fires `briefs_vec_ad` and `briefs_fts_status_ad`; the reinsert
 * fires `briefs_fts_status_ai`, but NOTHING re-inserts the `briefs_vec` row —
 * `db.ts` states outright that `briefs_vec_ad` is the only trigger on that table,
 * and embeddings are written by `extractBriefProblem` at brief CREATE and by the
 * backfill tool, nowhere else. For a brief that HAS an embedding, delete-and-
 * reinsert silently drops it. Preserving `brief_status.id` (which IS the
 * `briefs_vec` rowid) was therefore PRECAUTIONARY cover for that — and
 * precautionary is all it was here: measured on 2026-08-17, 0 of the 36 stranded
 * rows had a non-NULL `embedding` and 0 appeared in `briefs_vec`, so on THIS data
 * nothing was preserved because nothing existed. The re-key is still the right
 * statement; the reason is the trigger asymmetry, not a rescued embedding.
 * `brief_files` is updated BEFORE `brief_status` so the FTS triggers converge on
 * a populated `briefs_fts` row (the comment on `db.ts`'s `briefs_fts_files_au`
 * trigger notes that no live writer re-keys; this is the first).
 *
 * MODES
 *   (default)                    report only — opens read-only, writes nothing
 *   --rehearse                   executes every statement, then throws to ROLLBACK
 *   --apply --snapshot <path>    commits; refuses without a snapshot it verifies
 *
 * Usage:
 *   node scripts/td402_fold_project_slugs.mjs --db ~/.igris/memory/knowledge.db
 *   node scripts/td402_fold_project_slugs.mjs --db <path> --rehearse --report /tmp/r.jsonl
 *   node scripts/td402_fold_project_slugs.mjs --db <path> --apply --snapshot <backup>
 *
 * @module scripts/td402_fold_project_slugs
 * @author fifty.dev
 */

import { createRequire } from 'node:module';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING_DIR = resolve(HERE, '../../cli/dist/brain-mcp-server/node_modules/');
const req = createRequire(BINDING_DIR + '/anchor.cjs');
const Database = req('better-sqlite3');
const sqliteVec = req('sqlite-vec');

const LIVE_SLUG = 'fifty_eco_system';
const FOLDING_SLUGS = ['fifty-eco-system', 'fifty-flutter-kit'];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { db: null, apply: false, rehearse: false, snapshot: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--rehearse') out.rehearse = true;
    else if (a === '--snapshot') out.snapshot = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.db) { console.error('--db <path> is required'); process.exit(2); }
if (args.apply && args.rehearse) { console.error('--apply and --rehearse are mutually exclusive'); process.exit(2); }
if (args.apply && !args.snapshot) {
  console.error('--apply REFUSES without --snapshot <path>. Take a fresh db.backup() first.');
  process.exit(2);
}

const MODE = args.apply ? 'apply' : args.rehearse ? 'rehearse' : 'report';
const actions = [];
function record(action) {
  actions.push(action);
  if (args.report) appendFileSync(args.report, JSON.stringify(action) + '\n');
}
if (args.report) writeFileSync(args.report, '');

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// snapshot verification — "I had a backup" as a checkable argument
// ---------------------------------------------------------------------------

function verifySnapshot(path, liveCounts) {
  if (!existsSync(path)) { throw new Error(`--snapshot does not exist: ${path}`); }
  const sdb = new Database(path, { readonly: true });
  try {
    sqliteVec.load(sdb);
    const ic = sdb.pragma('integrity_check');
    if (ic[0]?.integrity_check !== 'ok') throw new Error(`snapshot integrity_check: ${JSON.stringify(ic)}`);
    const got = {};
    for (const t of ['projects', 'brief_status', 'brief_files', 'learnings', 'sessions']) {
      got[t] = sdb.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    }
    log('  snapshot integrity_check: ok');
    for (const t of Object.keys(got)) {
      const same = got[t] === liveCounts[t];
      log(`  snapshot ${t}=${got[t]} live ${t}=${liveCounts[t]} ${same ? 'MATCH' : 'DRIFT'}`);
      if (!same) {
        throw new Error(`snapshot ${t} count ${got[t]} != live ${liveCounts[t]} — the backup is stale, take a fresh one`);
      }
    }
    return got;
  } finally { sdb.close(); }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

const db = new Database(args.db, MODE === 'report' ? { readonly: true } : {});
db.pragma('busy_timeout = 15000');
sqliteVec.load(db);
// vec0 must answer BEFORE any transaction: the briefs_vec_ad trigger fires on
// every brief_status DELETE, and a channel that cannot load vec0 aborts mid-script.
const vecBefore = db.prepare('SELECT count(*) c FROM briefs_vec').get().c;
if (typeof vecBefore !== 'number') throw new Error('briefs_vec did not answer — sqlite-vec is not loaded');
log(`mode=${MODE} db=${args.db} node=${process.version}`);
log(`briefs_vec answers: ${vecBefore} rows`);

// PRAGMA foreign_keys is a silent no-op inside a transaction (BR-083) — settle it first.
let fk = db.pragma('foreign_keys', { simple: true });
if (fk !== 1) {
  db.pragma('foreign_keys = ON');
  fk = db.pragma('foreign_keys', { simple: true });
}
if (fk !== 1) throw new Error('foreign_keys could not be armed — the parent DELETE would not be checked');
log(`foreign_keys = ${fk}`);

const liveCounts = {};
for (const t of ['projects', 'brief_status', 'brief_files', 'learnings', 'sessions']) {
  liveCounts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
}
if (MODE === 'apply') {
  log('verifying --snapshot:');
  verifySnapshot(args.snapshot, liveCounts);
}

// ---------------------------------------------------------------------------
// enumerate project-keyed columns from pragma_table_info (never a hand list)
// ---------------------------------------------------------------------------

const SHADOW_RE = /_(data|idx|content|docsize|config|rowids|vector_chunks\d*|chunks|info|auxiliary)$/;

const projectCols = db.prepare(`
  SELECT m.name AS tbl, p.name AS col
    FROM sqlite_master m JOIN pragma_table_info(m.name) p
   WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
     AND m.sql NOT LIKE 'CREATE VIRTUAL%'
     AND p.name LIKE '%project%'
   ORDER BY m.name, p.name
`).all().filter((c) => !SHADOW_RE.test(c.tbl));

// `projects.slug` is the parent being deleted, not residue to re-point.
const SWEEP = projectCols.filter((c) => !(c.tbl === 'projects'));
// Columns holding a PATH, not a slug — a slug UPDATE would corrupt them.
const PATH_COLS = new Set(['instances.project_path']);

log(`\nproject-keyed columns enumerated: ${projectCols.length} (sweeping ${SWEEP.length})`);
const residueBefore = {};
for (const c of SWEEP) {
  const key = `${c.tbl}.${c.col}`;
  const n = FOLDING_SLUGS.reduce((s, f) => s + db.prepare(`SELECT COUNT(*) c FROM "${c.tbl}" WHERE "${c.col}" = ?`).get(f).c, 0);
  residueBefore[key] = n;
  if (n > 0) log(`  ${key}: ${n} row(s) under the folding slugs${PATH_COLS.has(key) ? ' [PATH COLUMN — not re-pointed]' : ''}`);
}
const nonZero = Object.entries(residueBefore).filter(([, n]) => n > 0);
log(`  non-zero: ${nonZero.length} of ${SWEEP.length}`);

// ---------------------------------------------------------------------------
// classify the stranded briefs: conflicts (have a body) vs dedupes (no body)
//
// "conflict" here is about the BODY, not the id. Every stranded brief collides
// on `brief_id` with a live one (36 of 36 on this data) — see the header. A
// stranded brief that carries a `brief_files` row holds content the live side
// does not, so it must survive under a NEW id; one that carries none is a
// duplicate row with nothing in it.
// ---------------------------------------------------------------------------

const strandedBriefs = db.prepare(
  `SELECT project, brief_id, id, brief_type, title, status, priority, effort, phase
     FROM brief_status WHERE project IN (${FOLDING_SLUGS.map(() => '?').join(',')}) ORDER BY project, brief_id`
).all(...FOLDING_SLUGS);

const conflicts = [];
const dedupes = [];
for (const b of strandedBriefs) {
  const bf = db.prepare('SELECT * FROM brief_files WHERE project=? AND brief_id=?').get(b.project, b.brief_id);
  if (bf) conflicts.push({ ...b, body: bf });
  else dedupes.push(b);
}
log(`\nstranded briefs: ${strandedBriefs.length} — ${conflicts.length} with a body (RE-KEY), ${dedupes.length} without (DELETE)`);
for (const c of conflicts) log(`  RE-KEY  ${c.project}/${c.brief_id} type=${c.brief_type} prio=${c.priority} effort=${c.effort} bytes=${c.body.content.length}`);

// Every dedupe must have a live counterpart WITH a body — that is the content
// criterion. A dedupe whose live counterpart has no body would be destroying the
// only record, so it aborts instead.
//
// THE CRITERION IS CONTENT-LEVEL AND NEVER FIELD-LEVEL, and the difference is
// not hypothetical. A deleted row's own `brief_status` scalars go with it whether
// or not the survivor has them. Measured over the applied run (2026-08-17), of
// the 34 deleted rows: 28 carried an `effort` and 10 carried a `phase` that the
// survivor holds NULL; 6 more carried an `effort` differing from the survivor's
// only in notation (`M-Medium` against `M-Medium (1-2d)`); and one carried a
// `phase` the survivor has since moved past (`BUILDING` deleted, `COMPLETE`
// surviving). Those values live on afterwards ONLY in the `--report` JSONL's
// `before` blocks. `--report` is an optional flag, so running `--apply` without
// it is a deliberate choice to discard them.
for (const d of dedupes) {
  const liveRow = db.prepare('SELECT brief_id FROM brief_status WHERE project=? AND brief_id=?').get(LIVE_SLUG, d.brief_id);
  if (!liveRow) throw new Error(`refusing to delete ${d.project}/${d.brief_id}: no live counterpart under ${LIVE_SLUG}`);
  const liveBody = db.prepare('SELECT 1 FROM brief_files WHERE project=? AND brief_id=?').get(LIVE_SLUG, d.brief_id);
  if (!liveBody) throw new Error(`refusing to delete ${d.project}/${d.brief_id}: live counterpart has no brief_files row either`);
}
log(`  all ${dedupes.length} dedupes have a live counterpart that HAS a body`);

// ---------------------------------------------------------------------------
// free-id derivation — re-derived INSIDE the transaction as well
// ---------------------------------------------------------------------------

/**
 * Next free id for `prefix` in the destination project.
 *
 * `brief_id` is unique per (project, brief_id), so the constraint is the maximum
 * across the three slugs being folded together — a cross-project maximum is not a
 * constraint and would skip ids for no reason.
 */
function nextFreeId(prefix) {
  const rows = db.prepare(
    `SELECT brief_id FROM brief_status
      WHERE project IN (?,?,?) AND brief_id GLOB '${prefix}-*'`
  ).all(LIVE_SLUG, ...FOLDING_SLUGS);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.brief_id.slice(prefix.length + 1), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = `${prefix}-${String(max + 1).padStart(3, '0')}`;
  const taken = db.prepare('SELECT 1 FROM brief_status WHERE project=? AND brief_id=?').get(LIVE_SLUG, next);
  if (taken) throw new Error(`computed id ${next} is already taken under ${LIVE_SLUG}`);
  return next;
}

// ---------------------------------------------------------------------------
// the fold
// ---------------------------------------------------------------------------

function fold() {
  // 1. re-derive the free ids and assert they are still free.
  const assigned = new Map();
  for (const c of conflicts) {
    const prefix = c.brief_id.split('-')[0];
    const next = nextFreeId(prefix);
    if ([...assigned.values()].includes(next)) throw new Error(`id ${next} assigned twice`);
    assigned.set(`${c.project}/${c.brief_id}`, next);
  }

  // 2. re-key the conflicts. brief_files FIRST, then brief_status (P6).
  const rekeyMap = [];
  for (const c of conflicts) {
    const newId = assigned.get(`${c.project}/${c.brief_id}`);

    // Idempotence: if the destination already carries this exact body, the
    // re-key already happened — skip rather than mint a second brief.
    const already = db.prepare('SELECT content_hash FROM brief_files WHERE project=? AND brief_id=?').get(LIVE_SLUG, newId);
    if (already && already.content_hash === c.body.content_hash) {
      record({ kind: 'skip', reason: 'destination already carries this content_hash', table: 'brief_files', key: `${LIVE_SLUG}/${newId}` });
      continue;
    }

    const newFilename = `${newId}.md`;
    db.prepare('UPDATE brief_files SET project=?, brief_id=?, filename=? WHERE project=? AND brief_id=?')
      .run(LIVE_SLUG, newId, newFilename, c.project, c.brief_id);
    record({
      kind: 'update', sql: 'UPDATE brief_files', table: 'brief_files',
      key: `${c.project}/${c.brief_id}`,
      before: { project: c.project, brief_id: c.brief_id, filename: c.body.filename },
      after: { project: LIVE_SLUG, brief_id: newId, filename: newFilename },
      content_hash: c.body.content_hash, bytes: c.body.content.length,
    });

    db.prepare('UPDATE brief_status SET project=?, brief_id=? WHERE id=?')
      .run(LIVE_SLUG, newId, c.id);
    record({
      kind: 'update', sql: 'UPDATE brief_status', table: 'brief_status',
      key: `id=${c.id}`,
      before: { project: c.project, brief_id: c.brief_id, brief_type: c.brief_type, priority: c.priority, effort: c.effort, status: c.status, phase: c.phase },
      after: { project: LIVE_SLUG, brief_id: newId, brief_type: c.brief_type, priority: c.priority, effort: c.effort, status: c.status, phase: c.phase },
      note: 'brief_status.id preserved — an UPDATE avoids the briefs_vec_ad / briefs_fts_status_ad + _ai churn a delete-and-reinsert would fire, and briefs_vec has no re-insert trigger. Precautionary for the vec rowid only — on the 2026-08-17 data both re-keyed rows had embedding IS NULL and no briefs_vec rowid, measured out-of-band; this script reads neither column.',
    });
    rekeyMap.push({ oldProject: c.project, oldId: c.brief_id, newId });
  }

  // 3. re-point every swept column. agent_metrics additionally remaps brief_id
  //    for the re-keyed ids ONLY: a metrics row with brief_id='BR-102' under a
  //    folding slug describes the STRANDED BR-102, so re-pointing `project`
  //    alone would attribute it to different work.
  for (const c of SWEEP) {
    const key = `${c.tbl}.${c.col}`;
    if (c.tbl === 'brief_status' || c.tbl === 'brief_files') continue; // handled above / below
    if (PATH_COLS.has(key)) {
      const n = FOLDING_SLUGS.reduce((s, f) => s + db.prepare(`SELECT COUNT(*) c FROM "${c.tbl}" WHERE "${c.col}"=?`).get(f).c, 0);
      if (n > 0) throw new Error(`${key} holds ${n} folding-slug row(s) but is a PATH column — needs an explicit disposition`);
      continue;
    }
    for (const f of FOLDING_SLUGS) {
      if (c.tbl === 'agent_metrics' && c.col === 'project') {
        for (const rk of rekeyMap.filter((r) => r.oldProject === f)) {
          const r = db.prepare('UPDATE agent_metrics SET project=?, brief_id=? WHERE project=? AND brief_id=?')
            .run(LIVE_SLUG, rk.newId, f, rk.oldId);
          record({ kind: 'update', sql: 'UPDATE agent_metrics (project + brief_id remap)', table: 'agent_metrics', key: `${f}/${rk.oldId}`, rows: r.changes, after: { project: LIVE_SLUG, brief_id: rk.newId } });
        }
      }
      const r = db.prepare(`UPDATE "${c.tbl}" SET "${c.col}"=? WHERE "${c.col}"=?`).run(LIVE_SLUG, f);
      if (r.changes > 0) record({ kind: 'update', sql: `UPDATE ${key}`, table: c.tbl, col: c.col, key: f, rows: r.changes, after: LIVE_SLUG });
    }
  }

  // 4. DELETE the dedupes by explicit (project, brief_id).
  let deleted = 0;
  for (const d of dedupes) {
    const r = db.prepare('DELETE FROM brief_status WHERE project=? AND brief_id=?').run(d.project, d.brief_id);
    deleted += r.changes;
    record({
      kind: 'delete', sql: 'DELETE FROM brief_status', table: 'brief_status',
      key: `${d.project}/${d.brief_id}`, rows: r.changes,
      before: { brief_type: d.brief_type, title: d.title, status: d.status, priority: d.priority, effort: d.effort, phase: d.phase },
      note: 'no brief_files row on this side; live counterpart has one',
    });
  }

  // 5. DELETE the parent rows LAST, with FKs armed, so a missed child aborts all.
  let projectsDeleted = 0;
  for (const f of FOLDING_SLUGS) {
    const r = db.prepare('DELETE FROM projects WHERE slug=?').run(f);
    projectsDeleted += r.changes;
    record({ kind: 'delete', sql: 'DELETE FROM projects', table: 'projects', key: f, rows: r.changes });
  }
  const parentsLeft = db.prepare(
    `SELECT COUNT(*) c FROM projects WHERE slug IN (${FOLDING_SLUGS.map(() => '?').join(',')})`
  ).get(...FOLDING_SLUGS).c;
  if (parentsLeft !== 0) throw new Error(`${parentsLeft} folding projects row(s) survived the DELETE`);
  const liveParent = db.prepare('SELECT slug, name, path, archetype, registered_at FROM projects WHERE slug=?').get(LIVE_SLUG);
  if (!liveParent) throw new Error(`the surviving parent ${LIVE_SLUG} is gone — aborting`);

  // 6. assert-inside-the-transaction: nothing remains under either folding slug.
  const remaining = [];
  let asserted = 0;
  for (const c of projectCols) {
    if (PATH_COLS.has(`${c.tbl}.${c.col}`)) continue;
    asserted++;
    for (const f of FOLDING_SLUGS) {
      const n = db.prepare(`SELECT COUNT(*) c FROM "${c.tbl}" WHERE "${c.col}"=?`).get(f).c;
      if (n > 0) remaining.push(`${c.tbl}.${c.col}=${f} (${n})`);
    }
  }
  if (remaining.length) throw new Error(`residue remains after the fold: ${remaining.join(', ')}`);

  const orphanLearnings = db.prepare('SELECT COUNT(*) c FROM learnings WHERE project NOT IN (SELECT slug FROM projects)').get().c;
  if (orphanLearnings !== 0) throw new Error(`orphan learnings after the fold: ${orphanLearnings}`);

  const summary = {
    kind: 'summary',
    rekeyed: rekeyMap,
    dedupes_deleted: deleted,
    projects_deleted: projectsDeleted,
    surviving_parent: liveParent,
    residue_columns_asserted_zero: asserted,
    residue_columns_enumerated: projectCols.length,
    orphan_learnings: orphanLearnings,
    live_brief_count: db.prepare('SELECT COUNT(*) c FROM brief_status WHERE project=?').get(LIVE_SLUG).c,
    live_brief_files_count: db.prepare('SELECT COUNT(*) c FROM brief_files WHERE project=?').get(LIVE_SLUG).c,
    briefs_vec_count: db.prepare('SELECT count(*) c FROM briefs_vec').get().c,
  };
  record(summary);

  if (MODE === 'rehearse') {
    const e = new Error('REHEARSE_ROLLBACK');
    e.rehearse = true;
    e.summary = summary;
    throw e;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

if (MODE === 'report') {
  log('\n[report mode] nothing was written. Re-run with --rehearse to execute-and-rollback.');
  log(`stranded briefs: ${strandedBriefs.length} (${conflicts.length} re-key, ${dedupes.length} delete)`);
  log(`would re-point: ${nonZero.map(([k, n]) => `${k}=${n}`).join(', ')}`);
  for (const prefix of [...new Set(conflicts.map((c) => c.brief_id.split('-')[0]))]) {
    log(`next free ${prefix} id: ${nextFreeId(prefix)}`);
  }
  db.close();
  process.exit(0);
}

let summary = null;
try {
  summary = db.transaction(fold).immediate();
  log('\nCOMMITTED.');
} catch (e) {
  if (e.rehearse) {
    summary = e.summary;
    log('\nROLLED BACK (rehearse). Every statement above executed, including the FK-guarded parent DELETE.');
  } else {
    log(`\nABORTED — transaction rolled back: ${e.message}`);
    db.close();
    process.exit(1);
  }
}

log('\nsummary:');
log(JSON.stringify(summary, null, 2));
log(`\nactions recorded: ${actions.length}${args.report ? ` -> ${args.report}` : ''}`);
log(`integrity_check: ${JSON.stringify(db.pragma('integrity_check'))}`);
log(`foreign_key_check rows: ${db.prepare('PRAGMA foreign_key_check').all().length}`);
db.close();
