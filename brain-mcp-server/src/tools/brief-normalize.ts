/**
 * Igris Brain -- Brief Metadata Normalization (TD-238)
 *
 * Canonicalizes the three free-text metadata fields written at the brief
 * write boundaries (`igris_brief_sync` / `_create` / `_update`):
 *   - phase
 *   - priority
 *   - brief_type
 *
 * Design posture (insert-narrow / read-widen — memory #228, CORRECTED by TD-328):
 *   These helpers NORMALIZE; they do NOT hard-reject. Known legacy forms are
 *   folded to their canonical spelling; UNKNOWN values pass through unchanged.
 *   A hard reject at the write boundary would break a legacy caller mid-
 *   transition and could silently drop operator data — so the conservative
 *   posture is to canonicalize what we recognize and let everything else
 *   through.
 *
 *   WHAT SURVIVES OF #228: the write boundary MUST NOT hard-reject. #228's core
 *   claim is about blast radius — a persisted column whose vocabulary is still
 *   evolving must not let a narrow writer destroy operator input. Rejecting
 *   `Bug (pub.dev Score)` would have meant that brief was never created. Still
 *   true; TD-328 does not weaken it.
 *
 *   WHAT TD-328 CORRECTS: the implicit assumption that tolerance is
 *   SELF-CORRECTING. This docstring used to end "reads stay tolerant; writes get
 *   cleaner over time". The live data falsified that: `brief_type` reached 50
 *   distinct non-NULL spellings for ~10 concepts, because tolerance without
 *   observation has no gradient. Read-widen is a TOLERANCE policy, not a SILENCE
 *   policy. A widened read requires a reporting surface, or the widening is
 *   permanent.
 *
 *   THE OBSERVERS TD-328 ADDS (find them here when the 51st spelling appears):
 *     - `src/tools/briefs.ts` — write-boundary echo: `igris_brief_create` /
 *       `_sync` / `_update` append a NOTE to the response when the stored type
 *       is not canonical. Informs; never rejects.
 *     - `scripts/validate_brief_type_vocabulary.sh` — repo validator wired into
 *       `scripts/git-hooks/pre-commit` as WARN-only; catches ACCUMULATION (a
 *       spelling that arrived via remote sync or an older client, where nobody
 *       saw the echo).
 *     - `core/enforcement/brief-type-vocabulary.md` — the obligation doc.
 *
 *   The ONLY exception is priority, where the "unset" family (empty string,
 *   whitespace, and the literal "Unset") is mapped to SQL NULL — the dashboard
 *   already renders NULL as "Unset" (`p.priority || 'Unset'`, briefs.ts), so
 *   collapsing the unset family to NULL fixes the split-bucket double-count
 *   without inventing a priority for a genuinely unset brief.
 *
 * Idempotency: every normalizer maps canonical input to itself (a fixed
 * point), so applying a normalizer twice equals applying it once. This is the
 * property the v18 data migration relies on for safe re-runs.
 *
 * Single-source-of-truth note: CANONICAL_PHASES MUST stay element-identical to
 * the bash validator's array in scripts/validate_brief_state_reconciliation.sh
 * (TD-257). There is no build step generating one from the other, so a parity
 * guard (test/validate_canonical_phase_parity.test.bash) hard-fails CI if the
 * two definitions diverge. Do NOT hand-edit one copy without the other.
 *
 *   THE SAME APPLIES TO CANONICAL_BRIEF_TYPES (TD-328), with one important
 *   difference: its bash twin lives in scripts/validate_brief_type_vocabulary.sh
 *   and it has NO equivalent parity guard yet — only a presence spot-check. See
 *   the note on CANONICAL_BRIEF_TYPES below. TD-330 owns closing that gap.
 *
 * @module tools/brief-normalize
 * @author fifty.dev
 */

/**
 * Canonical brief phases — the brief state-machine vocabulary.
 *
 * MUST match `CANONICAL_PHASES` in
 * scripts/validate_brief_state_reconciliation.sh element-for-element and in the
 * SAME ORDER (enforced by test/validate_canonical_phase_parity.test.bash).
 * COMPLETE is the terminal phase the C1 reconciliation pivots on.
 */
export const CANONICAL_PHASES = [
  'INIT',
  'PLANNING',
  'APPROVAL',
  'BUILDING',
  'TESTING',
  'REVIEWING',
  'DOCUMENTING',
  'COMMITTING',
  'COMPLETE',
  'BLOCKED',
] as const;

/**
 * Canonical brief priorities — the `P{N}-{Word}` form proven by the live
 * buckets. A genuinely unset priority is SQL NULL, NOT a member of this set.
 */
export const CANONICAL_PRIORITIES = [
  'P0-Critical',
  'P1-High',
  'P2-Medium',
  'P3-Low',
] as const;

/**
 * Canonical brief types (TD-328).
 *
 * THE DEFINING RULE: the canonical set is the IMAGE OF THE `/register` BRIEF-ID
 * PREFIX MAP (`core/skills/register/SKILL.md` §2) ∪ {`Documentation`}. A value
 * with a mint prefix is a TYPE; a value without one is a SPELLING. This is what
 * makes the fold table mechanical rather than a taste argument, and it removes
 * the ORIGINAL CAUSE of the 50-spelling drift: `/register` minted `DU-` and
 * `AC-` briefs while neither `Dependency Update` nor `Architecture` was
 * canonical, so those briefs had no legal type to write and the operator
 * invented one.
 *
 *   BR → Bug | Feature (ambiguous by design — see BRIEF_ID_PREFIX_TYPES)
 *   FR → Feature          MG → Migration        TD → Technical Debt
 *   TS → Testing          PI → Process Improvement
 *   DU → Dependency Update (TD-328 addition)
 *   PF → Performance      AC → Architecture     (TD-328 addition)
 *   (no prefix)          → Documentation
 *
 * DELIBERATE EXCEPTION — `Refactor` is canonical WITHOUT a mint prefix.
 *   It was promoted on MEASURED EVIDENCE, not on the prefix rule: of the 46
 *   live `Refactor`/`Refactoring` rows only 19 (41%) carry a `TD-` prefix — 25
 *   are `BR-`, 2 are `UI-`. The plan's own flip criterion was "<70% TD- ⇒ the
 *   value carries real information the prefix does not ⇒ promote instead of
 *   fold", and 41% triggers it. The `BR-` titles confirm it independently
 *   (*Extract fifty_connectivity Package*, *Restructure fifty_arch as
 *   Template*, *Migrate Tactical Grid to fifty_map_engine*) — genuine refactor
 *   work minted under `BR-` only because no refactor prefix exists.
 *   The operator DECLINED adding an `RF-` mint prefix, so the canonical set is
 *   deliberately NO LONGER exactly the image of the prefix map.
 *   ⇒ DO NOT "correct" this back by applying the prefix rule mechanically.
 *   Adding an `RF-` prefix to `/register` later would remove the exception;
 *   that is not in scope for TD-328.
 *
 * `Acceptance` is retained with 0 live rows — removing it would be a narrowing,
 * which is out of scope (and #228 says narrowings are the dangerous direction).
 *
 * Unknown types still pass through unchanged (read-widen) — but they are now
 * REPORTED by the observers named in the module docstring.
 *
 * ⚠ THIS ARRAY HAS A SECOND COPY. `scripts/validate_brief_type_vocabulary.sh`
 * carries a `CANONICAL_BRIEF_TYPES` bash array that MUST stay element-identical
 * to this one. There is no build step generating one from the other, and — read
 * this before trusting CI — the bats trio only SPOT-CHECKS that the TD-328
 * additions are present on both sides. It will NOT fail if you add a 13th type
 * here, remove one of the nine pre-existing members, or reorder them. So
 * editing this array is a two-file edit you have to remember; TD-330 owns
 * building the real parity guard (the shape `CANONICAL_PHASES` already has in
 * test/validate_canonical_phase_parity.test.bash).
 */
export const CANONICAL_BRIEF_TYPES = [
  'Feature',
  'Bug',
  'Migration',
  'Technical Debt',
  'Testing',
  'Process Improvement',
  'Documentation',
  'Acceptance',
  'Performance',
  // --- TD-328 additions ---
  'Architecture',
  'Dependency Update',
  'Refactor',
] as const;

/**
 * Priority alias fold map (legacy form → canonical form). Keys are matched
 * case-insensitively against the trimmed input. Canonical values map to
 * themselves so the normalizer is idempotent.
 */
const PRIORITY_ALIASES: Record<string, string> = {
  // Bare P{N} forms.
  p0: 'P0-Critical',
  p1: 'P1-High',
  p2: 'P2-Medium',
  p3: 'P3-Low',
  // Spaced-dash forms seen in the live data (e.g. "P1 - High").
  'p0 - critical': 'P0-Critical',
  'p1 - high': 'P1-High',
  'p2 - medium': 'P2-Medium',
  'p3 - low': 'P3-Low',
  // Canonical → canonical (idempotent fixed points).
  'p0-critical': 'P0-Critical',
  'p1-high': 'P1-High',
  'p2-medium': 'P2-Medium',
  'p3-low': 'P3-Low',
};

/**
 * brief_type UNCONDITIONAL alias fold map (legacy spelling → canonical type).
 *
 * Keys are LOWERCASE and TRIMMED; lookup is `value.trim().toLowerCase()`.
 *
 * EXPORTED as the SINGLE SOURCE OF TRUTH. The v22 data migration
 * (`src/db.ts`), the backfill script (`scripts/normalize_brief_types.ts`) and
 * the write boundary all read THIS object — there is deliberately no second
 * hand-copied list, which is the two-copies drift class that already bit
 * `CANONICAL_PHASES` (it needed a bash-parity guard). `brief-normalize.ts`
 * imports nothing, so `db.ts → tools/brief-normalize.js` stays acyclic.
 *
 * Every entry here is UNAMBIGUOUS: the fold loses nothing recoverable because
 * the row's title/content still say what it said, and where the row carries a
 * mint prefix the type field was redundant with the prefix anyway.
 *
 * NOT here, deliberately:
 *   - `BR` — `/register` maps BOTH `bug` and `feature` to `BR`, so the value is
 *     ambiguous by design. Folding it would mistype an unknown number of rows.
 *     Same reason `BR` is absent from BRIEF_ID_PREFIX_TYPES.
 *   - `Spike` / `Investigation` / `Integration` — no defensible target; folding
 *     would be INVENTING, not normalising. They surface in the D6 report every
 *     run, which is the correct outcome: visible and cheap to retype by hand.
 *   - `Bug/Feature` — genuinely two types, no head type.
 *   - the compound values — they need the per-row qualifier check in
 *     BRIEF_TYPE_COMPOUND_FOLDS, which a pure string normalizer cannot do.
 */
export const BRIEF_TYPE_ALIASES: Record<string, string> = {
  // --- tech-debt family (the largest spelling zoo: 9 spellings, ~106 rows) ---
  'tech debt': 'Technical Debt',
  td: 'Technical Debt',
  debt: 'Technical Debt',
  techdebt: 'Technical Debt',
  technicaldebt: 'Technical Debt',
  tech_debt: 'Technical Debt',
  'tech-debt': 'Technical Debt',
  // `Chore` has no mint prefix, no distinct consumer, and no downstream
  // decision turns on it (D2).
  chore: 'Technical Debt',

  // --- bug family ---
  'bug fix': 'Bug',
  bugfix: 'Bug',

  // --- feature family (D3 — 136 rows) ---
  // `request → FR` at the mint surface: `FR` and `Feature Request` are two
  // spellings of the prefix's expansion, they name the brief-ID KIND, not a
  // second type. "Request" is a LIFECYCLE POSITION, which `status` already
  // encodes. The status cross-tab settled the counter-argument with data:
  // `Feature Request` is 70/88 Done and `FR` is 36/44 Done — the same status
  // shape as `Feature` (463/718 Done), NOT an un-accepted intake queue
  // concentrated in Ready/Draft. There is no distinction to destroy.
  fr: 'Feature',
  'feature request': 'Feature',
  featurerequest: 'Feature',
  enhancement: 'Feature',
  'feature enhancement': 'Feature',

  // --- Refactor is CANONICAL (see CANONICAL_BRIEF_TYPES); only the -ing
  //     spelling folds ---
  refactoring: 'Refactor',

  // --- spelling variants of the two TD-328-promoted types ---
  architecturecleanup: 'Architecture',
  dependencyupdate: 'Dependency Update',

  // --- remaining single-word spellings ---
  doc: 'Documentation',
  test: 'Testing',
  process: 'Process Improvement',
  // Release work is release-PROCESS work and there is no `RL-` mint prefix.
  // D2 gated this on eyeballing the live titles; all 6 read as release-process
  // work (*v1.0.0 Release Preparation*, *Build signed Play Store app bundle*,
  // *Record Play Store declaration walkthrough video*), none as product
  // features, so the gate passes and the fold is unconditional.
  release: 'Process Improvement',
};

/** A compound `brief_type` value's head type + the qualifier tokens that must
 *  survive in the row's own text for the fold to be lossless. */
export interface CompoundFold {
  /** The canonical head type the compound folds to. */
  head: string;
  /**
   * Lowercase LIKE-fragments. The fold is applied if **ANY** token appears in
   * the row's `brief_status.title` or any of its `brief_files.content`, matched
   * against a SPACE-PADDED lowercased haystack — so a token may carry its own
   * leading/trailing space to get a crude word boundary (e.g. `' ui '` must not
   * match "build"/"guide"/"require").
   *
   * ANY, not ALL — so populate this list with SYNONYMS OF ONE FACT
   * (`'tech debt'`/`'technical debt'`/`'techdebt'`), never with two independent
   * facts. Listing two different facts under ANY-matching means a row that
   * mentions only one of them still folds, and the other is destroyed — which
   * silently breaks the "loses nothing recoverable" guarantee this gate exists
   * to provide. When a qualifier really is two facts, keep only the
   * DISTINGUISHING token (see `'feature / ui enhancement'` below).
   */
  tokens: string[];
}

/**
 * brief_type COMPOUND fold map (D4) — head type + qualifier-recoverability gate.
 *
 * These 16 rows are operators encoding a SECOND FACT in a single-value field.
 * They are evidence the schema is missing a tag/subtype, NOT evidence of 13
 * more types. Rather than add a `brief_subtype` column (a 6-file cross-
 * subsystem contract sweep for 16 rows), TD-328 folds each to its head type
 * ONLY where the dry-run proves the qualifier already survives in the row's own
 * title/content — so the fold loses nothing recoverable. A row that fails the
 * check is LEFT UNFOLDED and reported, so it is visible rather than quietly
 * damaged.
 *
 * ESCALATION TRIPWIRE (recorded in `core/enforcement/brief-type-vocabulary.md`):
 * if compound values ever exceed 25 rows OR 5% of the corpus at any run of the
 * D6 validator, FILE THE `brief_subtype` COLUMN BRIEF. That converts "we decided
 * not to" into a tripwire instead of an omission.
 *
 * `Bug/Feature` is deliberately ABSENT — it has no head type. Left unfolded,
 * reported.
 *
 * THE GATE IS PER-ROW, NOT PER-VALUE. Two rows sharing a compound spelling can
 * get different verdicts, and that is the design working — not an inconsistency
 * to "fix" by making the decision value-scoped. `Bug (pub.dev Score)` is the
 * worked example: of its two live rows, BR-110 folded to `Bug` (its own title
 * says *Upgrade Outdated Dependencies for pub.dev Score Recovery*, so the
 * qualifier survives) while BR-108 did NOT (its title is *Sync CHANGELOG.md with
 * Current Versions for All Packages* and it has no brief_files content, so
 * "pub.dev" appears nowhere in the row and folding would destroy it). Recording
 * a verdict against the VALUE would have silently damaged BR-108.
 *
 * Phase 0 row verdicts on the live corpus (2026-08-02): 13 of 16 compound ROWS
 * recoverable. The 3 rows left unfolded and reported: BR-108
 * (`Bug (pub.dev Score)` — the sibling of a row that DID fold), BR-023
 * (`Bug Fix / Tech Debt`), BR-014 (`Feature / Infrastructure`).
 */
export const BRIEF_TYPE_COMPOUND_FOLDS: Record<string, CompoundFold> = {
  'bug (doc misalignment)': { head: 'Bug', tokens: ['misalignment', 'documentation'] },
  'bug (pub.dev score)': { head: 'Bug', tokens: ['pub.dev'] },
  'bug fix / compliance': { head: 'Bug', tokens: ['compliance'] },
  'bug fix / refactor': { head: 'Bug', tokens: ['refactor'] },
  'bug fix / tech debt': {
    head: 'Bug',
    tokens: ['tech debt', 'technical debt', 'techdebt'],
  },
  'bug(visualpolish)': { head: 'Bug', tokens: ['visual polish', 'polish'] },
  'feature / asset update': { head: 'Feature', tokens: ['asset'] },
  'feature / demo': { head: 'Feature', tokens: ['demo'] },
  'feature / infrastructure': { head: 'Feature', tokens: ['infrastructure'] },
  'feature / new app': { head: 'Feature', tokens: ['new app'] },
  // ' ui ' ONLY — deliberately NOT ['  ui  ', 'enhancement']. Matching is
  // ANY-token (correct for the synonym sets above), but "UI" and "Enhancement"
  // are two DIFFERENT facts, so an ANY-match on 'enhancement' would fold a row
  // whose text never mentions the interface and destroy the UI fact — breaking
  // the "loses nothing recoverable" guarantee. Requiring the distinguishing
  // token is a no-op on the live corpus (both rows, BR-040 and BR-064, matched
  // ' ui ') and makes the guarantee true rather than nearly true.
  'feature / ui enhancement': { head: 'Feature', tokens: [' ui '] },
  'feature(rebrand)': { head: 'Feature', tokens: ['rebrand'] },
};

/**
 * Brief-ID mint prefix → canonical type (D5 — the NULL-row inference table).
 *
 * Decoding a prefix back to a type is a LOSSLESS DECODE, not a guess: the
 * prefix is a field of the brief ID, assigned by `/register`
 * (`core/skills/register/SKILL.md` §2) from the very type question being asked.
 * Used ONLY to fill rows where `brief_type IS NULL` — it never overwrites a
 * stated type, so there is no competing value to destroy.
 *
 * `BR` IS DELIBERATELY ABSENT AND MUST STAY ABSENT.
 *   `/register` §2 maps BOTH `bug` and `feature` to the `BR` prefix
 *   (`| bug, feature | BR |`), so a `BR-` brief may be either — and `BR-` is
 *   the oldest and largest prefix in the corpus (17 of the 68 NULL rows).
 *   Inferring `BR-` → `Bug` would silently mistype an unknown number of
 *   features. Those rows stay NULL and are REPORTED instead (AC-4 is satisfied
 *   by explanation, not only by assignment). A test pins this absence against a
 *   well-meaning future addition.
 *
 *   The `bug, feature → BR` collision is the same defect class as TD-328 one
 *   level up — an unconstrained mapping at the MINT surface. It deserves its
 *   own brief; explicitly out of scope here.
 */
export const BRIEF_ID_PREFIX_TYPES: Record<string, string> = {
  FR: 'Feature',
  MG: 'Migration',
  TD: 'Technical Debt',
  TS: 'Testing',
  PI: 'Process Improvement',
  DU: 'Dependency Update',
  PF: 'Performance',
  AC: 'Architecture',
};

/**
 * Canonical brief_type lookup, keyed by lowercase, for idempotent
 * case-folding (e.g. "technical debt" → "Technical Debt").
 */
const BRIEF_TYPE_CANONICAL: Record<string, string> = Object.fromEntries(
  CANONICAL_BRIEF_TYPES.map((t) => [t.toLowerCase(), t]),
);

/**
 * Is `v` a canonical brief type? Case-insensitive and trim-tolerant, so
 * `"feature"` does not trigger a spurious "non-canonical" report.
 *
 * This is the predicate the D6(c) write-boundary echo and the D6(d) validator
 * pivot on. It INFORMS; nothing in this module rejects on a false result.
 */
export function isCanonicalBriefType(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return BRIEF_TYPE_CANONICAL[v.trim().toLowerCase()] !== undefined;
}

/**
 * The D6(c) WRITE-BOUNDARY ECHO — the observer that makes read-widen a
 * tolerance policy instead of a silence policy.
 *
 * Returns a NOTE to append to an MCP tool response when the value that was
 * actually STORED is not canonical, or `null` when there is nothing to say.
 * The 51st spelling is then visible at the instant it is minted, in whichever
 * harness is running, instead of accumulating silently for years.
 *
 * It INFORMS; it never rejects and never alters the stored value (D1 option b —
 * a hard reject at the write boundary would break a legacy caller mid-
 * transition and could drop operator work that has no retry path).
 *
 * @param stored - the value as normalized and written (NOT the raw input)
 */
export function nonCanonicalBriefTypeNote(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored.trim() === '') return null;
  if (isCanonicalBriefType(stored)) return null;
  return (
    `NOTE: brief_type ${JSON.stringify(stored)} is not a canonical type (stored as-is).\n` +
    `      Canonical: ${CANONICAL_BRIEF_TYPES.join(', ')}.\n` +
    '      Unknown values are kept, never dropped — but they are reported (TD-328).'
  );
}

/**
 * Normalize a brief phase to its canonical (uppercase) spelling.
 *
 * Known phases (case-insensitive) fold to their CANONICAL_PHASES member.
 * Unknown values pass through UNCHANGED (do not reject — a legacy caller
 * mid-transition must not break; #228 insert-narrow is a normalize, not a
 * hard reject). null/undefined/empty → null.
 *
 * Idempotent: canonical input returns itself.
 */
export function normalizePhase(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const match = CANONICAL_PHASES.find((p) => p === trimmed.toUpperCase());
  // Known phase → canonical uppercase form; unknown → passthrough untouched.
  return match ?? v;
}

/**
 * Normalize a brief priority to its canonical `P{N}-{Word}` spelling.
 *
 * The "unset" family — empty string, whitespace-only, and the literal "Unset"
 * (case-insensitive) — maps to SQL NULL (the dashboard renders NULL as
 * "Unset"). Known aliases (`P1`, `P1 - High`, …) fold to canonical. Unknown
 * non-empty values pass through unchanged.
 *
 * Idempotent: canonical input returns itself.
 */
export function normalizePriority(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  // Unset family → NULL.
  if (trimmed === '' || trimmed.toLowerCase() === 'unset') return null;
  const folded = PRIORITY_ALIASES[trimmed.toLowerCase()];
  // Known alias → canonical; unknown → passthrough untouched.
  return folded ?? v;
}

/**
 * Normalize a brief_type to its canonical spelling.
 *
 * Known aliases (BRIEF_TYPE_ALIASES — `TD`/`Debt`/`TechDebt` → `Technical
 * Debt`, `FR`/`Feature Request` → `Feature`, …) fold to canonical, and any case
 * variant of a canonical type folds to its canonical casing (`technical debt` →
 * `Technical Debt`). Unknown values pass through UNCHANGED (read-widen — do not
 * drop operator data), and the caller is expected to REPORT them (D6). Compound
 * values (`Bug Fix / Compliance`) also pass through here: their fold is gated on
 * a per-row qualifier check this pure function has no row to perform.
 * null/undefined/empty → null.
 *
 * Idempotent: canonical input returns itself, and every alias TARGET is itself
 * canonical (pinned by a test), so `f(f(x)) === f(x)` holds for the whole table.
 */
export function normalizeBriefType(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  // Alias fold first, then canonical case-fold, else passthrough untouched.
  return BRIEF_TYPE_ALIASES[key] ?? BRIEF_TYPE_CANONICAL[key] ?? v;
}
