/**
 * TD-445 — claim-threshold re-sweep (READ-ONLY DIAGNOSTIC, checked in so the
 * next re-tune of `dedupe_claim_overlap` is reproducible from the repo, which
 * TD-440's was not).
 *
 * PROVENANCE. TD-440 chose `dedupe_claim_overlap = 0.25` by sweeping a scratch
 * copy of the operator brain with a script that was never checked in; the
 * 410-row slope and the 113-row hand-labelled corpus it cites exist only as
 * figures in `docs/architecture/subconscious_engine.md`. TD-445's production
 * window (T0 `2026-09-03 12:42:03Z`, three new-bundle runs) found three
 * same-anchor re-emissions scoring 0.209 / 0.216 / 0.186 — below the line —
 * and its AC-5 asks whether the line should move. This script is the
 * instrument that answers that, and it is decided by a PRE-REGISTERED rule in
 * `~/.igris/projects/igris-ai/plans/TD-445-plan.md` §"THE DECISION RULE", not
 * by this file.
 *
 * READ-ONLY POSTURE. The database is opened `{ readonly: true,
 * fileMustExist: true }` and this script REFUSES the live brain: `--db` is
 * mandatory, and a path that resolves to `~/.igris/memory/knowledge.db` (or
 * `$IGRIS_BRAIN_DIR/knowledge.db`) exits 3 before anything is opened. Run it
 * against a `.backup` copy taken with `sqlite3 -readonly`:
 *
 *   sqlite3 -readonly ~/.igris/memory/knowledge.db ".backup '<scratch>/knowledge-td445.db'"
 *   sqlite3 <scratch>/knowledge-td445.db "PRAGMA journal_mode=DELETE"   # the copy, not the live file
 *   cd brain-mcp-server && npx tsx scripts/td445_claim_threshold_sweep.ts \
 *       --db <scratch>/knowledge-td445.db --out <scratch>/td445 \
 *       [--findings scripts/td445_row_findings.csv]
 *
 * Never `bootEngine` on the live file (it purges `event_log`); never open the
 * live file writable — `architecture_map.md` §Brain→CLI projection door.
 *
 * SELF-CHECK CONTRACT. Before any row is scored for the slope or the marginal
 * list, the script asserts that the matcher it imported IS the deployed one:
 *   - the four production pairs the brief recorded reproduce to 3 dp —
 *     1880/1888 → 0.209, 1814/1823 → 0.216, 1879/1887 → 0.186 and the
 *     0.128 control 1821/1884 — with equal `entityKey` on each pair and
 *     `claimsMatch === false` at 0.25 / 3;
 *   - the in-repo labelled excerpt (`__tests__/finding-key.test.ts` CORPUS)
 *     reproduces its asserted DIFFERENT-arm maximum, 0.192, to 3 dp;
 *   - three known-answer points on the subject gate and the short-claim guard
 *     hold — a Jaccard-only stand-in reproduces every score and fails these.
 * A self-check failure exits 1 and writes nothing: the instrument is not the
 * matcher the production scores came from (a re-implementation, a normaliser
 * drift, an edited fixture), and labelling on it would label the wrong thing.
 * The functions are IMPORTED from `../src/engine/components/subconscious/
 * finding-key.ts` — never re-implemented (learning #930, TD-285's precedent).
 *
 * WHAT IT EMITS (to `--out`):
 *   - `td445_slope.md`      the cluster count per threshold on two CUTS
 *                           (C1 `created_at < --cut`, the TD-440-comparable
 *                           population; C2 the whole current population)
 *                           under two LOOPS (L1 greedy first-match against
 *                           cluster heads, the loop TD-440's doc describes;
 *                           L2 best-match ≥ t within the entity block, the
 *                           production stage B in
 *                           `cognition/extractors/subconscious.ts`). Every row
 *                           names cut, loop, N and the ordering (`id ASC`).
 *                           Status is ignored, as TD-440's sweep ignored it.
 *   - `td445_marginal_pairs.csv`  M(0.18): every same-anchor pair in C2 that
 *                           `claimsMatch`es at the LOWEST threshold in
 *                           `--thresholds` and does NOT at the shipped 0.25 —
 *                           i.e. exactly the merges a lower line would newly
 *                           admit, PAIRWISE (a superset of what either loop
 *                           admits, so conservative for precision). Columns
 *                           `id_a,id_b,entity_key,score,title_a,title_b,label`,
 *                           sorted score DESC then ids ASC. `label` is blank
 *                           unless `--findings` supplies the row tags it is
 *                           DERIVED from (below).
 *   - the decision table on stdout: per candidate threshold, |M(t)| and how
 *     many of its pairs are labelled SAME / DIFFERENT / EXCLUDED / blank, the
 *     highest-scoring DIFFERENT pair, and which of the three production pairs
 *     it catches.
 *
 * HOW THE LABELS ARE MADE. The plan's rule is per PAIR — "SAME if an operator
 * resolving one would consider the other resolved by the same action" — but
 * that is a property of each row's FINDING, so the hand-authored artifact is
 * `--findings`, a CSV of `id,finding,title` tagging every row that appears in
 * M(low) with the finding it expresses (tags are free text; `EXCLUDED` marks a
 * row that visibly blends two findings, which TD-440's corpus left out rather
 * than forced). Pair labels are derived: both tagged and equal → SAME; both
 * tagged and unequal → DIFFERENT; either `EXCLUDED` → EXCLUDED; a missing tag
 * → blank. Tagging 326 rows once is more consistent than judging 1,018 pairs
 * independently, and a reviewer re-reads a ROW's tag by id rather than a pair.
 * The derivation is transitive by construction — the same-action relation is.
 *
 * The numbers this prints are a NEW slope on a NAMED cut. They are not a
 * continuation of TD-440's row; comparability is claimed only where a recorded
 * point reproduces (the self-check points, and L1/C1 at 0.25 against TD-440's
 * 153, which is reported next to it rather than spliced into it).
 *
 * Usage:
 *   npx tsx scripts/td445_claim_threshold_sweep.ts --db <copy> [--cut <iso>]
 *       [--thresholds 0.18,0.20,0.21,0.22,0.25] [--out <dir>] [--findings <csv>]
 *
 * Exit codes: 0 ok · 1 self-check failed · 2 bad arguments · 3 refused the
 * live brain path.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  candidateFromRow,
  claimOf,
  claimSimilarity,
  claimTokens,
  claimsMatch,
  entityKey,
  type Claim,
} from '../src/engine/components/subconscious/finding-key.js';
import { DEFAULT_SUBCONSCIOUS_CONFIG } from '../src/engine/components/subconscious/types.js';

// ---------------------------------------------------------------------------
// Constants that are RECORDS, not choices
// ---------------------------------------------------------------------------

/** T0 of TD-445's production window — the respawn, never the schema. */
const DEFAULT_CUT = '2026-09-03 12:42:03';

/** The shipped values; the sweep's "does not match today" arm reads them. */
const SHIPPED_THRESHOLD = DEFAULT_SUBCONSCIOUS_CONFIG.dedupe_claim_overlap;
const MIN_TOKENS = DEFAULT_SUBCONSCIOUS_CONFIG.dedupe_min_claim_tokens;

/** The corpus predicate — `subconscious_engine.md` §"These are SNAPSHOTS". */
const CORPUS_SQL = `
  SELECT id, project_slug, title, evidence, suggested_action, entity_key, created_at
    FROM suggestions
   WHERE type_inferred = 1
     AND source_module NOT IN ('janitor','arbiter','curator','cartographer','edge_inference')
   ORDER BY id ASC`;

/**
 * The self-check points. Scores are TD-445's MEASUREMENT READ (2026-09-04),
 * taken with the deployed bundle; `same_anchor` is what makes the three
 * in-band pairs THIS brief's rather than TD-452's.
 */
const PRODUCTION_PAIRS: Array<{ a: number; b: number; score: number; note: string }> = [
  { a: 1880, b: 1888, score: 0.209, note: '"44 of 60 edge_inference" — in band' },
  { a: 1814, b: 1823, score: 0.216, note: 'igris-ai backlog, two heads — in band' },
  { a: 1879, b: 1887, score: 0.186, note: '"Learning 1509 ↔ e7435d0" — in band, below the excerpt floor' },
  { a: 1821, b: 1884, score: 0.128, note: 'fifty_eco_system — the correct non-merge control' },
];

/** `finding-key.test.ts` asserts its DIFFERENT arm tops out here. */
const EXCERPT_DIFF_MAX = 0.192;

/**
 * Known-answer points on the two GATES `claimsMatch` adds over Jaccard — the
 * subject gate and the short-claim guard — taken from `finding-key.test.ts`.
 * A Jaccard-only stand-in reproduces every SCORE above and would still pass;
 * these are what red it (TD-445's R4 mutation is exactly that stand-in).
 */
const GATE_POINTS: Array<{ a: string; b: string; match: boolean; why: string }> = [
  {
    a: 'BR-128 is the only P0-Critical brief in the brain and has sat In Progress 105 days',
    b: 'BR-023 is the only P0-Critical brief in the brain and has sat In Progress 105 days',
    match: false,
    why: 'subject gate — identical prose, disjoint identifiers',
  },
  {
    a: 'queue flooded',
    b: 'the review queue is flooded by mechanical rows',
    match: false,
    why: 'short-claim guard — under minTokens, containment is not equality',
  },
  { a: 'queue flooded', b: 'flooded queue', match: true, why: 'short-claim guard — equal sets' },
];

/** Where the excerpt lives, relative to this script. */
const EXCERPT_TEST_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/engine/components/subconscious/__tests__/finding-key.test.ts',
);

// ---------------------------------------------------------------------------
// Arguments and the live-path refusal
// ---------------------------------------------------------------------------

interface Args {
  db: string;
  cut: string;
  thresholds: number[];
  out: string;
  findings: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: '',
    cut: DEFAULT_CUT,
    thresholds: [0.18, 0.2, 0.21, 0.22, 0.25],
    out: path.join(process.cwd(), 'td445_out'),
    findings: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const need = (): string => {
      if (value === undefined) fail(2, `${flag} needs a value`);
      i += 1;
      return value as string;
    };
    switch (flag) {
      case '--db':
        out.db = need();
        break;
      case '--cut':
        out.cut = need();
        break;
      case '--thresholds':
        out.thresholds = need()
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        break;
      case '--out':
        out.out = need();
        break;
      case '--findings':
        out.findings = need();
        break;
      default:
        fail(2, `unknown flag ${flag}`);
    }
  }
  if (!out.db) fail(2, '--db <path-to-a-.backup-copy> is required');
  if (out.thresholds.length === 0) fail(2, '--thresholds parsed to nothing');
  out.thresholds = [...new Set(out.thresholds)].sort((x, y) => x - y);
  return out;
}

function fail(code: number, message: string): never {
  process.stderr.write(`td445_claim_threshold_sweep: ${message}\n`);
  process.exit(code);
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Exit 3 if `dbPath` is the live brain, by resolved-path equality. */
function refuseLiveBrain(dbPath: string): void {
  const candidates = [path.join(os.homedir(), '.igris', 'memory', 'knowledge.db')];
  if (process.env.IGRIS_BRAIN_DIR) {
    candidates.push(path.join(process.env.IGRIS_BRAIN_DIR, 'knowledge.db'));
  }
  const target = realpathOrSelf(dbPath);
  for (const live of candidates) {
    if (target === realpathOrSelf(live)) {
      fail(3, `refusing the live brain at ${live} — take a \`sqlite3 -readonly … .backup\` copy first`);
    }
  }
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  project_slug: string | null;
  title: string;
  evidence: string | null;
  suggested_action: string | null;
  entity_key: string | null;
  created_at: string;
}

interface Scored {
  id: number;
  anchor: string;
  claim: Claim;
  title: string;
  created_at: string;
}

function score(rows: Row[]): Scored[] {
  return rows.map((row) => ({
    id: row.id,
    anchor: entityKey(candidateFromRow(row)),
    claim: claimOf(row.title ?? ''),
    title: row.title ?? '',
    created_at: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// The two accept loops
// ---------------------------------------------------------------------------

/** L1 — greedy FIRST match against the cluster heads in the anchor block. */
function clustersL1(rows: Scored[], t: number): number {
  const heads = new Map<string, Claim[]>();
  for (const row of rows) {
    const block = heads.get(row.anchor) ?? [];
    if (!block.some((head) => claimsMatch(row.claim, head, t, MIN_TOKENS))) {
      block.push(row.claim);
      heads.set(row.anchor, block);
    }
  }
  let n = 0;
  for (const block of heads.values()) n += block.length;
  return n;
}

/** L2 — BEST match ≥ t in the anchor block (production stage B). */
function clustersL2(rows: Scored[], t: number): number {
  const heads = new Map<string, Claim[]>();
  for (const row of rows) {
    const block = heads.get(row.anchor) ?? [];
    let best = -1;
    for (const head of block) {
      if (!claimsMatch(row.claim, head, t, MIN_TOKENS)) continue;
      const s = claimSimilarity(row.claim.tokens, head.tokens);
      if (s > best) best = s;
    }
    if (best < 0) {
      block.push(row.claim);
      heads.set(row.anchor, block);
    }
  }
  let n = 0;
  for (const block of heads.values()) n += block.length;
  return n;
}

// ---------------------------------------------------------------------------
// The marginal set M(t)
// ---------------------------------------------------------------------------

interface Pair {
  a: Scored;
  b: Scored;
  score: number;
}

/**
 * Every same-anchor pair that `claimsMatch`es at `low` and does NOT at the
 * shipped threshold — the merges a line at `low` would newly admit, pairwise.
 */
function marginalPairs(rows: Scored[], low: number): Pair[] {
  const byAnchor = new Map<string, Scored[]>();
  for (const row of rows) {
    const block = byAnchor.get(row.anchor) ?? [];
    block.push(row);
    byAnchor.set(row.anchor, block);
  }
  const out: Pair[] = [];
  for (const block of byAnchor.values()) {
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        const a = block[i]!;
        const b = block[j]!;
        if (!claimsMatch(a.claim, b.claim, low, MIN_TOKENS)) continue;
        if (claimsMatch(a.claim, b.claim, SHIPPED_THRESHOLD, MIN_TOKENS)) continue;
        out.push({ a, b, score: claimSimilarity(a.claim.tokens, b.claim.tokens) });
      }
    }
  }
  out.sort((x, y) => y.score - x.score || x.a.id - y.a.id || x.b.id - y.b.id);
  return out;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180 — titles carry commas, quotes and em-dashes)
// ---------------------------------------------------------------------------

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Row id → finding tag, from the hand-authored `--findings` CSV. */
function readFindings(file: string): Map<number, string> {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows[0] ?? [];
  const ii = header.indexOf('id');
  const ifi = header.indexOf('finding');
  if (ii < 0 || ifi < 0) fail(2, `${file}: header must carry id, finding`);
  const out = new Map<number, string>();
  for (const row of rows.slice(1)) {
    if (row.length <= ifi) continue;
    const tag = (row[ifi] ?? '').trim();
    if (tag.length > 0) out.set(Number(row[ii]), tag);
  }
  return out;
}

/** The derived pair label — see "HOW THE LABELS ARE MADE" in the header. */
function pairLabel(findings: Map<number, string>, p: Pair): string {
  const a = findings.get(p.a.id);
  const b = findings.get(p.b.id);
  if (a === undefined || b === undefined) return '';
  if (a === 'EXCLUDED' || b === 'EXCLUDED') return 'EXCLUDED';
  return a === b ? 'SAME' : 'DIFFERENT';
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/** Read the CORPUS literal out of the test file — one source of truth. */
function excerptCorpus(): Record<string, Record<string, string[]>> {
  const src = fs.readFileSync(EXCERPT_TEST_FILE, 'utf8');
  const start = src.indexOf('const CORPUS: Record<string, Record<string, string[]>> = {');
  if (start < 0) fail(1, `self-check: CORPUS literal not found in ${EXCERPT_TEST_FILE}`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n};', open);
  if (close < 0) fail(1, 'self-check: CORPUS literal has no terminator');
  const literal = src.slice(open, close + 2);
  return vm.runInNewContext(`(${literal})`) as Record<string, Record<string, string[]>>;
}

function excerptDiffMax(): number {
  const corpus = excerptCorpus();
  let max = 0;
  for (const groups of Object.values(corpus)) {
    const names = Object.keys(groups);
    for (let a = 0; a < names.length; a++) {
      for (let b = a + 1; b < names.length; b++) {
        for (const x of groups[names[a]!]!) {
          for (const y of groups[names[b]!]!) {
            max = Math.max(max, claimSimilarity(claimTokens(x), claimTokens(y)));
          }
        }
      }
    }
  }
  return max;
}

function to3dp(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function selfCheck(db: Database.Database): string[] {
  const lines: string[] = [];
  const problems: string[] = [];
  const ids = PRODUCTION_PAIRS.flatMap((p) => [p.a, p.b]);
  const rows = db
    .prepare(
      `SELECT id, project_slug, title, evidence, suggested_action, entity_key, created_at
         FROM suggestions WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const p of PRODUCTION_PAIRS) {
    const A = byId.get(p.a);
    const B = byId.get(p.b);
    if (!A || !B) {
      problems.push(`pair ${p.a}/${p.b}: row missing from the copy`);
      continue;
    }
    const s = claimSimilarity(claimTokens(A.title), claimTokens(B.title));
    const ka = entityKey(candidateFromRow(A));
    const kb = entityKey(candidateFromRow(B));
    const m25 = claimsMatch(claimOf(A.title), claimOf(B.title), SHIPPED_THRESHOLD, MIN_TOKENS);
    const ok = to3dp(s) === p.score && ka === kb && m25 === false;
    lines.push(
      `  ${ok ? 'ok ' : 'BAD'} ${p.a}/${p.b}  score ${s.toFixed(4)} (expected ${p.score.toFixed(3)})  ` +
        `anchor ${ka}${ka === kb ? '' : ` ≠ ${kb}`}  match@${SHIPPED_THRESHOLD}=${m25}  — ${p.note}`,
    );
    if (!ok) problems.push(`pair ${p.a}/${p.b} does not reproduce`);
  }
  const dm = excerptDiffMax();
  const dmOk = to3dp(dm) === EXCERPT_DIFF_MAX;
  lines.push(
    `  ${dmOk ? 'ok ' : 'BAD'} excerpt DIFFERENT max ${dm.toFixed(4)} (expected ${EXCERPT_DIFF_MAX.toFixed(3)})  — ${EXCERPT_TEST_FILE}`,
  );
  if (!dmOk) problems.push('excerpt DIFFERENT max does not reproduce');
  for (const g of GATE_POINTS) {
    const m = claimsMatch(claimOf(g.a), claimOf(g.b), SHIPPED_THRESHOLD, MIN_TOKENS);
    const ok = m === g.match;
    lines.push(`  ${ok ? 'ok ' : 'BAD'} gate  match=${m} (expected ${g.match})  — ${g.why}`);
    if (!ok) problems.push(`gate point does not reproduce: ${g.why}`);
  }
  if (problems.length > 0) {
    process.stderr.write(`SELF-CHECK FAILED — the imported matcher is not the deployed one:\n${lines.join('\n')}\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  refuseLiveBrain(args.db);
  if (!fs.existsSync(args.db)) fail(2, `${args.db} does not exist`);
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  const out: string[] = [];
  const say = (line = ''): void => {
    out.push(line);
    process.stdout.write(`${line}\n`);
  };

  try {
    say(`# TD-445 claim-threshold sweep`);
    say(`db: ${args.db}`);
    say(`shipped: dedupe_claim_overlap=${SHIPPED_THRESHOLD} dedupe_min_claim_tokens=${MIN_TOKENS}`);
    say(`cut: ${args.cut}   thresholds: ${args.thresholds.join(', ')}`);
    say();
    say('## Self-check (the instrument is the deployed matcher)');
    for (const line of selfCheck(db)) say(line);
    say();

    const total = (db.prepare('SELECT COUNT(*) AS n FROM suggestions').get() as { n: number }).n;
    const rows = db.prepare(CORPUS_SQL).all() as Row[];
    const scored = score(rows);
    const c1 = scored.filter((r) => r.created_at < args.cut);
    const c2 = scored;
    const anchorMismatch = rows.filter(
      (r, i) => typeof r.entity_key === 'string' && r.entity_key.length > 0 && r.entity_key !== scored[i]!.anchor,
    ).length;
    say('## Corpus');
    say(`suggestions total: ${total}`);
    say(`C1 (predicate ∧ created_at < ${args.cut}): N=${c1.length}, anchors=${new Set(c1.map((r) => r.anchor)).size}`);
    say(`C2 (predicate, whole table):               N=${c2.length}, anchors=${new Set(c2.map((r) => r.anchor)).size}`);
    say(`stored entity_key ≠ recomputed entityKey(candidateFromRow): ${anchorMismatch} rows`);
    say();

    say('## Slope — clusters per threshold (order: id ASC; status ignored)');
    say('| threshold | C1/L1 | C1/L2 | C2/L1 | C2/L2 |');
    say('|---|---|---|---|---|');
    for (const t of args.thresholds) {
      say(`| ${t.toFixed(3)} | ${clustersL1(c1, t)} | ${clustersL2(c1, t)} | ${clustersL1(c2, t)} | ${clustersL2(c2, t)} |`);
    }
    say(`(C1 N=${c1.length}, C2 N=${c2.length}; L1 = greedy first-match against heads, L2 = best-match ≥ t, production stage B)`);
    say();

    const low = args.thresholds[0]!;
    const pairs = marginalPairs(c2, low);
    const findings = args.findings ? readFindings(args.findings) : new Map<number, string>();
    const labelOf = (p: Pair): string => pairLabel(findings, p);
    const rowsInM = new Set(pairs.flatMap((p) => [p.a.id, p.b.id]));
    let tagged = 0;
    let stale = 0;
    for (const id of findings.keys()) if (rowsInM.has(id)) tagged += 1; else stale += 1;

    say(`## Marginal set M(${low}) on C2 — pairwise, same anchor, matches at ${low} and not at ${SHIPPED_THRESHOLD}`);
    say(
      `|M(${low})| = ${pairs.length} pairs over ${rowsInM.size} rows` +
        (args.findings
          ? `   row tags applied: ${tagged} of ${rowsInM.size}; tags for rows no longer in M: ${stale}`
          : ''),
    );
    say();
    say('| t | |M(t)| | SAME | DIFFERENT | EXCLUDED | unlabelled | production pairs caught | highest DIFFERENT |');
    say('|---|---|---|---|---|---|---|---|');
    const prodKeys = new Set(PRODUCTION_PAIRS.slice(0, 3).map((p) => `${p.a},${p.b}`));
    for (const t of args.thresholds) {
      if (t >= SHIPPED_THRESHOLD) continue;
      const mt = pairs.filter((p) => claimsMatch(p.a.claim, p.b.claim, t, MIN_TOKENS));
      const same = mt.filter((p) => labelOf(p) === 'SAME').length;
      const diff = mt.filter((p) => labelOf(p) === 'DIFFERENT');
      const excluded = mt.filter((p) => labelOf(p) === 'EXCLUDED').length;
      const blank = mt.length - same - diff.length - excluded;
      const caught = mt.filter((p) => prodKeys.has(`${p.a.id},${p.b.id}`)).map((p) => `${p.a.id}/${p.b.id}`);
      const top = diff[0] ? `${diff[0].a.id}/${diff[0].b.id} @ ${diff[0].score.toFixed(4)}` : '—';
      say(`| ${t.toFixed(2)} | ${mt.length} | ${same} | ${diff.length} | ${excluded} | ${blank} | ${caught.length ? caught.join(' ') : 'none'} | ${top} |`);
    }
    say();

    say('## Record re-reads (not decision inputs)');
    const near226 = pairs.filter((p) => Math.abs(p.score - 0.226) < 0.0015);
    say(`pairs scoring ≈0.226 (TD-440\'s highest DIFFERENT on the 113-row corpus): ${near226.length ? near226.map((p) => `${p.a.id}/${p.b.id} @ ${p.score.toFixed(4)}${p.a.created_at < args.cut && p.b.created_at < args.cut ? ' (both in C1)' : ''}`).join('; ') : 'none'}`);
    const ANCHORS: Array<[number, number, number]> = [
      [1660, 1291, 0.25],
      [1473, 1275, 0.259],
    ];
    const byId = new Map(scored.map((r) => [r.id, r]));
    for (const [x, y, recorded] of ANCHORS) {
      const X = byId.get(x);
      const Y = byId.get(y);
      say(
        X && Y
          ? `[${x}]→[${y}] recorded ${recorded}: now ${claimSimilarity(X.claim.tokens, Y.claim.tokens).toFixed(4)}, anchors ${X.anchor} / ${Y.anchor}`
          : `[${x}]→[${y}] recorded ${recorded}: row missing from the predicate corpus`,
      );
    }
    const top = pairs[0];
    say(`highest same-anchor pair below the line: ${top ? `${top.a.id}/${top.b.id} @ ${top.score.toFixed(4)}` : 'none'}`);
    say();

    fs.mkdirSync(args.out, { recursive: true });
    const csv = [
      'id_a,id_b,entity_key,score,title_a,title_b,label',
      ...pairs.map((p) =>
        [
          String(p.a.id),
          String(p.b.id),
          p.a.anchor,
          p.score.toFixed(4),
          csvField(p.a.title),
          csvField(p.b.title),
          csvField(labelOf(p)),
        ].join(','),
      ),
    ].join('\n');
    const csvPath = path.join(args.out, 'td445_marginal_pairs.csv');
    fs.writeFileSync(csvPath, `${csv}\n`);
    const slopePath = path.join(args.out, 'td445_slope.md');
    fs.writeFileSync(slopePath, `${out.join('\n')}\n`);
    say(`wrote ${csvPath}`);
    say(`wrote ${slopePath}`);
  } finally {
    db.close();
  }
}

main();
