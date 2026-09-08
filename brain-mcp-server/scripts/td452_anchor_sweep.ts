/**
 * TD-452 — entity-anchor re-design sweep (READ-ONLY DIAGNOSTIC, checked in so
 * the anchor decision is reproducible from the repo the way TD-445's threshold
 * decision is). Named `td452_*` so BR-101's prune keeps it out of the package.
 *
 * WHAT IT MEASURES. `entityKey` BLOCKS and `claimsMatch` DISCRIMINATES
 * (TD-440). TD-452 proposed changing what gets BLOCKED together in two ways —
 * (a-narrow) the evidence-derived `brief:` anchor is taken only when the TITLE
 * names an id, and (c) a `global` candidate is compared against `project:*`
 * blocks (and vice versa) in a SECOND pass when its own block yields nothing.
 * Every pair that becomes comparable under a candidate rule and was not under
 * the shipped one is a pair the change could newly MERGE, so the decision set
 * is that pairwise set at the shipped threshold, labelled per row, and the
 * DIFFERENT count must be 0 (the pre-registered rule in
 * `plans/TD-452-plan.md` §1 — pairwise, a superset of what any loop admits,
 * therefore conservative for precision; TD-445's rule).
 *
 * THE OUTCOME IT RECORDED (2026-09-07, 1,912-row copy, cut C2 N=442, both
 * tag files — `td445_row_findings.csv` + `td452_row_findings.csv`): NEITHER
 * candidate ships. (a-narrow) newly admits 52 pairs, 43 SAME / 9 DIFFERENT —
 * 4 of the 9 on TD-445's own tags (`stalled_detector_gap` ×
 * `zero_learnings_projects`, 1434/1486 @ 0.303), the highest DIFFERENT being
 * 1596/1614 @ 0.581 on a TD-452 tag; (c) admits 85, 49 SAME / 33 DIFFERENT
 * (highest 1291/1698 @ 0.387); its pre-registered asymmetric narrowings admit
 * 45 (13 DIFFERENT) and 40 (20 DIFFERENT); (a)+(c) 208 with 90 DIFFERENT. An
 * earlier draft of this paragraph quoted 4 / 26 / 11 / 15 from a run over
 * TD-445's tags alone — superseded by the two-file figures, which are the
 * ones every other record cites. So the anchor is unchanged and BOTH
 * candidates live HERE, as transformations of the SHIPPED matcher, not as
 * runtime exports with no caller:
 *   - candidate (a-narrow) = `entityKey()` of the candidate with its evidence
 *     brief ids REMOVED, taken only when the shipped anchor is `brief:` and the
 *     title names no id — the shipped precedence chain decides where the row
 *     lands next (the action's brief_id, a learning, `global`).
 *   - candidate (c) = {@link candidateComparable}, `global` ↔ `project:*`.
 * Nothing in the matcher is re-implemented (learning #930): scoring, gating
 * and the shipped anchor are the imported functions.
 *
 * THE TWO ARMS. A = the STORED `entity_key` column — every row was stamped by
 * the deployed writer (or v5's backfill) with the shipped `entityKey`, and the
 * self-check requires the column to equal the imported `entityKey()` on 100%
 * of rows (that pins the column as a faithful HEAD arm). B = the (a-narrow)
 * candidate anchor. Designs: `a` (B anchors, same block only), `c` (A anchors,
 * cross-block), `cg` / `cp` (the asymmetric narrowings: the LATER row is the
 * candidate, and only a global / only a project candidate crosses), `ac`
 * (B anchors, cross-block).
 *
 * READ-ONLY POSTURE, copied from `td445_claim_threshold_sweep.ts`: `--db` is
 * mandatory, a path resolving to the live brain exits 3 before anything is
 * opened, and the copy is opened `{ readonly: true }`.
 *
 *   sqlite3 -readonly ~/.igris/memory/knowledge.db ".backup '<scratch>/knowledge-td452.db'"
 *   sqlite3 <scratch>/knowledge-td452.db "PRAGMA journal_mode=DELETE"
 *   cd brain-mcp-server && npx tsx scripts/td452_anchor_sweep.ts \
 *       --db <scratch>/knowledge-td452.db --out <scratch>/td452 \
 *       --findings scripts/td445_row_findings.csv \
 *       --findings2 scripts/td452_row_findings.csv
 *
 * SELF-CHECK (exit 1, writes nothing, on any failure): the stored column
 * equals the imported `entityKey()` on every row; TD-445's four production
 * scores reproduce to 3 dp with `claimsMatch === false` at the shipped
 * threshold; the brief's own points — family 1 pairwise 0.238 / 0.200 /
 * 0.238 (no match) and family 2 at 0.414 (match) — reproduce; C1 @0.25 under
 * the A arm is 153 (TD-440's and TD-445's row); five known-answer points on
 * the candidate comparability rule.
 *
 * WHAT IT EMITS (to `--out`): `td452_anchor_census.md` (this stdout),
 * `td452_moved_rows.csv`, `td452_new_pairs.csv`
 * (`id_a,id_b,anchor_a,anchor_b,anchor_a_new,anchor_b_new,score,design,label,title_a,title_b`),
 * `td452_crossblock_top.csv` (the highest-scoring global×project pairs) and
 * `td452_untagged_rows.csv` (rows in a decision set that neither findings
 * file tags — the template for hand-tagging).
 *
 * TD-454 (2026-09-07): `--vocab-from-db` loads the copy's `projects` slugs
 * through the shipped `loadProjectVocabulary` and adds three claim VARIANTS
 * beside the vocab-off claim — `gate` (the shipped project-set gate),
 * `strip` (the NAMED slugs' tokens removed from the similarity operands) and
 * `gate+strip` (with `--strip-slugs`). The self-check stays vocab-OFF, so it
 * still pins the instrument to HEAD; the TD-454 sections report the shape
 * (S1/S2/S3/EQ) and separator of every DIFFERENT pair in the vocab-off
 * decision sets, the AC-3 re-evaluation of P_new on each variant, the
 * same-block recall cost / precision gain, and the loop replay under the
 * gate. Emits `td454_census.md`, `td454_pairs_separated.csv`
 * (`id_a,id_b,design,score,label,shape,separated_by,projects_a,projects_b`
 * — the checked-in record), `td454_recall_cost.csv`, `td454_pnew_variants.csv`.
 * Outcome on the 1,914-row copy: (a-narrow) 15 / 15 SAME / 0 DIFFERENT under
 * the gate (passes the pairwise rule — a follow-up, D-3); (c) 50 / 44 / 5
 * (four S3 floods + one equal-list pair, fails); strip fails P-3 (breaks 82
 * more SAME pairs than the gate alone); the gate's own same-block cost is 49
 * SAME pairs / 6 DIFFERENT separated, C1 153 → 169, C2 183 → 200.
 *
 * TD-458 (2026-09-08): `--source-module-gate` (requires `--vocab-from-db`)
 * adds two more claim VARIANTS — `mod` (the shipped project-set gate PLUS a
 * MODULE-NAME gate) and, with `--strip-slugs`, `modStrip`. The module gate is
 * the `subjectIds` rule (gate 1) over a closed vocabulary the TITLES carry:
 * both titles name modules AND the two sets are DISJOINT ⇒ no match. The
 * vocabulary is a property of the CODE, not the data — the v1 CHECK set
 * (`stalled`, `conflict`, `gap`, `pattern`), the synapse writer's
 * `edge_inference`, and the four internal modules `CORPUS_SQL` excludes — so
 * it is inert on a fresh brain and never reads the LLM's `source_module`
 * labels (`1801` = `suggestion_channel_flooded`, `1888` =
 * `self_referential_finding_risk`: the SAME pair, two labels — the row's own
 * column is dead as a lever, TD-440 AC-4). `namedModules` IS the shipped
 * `namedProjects` algorithm over that constant list (nothing re-implemented).
 * PRE-REGISTERED RULE (recorded before the sweep): P-A the gate separates all
 * four S3 pairs `1341`/`1801`, `1355`/`1801`, `1326`/`1888`, `1271`/`1815`;
 * P-B it breaks 0 labelled SAME pairs — in P_new of every design and inside
 * the shipped blocks on C1 and C2; P-C it separates ≥ 1 labelled DIFFERENT
 * pair INSIDE a shipped block (a live-path benefit; the shipped loop compares
 * a candidate against its OWN block only, so a cross-block separation changes
 * nothing live). Ship iff P-A ∧ P-B ∧ P-C. `1297`/`1830` (EQ) is out of scope.
 * (c) closes in either outcome. Emits `td458_s3_pairs.csv`,
 * `td458_module_recall_cost.csv`, `td458_census.md`.
 * OUTCOME (2026-09-08, 1,918-row copy, C2 N=448): P-A 4/4 separated; P-B 0
 * SAME broken (P_new of every design, same-block C1/C2); P-C 3 same-block
 * DIFFERENT pairs separated (1326/1809 @0.258, 1326/1815 @0.250, 1384/1809
 * @0.250, all `global`) → SHIPPED as gate 1c in `claimsMatch`. P_new under the
 * gate+module matcher: a 15/15/0, c 46/44/1 (the EQ pair), cg 31/31/0,
 * cp 15/13/1 (EQ), ac 83/67/15; C1 169 / C2 204 unchanged by the module gate
 * (the separated candidates land on another head in the same block).
 * POST-SHIP POSTURE: the module gate is INSIDE the imported `claimsMatch`, so
 * every variant carries it. `--source-module-gate` now reports the gate's
 * INCREMENTAL effect by comparing the shipped claims against `noMod` — the
 * same claims with the module set EMPTIED (a transformation of the shipped
 * matcher's input, L-930; nothing re-implemented). The pre-ship reading
 * (instrument gate over `gate`) and the post-ship reading (shipped `gate`
 * over `noMod`) must agree — the self-check pins the four S3 separations and
 * the P_new(a) 15/15/0 point on the shipped matcher.
 *
 * TD-457 (2026-09-08) SHIPPED anchor (a-narrow): `entityKey` consults the
 * EVIDENCE brief ids only when the title names an id (the ACTION brief param
 * still anchors). Post-ship posture of this instrument, dated here so nobody
 * "fixes" the self-checks by deleting them:
 *   - `candidateAnchor` == the imported `entityKey` on every row now, so the
 *     B arm IS the shipped anchor. The "stored == imported" self-check became
 *     `disagree === moved` with the SAME id set: on a PRE-re-key copy the
 *     stored column is the pre-TD-457 anchor and the disagreements are
 *     exactly the (a-narrow) moved set (26 on the 2026-09-08 copy); on a
 *     re-keyed copy both are 0.
 *   - C1 @0.25 under A is asserted as 153 (TD-440/TD-445's row, the
 *     pre-TD-457 anchor) only when `disagree > 0`; on a re-keyed copy the
 *     dated pin `C1_AT_SHIPPED_TD457` = 146 is asserted instead (first
 *     reading on the 2026-09-08 `--rekey-check` run: L1 146, L2 146, N=410,
 *     anchors 35 — the seven `brief:` blocks that held one row each folded
 *     into `global`; then pinned).
 *   - on a re-keyed copy design `a` admits 0 new pairs (B == A everywhere).
 *   - `--rekey-check <writable-scratch-copy>` refuses the live path, applies
 *     schema v6 (NULL-all) and `backfillFindingKeys`, prints the NULL count
 *     (must be 0), the moved count, the unmoved-rows byte-identity check and
 *     `moved ∩ dismissed` (D-4), then re-runs the whole sweep on that copy.
 *   Emits `td457_pairs_a_narrow.csv` (the 15 pairs on a pre-re-key copy:
 *   `id_a,id_b,anchor_pre,anchor_post,score,label,projects_a,projects_b,
 *   title_a,title_b`) and `td457_census.md`.
 *
 * Exit codes: 0 ok · 1 self-check failed · 2 bad arguments · 3 refused the
 * live brain path.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GLOBAL_ENTITY_KEY,
  backfillFindingKeys,
  candidateFromRow,
  claimOf,
  claimSimilarity,
  claimsMatch,
  entityKey,
  loadProjectVocabulary,
  namedProjects,
  subjectIds,
  type Claim,
  type ProjectVocabulary,
} from '../src/engine/components/subconscious/finding-key.js';
import { DEFAULT_SUBCONSCIOUS_CONFIG } from '../src/engine/components/subconscious/types.js';
import { subconsciousMigrations } from '../src/engine/components/subconscious/schema.js';
import { normalizeForDedup } from '../src/engine/components/perception/dedup.js';

// ---------------------------------------------------------------------------
// Records, not choices
// ---------------------------------------------------------------------------

/** T0 of TD-445's production window — the cut C1 is comparable to TD-440 on. */
const DEFAULT_CUT = '2026-09-03 12:42:03';
const SHIPPED_THRESHOLD = DEFAULT_SUBCONSCIOUS_CONFIG.dedupe_claim_overlap;
const MIN_TOKENS = DEFAULT_SUBCONSCIOUS_CONFIG.dedupe_min_claim_tokens;

/** Same predicate as td445 — `subconscious_engine.md` §"These are SNAPSHOTS". */
const CORPUS_SQL = `
  SELECT id, project_slug, title, evidence, suggested_action, entity_key, status, created_at
    FROM suggestions
   WHERE type_inferred = 1
     AND source_module NOT IN ('janitor','arbiter','curator','cartographer','edge_inference')
   ORDER BY id ASC`;

const ALL_SQL = `
  SELECT id, project_slug, title, evidence, suggested_action, entity_key, dedupe_key, status, created_at
    FROM suggestions ORDER BY id ASC`;

/** TD-440's C1 @0.25 point, reproduced by TD-445 — the A arm must give it on a PRE-re-key copy (the pre-TD-457 anchor). */
const C1_AT_SHIPPED = 153;
/**
 * TD-457: C1 @0.25 under the SHIPPED (a-narrow) anchor on a re-keyed copy.
 * `null` = not yet measured (the run prints the first reading and asks for
 * the pin); a number = asserted. Recorded 2026-09-08 from `--rekey-check`.
 */
const C1_AT_SHIPPED_TD457: number | null = 146; // first reading 2026-09-08: L1 146, L2 146 (N=410, anchors=35)

/** Known-answer scores: TD-445's four, then the brief's own two families. */
const SCORE_POINTS: Array<{ a: number; b: number; score: number; note: string }> = [
  { a: 1880, b: 1888, score: 0.209, note: 'TD-445 in-band miss' },
  { a: 1814, b: 1823, score: 0.216, note: 'TD-445 in-band miss' },
  { a: 1879, b: 1887, score: 0.186, note: 'TD-445 DIFFERENT' },
  { a: 1821, b: 1884, score: 0.128, note: 'TD-445 control' },
  { a: 1822, b: 1883, score: 0.238, note: 'family 1 (below the line)' },
  { a: 1822, b: 1885, score: 0.2, note: 'family 1 (below the line)' },
  { a: 1883, b: 1885, score: 0.238, note: 'family 1 (below the line)' },
  { a: 1801, b: 1888, score: 0.414, note: 'family 2 (above the line, split by anchor)' },
];

const COMPARABLE_POINTS: Array<{ a: string; b: string; expect: boolean }> = [
  { a: 'global', b: 'project:igris-ai', expect: true },
  { a: 'project:igris-ai', b: 'global', expect: true },
  { a: 'project:igris-ai', b: 'project:lifeos', expect: false },
  { a: 'brief:br-074', b: 'global', expect: false },
  { a: 'learning:42', b: 'global', expect: false },
  { a: 'project:igris-ai', b: 'project:igris-ai', expect: true },
];

// ---------------------------------------------------------------------------
// TD-458 — the MODULE-NAME gate (measured here, not shipped)
// ---------------------------------------------------------------------------

/**
 * The closed module vocabulary the TITLES can name. A property of the code:
 * `schema.ts` v1 `CHECK (source_module IN (...))` + the synapse writer's
 * literal + the four internal modules `CORPUS_SQL` excludes. NOT
 * `SELECT DISTINCT source_module` — that would be inert on a fresh brain and
 * would read the LLM's re-authored labels on this one.
 */
const MODULE_VOCABULARY = [
  'stalled', 'conflict', 'gap', 'pattern', // schema.ts v1 CHECK set
  'edge_inference', // extractors/synapse.ts
  'janitor', 'arbiter', 'curator', 'cartographer', // CORPUS_SQL's exclusion list
];
const MODULE_VOCAB: ProjectVocabulary = new Map(
  MODULE_VOCABULARY.map((m) => [m, normalizeForDedup(m).split(' ').filter((w) => w.length > 0)]),
);

/** The modules a title NAMES — the shipped `namedProjects` algorithm over the constant list. */
function namedModules(title: string): Set<string> {
  return namedProjects(title, MODULE_VOCAB);
}

/**
 * The pre-registered DISJOINT reading (gate 1's rule): both sides name modules
 * and share none ⇒ different findings. One empty side is NOT disjoint (a
 * re-emission that drops the module word still merges); `{stalled, gap}` vs
 * `{stalled}` shares a member (not disjoint) — EQUALITY would refuse that
 * re-emission, which is why equality is reported beside this, never as the
 * verdict.
 */
function modulesDisjoint(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const m of a) if (b.has(m)) return false;
  return true;
}

/** The EQUAL reading, reported beside the verdict (never the verdict). */
function modulesUnequal(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return true;
  for (const m of a) if (!b.has(m)) return true;
  return false;
}

/** The four S3 pairs and their pinned module sets (L-35 read of the copy, 2026-09-08). */
const S3_PAIRS: Array<{ a: number; b: number; modsA: string[]; modsB: string[] }> = [
  { a: 1341, b: 1801, modsA: ['gap', 'stalled'], modsB: ['edge_inference'] },
  { a: 1355, b: 1801, modsA: ['gap', 'stalled'], modsB: ['edge_inference'] },
  { a: 1326, b: 1888, modsA: ['gap', 'stalled'], modsB: ['edge_inference'] },
  { a: 1271, b: 1815, modsA: ['gap', 'stalled'], modsB: ['edge_inference'] },
];
/** The EQ pair — out of every named mechanism's reach; reported, never a criterion. */
const EQ_PAIR = { a: 1297, b: 1830 };

/** Known-answer points for `namedModules` (the algorithm + the vocabulary, pinned). */
const MODULE_POINTS: Array<{ title: string; expect: string[]; note: string }> = [
  { title: '58 of 61 open suggestions are mechanical stalled/gap rows', expect: ['gap', 'stalled'], note: 'designed pair, side A' },
  { title: '58 of 61 open suggestions are mechanical stalled rows', expect: ['stalled'], note: 'designed pair, side B' },
  { title: 'Learning capture is concentrated in igris-ai while 8 projects have zero learnings', expect: [], note: 'no module word' },
  { title: "44 of the 60 open suggestions are low-value edge_inference rows", expect: ['edge_inference'], note: 'underscore token survives normalizeForDedup' },
];

// ---------------------------------------------------------------------------
// The two CANDIDATE designs — measured here, not shipped
// ---------------------------------------------------------------------------

/**
 * Candidate (c): which anchors the paraphrase stage would compare ACROSS —
 * `global` against any `project:` block, never an id-bound block.
 */
function candidateComparable(a: string, b: string): boolean {
  if (a === b) return true;
  const project = (k: string): boolean => k.startsWith('project:');
  return (a === GLOBAL_ENTITY_KEY && project(b)) || (b === GLOBAL_ENTITY_KEY && project(a));
}

/**
 * Candidate (a-narrow): the evidence brief is an illustration unless the
 * title names an id. Expressed as the SHIPPED `entityKey` over the candidate
 * with `evidence.brief_id` / `brief_ids` removed, so the shipped precedence
 * (action target brief → learning → suggestion → global) decides the new
 * anchor and nothing is re-implemented.
 */
function candidateAnchor(row: Row): string {
  // TD-457: post-ship the imported `entityKey` already skips the evidence
  // brief when the title names no id, so this returns `shipped` unchanged —
  // the B arm IS the shipped anchor (the self-check pins disagree === moved).
  const candidate = candidateFromRow(row);
  const shipped = entityKey(candidate);
  if (!shipped.startsWith('brief:') || subjectIds(candidate.title).size > 0) return shipped;
  const { brief_id: _briefId, brief_ids: _briefIds, ...rest } = candidate.evidence ?? {};
  return entityKey({ ...candidate, evidence: rest });
}

// ---------------------------------------------------------------------------
// Arguments and the live-path refusal
// ---------------------------------------------------------------------------

interface Args {
  db: string;
  cut: string;
  out: string;
  findings: string | null;
  findings2: string | null;
  /** TD-454: build the gate/strip claim variants from the copy's `projects` table. */
  vocabFromDb: boolean;
  /** TD-454: also report the slug-stripped similarity variants (measured, ships only per P-3). */
  stripSlugs: boolean;
  /** TD-458: add the module-name gate variants `mod` / `modStrip` (requires --vocab-from-db). */
  moduleGate: boolean;
  /** TD-457: a WRITABLE scratch copy to apply v6 + backfill to, then sweep (refuses the live path). */
  rekeyCheck: string | null;
}

function fail(code: number, message: string): never {
  process.stderr.write(`td452_anchor_sweep: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: '',
    cut: DEFAULT_CUT,
    out: path.join(process.cwd(), 'td452_out'),
    findings: null,
    findings2: null,
    vocabFromDb: false,
    stripSlugs: false,
    moduleGate: false,
    rekeyCheck: null,
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
      case '--out':
        out.out = need();
        break;
      case '--findings':
        out.findings = need();
        break;
      case '--findings2':
        out.findings2 = need();
        break;
      case '--vocab-from-db':
        out.vocabFromDb = true;
        break;
      case '--strip-slugs':
        out.stripSlugs = true;
        break;
      case '--source-module-gate':
        out.moduleGate = true;
        break;
      case '--rekey-check':
        out.rekeyCheck = need();
        break;
      default:
        fail(2, `unknown flag ${flag}`);
    }
  }
  if (!out.db) fail(2, '--db <path-to-a-.backup-copy> is required');
  if (out.moduleGate && !out.vocabFromDb) fail(2, '--source-module-gate needs --vocab-from-db (the mod variants sit on the gate claims)');
  return out;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

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
// Rows and the two arms
// ---------------------------------------------------------------------------

interface Row {
  id: number;
  project_slug: string | null;
  title: string;
  evidence: string | null;
  suggested_action: string | null;
  entity_key: string | null;
  dedupe_key?: string | null;
  status: string;
  created_at: string;
}

interface Scored {
  id: number;
  /** A arm — the stored column (the shipped anchor). */
  a: string;
  /** B arm — the (a-narrow) candidate anchor. */
  b: string;
  /** The imported `entityKey()` — must equal `a` (self-check). */
  shipped: string;
  /** The vocab-OFF claim — the deployed matcher at HEAD (the self-check arm). */
  claim: Claim;
  /** TD-454 variants, present with --vocab-from-db: the gate, slug-stripped tokens, both. */
  gate?: Claim;
  strip?: Claim;
  gateStrip?: Claim;
  /** TD-458 post-ship counterfactuals: the gate / gate+strip claims with the module set emptied. */
  noMod?: Claim;
  noModStrip?: Claim;
  /** TD-458: the modules the title names (the shipped constant vocabulary). */
  modules: Set<string>;
  dedupeKey: string | null;
  title: string;
  status: string;
  created_at: string;
  titledIds: number;
  hasSlug: boolean;
}

/**
 * TD-454: which claim a variant reads — `base` is the deployed matcher.
 * TD-458: `mod` reads the `gate` claim, `modStrip` the `gateStrip` claim, and
 * both apply the module-name gate FIRST (see {@link matchV}).
 */
type Variant = 'base' | 'gate' | 'strip' | 'gateStrip' | 'mod' | 'modStrip' | 'noMod' | 'noModStrip';
const claimAs = (r: Scored, v: Variant): Claim =>
  v === 'base'
    ? r.claim
    : v === 'mod'
      ? (r.gate ?? r.claim)
      : v === 'modStrip'
        ? (r.gateStrip ?? r.claim)
        : v === 'noMod'
          ? (r.noMod ?? r.claim)
          : v === 'noModStrip'
            ? (r.noModStrip ?? r.claim)
            : (r[v] ?? r.claim);
const isModuleVariant = (v: Variant): boolean => v === 'mod' || v === 'modStrip';

/** One side of a variant match — a scored row or a cluster head (both carry a claim and the module set). */
interface Side { claim: Claim; modules: Set<string> }
const sideOf = (r: Scored, v: Variant): Side => ({ claim: claimAs(r, v), modules: r.modules });

/**
 * The variant matcher: the shipped `claimsMatch` on the variant's claim. Under
 * `mod` / `modStrip` the instrument's own DISJOINT predicate is applied first
 * — pre-ship that WAS the candidate gate; post-ship (gate 1c inside
 * `claimsMatch`) it is redundant and kept only so the pre-ship reading
 * reproduces. `noMod` / `noModStrip` read claims whose module set is EMPTY, so
 * the shipped gate cannot fire: the counterfactual the post-ship sections
 * measure against.
 */
function matchV(x: Side, y: Side, v: Variant, t: number): boolean {
  if (isModuleVariant(v) && modulesDisjoint(x.modules, y.modules)) return false;
  return claimsMatch(x.claim, y.claim, t, MIN_TOKENS);
}

/**
 * TD-454 slug-STRIPPING (measured, ships only per P-3): the tokens of every
 * slug the title NAMES are removed from the similarity operands, never from
 * the hashed set. Only named slugs — stripping every vocabulary token would
 * take `system`, `app`, `content` out of every title.
 */
function strippedTokens(gate: Claim, lower: Map<string, string[]>): Set<string> {
  const out = new Set(gate.tokens);
  for (const slug of gate.projects) for (const t of lower.get(slug) ?? []) out.delete(t);
  return out;
}

function score(rows: Row[], vocab?: ProjectVocabulary): { scored: Scored[]; nullStored: number } {
  let nullStored = 0;
  const lower = new Map<string, string[]>();
  if (vocab) for (const [slug, seq] of vocab) lower.set(slug.toLowerCase(), seq);
  const scored = rows.map((row) => {
    const candidate = candidateFromRow(row);
    const shipped = entityKey(candidate);
    const stored = typeof row.entity_key === 'string' && row.entity_key.length > 0 ? row.entity_key : null;
    if (stored === null) nullStored += 1;
    const title = row.title ?? '';
    const base: Scored = {
      id: row.id,
      a: stored ?? shipped,
      b: candidateAnchor(row),
      shipped,
      claim: claimOf(title),
      modules: namedModules(title),
      dedupeKey: typeof row.dedupe_key === 'string' && row.dedupe_key.length > 0 ? row.dedupe_key : null,
      title,
      status: row.status,
      created_at: row.created_at,
      titledIds: subjectIds(title).size,
      hasSlug: candidate.project_slug !== null && candidate.project_slug !== undefined,
    };
    if (vocab) {
      const gate = claimOf(title, vocab);
      const stripped = strippedTokens(gate, lower);
      base.gate = gate;
      base.strip = { tokens: stripped, subject: gate.subject, projects: new Set(), modules: gate.modules };
      base.gateStrip = { tokens: stripped, subject: gate.subject, projects: gate.projects, modules: gate.modules };
      base.noMod = { tokens: gate.tokens, subject: gate.subject, projects: gate.projects, modules: new Set() };
      base.noModStrip = { tokens: stripped, subject: gate.subject, projects: gate.projects, modules: new Set() };
    }
    return base;
  });
  return { scored, nullStored };
}

const classOf = (anchor: string): string => anchor.split(':')[0]!;

function classCensus(rows: Scored[], arm: 'a' | 'b'): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const c = classOf(r[arm]);
    out.set(c, (out.get(c) ?? 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The accept loops — own block, and own block THEN comparable blocks
// ---------------------------------------------------------------------------

interface Head {
  id: number;
  claim: Claim;
  modules: Set<string>;
  anchor: string;
}

interface Absorption {
  cand: Scored;
  headId: number;
  headAnchor: string;
  score: number;
  cross: boolean;
}

interface LoopResult {
  clusters: number;
  comparisons: number[];
  absorptions: Absorption[];
}

/**
 * L2 — best match ≥ t (production stage B), own block first; when `crossBlock`
 * and the own block yields nothing, best match over the comparable blocks
 * (candidate (c)'s second pass). `comparisons` records how many heads each
 * candidate was scored against; `absorptions` which head took it.
 */
function clustersL2(rows: Scored[], arm: 'a' | 'b', t: number, crossBlock: boolean, variant: Variant = 'base'): LoopResult {
  const heads = new Map<string, Head[]>();
  const comparisons: number[] = [];
  const absorptions: Absorption[] = [];
  for (const row of rows) {
    const claim = claimAs(row, variant);
    const side = sideOf(row, variant);
    const anchor = row[arm];
    const own = heads.get(anchor) ?? [];
    let best: Head | null = null;
    let bestScore = -1;
    let cross = false;
    let compared = own.length;
    for (const head of own) {
      if (!matchV(side, head, variant, t)) continue;
      const s = claimSimilarity(claim.tokens, head.claim.tokens);
      if (s > bestScore) {
        bestScore = s;
        best = head;
      }
    }
    if (!best && crossBlock) {
      for (const [other, block] of heads) {
        if (other === anchor || !candidateComparable(anchor, other)) continue;
        compared += block.length;
        for (const head of block) {
          if (!matchV(side, head, variant, t)) continue;
          const s = claimSimilarity(claim.tokens, head.claim.tokens);
          if (s > bestScore) {
            bestScore = s;
            best = head;
            cross = true;
          }
        }
      }
    }
    comparisons.push(compared);
    if (best) {
      absorptions.push({ cand: row, headId: best.id, headAnchor: best.anchor, score: bestScore, cross });
    } else {
      own.push({ id: row.id, claim, modules: row.modules, anchor });
      heads.set(anchor, own);
    }
  }
  let n = 0;
  for (const block of heads.values()) n += block.length;
  return { clusters: n, comparisons, absorptions };
}

/** L1 — greedy first match, same two-pass shape (TD-440's doc loop). */
function clustersL1(rows: Scored[], arm: 'a' | 'b', t: number, crossBlock: boolean, variant: Variant = 'base'): number {
  const heads = new Map<string, Head[]>();
  for (const row of rows) {
    const claim = claimAs(row, variant);
    const side = sideOf(row, variant);
    const anchor = row[arm];
    const own = heads.get(anchor) ?? [];
    let hit = own.some((h) => matchV(side, h, variant, t));
    if (!hit && crossBlock) {
      for (const [other, block] of heads) {
        if (other === anchor || !candidateComparable(anchor, other)) continue;
        if (block.some((h) => matchV(side, h, variant, t))) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) {
      own.push({ id: row.id, claim, modules: row.modules, anchor });
      heads.set(anchor, own);
    }
  }
  let n = 0;
  for (const block of heads.values()) n += block.length;
  return n;
}

function meanMax(xs: number[]): string {
  if (xs.length === 0) return 'n/a';
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return `mean ${mean.toFixed(2)}, max ${Math.max(...xs)}`;
}

// ---------------------------------------------------------------------------
// The decision set P_new — pairwise, attributed to a design
// ---------------------------------------------------------------------------

type Design = 'a' | 'c' | 'cg' | 'cp' | 'ac';
const DESIGNS: Design[] = ['a', 'c', 'cg', 'cp', 'ac'];

interface Pair {
  a: Scored;
  b: Scored;
  score: number;
  design: Design;
}

/** Was the pair comparable under the shipped rule (same stored anchor)? */
const oldComparable = (x: Scored, y: Scored): boolean => x.a === y.a;

/**
 * `cg` / `cp` are the plan's pre-registered ASYMMETRIC narrowings of (c): the
 * LATER row (higher id = arrival order) is the candidate; `cg` admits only a
 * global candidate against project blocks, `cp` only a project candidate
 * against the global block.
 */
function newComparable(x: Scored, y: Scored, design: Design): boolean {
  const later = x.id > y.id ? x : y;
  switch (design) {
    case 'a':
      return x.b === y.b;
    case 'c':
      return candidateComparable(x.a, y.a);
    case 'cg':
      return candidateComparable(x.a, y.a) && x.a !== y.a && later.a === GLOBAL_ENTITY_KEY;
    case 'cp':
      return candidateComparable(x.a, y.a) && x.a !== y.a && classOf(later.a) === 'project';
    case 'ac':
      return candidateComparable(x.b, y.b);
  }
}

/** Every pair comparable under `design` and NOT under the shipped rule that matches at the shipped threshold (under `variant`'s claims). */
function newPairs(rows: Scored[], design: Design, variant: Variant = 'base'): Pair[] {
  const out: Pair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i]!;
      const y = rows[j]!;
      if (oldComparable(x, y)) continue;
      if (!newComparable(x, y, design)) continue;
      const cx = claimAs(x, variant);
      const cy = claimAs(y, variant);
      if (!matchV(sideOf(x, variant), sideOf(y, variant), variant, SHIPPED_THRESHOLD)) continue;
      out.push({ a: x, b: y, score: claimSimilarity(cx.tokens, cy.tokens), design });
    }
  }
  out.sort((p, q) => q.score - p.score || p.a.id - q.a.id || p.b.id - q.b.id);
  return out;
}

/** The highest-scoring cross-block (global × project) pairs, matched or not. */
function crossBlockTop(rows: Scored[], limit: number): Array<Pair & { matched: boolean }> {
  const out: Array<Pair & { matched: boolean }> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i]!;
      const y = rows[j]!;
      if (x.a === y.a || !candidateComparable(x.a, y.a)) continue;
      const s = claimSimilarity(x.claim.tokens, y.claim.tokens);
      if (s <= 0) continue;
      out.push({
        a: x,
        b: y,
        score: s,
        design: 'c',
        matched: claimsMatch(x.claim, y.claim, SHIPPED_THRESHOLD, MIN_TOKENS),
      });
    }
  }
  out.sort((p, q) => q.score - p.score || p.a.id - q.a.id || p.b.id - q.b.id);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// CSV and the row tags
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

/**
 * TD-445's tags win where both files tag a row (the labelled set is the
 * precedent); `--findings2` supplies tags for rows TD-445 never saw. A
 * conflict is reported, never silently resolved.
 */
function mergeFindings(
  primary: Map<number, string>,
  secondary: Map<number, string>,
): { tags: Map<number, string>; conflicts: string[] } {
  const tags = new Map(primary);
  const conflicts: string[] = [];
  for (const [id, tag] of secondary) {
    const have = tags.get(id);
    if (have === undefined) tags.set(id, tag);
    else if (have !== tag) conflicts.push(`${id}: td445 "${have}" vs td452 "${tag}"`);
  }
  return { tags, conflicts };
}

function labelOf(tags: Map<number, string>, idA: number, idB: number): string {
  const a = tags.get(idA);
  const b = tags.get(idB);
  if (a === undefined || b === undefined) return '';
  if (a === 'EXCLUDED' || b === 'EXCLUDED') return 'EXCLUDED';
  return a === b ? 'SAME' : 'DIFFERENT';
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

function to3dp(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function selfCheck(all: Scored[], c1: Scored[], nullStored: number, moduleGate = false): string[] {
  const lines: string[] = [];
  const problems: string[] = [];
  const byId = new Map(all.map((r) => [r.id, r]));

  if (moduleGate) {
    // TD-458 (i): the four S3 pairs' module sets read as pinned AND are DISJOINT.
    for (const p of S3_PAIRS) {
      const A = byId.get(p.a);
      const B = byId.get(p.b);
      if (!A || !B) {
        problems.push(`S3 pair ${p.a}/${p.b}: row missing from the copy`);
        continue;
      }
      const ma = [...A.modules].sort();
      const mb = [...B.modules].sort();
      const pinned = JSON.stringify(ma) === JSON.stringify(p.modsA) && JSON.stringify(mb) === JSON.stringify(p.modsB);
      const disjoint = modulesDisjoint(A.modules, B.modules);
      const ok = pinned && disjoint;
      lines.push(`  ${ok ? 'ok ' : 'BAD'} TD-458 S3 ${p.a}/${p.b} modules {${ma.join(',')}} vs {${mb.join(',')}} (pinned {${p.modsA.join(',')}} vs {${p.modsB.join(',')}}) disjoint=${disjoint}`);
      if (!ok) problems.push(`TD-458 S3 pair ${p.a}/${p.b}: module sets not as pinned or not disjoint`);
    }
    // TD-458 (iv) post-ship: the SHIPPED matcher (gate 1c inside claimsMatch, no instrument
    // predicate) separates each S3 pair, and the noMod counterfactual does not.
    for (const p of S3_PAIRS) {
      const A = byId.get(p.a);
      const B = byId.get(p.b);
      if (!A || !B || !A.gate || !B.gate || !A.noMod || !B.noMod) continue;
      const shipped = !claimsMatch(A.gate, B.gate, SHIPPED_THRESHOLD, MIN_TOKENS);
      const counter = claimsMatch(A.noMod, B.noMod, SHIPPED_THRESHOLD, MIN_TOKENS);
      const ok = shipped && counter;
      lines.push(`  ${ok ? 'ok ' : 'BAD'} TD-458 shipped claimsMatch separates ${p.a}/${p.b} = ${shipped}; noMod counterfactual matches = ${counter}`);
      if (!ok) problems.push(`TD-458 shipped gate 1c does not separate ${p.a}/${p.b} (or noMod does)`);
    }
    // TD-458 (ii): the designed pair shares a member — NOT disjoint (equality would refuse it).
    const dA = namedModules(MODULE_POINTS[0]!.title);
    const dB = namedModules(MODULE_POINTS[1]!.title);
    const dDisjoint = modulesDisjoint(dA, dB);
    const dUnequal = modulesUnequal(dA, dB);
    lines.push(`  ${!dDisjoint ? 'ok ' : 'BAD'} TD-458 designed pair "stalled/gap rows" vs "stalled rows": disjoint=${dDisjoint} (must be false; unequal=${dUnequal} — the EQUAL reading would separate it)`);
    if (dDisjoint) problems.push('TD-458 designed pair reads disjoint — the DISJOINT rule is not what is wired');
    // TD-458 (iii): namedModules known-answer points (the shipped algorithm over the constant list).
    for (const m of MODULE_POINTS) {
      const got = [...namedModules(m.title)].sort();
      const ok = JSON.stringify(got) === JSON.stringify(m.expect);
      lines.push(`  ${ok ? 'ok ' : 'BAD'} TD-458 namedModules("${m.title.slice(0, 48)}…") = {${got.join(',')}} (expected {${m.expect.join(',')}}) — ${m.note}`);
      if (!ok) problems.push(`TD-458 namedModules known-answer point failed: ${m.note}`);
    }
  }

  // TD-457 (2026-09-08): on a PRE-re-key copy the stored column is the
  // pre-TD-457 anchor and the rows that disagree with the imported entityKey
  // are EXACTLY the (a-narrow) moved set; on a re-keyed copy both are 0.
  const disagreeRows = all.filter((r) => r.a !== r.shipped);
  const movedRows = all.filter((r) => r.a !== r.b);
  const disagree = disagreeRows.length;
  const sameSet =
    disagree === movedRows.length &&
    disagreeRows.every((r) => r.a !== r.b) &&
    all.every((r) => r.b === r.shipped);
  lines.push(
    `  ${sameSet ? 'ok ' : 'BAD'} stored entity_key ≠ imported entityKey() on ${disagree} of ${all.length} rows; moved under (a-narrow) ${movedRows.length}; B arm == imported on ${all.filter((r) => r.b === r.shipped).length}; NULL stored: ${nullStored}  — ${disagree === 0 ? 'a RE-KEYED copy (the column is the shipped anchor)' : 'a PRE-re-key copy: the disagreements are exactly the moved set (TD-457)'}`,
  );
  if (!sameSet) problems.push('disagree ≠ moved (or the B arm is not the imported entityKey) — the instrument is not the deployed anchor (TD-457 posture)');
  const rekeyed = disagree === 0;

  for (const p of SCORE_POINTS) {
    const A = byId.get(p.a);
    const B = byId.get(p.b);
    if (!A || !B) {
      problems.push(`pair ${p.a}/${p.b}: row missing from the copy`);
      continue;
    }
    const s = claimSimilarity(A.claim.tokens, B.claim.tokens);
    const m = claimsMatch(A.claim, B.claim, SHIPPED_THRESHOLD, MIN_TOKENS);
    const expectMatch = p.score >= SHIPPED_THRESHOLD;
    const ok = to3dp(s) === p.score && m === expectMatch;
    lines.push(
      `  ${ok ? 'ok ' : 'BAD'} ${p.a}/${p.b}  score ${s.toFixed(4)} (expected ${p.score.toFixed(3)})  ` +
        `A ${A.a} / ${B.a}  B ${A.b} / ${B.b}  claimsMatch@${SHIPPED_THRESHOLD}=${m}  — ${p.note}`,
    );
    if (!ok) problems.push(`pair ${p.a}/${p.b} does not reproduce`);
  }

  const c1L1 = clustersL1(c1, 'a', SHIPPED_THRESHOLD, false);
  const c1L2 = clustersL2(c1, 'a', SHIPPED_THRESHOLD, false).clusters;
  if (!rekeyed) {
    const c1Ok = c1L1 === C1_AT_SHIPPED && c1L2 === C1_AT_SHIPPED;
    lines.push(
      `  ${c1Ok ? 'ok ' : 'BAD'} C1 @${SHIPPED_THRESHOLD} under A (pre-TD-457 anchor): L1 ${c1L1}, L2 ${c1L2} (expected ${C1_AT_SHIPPED}, N=${c1.length}, anchors=${new Set(c1.map((r) => r.a)).size})`,
    );
    if (!c1Ok) problems.push('C1 @ shipped threshold under the pre-TD-457 A arm does not reproduce 153');
  } else if (C1_AT_SHIPPED_TD457 === null) {
    lines.push(
      `  ok  C1 @${SHIPPED_THRESHOLD} under A (TD-457 anchor, re-keyed copy): L1 ${c1L1}, L2 ${c1L2} (N=${c1.length}, anchors=${new Set(c1.map((r) => r.a)).size}) — FIRST READING, not yet pinned: set C1_AT_SHIPPED_TD457`,
    );
  } else {
    const c1Ok = c1L1 === C1_AT_SHIPPED_TD457 && c1L2 === C1_AT_SHIPPED_TD457;
    lines.push(
      `  ${c1Ok ? 'ok ' : 'BAD'} C1 @${SHIPPED_THRESHOLD} under A (TD-457 anchor, re-keyed copy): L1 ${c1L1}, L2 ${c1L2} (expected ${C1_AT_SHIPPED_TD457}, N=${c1.length}, anchors=${new Set(c1.map((r) => r.a)).size})`,
    );
    if (!c1Ok) problems.push(`C1 @ shipped threshold under the TD-457 A arm does not reproduce ${C1_AT_SHIPPED_TD457}`);
  }
  if (rekeyed) {
    const aNew = newPairs(all, 'a').length;
    lines.push(`  ${aNew === 0 ? 'ok ' : 'BAD'} design a admits ${aNew} new pairs on a re-keyed copy (B == A everywhere once the anchor is shipped)`);
    if (aNew !== 0) problems.push('design a admits new pairs on a re-keyed copy — the B arm is not the stored anchor');
  }

  for (const c of COMPARABLE_POINTS) {
    const got = candidateComparable(c.a, c.b);
    const ok = got === c.expect;
    lines.push(`  ${ok ? 'ok ' : 'BAD'} candidateComparable(${c.a}, ${c.b}) = ${got} (expected ${c.expect})`);
    if (!ok) problems.push(`candidateComparable known-answer point failed: ${c.a} / ${c.b}`);
  }

  if (problems.length > 0) {
    process.stderr.write(`SELF-CHECK FAILED:\n${lines.join('\n')}\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * TD-457 AC-3 — the migration rehearsal on a WRITABLE scratch copy: v6 NULLs
 * both key columns, `backfillFindingKeys` re-keys every row in one
 * transaction, and the report is what the operator's read-only count would
 * show after the first post-deploy run. Returns the report lines.
 */
function rekeyCheck(dbPath: string): string[] {
  refuseLiveBrain(dbPath);
  if (!fs.existsSync(dbPath)) fail(2, `${dbPath} does not exist`);
  const v6 = subconsciousMigrations.find((m) => m.version === 6);
  if (!v6) fail(2, 'schema v6 (TD-457) is not registered — nothing to rehearse');
  const lines: string[] = [];
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    type K = { id: number; entity_key: string | null; dedupe_key: string | null; status: string };
    const before = new Map((db.prepare('SELECT id, entity_key, dedupe_key, status FROM suggestions').all() as K[]).map((r) => [r.id, r]));
    const total = before.size;
    const nullBefore = [...before.values()].filter((r) => r.dedupe_key === null).length;
    db.exec(v6.sql);
    const nullAfterV6 = (db.prepare('SELECT COUNT(*) AS n FROM suggestions WHERE dedupe_key IS NULL OR entity_key IS NULL').get() as { n: number }).n;
    const keyed = backfillFindingKeys(db);
    const nullAfter = (db.prepare('SELECT COUNT(*) AS n FROM suggestions WHERE dedupe_key IS NULL OR entity_key IS NULL').get() as { n: number }).n;
    const after = new Map((db.prepare('SELECT id, entity_key, dedupe_key, status FROM suggestions').all() as K[]).map((r) => [r.id, r]));
    const moved: number[] = [];
    let unmovedIdentical = 0;
    let unmovedChangedDedupe = 0;
    for (const [id, b] of before) {
      const a = after.get(id)!;
      if (b.entity_key !== a.entity_key) moved.push(id);
      else if (b.dedupe_key === a.dedupe_key) unmovedIdentical += 1;
      else unmovedChangedDedupe += 1;
    }
    let sigs = new Set<string>();
    try {
      sigs = new Set((db.prepare('SELECT evidence_signature FROM dismissed_patterns').all() as Array<{ evidence_signature: string }>).map((r) => r.evidence_signature));
    } catch {
      /* no table */
    }
    const movedDismissed = moved.filter((id) => sigs.has(before.get(id)!.dedupe_key ?? ''));
    const spot = [...before.keys()].filter((id) => !moved.includes(id)).slice(0, 5);
    lines.push('## TD-457 --rekey-check (v6 + backfillFindingKeys on the writable scratch copy)');
    lines.push(`rows: ${total}; NULL dedupe_key before v6: ${nullBefore}; NULL (either key) after v6: ${nullAfterV6} (must equal rows); backfill keyed: ${keyed}; NULL after backfill: ${nullAfter} (must be 0)`);
    lines.push(`moved (entity_key changed): ${moved.length} — ${moved.join(' ')}`);
    lines.push(`unmoved rows byte-identical on BOTH keys: ${unmovedIdentical} of ${total - moved.length} (dedupe_key changed on an unmoved row: ${unmovedChangedDedupe} — must be 0)`);
    lines.push(`spot-check (5 unmoved ids, entity_key / dedupe_key before == after): ${spot.map((id) => `${id} ${before.get(id)!.entity_key} ${before.get(id)!.dedupe_key === after.get(id)!.dedupe_key ? '==' : '!='}`).join('; ')}`);
    lines.push(`moved ∩ dismissed_patterns.evidence_signature (D-4, the one-time re-emission population): ${movedDismissed.length}${movedDismissed.length ? ' — ' + movedDismissed.join(' ') : ''}`);
    lines.push(`moved rows by status: ${[...moved.reduce((m, id) => m.set(before.get(id)!.status, (m.get(before.get(id)!.status) ?? 0) + 1), new Map<string, number>()).entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (nullAfterV6 !== total) fail(1, `v6 did not NULL every row (${nullAfterV6} of ${total})`);
    if (nullAfter !== 0) fail(1, `backfill left ${nullAfter} NULL keys`);
    if (unmovedChangedDedupe !== 0) fail(1, `${unmovedChangedDedupe} unmoved rows changed dedupe_key — the re-key is not idempotent on unmoved rows`);
  } finally {
    db.close();
  }
  return lines;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rekeyLines = args.rekeyCheck ? rekeyCheck(args.rekeyCheck) : [];
  if (args.rekeyCheck) args.db = args.rekeyCheck;
  refuseLiveBrain(args.db);
  if (!fs.existsSync(args.db)) fail(2, `${args.db} does not exist`);

  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  const out: string[] = [];
  const say = (line = ''): void => {
    out.push(line);
    process.stdout.write(`${line}\n`);
  };

  try {
    for (const l of rekeyLines) say(l);
    if (rekeyLines.length) say();
    say('# TD-452 anchor sweep');
    say(`db: ${args.db}`);
    say(`shipped: dedupe_claim_overlap=${SHIPPED_THRESHOLD} dedupe_min_claim_tokens=${MIN_TOKENS}`);
    say(`cut: ${args.cut}   arms: A = stored entity_key column (shipped), B = candidate (a-narrow) anchor`);
    say();

    const allRows = db.prepare(ALL_SQL).all() as Row[];
    // TD-454: the vocabulary only ADDS the gate/strip claim variants; `claim`
    // (vocab-off) is what every self-check and every TD-452 section reads.
    const vocab = args.vocabFromDb ? loadProjectVocabulary(db) : undefined;
    const { scored: all, nullStored } = score(allRows, vocab);
    const corpusIds = new Set((db.prepare(CORPUS_SQL).all() as Row[]).map((r) => r.id));
    const c2 = all.filter((r) => corpusIds.has(r.id));
    const c1 = c2.filter((r) => r.created_at < args.cut);
    const pending = all.filter((r) => r.status === 'pending');

    say('## Self-check (the instrument is the deployed matcher)');
    for (const line of selfCheck(all, c1, nullStored, args.moduleGate)) say(line);
    say();

    say('## Corpus');
    say(`suggestions total: ${all.length}; pending: ${pending.length}`);
    say(`C1 (predicate ∧ created_at < ${args.cut}): N=${c1.length}, anchors A=${new Set(c1.map((r) => r.a)).size} B=${new Set(c1.map((r) => r.b)).size}`);
    say(`C2 (predicate, whole table):               N=${c2.length}, anchors A=${new Set(c2.map((r) => r.a)).size} B=${new Set(c2.map((r) => r.b)).size}`);
    say();

    say('## Anchor census — rows per anchor class, A (shipped) vs B (candidate a-narrow)');
    say('| class | all rows A | all rows B | C2 A | C2 B | pending A | pending B |');
    say('|---|---|---|---|---|---|---|');
    const classes = new Set<string>();
    for (const r of all) {
      classes.add(classOf(r.a));
      classes.add(classOf(r.b));
    }
    const cA = classCensus(all, 'a'), cB = classCensus(all, 'b');
    const c2A = classCensus(c2, 'a'), c2B = classCensus(c2, 'b');
    const pA = classCensus(pending, 'a'), pB = classCensus(pending, 'b');
    for (const c of [...classes].sort()) {
      say(`| ${c} | ${cA.get(c) ?? 0} | ${cB.get(c) ?? 0} | ${c2A.get(c) ?? 0} | ${c2B.get(c) ?? 0} | ${pA.get(c) ?? 0} | ${pB.get(c) ?? 0} |`);
    }
    const briefNoTitleId = all.filter((r) => classOf(r.a) === 'brief' && r.titledIds === 0);
    const briefNoTitleIdNoSlug = briefNoTitleId.filter((r) => !r.hasSlug);
    say();
    say(`brief:-anchored under A with NO id in the title (the (a-narrow) population): ${briefNoTitleId.length} rows (of which without a project slug: ${briefNoTitleIdNoSlug.length}) — ids: ${briefNoTitleId.map((r) => r.id).join(' ')}`);
    const moved = all.filter((r) => r.a !== r.b);
    say(`moved rows under (a-narrow) (A ≠ B): ${moved.length}${moved.length ? ' — ' + moved.map((r) => `${r.id} ${r.a}→${r.b}`).join('; ') : ''}`);
    say();

    say(`## Clusters @${SHIPPED_THRESHOLD} — A vs B, own-block vs two-pass (order id ASC; status ignored)`);
    say('| cut | N | A own-block L1 | A own-block L2 (shipped) | A two-pass L2 (c alone) | B own-block L2 (a alone) | B two-pass L1 | B two-pass L2 (a+c) |');
    say('|---|---|---|---|---|---|---|---|');
    const loops: Record<string, LoopResult> = {};
    for (const [name, rows] of [['C1', c1], ['C2', c2]] as const) {
      const aL1 = clustersL1(rows, 'a', SHIPPED_THRESHOLD, false);
      const aL2 = clustersL2(rows, 'a', SHIPPED_THRESHOLD, false);
      const aX = clustersL2(rows, 'a', SHIPPED_THRESHOLD, true);
      const bOwn = clustersL2(rows, 'b', SHIPPED_THRESHOLD, false);
      const bL1 = clustersL1(rows, 'b', SHIPPED_THRESHOLD, true);
      const bX = clustersL2(rows, 'b', SHIPPED_THRESHOLD, true);
      loops[`${name} A own-block (shipped)`] = aL2;
      loops[`${name} A two-pass (c alone)`] = aX;
      loops[`${name} B own-block (a alone)`] = bOwn;
      loops[`${name} B two-pass (a+c)`] = bX;
      say(`| ${name} | ${rows.length} | ${aL1} | ${aL2.clusters} | ${aX.clusters} | ${bOwn.clusters} | ${bL1} | ${bX.clusters} |`);
    }
    say();
    say('## Comparisons per candidate (heads scored, corpus loop)');
    for (const [k, v] of Object.entries(loops)) say(`${k}: ${meanMax(v.comparisons)}`);
    const pendGlobal = pending.filter((r) => r.a === GLOBAL_ENTITY_KEY).length;
    const pendProject = pending.filter((r) => classOf(r.a) === 'project').length;
    say(`live pending bound under (c): a project candidate scores ≤ |own block| + |global| = … + ${pendGlobal}; a global candidate ≤ ${pendGlobal} + Σ|project blocks| = ${pendGlobal + pendProject} (pending rows: ${pending.length})`);
    say();

    const f1 = args.findings ? readFindings(args.findings) : new Map<number, string>();
    const f2 = args.findings2 ? readFindings(args.findings2) : new Map<number, string>();
    const { tags, conflicts } = mergeFindings(f1, f2);
    if (conflicts.length) {
      say('## TAG CONFLICTS between --findings and --findings2 (must be resolved):');
      for (const c of conflicts) say(`  ${c}`);
      say();
    }

    say(`## P_new — THE DECISION SET: pairs comparable under a candidate rule and NOT under the shipped one, matching at ${SHIPPED_THRESHOLD}, on C2 (N=${c2.length}); DIFFERENT must be 0 to ship`);
    say('| design | pairs | SAME | DIFFERENT | EXCLUDED | unlabelled | highest DIFFERENT | rows in set | verdict |');
    say('|---|---|---|---|---|---|---|---|---|');
    const allPairs: Pair[] = [];
    const untagged = new Map<number, Scored>();
    for (const design of DESIGNS) {
      const pairs = newPairs(c2, design);
      allPairs.push(...pairs);
      const same = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'SAME').length;
      const diff = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
      const excl = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'EXCLUDED').length;
      const blank = pairs.length - same - diff.length - excl;
      const rowsIn = new Set(pairs.flatMap((p) => [p.a.id, p.b.id]));
      for (const p of pairs) for (const r of [p.a, p.b]) if (!tags.has(r.id)) untagged.set(r.id, r);
      const top = diff[0] ? `${diff[0].a.id}/${diff[0].b.id} @ ${diff[0].score.toFixed(4)}` : '—';
      const verdict = diff.length > 0 ? 'FAILS (DIFFERENT > 0)' : blank > 0 ? 'incomplete (unlabelled)' : 'passes';
      say(`| ${design} | ${pairs.length} | ${same} | ${diff.length} | ${excl} | ${blank} | ${top} | ${rowsIn.size} | ${verdict} |`);
    }
    say();
    for (const design of DESIGNS) {
      const diff = newPairs(c2, design).filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
      say(`### ${design} — DIFFERENT pairs (${diff.length}): ${diff.map((p) => `${p.a.id}/${p.b.id}@${p.score.toFixed(3)}`).join(' ') || 'none'}`);
    }
    say();
    say('### P_new pairs, every design, score DESC');
    for (const p of allPairs.sort((x, y) => y.score - x.score || x.a.id - y.a.id || x.b.id - y.b.id)) {
      say(`  [${p.design}] ${p.a.id}/${p.b.id}  ${p.score.toFixed(4)}  A ${p.a.a} | ${p.b.a}  B ${p.a.b} | ${p.b.b}  ${labelOf(tags, p.a.id, p.b.id) || '(unlabelled)'}`);
    }
    say();

    say('## Loop-faithful audit (REPORTED, not the decision input): what the two-pass L2 loop would actually absorb on the C2 replay');
    for (const [name, arm, cross] of [
      ['candidate a alone (B anchors, own block)', 'b', false],
      ['candidate c alone (A anchors, two-pass)', 'a', true],
      ['candidates a+c (B anchors, two-pass)', 'b', true],
    ] as const) {
      const res = clustersL2(c2, arm, SHIPPED_THRESHOLD, cross);
      const newly = res.absorptions.filter((x) => x.cross || (arm === 'b' && (x.cand.a !== x.cand.b || all.find((r) => r.id === x.headId)!.a !== all.find((r) => r.id === x.headId)!.b)));
      let s = 0, d = 0, e = 0, u = 0;
      const lines: string[] = [];
      for (const x of newly) {
        const label = labelOf(tags, x.cand.id, x.headId);
        if (label === 'SAME') s += 1; else if (label === 'DIFFERENT') d += 1; else if (label === 'EXCLUDED') e += 1; else u += 1;
        lines.push(`    ${x.cand.id} (${x.cand[arm]}) → head ${x.headId} (${x.headAnchor}) @ ${x.score.toFixed(4)}${x.cross ? ' cross-block' : ''}  ${label || '(unlabelled)'}`);
      }
      say(`  ${name}: ${newly.length} absorptions the shipped anchor could not make — SAME ${s}, DIFFERENT ${d}, EXCLUDED ${e}, unlabelled ${u} (total absorptions ${res.absorptions.length})`);
      for (const l of lines) say(l);
    }
    say();

    const top = crossBlockTop(c2, 40);
    say('## Highest-scoring global × project pairs under the shipped anchor (matched or not)');
    for (const p of top) {
      say(`  ${p.a.id}/${p.b.id}  ${p.score.toFixed(4)}  ${p.matched ? 'MATCH' : 'below'}  ${p.a.a} | ${p.b.a}  ${labelOf(tags, p.a.id, p.b.id) || '(unlabelled)'}`);
    }
    say();

    // -----------------------------------------------------------------------
    // TD-454 — the PROJECT-SET GATE, vocab-ON. Everything above ran vocab-OFF,
    // so the self-check still pins the instrument to the deployed matcher at
    // HEAD; these sections are REPORTED with their own figures (P-4).
    // -----------------------------------------------------------------------
    const separatedCsv: string[] = ['id_a,id_b,design,score,label,shape,separated_by,projects_a,projects_b'];
    const recallCsv: string[] = ['variant,id_a,id_b,anchor,score,label,projects_a,projects_b,title_a,title_b'];
    const pnewCsv: string[] = ['variant,design,id_a,id_b,anchor_a,anchor_b,score,label,shape'];
    if (vocab) {
      const T = SHIPPED_THRESHOLD;
      const variants: Variant[] = args.stripSlugs ? ['gate', 'strip', 'gateStrip'] : ['gate'];
      if (args.moduleGate) variants.push('mod');
      if (args.moduleGate && args.stripSlugs) variants.push('modStrip');
      const vname = (v: Variant): string => (v === 'gateStrip' ? 'gate+strip' : v === 'modStrip' ? 'mod+strip' : v === 'noModStrip' ? 'noMod+strip' : v);
      const projs = (r: Scored): string => [...r.gate!.projects].sort().join(' ');
      const shapeOf = (x: Scored, y: Scored): string => {
        const px = x.gate!.projects;
        const py = y.gate!.projects;
        if (px.size === 0 || py.size === 0) return 'S3';
        const xInY = [...px].every((p) => py.has(p));
        const yInX = [...py].every((p) => px.has(p));
        if (xInY && yInX) return 'EQ';
        return xInY || yInX ? 'S2' : 'S1';
      };
      const sepOf = (x: Scored, y: Scored): string => {
        const seps: string[] = [];
        const vs: Variant[] = ['gate', 'strip', 'gateStrip'];
        if (args.moduleGate) vs.push('mod', 'modStrip');
        for (const v of vs) {
          if (!matchV(sideOf(x, v), sideOf(y, v), v, T)) seps.push(vname(v));
        }
        return seps.length ? seps.join('|') : 'none';
      };

      say('## TD-454 — the PROJECT-SET GATE (vocab-ON; the self-check above ran vocab-OFF = the deployed matcher at HEAD)');
      say(`vocabulary: ${vocab.size} slugs from the copy's projects table. Variants: gate = project-set equality in claimsMatch; strip = the NAMED slugs' tokens removed from the similarity operands (never from the hashed set); gate+strip = both.`);
      const c1Line = variants.map((v) => `${vname(v)} L2 ${clustersL2(c1, 'a', T, false, v).clusters}`).join(' · ');
      say(`C1 @${T} under A: vocab-off ${clustersL2(c1, 'a', T, false).clusters} (asserted above) · ${c1Line} — REPORTED, not asserted: a gate can only refuse, so its figure is ≥ 153 by construction and the excess is the same-block pairs it now keeps apart; strip can move either way.`);
      const c2Base = clustersL2(c2, 'a', T, false).clusters;
      const c2Line = variants.map((v) => `${vname(v)} L2 ${clustersL2(c2, 'a', T, false, v).clusters}`).join(' · ');
      say(`C2 @${T} under A (N=${c2.length}): vocab-off L2 ${c2Base} · ${c2Line} — same reading, whole table.`);
      say();

      say('### Every DIFFERENT pair of the vocab-off decision sets, tagged with its SHAPE and its SEPARATOR');
      say('shape: S1 = overlapping-but-unequal project lists · S2 = one list a strict subset of the other · S3 = no project list on at least one side · EQ = equal lists (the gate cannot touch EQ or S3)');
      say('| design | DIFFERENT | S1 | S2 | S3 | EQ | sep. by gate | by strip | by gate+strip | by none |');
      say('|---|---|---|---|---|---|---|---|---|---|');
      const perPair: string[] = [];
      for (const design of DESIGNS) {
        const diff = newPairs(c2, design).filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
        const shapes = { S1: 0, S2: 0, S3: 0, EQ: 0 } as Record<string, number>;
        const seps = { gate: 0, strip: 0, 'gate+strip': 0, none: 0 } as Record<string, number>;
        for (const p of diff) {
          const shape = shapeOf(p.a, p.b);
          const sep = sepOf(p.a, p.b);
          shapes[shape] = (shapes[shape] ?? 0) + 1;
          for (const s of sep.split('|')) seps[s] = (seps[s] ?? 0) + 1;
          separatedCsv.push([p.a.id, p.b.id, design, p.score.toFixed(4), 'DIFFERENT', shape, sep, csvField(projs(p.a)), csvField(projs(p.b))].join(','));
          if (design === 'a' || design === 'c') {
            perPair.push(`  [${design}] ${p.a.id}/${p.b.id} @ ${p.score.toFixed(3)}  ${shape}  sep=${sep}  {${projs(p.a)}} vs {${projs(p.b)}}`);
          }
        }
        say(`| ${design} | ${diff.length} | ${shapes.S1} | ${shapes.S2} | ${shapes.S3} | ${shapes.EQ} | ${seps.gate} | ${seps.strip} | ${seps['gate+strip']} | ${seps.none} |`);
      }
      say('#### the two candidates, pair by pair');
      for (const l of perPair) say(l);
      say();

      say('### AC-3 re-evaluation under the PAIRWISE rule (D-1) with the gate: P_new recomputed on the variant claims (pairs newly comparable AND matching)');
      for (const v of variants) {
        say(`#### variant: ${vname(v)}`);
        say('| design | pairs | SAME | DIFFERENT | EXCLUDED | unlabelled | highest DIFFERENT | rows in set | verdict |');
        say('|---|---|---|---|---|---|---|---|---|');
        for (const design of DESIGNS) {
          const pairs = newPairs(c2, design, v);
          const same = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'SAME').length;
          const diff = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
          const excl = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'EXCLUDED').length;
          const blank = pairs.length - same - diff.length - excl;
          const rowsIn = new Set(pairs.flatMap((p) => [p.a.id, p.b.id]));
          const top = diff[0] ? `${diff[0].a.id}/${diff[0].b.id} @ ${diff[0].score.toFixed(4)} (${shapeOf(diff[0].a, diff[0].b)})` : '—';
          const verdict = diff.length > 0 ? 'FAILS (DIFFERENT > 0)' : blank > 0 ? 'incomplete (unlabelled)' : 'passes';
          say(`| ${design} | ${pairs.length} | ${same} | ${diff.length} | ${excl} | ${blank} | ${top} | ${rowsIn.size} | ${verdict} |`);
          for (const p of pairs) {
            pnewCsv.push([vname(v), design, p.a.id, p.b.id, p.a.a, p.b.a, p.score.toFixed(4), labelOf(tags, p.a.id, p.b.id), shapeOf(p.a, p.b)].join(','));
          }
        }
        for (const design of ['a', 'c'] as Design[]) {
          const diff = newPairs(c2, design, v).filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
          say(`${design} — remaining DIFFERENT (${diff.length}): ${diff.map((p) => `${p.a.id}/${p.b.id}@${p.score.toFixed(3)}(${shapeOf(p.a, p.b)})`).join(' ') || 'none'}`);
        }
        say();
      }

      say('### Recall cost / precision gain INSIDE the shipped blocks (C2, same stored anchor): pairs that match at HEAD and stop matching under the variant');
      for (const v of variants) {
        let s = 0, d = 0, e = 0, u = 0;
        const lines: string[] = [];
        for (let i = 0; i < c2.length; i++) {
          for (let j = i + 1; j < c2.length; j++) {
            const x = c2[i]!;
            const y = c2[j]!;
            if (x.a !== y.a) continue;
            if (!claimsMatch(x.claim, y.claim, T, MIN_TOKENS)) continue;
            if (matchV(sideOf(x, v), sideOf(y, v), v, T)) continue;
            const label = labelOf(tags, x.id, y.id);
            if (label === 'SAME') s += 1; else if (label === 'DIFFERENT') d += 1; else if (label === 'EXCLUDED') e += 1; else u += 1;
            const sc = claimSimilarity(x.claim.tokens, y.claim.tokens);
            lines.push(`    ${x.id}/${y.id} @ ${sc.toFixed(3)} ${x.a}  ${label || '(unlabelled)'}  {${projs(x)}} vs {${projs(y)}}`);
            recallCsv.push([vname(v), x.id, y.id, x.a, sc.toFixed(4), label, csvField(projs(x)), csvField(projs(y)), csvField(x.title), csvField(y.title)].join(','));
          }
        }
        say(`  ${vname(v)}: ${s + d + e + u} same-block pairs stop matching — SAME ${s} (the recall cost), DIFFERENT ${d} (the precision gain at HEAD), EXCLUDED ${e}, unlabelled ${u}`);
        for (const l of lines) say(l);
      }
      say();

      say('### Loop-faithful replay under the gate (REPORTED, not the decision input)');
      for (const [name, arm, cross] of [
        ['candidate a alone (B anchors, own block)', 'b', false],
        ['candidate c alone (A anchors, two-pass)', 'a', true],
        ['candidates a+c (B anchors, two-pass)', 'b', true],
      ] as const) {
        const res = clustersL2(c2, arm, T, cross, 'gate');
        const newly = res.absorptions.filter((x) => x.cross || (arm === 'b' && (x.cand.a !== x.cand.b || all.find((r) => r.id === x.headId)!.a !== all.find((r) => r.id === x.headId)!.b)));
        let s = 0, d = 0, e = 0, u = 0;
        const lines: string[] = [];
        for (const x of newly) {
          const label = labelOf(tags, x.cand.id, x.headId);
          if (label === 'SAME') s += 1; else if (label === 'DIFFERENT') d += 1; else if (label === 'EXCLUDED') e += 1; else u += 1;
          lines.push(`    ${x.cand.id} (${x.cand[arm]}) → head ${x.headId} (${x.headAnchor}) @ ${x.score.toFixed(4)}${x.cross ? ' cross-block' : ''}  ${label || '(unlabelled)'}`);
        }
        say(`  ${name}: ${newly.length} absorptions the shipped anchor could not make — SAME ${s}, DIFFERENT ${d}, EXCLUDED ${e}, unlabelled ${u} (total absorptions ${res.absorptions.length})`);
        for (const l of lines) say(l);
      }
      say();
    }

    // -----------------------------------------------------------------------
    // TD-458 — the MODULE-NAME gate. Everything is REPORTED against the
    // pre-registered rule in the docblock; the verdict lines are the record.
    // -----------------------------------------------------------------------
    const s3Csv: string[] = ['id_a,id_b,design,score,label,shape,modules_a,modules_b,separated_by'];
    const modCostCsv: string[] = ['cut,id_a,id_b,anchor,score,label,modules_a,modules_b,title_a,title_b'];
    if (vocab && args.moduleGate) {
      const T = SHIPPED_THRESHOLD;
      const mods = (r: Scored): string => [...r.modules].sort().join(' ');
      const projs = (r: Scored): string => [...r.gate!.projects].sort().join(' ');
      const shapeOf = (x: Scored, y: Scored): string => {
        const px = x.gate!.projects;
        const py = y.gate!.projects;
        if (px.size === 0 || py.size === 0) return 'S3';
        const xInY = [...px].every((p) => py.has(p));
        const yInX = [...py].every((p) => px.has(p));
        if (xInY && yInX) return 'EQ';
        return xInY || yInX ? 'S2' : 'S1';
      };
      const byId = new Map(all.map((r) => [r.id, r]));
      const modVariants: Variant[] = args.stripSlugs ? ['mod', 'modStrip'] : ['mod'];
      const baseOf = (v: Variant): Variant => (v === 'mod' ? 'noMod' : 'noModStrip');
      const vn = (v: Variant): string => (v === 'modStrip' ? 'mod+strip' : v === 'gateStrip' ? 'gate+strip' : v === 'noModStrip' ? 'noMod+strip' : v);

      say('## TD-458 — the MODULE-NAME gate (vocab-ON + module gate; REPORTED against the pre-registered rule)');
      say(`vocabulary (a property of the code, ${MODULE_VOCABULARY.length} literals): ${MODULE_VOCABULARY.join(', ')}. Rule: both titles name modules AND the sets are DISJOINT ⇒ no match (the subjectIds reading; EQUAL is reported beside it). C2 rows naming ≥ 1 module word: ${c2.filter((r) => r.modules.size > 0).length} of ${c2.length}.`);
      say();

      // P-A — the four S3 pairs, per variant.
      say('### P-A — the four S3 pairs (cross-block; the shipped loop never compares them — a live change needs (c))');
      say('| pair | score | label | shape | modules A | modules B | separated by | EQUAL reading |');
      say('|---|---|---|---|---|---|---|---|');
      let pa = 0;
      for (const p of S3_PAIRS) {
        const A = byId.get(p.a)!;
        const B = byId.get(p.b)!;
        const sc = claimSimilarity(A.claim.tokens, B.claim.tokens);
        const label = labelOf(tags, p.a, p.b) || '(unlabelled)';
        const seps: string[] = [];
        for (const v of ['noMod', 'gate', 'mod', ...(args.stripSlugs ? ['modStrip'] : [])] as Variant[]) {
          if (!matchV(sideOf(A, v), sideOf(B, v), v, T)) seps.push(vn(v));
        }
        const sepMod = !matchV(sideOf(A, 'mod'), sideOf(B, 'mod'), 'mod', T);
        if (sepMod) pa += 1;
        say(`| ${p.a}/${p.b} | ${sc.toFixed(3)} | ${label} | ${shapeOf(A, B)} | {${mods(A)}} | {${mods(B)}} | ${seps.join('|') || 'none'} | ${modulesUnequal(A.modules, B.modules) ? 'unequal' : 'equal/empty'} |`);
        s3Csv.push([p.a, p.b, 'c', sc.toFixed(4), label, shapeOf(A, B), csvField(mods(A)), csvField(mods(B)), seps.join('|') || 'none'].join(','));
      }
      const eqA = byId.get(EQ_PAIR.a)!;
      const eqB = byId.get(EQ_PAIR.b)!;
      const eqSep = !matchV(sideOf(eqA, 'mod'), sideOf(eqB, 'mod'), 'mod', T);
      say(`EQ pair ${EQ_PAIR.a}/${EQ_PAIR.b} (out of scope): modules {${mods(eqA)}} vs {${mods(eqB)}} — separated by mod: ${eqSep} (expected false; no named mechanism reaches it)`);
      say(`P-A: ${pa} of ${S3_PAIRS.length} S3 pairs separated under mod (noMod is the counterfactual: a pair "separated by noMod" would be separated WITHOUT the module gate) → ${pa === S3_PAIRS.length ? 'PASS' : 'FAIL'}`);
      say();

      // P_new under the module variants, every design.
      say('### P_new under the module variants (the pairwise rule; DIFFERENT must be 0 for a design to ship)');
      const pnewSameBroken: string[] = [];
      for (const v of modVariants) {
        const baseV: Variant = baseOf(v);
        say(`#### variant: ${vn(v)} (against ${vn(baseV)} — the same claims with the module set emptied)`);
        say('| design | pairs | SAME | DIFFERENT | EXCLUDED | unlabelled | highest DIFFERENT | SAME pairs lost vs base | verdict |');
        say('|---|---|---|---|---|---|---|---|---|');
        for (const design of DESIGNS) {
          const pairs = newPairs(c2, design, v);
          const basePairs = newPairs(c2, design, baseV);
          const key = (p: Pair): string => `${p.a.id}/${p.b.id}`;
          const have = new Set(pairs.map(key));
          const lost = basePairs.filter((p) => !have.has(key(p)) && labelOf(tags, p.a.id, p.b.id) === 'SAME');
          for (const p of lost) pnewSameBroken.push(`[${vn(v)} ${design}] ${key(p)} @ ${p.score.toFixed(3)} {${mods(p.a)}} vs {${mods(p.b)}}`);
          const same = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'SAME').length;
          const diff = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
          const excl = pairs.filter((p) => labelOf(tags, p.a.id, p.b.id) === 'EXCLUDED').length;
          const blank = pairs.length - same - diff.length - excl;
          const top = diff[0] ? `${diff[0].a.id}/${diff[0].b.id} @ ${diff[0].score.toFixed(4)} (${shapeOf(diff[0].a, diff[0].b)})` : '—';
          const verdict = diff.length > 0 ? 'FAILS (DIFFERENT > 0)' : blank > 0 ? 'incomplete (unlabelled)' : 'passes';
          say(`| ${design} | ${pairs.length} | ${same} | ${diff.length} | ${excl} | ${blank} | ${top} | ${lost.length} | ${verdict} |`);
          for (const p of pairs) {
            pnewCsv.push([vn(v), design, p.a.id, p.b.id, p.a.a, p.b.a, p.score.toFixed(4), labelOf(tags, p.a.id, p.b.id), shapeOf(p.a, p.b)].join(','));
          }
        }
        for (const design of ['a', 'c'] as Design[]) {
          const diff = newPairs(c2, design, v).filter((p) => labelOf(tags, p.a.id, p.b.id) === 'DIFFERENT');
          say(`${design} — remaining DIFFERENT (${diff.length}): ${diff.map((p) => `${p.a.id}/${p.b.id}@${p.score.toFixed(3)}(${shapeOf(p.a, p.b)})`).join(' ') || 'none'}`);
        }
        say();
      }

      // P-B / P-C — the INCREMENTAL same-block cost of the module gate over the shipped gate, C1 and C2.
      say('### Same-block recall cost / precision gain of the MODULE gate (pairs sharing a stored anchor that match under noMod — the module set emptied — and stop under mod)');
      let pbSame = 0;
      let pcDiff = 0;
      for (const [cut, rows] of [['C1', c1], ['C2', c2]] as const) {
        let s = 0, d = 0, e = 0, u = 0;
        const lines: string[] = [];
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            const x = rows[i]!;
            const y = rows[j]!;
            if (x.a !== y.a) continue;
            if (!matchV(sideOf(x, 'noMod'), sideOf(y, 'noMod'), 'noMod', T)) continue;
            if (matchV(sideOf(x, 'mod'), sideOf(y, 'mod'), 'mod', T)) continue;
            const label = labelOf(tags, x.id, y.id);
            if (label === 'SAME') s += 1; else if (label === 'DIFFERENT') d += 1; else if (label === 'EXCLUDED') e += 1; else u += 1;
            const sc = claimSimilarity(x.claim.tokens, y.claim.tokens);
            lines.push(`    ${x.id}/${y.id} @ ${sc.toFixed(3)} ${x.a}  ${label || '(unlabelled)'}  {${mods(x)}} vs {${mods(y)}}  projects {${projs(x)}} vs {${projs(y)}}`);
            modCostCsv.push([cut, x.id, y.id, x.a, sc.toFixed(4), label, csvField(mods(x)), csvField(mods(y)), csvField(x.title), csvField(y.title)].join(','));
          }
        }
        say(`  ${cut} (N=${rows.length}): ${s + d + e + u} same-block pairs stop matching — SAME ${s} (the recall cost), DIFFERENT ${d} (the live-path precision gain), EXCLUDED ${e}, unlabelled ${u}`);
        for (const l of lines) say(l);
        if (cut === 'C2') {
          pbSame = s;
          pcDiff = d;
        } else {
          pbSame = Math.max(pbSame, s);
        }
      }
      const c1Mod = clustersL2(c1, 'a', T, false, 'mod').clusters;
      const c2Mod = clustersL2(c2, 'a', T, false, 'mod').clusters;
      say(`C1 @${T} under A: noMod L2 ${clustersL2(c1, 'a', T, false, 'noMod').clusters} · gate L2 ${clustersL2(c1, 'a', T, false, 'gate').clusters} · mod L2 ${c1Mod} (N=${c1.length}); C2: noMod L2 ${clustersL2(c2, 'a', T, false, 'noMod').clusters} · gate L2 ${clustersL2(c2, 'a', T, false, 'gate').clusters} · mod L2 ${c2Mod} (N=${c2.length}) — REPORTED, not asserted.`);
      say();
      say('### Verdict against the pre-registered rule');
      const pbOk = pbSame === 0 && pnewSameBroken.length === 0;
      say(`P-A (all four S3 pairs separated, cross-block): ${pa === S3_PAIRS.length ? 'PASS' : 'FAIL'} (${pa}/${S3_PAIRS.length})`);
      say(`P-B (0 labelled SAME pairs broken — same-block C1/C2 under mod: ${pbSame}; P_new SAME lost vs base: ${pnewSameBroken.length}): ${pbOk ? 'PASS' : 'FAIL'}`);
      for (const l of pnewSameBroken) say(`    lost: ${l}`);
      say(`P-C (≥ 1 labelled DIFFERENT pair separated INSIDE a shipped block on C2): ${pcDiff >= 1 ? 'PASS' : 'FAIL'} (${pcDiff})`);
      const agreeA = newPairs(c2, 'a', 'gate').length === newPairs(c2, 'a', 'mod').length;
      const agreeC = newPairs(c2, 'c', 'gate').length === newPairs(c2, 'c', 'mod').length;
      say(`L-930 agreement (post-ship): P_new(gate) == P_new(mod) — a ${agreeA ? 'yes' : 'NO'}, c ${agreeC ? 'yes' : 'NO'} (the shipped claim already carries gate 1c; the instrument predicate is redundant)`);
      const ship = pa === S3_PAIRS.length && pbOk && pcDiff >= 1;
      say(`SHIP RULE P-A ∧ P-B ∧ P-C: ${ship ? 'SHIP' : 'MEASURED-NOT-MOVED'}; candidate (c) is CLOSED in either outcome (${EQ_PAIR.a}/${EQ_PAIR.b} EQ survives every named mechanism).`);
      say();
    }

    // -----------------------------------------------------------------------
    // TD-457 D-4 — dismissed rows whose anchor moves: the one-time re-emission
    // population. `dismissed_patterns.evidence_signature` stores the OLD
    // `dedupe_key`; for a moved row that key stops matching after the re-key.
    // -----------------------------------------------------------------------
    {
      let sigs = new Set<string>();
      try {
        sigs = new Set(
          (db.prepare('SELECT evidence_signature FROM dismissed_patterns').all() as Array<{ evidence_signature: string }>).map((r) => r.evidence_signature),
        );
      } catch {
        /* no table */
      }
      const movedDismissedSig = moved.filter((r) => r.dedupeKey !== null && sigs.has(r.dedupeKey));
      const movedByStatus = new Map<string, number>();
      for (const r of moved) movedByStatus.set(r.status, (movedByStatus.get(r.status) ?? 0) + 1);
      say('## TD-457 D-4 — moved ∩ dismissed');
      say(`moved rows: ${moved.length}; by status: ${[...movedByStatus.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}; dismissed_patterns rows: ${sigs.size}`);
      say(`moved rows whose dedupe_key is a dismissed_patterns.evidence_signature (the re-emission population): ${movedDismissedSig.length}${movedDismissedSig.length ? ' — ' + movedDismissedSig.map((r) => r.id).join(' ') : ''}`);
      say();
    }

    fs.mkdirSync(args.out, { recursive: true });
    const movedCsv = [
      'id,anchor_a,anchor_b,status,has_slug,title_ids,title',
      ...moved.map((r) => [r.id, r.a, r.b, r.status, r.hasSlug, r.titledIds, csvField(r.title)].join(',')),
    ].join('\n');
    fs.writeFileSync(path.join(args.out, 'td452_moved_rows.csv'), `${movedCsv}\n`);
    // TD-457: the (a-narrow) decision set under the shipped gate — the 15 pairs on a pre-re-key copy (empty on a re-keyed one).
    {
      const projs = (r: Scored): string => (r.gate ? [...r.gate.projects].sort().join(' ') : '');
      const aPairs = vocab ? newPairs(c2, 'a', 'gate') : [];
      const td457 = [
        'id_a,id_b,anchor_pre,anchor_post,score,label,projects_a,projects_b,title_a,title_b',
        ...aPairs.map((p) => [p.a.id, p.b.id, `${p.a.a}|${p.b.a}`, `${p.a.b}|${p.b.b}`, p.score.toFixed(4), labelOf(tags, p.a.id, p.b.id), csvField(projs(p.a)), csvField(projs(p.b)), csvField(p.a.title), csvField(p.b.title)].join(',')),
      ].join('\n');
      fs.writeFileSync(path.join(args.out, 'td457_pairs_a_narrow.csv'), `${td457}\n`);
      fs.writeFileSync(path.join(args.out, 'td457_census.md'), `${out.join('\n')}\n`);
      say(`wrote ${args.out}/td457_{pairs_a_narrow.csv (${aPairs.length} pairs${vocab ? '' : ' — vocab OFF, none computed'}),census.md}`);
    }
    const pairsCsv = [
      'id_a,id_b,anchor_a,anchor_b,anchor_a_new,anchor_b_new,score,design,label,title_a,title_b',
      ...allPairs.map((p) =>
        [p.a.id, p.b.id, p.a.a, p.b.a, p.a.b, p.b.b, p.score.toFixed(4), p.design, labelOf(tags, p.a.id, p.b.id), csvField(p.a.title), csvField(p.b.title)].join(','),
      ),
    ].join('\n');
    fs.writeFileSync(path.join(args.out, 'td452_new_pairs.csv'), `${pairsCsv}\n`);
    const topCsv = [
      'id_a,id_b,anchor_a,anchor_b,score,matched,label,title_a,title_b',
      ...top.map((p) => [p.a.id, p.b.id, p.a.a, p.b.a, p.score.toFixed(4), p.matched, labelOf(tags, p.a.id, p.b.id), csvField(p.a.title), csvField(p.b.title)].join(',')),
    ].join('\n');
    fs.writeFileSync(path.join(args.out, 'td452_crossblock_top.csv'), `${topCsv}\n`);
    const untaggedCsv = [
      'id,finding,title',
      ...[...untagged.values()].sort((x, y) => x.id - y.id).map((r) => [r.id, '', csvField(r.title)].join(',')),
    ].join('\n');
    fs.writeFileSync(path.join(args.out, 'td452_untagged_rows.csv'), `${untaggedCsv}\n`);
    fs.writeFileSync(path.join(args.out, 'td452_anchor_census.md'), `${out.join('\n')}\n`);
    say(`wrote ${args.out}/td452_{anchor_census.md,moved_rows.csv,new_pairs.csv,crossblock_top.csv,untagged_rows.csv}`);
    if (vocab) {
      fs.writeFileSync(path.join(args.out, 'td454_pairs_separated.csv'), `${separatedCsv.join('\n')}\n`);
      fs.writeFileSync(path.join(args.out, 'td454_recall_cost.csv'), `${recallCsv.join('\n')}\n`);
      fs.writeFileSync(path.join(args.out, 'td454_pnew_variants.csv'), `${pnewCsv.join('\n')}\n`);
      fs.writeFileSync(path.join(args.out, 'td454_census.md'), `${out.join('\n')}\n`);
      say(`wrote ${args.out}/td454_{census.md,pairs_separated.csv,recall_cost.csv,pnew_variants.csv}`);
    }
    if (vocab && args.moduleGate) {
      fs.writeFileSync(path.join(args.out, 'td458_s3_pairs.csv'), `${s3Csv.join('\n')}\n`);
      fs.writeFileSync(path.join(args.out, 'td458_module_recall_cost.csv'), `${modCostCsv.join('\n')}\n`);
      fs.writeFileSync(path.join(args.out, 'td458_census.md'), `${out.join('\n')}\n`);
      say(`wrote ${args.out}/td458_{census.md,s3_pairs.csv,module_recall_cost.csv}`);
    }
  } finally {
    db.close();
  }
}

main();
