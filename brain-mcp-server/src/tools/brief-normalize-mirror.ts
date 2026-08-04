/**
 * Igris Brain -- CLI brief-normalize MIRROR builder (TD-338).
 *
 * A single pure builder that renders the CLI-side copy of the brief metadata
 * normalizers ENTIRELY from the exported maps in `brief-normalize.ts` (the
 * single source of truth). It emits ONE committed, never-hand-edited artifact:
 *
 *   `cli/src/lib/brief-normalize.generated.ts`
 *
 * WHY A GENERATOR AND NOT A HAND MIRROR. `cli/` and `brain-mcp-server/` are
 * separate npm packages with ZERO cross-imports (coding_guidelines §13), and the
 * CLI's own `mergeRows` (`cli/src/lib/brain-db.ts`) is the ingress door that
 * actually runs on a workstation — the awaken / `igris boot-sync` VPS→local
 * pull. It needs the same fold tables the brain has. Hand-copying them would
 * make a FOURTH copy of this vocabulary (after the TS source, the bash
 * validator and the dashboard picker mirror) in a place no pin test can check —
 * exactly the TD-330 defect class. This builder is modeled byte-for-byte on the
 * proven `egress-manifest.ts` / `gen-egress-manifest.ts` pair (TD-253).
 *
 * TWO LAYERS, TWO GUARDS — read this before adding a normalizer:
 *
 *   1. THE DATA (canonical sets + fold tables + SYNC_NORMALIZED_FIELDS) is
 *      rendered from the live exports. Drift is caught by the byte-parity test
 *      (`__tests__/brief-normalize-mirror-parity.test.ts`), the same shape as
 *      the egress manifest's.
 *   2. THE LOGIC (the normalizer function bodies) is authored ONCE, here, as
 *      template text. A byte-parity test cannot see a change to the BRAIN's
 *      `normalizePriority` body, because that body is not an input to this
 *      renderer. That gap is closed by `NORMALIZE_FIXTURES`: this builder runs
 *      the BRAIN's real normalizers over a corpus at generation time and bakes
 *      the input→output pairs into the artifact. The CLI-side test replays them
 *      through the CLI's copy. So a behavioural change in the brain that is not
 *      reproduced here fails on the CLI side, with no cross-package import.
 *
 * @module tools/brief-normalize-mirror
 * @author fifty.dev
 */

import {
  BRIEF_TYPE_ALIASES,
  CANONICAL_BRIEF_TYPES,
  CANONICAL_PHASES,
  CANONICAL_PRIORITIES,
  PRIORITY_ALIASES,
  SYNC_NORMALIZED_FIELDS,
  isCanonicalBriefType,
  isCanonicalPhase,
  isCanonicalPriority,
  normalizeBriefType,
  normalizePhase,
  normalizePriority,
  normalizeSyncRow,
  type SyncFieldFold,
  type SyncFieldPassthrough,
  type SyncNormalizerId,
} from './brief-normalize.js';

// ---------------------------------------------------------------------------
// Committed-artifact location (repo-relative)
// ---------------------------------------------------------------------------

/** Repo-relative path to the generated CLI-side normalizer mirror. */
export const MIRROR_CLI_REL_PATH = 'cli/src/lib/brief-normalize.generated.ts';

// ---------------------------------------------------------------------------
// Behavioural fixture corpus
// ---------------------------------------------------------------------------

/**
 * Inputs the fixture table is built from. Deliberately a SUPERSET of the fold
 * tables: every alias key, every canonical value, plus the edge cases the two
 * copies could plausibly disagree on (case, padding, the unset family, and
 * values that must pass through UNTOUCHED).
 *
 * Add a case here whenever a new disagreement becomes conceivable — this corpus
 * is the only thing standing between the two packages and silent logic drift.
 */
const FIXTURE_EDGE_CASES = [
  '',
  '   ',
  'Unset',
  'UNSET',
  // The bare wire forms the live VPS still holds. `PRIORITY_ALIASES` keys are
  // LOWERCASE (they are lookup keys, not values), so the upper-case spellings
  // that actually travel on the wire are only covered if listed here.
  'P0',
  'P1',
  'P2',
  'P3',
  ' P1 ',
  'p1',
  'P1 - High',
  'P4-Trivial',
  'Spike',
  'Investigation',
  'Bug/Feature',
  'Bug Fix / Compliance',
  'building',
  'BUILDING',
  'Deferred',
  'SUPERSEDED-BY-FR-201',
  'technical debt',
  'TECH DEBT',
] as const;

function fixtureInputs(): string[] {
  const seen = new Set<string>();
  const push = (v: string): void => {
    if (!seen.has(v)) seen.add(v);
  };
  for (const v of CANONICAL_PRIORITIES) push(v);
  for (const v of CANONICAL_PHASES) push(v);
  for (const v of CANONICAL_BRIEF_TYPES) push(v);
  for (const k of Object.keys(PRIORITY_ALIASES)) push(k);
  for (const k of Object.keys(BRIEF_TYPE_ALIASES)) push(k);
  for (const v of FIXTURE_EDGE_CASES) push(v);
  return [...seen];
}

/** One replayable behavioural fixture: `normalizer(input) === expected`. */
export interface NormalizeFixture {
  normalizer: SyncNormalizerId;
  input: string;
  expected: string | null;
}

function buildFixtures(): NormalizeFixture[] {
  const inputs = fixtureInputs();
  const out: NormalizeFixture[] = [];
  for (const input of inputs) {
    out.push({ normalizer: 'priority', input, expected: normalizePriority(input) });
    out.push({ normalizer: 'brief_type', input, expected: normalizeBriefType(input) });
    out.push({ normalizer: 'phase', input, expected: normalizePhase(input) });
  }
  return out;
}

/** One replayable canonicality fixture: `isCanonical<X>(input) === expected`. */
export interface PredicateFixture {
  normalizer: SyncNormalizerId;
  input: string;
  expected: boolean;
}

/**
 * The `isCanonical*` predicates are authored template text too, and they are
 * what decides whether a passed-through value is REPORTED. `SYNC_ROW_FIXTURES`
 * exercises them transitively via `nonCanonical`, but only for values that
 * survive a normalizer — so they get their own direct corpus.
 */
function buildPredicateFixtures(): PredicateFixture[] {
  const out: PredicateFixture[] = [];
  for (const input of fixtureInputs()) {
    out.push({ normalizer: 'priority', input, expected: isCanonicalPriority(input) });
    out.push({ normalizer: 'brief_type', input, expected: isCanonicalBriefType(input) });
    out.push({ normalizer: 'phase', input, expected: isCanonicalPhase(input) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row-level fixture corpus — the guard for `normalizeSyncRow` itself
// ---------------------------------------------------------------------------

/**
 * Inbound rows the row-level corpus is built from.
 *
 * WHY THIS EXISTS AT ALL (the TD-338 warden finding): `normalizeSyncRow` is the
 * function both `mergeRows` copies actually call, and it is AUTHORED template
 * text in this builder — it is not an input to the renderer. So a brain-side
 * edit to it regenerates a byte-identical artifact: `--check` prints "in sync"
 * and every CLI test passes while the two packages silently disagree. The
 * leaf-normalizer fixtures did not cover it, and the module header, the
 * obligation doc and the coding-guidelines rule all CLAIMED they did.
 *
 * THE ARM CHECK THIS CORPUS IS BUILT FOR: apply a fold-plus-bump mutation to
 * the brain's `normalizeSyncRow` (write `updated_at` while folding) and this
 * corpus must go RED on the CLI side. That needs a row whose `updated_at` is a
 * FOLDABLE-LOOKING string, which is why `'P2'` appears there below — a
 * timestamp-shaped value would fold to itself and hide the mutation.
 */
const FIXTURE_ROWS: { table: string; row: Record<string, unknown> }[] = [
  // Everything folds: the live VPS spellings.
  {
    table: 'brief_status',
    row: {
      project: 'moca-ai-agent',
      brief_id: 'BR-045',
      brief_type: 'TD',
      title: 'HR read tools on mocasmart-mcp',
      status: 'Done',
      priority: 'P2',
      effort: 'L-Large',
      phase: 'building',
      updated_at: '2026-08-04 00:00:00',
    },
  },
  // THE NO-BUMP ARM: `updated_at` is itself a foldable-looking string. If the
  // fold ever reaches the LWW comparison column, `expectedRow.updated_at`
  // becomes 'P2-Medium' here and the CLI replay diverges immediately.
  {
    table: 'brief_status',
    row: { project: 'p', brief_id: 'ARM-1', priority: 'P1', updated_at: 'P2' },
  },
  // ...and the same trap on a row where NOTHING else folds, so the only thing
  // that can move the expectation is a fold reaching `updated_at`.
  {
    table: 'brief_status',
    row: { project: 'p', brief_id: 'ARM-2', priority: 'P1-High', updated_at: 'P2' },
  },
  // Already canonical: must return the SAME object (identity is contract).
  {
    table: 'brief_status',
    row: {
      project: 'p',
      brief_id: 'CLEAN-1',
      brief_type: 'Technical Debt',
      priority: 'P2-Medium',
      phase: 'COMPLETE',
      updated_at: '2026-08-04 00:00:00',
    },
  },
  // Unknown values: stored verbatim, reported. The fold never invents.
  {
    table: 'brief_status',
    row: {
      project: 'p',
      brief_id: 'UNK-1',
      brief_type: 'Spike',
      priority: 'P4-Trivial',
      phase: 'Deferred',
      updated_at: '2026-08-04 00:00:00',
    },
  },
  // The unset family folds to SQL NULL and is NOT reported as an offender.
  {
    table: 'brief_status',
    row: { project: 'p', brief_id: 'UNSET-1', priority: '', phase: '   ', updated_at: 'x' },
  },
  { table: 'brief_status', row: { project: 'p', brief_id: 'UNSET-2', priority: 'Unset' } },
  // Explicit nulls survive as nulls, and produce no fold.
  {
    table: 'brief_status',
    row: { project: 'p', brief_id: 'NULL-1', brief_type: null, priority: null, phase: null },
  },
  // Absent columns must NOT be materialized — the INSERT branch filters on
  // `!== undefined`, so a fold that invented a key would widen the INSERT.
  { table: 'brief_status', row: { project: 'p', brief_id: 'SPARSE-1', updated_at: 'ts' } },
  // Non-string values are left for the row-level try/catch, never normalized.
  {
    table: 'brief_status',
    row: { project: 'p', brief_id: 'TYPE-1', priority: 7, phase: false, brief_type: 'td' },
  },
  // Mixed: one field folds, one passes through unknown, one already canonical.
  {
    table: 'brief_status',
    row: {
      project: 'p',
      brief_id: 'MIX-1',
      brief_type: 'Feature Request',
      priority: 'P4-Trivial',
      phase: 'COMPLETE',
      updated_at: '2026-08-04 00:00:00',
    },
  },
  // Unmapped tables are copied verbatim — the hook is brief_status-scoped.
  {
    table: 'learnings',
    row: { project: 'p', title: 'P2', content: 'TD', phase: 'building', updated_at: 'P2' },
  },
  { table: 'not_a_sync_table', row: { priority: 'P2' } },
];

/**
 * One replayable ROW-level fixture — the whole `normalizeSyncRow` contract for
 * one input: what is stored, what folded, what was reported, and whether the
 * input object was returned unchanged.
 */
export interface SyncRowFixture {
  table: string;
  row: Record<string, unknown>;
  expectedRow: Record<string, unknown>;
  expectedFolds: SyncFieldFold[];
  expectedNonCanonical: SyncFieldPassthrough[];
  /**
   * Whether the result reused the INPUT object. Part of the contract (the
   * allocation-light path) and invisible to a value comparison, so it is baked
   * and replayed rather than assumed.
   */
  expectedSameObject: boolean;
}

function buildSyncRowFixtures(): SyncRowFixture[] {
  return FIXTURE_ROWS.map(({ table, row }) => {
    // Snapshot the INPUT before handing it to the brain. Without this, a
    // brain-side change that mutated its argument rather than its return value
    // would be invisible to the whole corpus: we serialize the same object as
    // both `row` and `expectedRow`, so the CLI would replay against an
    // already-mutated input and agree with it. Baking a fixture from a
    // mutated input records the bug as the expectation.
    const before = JSON.stringify(row);
    const result = normalizeSyncRow(table, row);
    const after = JSON.stringify(row);
    if (before !== after) {
      throw new Error(
        `brief-normalize mirror: normalizeSyncRow MUTATED its inbound row for ` +
          `table '${table}'.\n  before: ${before}\n  after:  ${after}\n` +
          'It must treat the inbound row as immutable and return a copy when ' +
          'anything folds — mergeRows hands it rows it does not own ' +
          '(processSyncPush) and rows replayed from stored JSON ' +
          '(handleSyncQueueDrain). Fix normalizeSyncRow; do not adjust the ' +
          'fixture corpus to match.',
      );
    }
    return {
      table,
      row,
      expectedRow: result.row,
      expectedFolds: result.folds,
      expectedNonCanonical: result.nonCanonical,
      expectedSameObject: result.row === row,
    };
  });
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function lit(value: string | null): string {
  return JSON.stringify(value);
}

function renderStringArray(name: string, values: readonly string[], doc: string): string[] {
  return [
    doc,
    `export const ${name}: readonly string[] = [`,
    ...values.map((v) => `  ${lit(v)},`),
    '];',
    '',
  ];
}

function renderRecord(name: string, record: Record<string, string>, doc: string): string[] {
  return [
    doc,
    `export const ${name}: Readonly<Record<string, string>> = {`,
    ...Object.entries(record).map(([k, v]) => `  ${lit(k)}: ${lit(v)},`),
    '};',
    '',
  ];
}

// ---------------------------------------------------------------------------
// Per-normalizer authored layer — THE ONLY thing not derived from the map
// ---------------------------------------------------------------------------

/**
 * `snake_case` normalizer id → the `PascalCase` suffix of its emitted function
 * names. `brief_type` → `BriefType`, so the pair is `normalizeBriefType` /
 * `isCanonicalBriefType`. Deterministic, which is what lets the dispatch table
 * be DERIVED rather than hand-listed.
 */
function pascal(id: string): string {
  return id
    .split('_')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * The two function BODIES per normalizer id — the only per-normalizer layer
 * still authored by hand in this builder.
 *
 * Everything else about a normalizer is derived from `SYNC_NORMALIZED_FIELDS`:
 * the `SyncNormalizerId` union, the `SYNC_NORMALIZERS` dispatch row, and the
 * order things are emitted in. So adding a normalized column really is **one
 * line in the map plus one body here** — which is what the TD-333 sequencing
 * claim asserts, and it is now true by construction rather than by correction.
 *
 * A mapped id with NO entry here THROWS at generation time (see
 * `assertNormalizerBodies`), because the alternative is emitting a module that
 * does not compile — a failure that would surface far from its cause.
 */
const NORMALIZER_BODIES: Record<string, string[]> = {
  priority: [
    '/**',
    ' * Normalize a brief priority to its canonical `P{N}-{Word}` spelling. The',
    ' * "unset" family (empty, whitespace-only, literal "Unset") maps to SQL NULL.',
    ' * Known aliases fold; unknown non-empty values pass through unchanged.',
    ' */',
    'export function normalizePriority(v: string | null | undefined): string | null {',
    '  if (v === null || v === undefined) return null;',
    '  const trimmed = v.trim();',
    "  if (trimmed === '' || trimmed.toLowerCase() === 'unset') return null;",
    '  const folded = PRIORITY_ALIASES[trimmed.toLowerCase()];',
    '  return folded ?? v;',
    '}',
    '',
    '/** Is `v` a canonical priority? NULL is *unset*, not an offender. */',
    'export function isCanonicalPriority(v: string | null | undefined): boolean {',
    '  if (v === null || v === undefined) return false;',
    '  const trimmed = v.trim();',
    '  return CANONICAL_PRIORITIES.some((p) => p === trimmed);',
    '}',
  ],
  brief_type: [
    '/**',
    ' * Normalize a brief_type to its canonical spelling. Known aliases fold, any',
    ' * case variant of a canonical type folds to its canonical casing, unknown',
    ' * values pass through UNCHANGED. null/undefined/empty -> null.',
    ' */',
    'export function normalizeBriefType(v: string | null | undefined): string | null {',
    '  if (v === null || v === undefined) return null;',
    '  const trimmed = v.trim();',
    "  if (trimmed === '') return null;",
    '  const key = trimmed.toLowerCase();',
    '  return BRIEF_TYPE_ALIASES[key] ?? BRIEF_TYPE_CANONICAL[key] ?? v;',
    '}',
    '',
    '/** Is `v` a canonical brief_type? Case-insensitive, trim-tolerant. */',
    'export function isCanonicalBriefType(v: string | null | undefined): boolean {',
    '  if (v === null || v === undefined) return false;',
    '  return BRIEF_TYPE_CANONICAL[v.trim().toLowerCase()] !== undefined;',
    '}',
  ],
  phase: [
    '/**',
    ' * Normalize a brief phase to its canonical (uppercase) spelling. Known phases',
    ' * fold; unknown values pass through UNCHANGED. null/undefined/empty -> null.',
    ' */',
    'export function normalizePhase(v: string | null | undefined): string | null {',
    '  if (v === null || v === undefined) return null;',
    '  const trimmed = v.trim();',
    "  if (trimmed === '') return null;",
    '  const upper = trimmed.toUpperCase();',
    '  const match = CANONICAL_PHASES.find((p) => p === upper);',
    '  return match ?? v;',
    '}',
    '',
    '/** Is `v` a canonical phase? Case-insensitive, trim-tolerant. */',
    'export function isCanonicalPhase(v: string | null | undefined): boolean {',
    '  if (v === null || v === undefined) return false;',
    '  const upper = v.trim().toUpperCase();',
    '  return CANONICAL_PHASES.some((p) => p === upper);',
    '}',
  ],
};

/** Every normalizer id `SYNC_NORMALIZED_FIELDS` actually uses, sorted. */
export function normalizerIdsInUse(
  fields: Record<string, Record<string, string>>,
): string[] {
  const ids = new Set<string>();
  for (const table of Object.values(fields)) {
    for (const id of Object.values(table)) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Fail LOUDLY at generation time when a mapped normalizer id has no authored
 * body. Without this the renderer would emit a `SYNC_NORMALIZERS` row calling
 * a function it never defined, and the first sign of trouble would be a CLI
 * typecheck error with no hint about what to add or where.
 */
export function assertNormalizerBodies(ids: string[]): void {
  const missing = ids.filter((id) => NORMALIZER_BODIES[id] === undefined);
  if (missing.length === 0) return;
  throw new Error(
    `brief-normalize mirror: no authored body for normalizer id(s) ${missing
      .map((m) => `'${m}'`)
      .join(', ')}. ` +
      'Mapping a field to an EXISTING normalizer id is one line in ' +
      'SYNC_NORMALIZED_FIELDS. Introducing a NEW id — which is what you are ' +
      'doing — costs three more: (1) the brain-side ' +
      `${missing
        .map((m) => `normalize${pascal(m)}/isCanonical${pascal(m)}`)
        .join(', ')} pair in brief-normalize.ts, (2) its SYNC_NORMALIZERS row ` +
      'there, and (3) its body in NORMALIZER_BODIES (brief-normalize-mirror.ts). ' +
      'The union and dispatch are DERIVED — do not hand-edit them. Then ' +
      'regenerate. See core/enforcement/sync-ingress-normalization.md ' +
      '"Adding a normalized field" for the two cost shapes.',
  );
}

// ---------------------------------------------------------------------------
// The module renderer
// ---------------------------------------------------------------------------

function renderCliModule(
  fieldMap: Record<string, Record<string, string>> = SYNC_NORMALIZED_FIELDS,
): string {
  const fieldEntries: string[] = [];
  for (const [table, fields] of Object.entries(fieldMap)) {
    fieldEntries.push(`  ${lit(table)}: {`);
    for (const [field, id] of Object.entries(fields)) {
      fieldEntries.push(`    ${lit(field)}: ${lit(id)},`);
    }
    fieldEntries.push('  },');
  }

  // DERIVED, not hand-listed: the union members, the dispatch rows and the
  // emitted bodies all come from the ids the map actually uses.
  const ids = normalizerIdsInUse(fieldMap);
  assertNormalizerBodies(ids);

  const unionType = ids.map((id) => lit(id)).join(' | ');
  const dispatchRows = ids.map(
    (id) =>
      `  ${id}: { normalize: normalize${pascal(id)}, isCanonical: isCanonical${pascal(id)} },`,
  );
  const normalizerBodies: string[] = [];
  for (const id of ids) {
    normalizerBodies.push(...NORMALIZER_BODIES[id], '');
  }

  const fixtures = buildFixtures().map(
    (f) => `  { normalizer: ${lit(f.normalizer)}, input: ${lit(f.input)}, expected: ${lit(f.expected)} },`,
  );
  const predicateFixtures = buildPredicateFixtures().map(
    (f) => `  { normalizer: ${lit(f.normalizer)}, input: ${lit(f.input)}, expected: ${f.expected} },`,
  );
  const rowFixtures = buildSyncRowFixtures().map(
    (f) =>
      `  { table: ${lit(f.table)}, row: ${JSON.stringify(f.row)}, ` +
      `expectedRow: ${JSON.stringify(f.expectedRow)}, ` +
      `expectedFolds: ${JSON.stringify(f.expectedFolds)}, ` +
      `expectedNonCanonical: ${JSON.stringify(f.expectedNonCanonical)}, ` +
      `expectedSameObject: ${f.expectedSameObject} },`,
  );

  const lines: string[] = [
    '// GENERATED by brain-mcp-server/scripts/gen-brief-normalize-mirror.ts — DO NOT EDIT BY HAND.',
    '// Re-run `npm run gen:brief-normalize-mirror` (in brain-mcp-server/) to refresh; edits here are overwritten.',
    '//',
    '// TD-338 — the CLI-side copy of the brief metadata normalizers. The CLI and',
    '// brain-mcp-server are separate npm packages with ZERO cross-imports',
    '// (coding_guidelines §13), so the CLI reads this committed copy. The brain-side',
    '// parity test asserts it is byte-identical to a fresh regeneration, so any edit',
    '// to the fold tables that is not regenerated fails CI.',
    '//',
    '// THE LOGIC HALF. Byte-parity cannot see a change to a function BODY here,',
    '// because the bodies are authored in the builder rather than derived from the',
    '// source. Three fixture tables close that, each computed by running the',
    "// BRAIN's real code at generation time and replayed by the CLI-side test:",
    '//   NORMALIZE_FIXTURES  — the three leaf normalizers',
    '//   PREDICATE_FIXTURES  — the three isCanonical* predicates',
    '//   SYNC_ROW_FIXTURES   — normalizeSyncRow, the function mergeRows calls',
    '// Together they cover every authored function in this module, so a brain-side',
    '// logic change that is not reproduced here fails on the CLI side.',
    '//',
    '// Source of truth: brain-mcp-server/src/tools/brief-normalize.ts',
    '',
    ...renderStringArray(
      'CANONICAL_PHASES',
      CANONICAL_PHASES,
      '/** Canonical brief phases — the brief state-machine vocabulary. */',
    ),
    ...renderStringArray(
      'CANONICAL_PRIORITIES',
      CANONICAL_PRIORITIES,
      '/** Canonical brief priorities. A genuinely unset priority is SQL NULL, NOT a member. */',
    ),
    ...renderStringArray(
      'CANONICAL_BRIEF_TYPES',
      CANONICAL_BRIEF_TYPES,
      '/** Canonical brief types (TD-328). */',
    ),
    ...renderRecord(
      'PRIORITY_ALIASES',
      PRIORITY_ALIASES,
      '/** Priority alias fold map. Keys are lowercase + trimmed; lookup is `v.trim().toLowerCase()`. */',
    ),
    ...renderRecord(
      'BRIEF_TYPE_ALIASES',
      BRIEF_TYPE_ALIASES,
      '/** brief_type unconditional alias fold map. Keys are lowercase + trimmed. */',
    ),
    '/** Canonical brief_type lookup keyed by lowercase, for idempotent case-folding. */',
    'const BRIEF_TYPE_CANONICAL: Readonly<Record<string, string>> = Object.fromEntries(',
    '  CANONICAL_BRIEF_TYPES.map((t) => [t.toLowerCase(), t]),',
    ');',
    '',
    '/**',
    ' * Stable normalizer id — the key `SYNC_NORMALIZED_FIELDS` dispatches on.',
    ' * DERIVED from the values actually present in that map, so adding a',
    ' * normalized field widens this union automatically.',
    ' */',
    `export type SyncNormalizerId = ${unionType};`,
    '',
    '/**',
    ' * Which synced columns pass through a write-boundary normalizer on INGRESS,',
    ' * per table. A table absent from this map is copied verbatim.',
    ' */',
    'export const SYNC_NORMALIZED_FIELDS: Readonly<',
    '  Record<string, Readonly<Record<string, SyncNormalizerId>>>',
    '> = {',
    ...fieldEntries,
    '};',
    '',
    ...normalizerBodies,
    'interface SyncNormalizerEntry {',
    '  normalize(v: string | null | undefined): string | null;',
    '  isCanonical(v: string | null | undefined): boolean;',
    '}',
    '',
    '/** DERIVED dispatch table — one row per normalizer id the map uses. */',
    'const SYNC_NORMALIZERS: Record<SyncNormalizerId, SyncNormalizerEntry> = {',
    ...dispatchRows,
    '};',
    '',
    '/** One field folded on ingress: what it arrived as, what was stored. */',
    'export interface SyncFieldFold {',
    '  field: string;',
    '  from: string;',
    '  to: string | null;',
    '}',
    '',
    '/** One field that arrived non-canonical and was stored AS-IS (never folded). */',
    'export interface SyncFieldPassthrough {',
    '  field: string;',
    '  value: string;',
    '}',
    '',
    '/** The result of normalizing one inbound sync row. */',
    'export interface SyncRowNormalizeResult {',
    '  /** The row to store. The SAME object as the input when nothing folded. */',
    '  row: Record<string, unknown>;',
    '  folds: SyncFieldFold[];',
    '  nonCanonical: SyncFieldPassthrough[];',
    '}',
    '',
    'const NO_FOLDS: SyncFieldFold[] = [];',
    'const NO_PASSTHROUGHS: SyncFieldPassthrough[] = [];',
    '',
    '/**',
    ' * Fold an inbound replication row through the write-boundary normalizers.',
    ' * FOLD-KNOWN / PASSTHROUGH-UNKNOWN / REPORT-BOTH. Never mutates `row`.',
    ' */',
    'export function normalizeSyncRow(',
    '  table: string,',
    '  row: Record<string, unknown>,',
    '): SyncRowNormalizeResult {',
    '  const fields = SYNC_NORMALIZED_FIELDS[table];',
    '  if (!fields) return { row, folds: NO_FOLDS, nonCanonical: NO_PASSTHROUGHS };',
    '',
    '  let out = row;',
    '  let folds: SyncFieldFold[] | null = null;',
    '  let nonCanonical: SyncFieldPassthrough[] | null = null;',
    '',
    '  for (const field of Object.keys(fields)) {',
    '    const raw = row[field];',
    '    if (raw === undefined) continue;',
    "    if (raw !== null && typeof raw !== 'string') continue;",
    '',
    '    const entry = SYNC_NORMALIZERS[fields[field]];',
    '    const next = entry.normalize(raw);',
    '',
    '    if (next !== raw) {',
    '      if (out === row) out = { ...row };',
    '      out[field] = next;',
    '      (folds ??= []).push({ field, from: raw as string, to: next });',
    '    }',
    '',
    "    if (next !== null && next.trim() !== '' && !entry.isCanonical(next)) {",
    '      (nonCanonical ??= []).push({ field, value: next });',
    '    }',
    '  }',
    '',
    '  return {',
    '    row: out,',
    '    folds: folds ?? NO_FOLDS,',
    '    nonCanonical: nonCanonical ?? NO_PASSTHROUGHS,',
    '  };',
    '}',
    '',
    '/** One replayable behavioural fixture: `normalizer(input) === expected`. */',
    'export interface NormalizeFixture {',
    '  normalizer: SyncNormalizerId;',
    '  input: string;',
    '  expected: string | null;',
    '}',
    '',
    '/**',
    " * Input -> output pairs computed by running the BRAIN's real normalizers at",
    ' * generation time. The CLI-side test replays them through the functions above,',
    ' * which is what makes this a behavioural mirror and not just a data copy.',
    ' */',
    'export const NORMALIZE_FIXTURES: readonly NormalizeFixture[] = [',
    ...fixtures,
    '];',
    '',
    '/** One replayable canonicality fixture: `isCanonical<X>(input) === expected`. */',
    'export interface PredicateFixture {',
    '  normalizer: SyncNormalizerId;',
    '  input: string;',
    '  expected: boolean;',
    '}',
    '',
    '/**',
    " * Canonicality verdicts computed by the BRAIN's real predicates at generation",
    ' * time. These decide whether a passed-through value is REPORTED, so they are',
    ' * behaviour, not data.',
    ' */',
    'export const PREDICATE_FIXTURES: readonly PredicateFixture[] = [',
    ...predicateFixtures,
    '];',
    '',
    '/**',
    ' * One replayable ROW-level fixture — the whole `normalizeSyncRow` contract',
    ' * for one input: what is stored, what folded, what was reported, and whether',
    ' * the INPUT object was returned unchanged.',
    ' */',
    'export interface SyncRowFixture {',
    '  table: string;',
    '  row: Record<string, unknown>;',
    '  expectedRow: Record<string, unknown>;',
    '  expectedFolds: SyncFieldFold[];',
    '  expectedNonCanonical: SyncFieldPassthrough[];',
    '  expectedSameObject: boolean;',
    '}',
    '',
    '/**',
    " * Row-level outcomes computed by running the BRAIN's real `normalizeSyncRow`",
    ' * at generation time. `normalizeSyncRow` is AUTHORED template text in the',
    ' * builder, not derived from the source, so a byte-parity test cannot see a',
    ' * brain-side edit to it — these fixtures are what makes the mirror',
    ' * behavioural for the function both mergeRows copies actually call.',
    ' *',
    ' * At least one row carries a FOLDABLE-LOOKING `updated_at`, so a fold that',
    ' * ever reached the LWW comparison column diverges here immediately.',
    ' */',
    'export const SYNC_ROW_FIXTURES: readonly SyncRowFixture[] = [',
    ...rowFixtures,
    '];',
    '',
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** The full build result: the rendered CLI mirror module text. */
export interface BriefNormalizeMirrorResult {
  cliModule: string;
  /** Leaf-normalizer fixtures baked into the artifact (exposed for tests). */
  fixtures: NormalizeFixture[];
  /** `isCanonical*` fixtures baked into the artifact. */
  predicateFixtures: PredicateFixture[];
  /** `normalizeSyncRow` row-level fixtures baked into the artifact. */
  rowFixtures: SyncRowFixture[];
}

/**
 * Build the CLI normalizer mirror from the live `brief-normalize.ts` exports.
 * Everything (canonical sets, fold tables, the ingress field map, the
 * `SyncNormalizerId` union, the dispatch table and the behavioural fixtures) is
 * derived — the ONLY hand-listed layer is `NORMALIZER_BODIES`.
 *
 * `fieldMap` is a seam: the caller passes it so the guard behaviour is
 * trivially testable with any input (the `buildEgressManifest(tables)`
 * pattern). Production callers use the default.
 */
export function buildBriefNormalizeMirror(
  fieldMap: Record<string, Record<string, string>> = SYNC_NORMALIZED_FIELDS,
): BriefNormalizeMirrorResult {
  return {
    cliModule: renderCliModule(fieldMap),
    fixtures: buildFixtures(),
    predicateFixtures: buildPredicateFixtures(),
    rowFixtures: buildSyncRowFixtures(),
  };
}
