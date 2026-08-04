/**
 * Igris Brain -- Brief Metadata Normalization (TD-238)
 *
 * Canonicalizes the FOUR free-text metadata fields written at the brief
 * write boundaries (`igris_brief_sync` / `_create` / `_update`) and, since
 * TD-338, at replication ingress:
 *   - phase
 *   - priority
 *   - brief_type
 *   - status      (TD-333 — the last one to get a normalizer, and the one the
 *                  system treats as AUTHORITATIVE: it is the canonical
 *                  build-state source. Fifteen distinct values had accumulated
 *                  for six documented states, including three spellings of
 *                  *finished*. See CANONICAL_STATUSES below.)
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
 *   THE MIRROR-IMAGE EXCEPTION (TD-333): `normalizeStatus` does NOT map the
 *   empty string to NULL, and that asymmetry is a SCHEMA fact rather than an
 *   inconsistency. `brief_status.status` is `TEXT NOT NULL` — the only one of
 *   the four whose column is — so there is no unset member to fold to, and
 *   folding would convert a meaningless write into a hard reject at the write
 *   boundary and a silently dropped row at ingress. See `normalizeStatus`.
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
 *   the note on CANONICAL_BRIEF_TYPES below.
 *
 *   ...AND TO CANONICAL_STATUSES (TD-333), whose bash twin is in
 *   scripts/validate_brief_status_vocabulary.sh. **TD-330 now owes a parity
 *   guard for THREE bash canonical arrays, not one.** The status and priority
 *   pairs are small enough that their bats suites check element COUNT in both
 *   directions, which is a real guard; the 12-member brief_type pair is still
 *   only spot-checked. The generic guard is TD-330's.
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
 *
 * EXPORTED (TD-338) as the single source the generated CLI mirror
 * (`cli/src/lib/brief-normalize.generated.ts`) is rendered from — the CLI's
 * `mergeRows` needs the same fold table and the two packages have zero
 * cross-imports. Nothing hand-copies this object; see
 * `brain-mcp-server/src/tools/brief-normalize-mirror.ts`.
 */
export const PRIORITY_ALIASES: Record<string, string> = {
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

/**
 * Is `v` a canonical priority? Trim-tolerant, case-SENSITIVE on the canonical
 * spelling — every case variant already folds via `PRIORITY_ALIASES`, so a
 * value that reaches here in the wrong case was never normalized and SHOULD be
 * reported. NULL is *unset*, not an offender: it returns false, and every
 * caller skips reporting for null/empty (see `normalizeSyncRow`).
 */
export function isCanonicalPriority(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  const trimmed = v.trim();
  return CANONICAL_PRIORITIES.some((p) => p === trimmed);
}

/**
 * Is `v` a canonical phase? Case-insensitive (the normalizer upper-cases known
 * phases), trim-tolerant.
 */
export function isCanonicalPhase(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  const upper = v.trim().toUpperCase();
  return CANONICAL_PHASES.some((p) => p === upper);
}

/**
 * The priority twin of {@link nonCanonicalBriefTypeNote} (TD-338).
 *
 * `priority` had no observer at all before TD-338: the TD-328 echo covers
 * `brief_type` only, so a `P4-Trivial` could sit in the corpus indefinitely
 * with nothing naming it. Returns a NOTE for a non-canonical STORED value, or
 * `null` when there is nothing to say. Informs; never rejects, never rewrites.
 *
 * @param stored - the value as normalized and written (NOT the raw input)
 */
export function nonCanonicalPriorityNote(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored.trim() === '') return null;
  if (isCanonicalPriority(stored)) return null;
  return (
    `NOTE: priority ${JSON.stringify(stored)} is not a canonical priority (stored as-is).\n` +
    `      Canonical: ${CANONICAL_PRIORITIES.join(', ')} (or NULL for unset).\n` +
    '      Unknown values are kept, never dropped — but they are reported (TD-338).'
  );
}

// ===========================================================================
// TD-333 — THE `status` VOCABULARY
// ===========================================================================

/**
 * Canonical brief statuses (TD-333) — the DOCUMENTED LIFECYCLE.
 *
 * THE DEFINING RULE, and the reason this fold is mechanical rather than taste:
 * the canonical set is the lifecycle written down at
 * `docs/architecture/brief-state-source-of-truth.md` (the "Source" table) — the
 * SAME six values `cli/dashboard/src/layers/board.ts` mirrors as
 * `KNOWN_BRIEF_STATUSES`. TD-333 does NOT widen it. From that anchor:
 *
 *   - a live value is a SPELLING if it is a morphological variant of a
 *     documented member AND the documented set has no separate slot for what it
 *     means  →  it folds (see STATUS_ALIASES);
 *   - a live value is a MISSING STATE if it names an outcome the documented set
 *     has no member for at all  →  it does NOT fold. It passes through, and the
 *     observers report it until a human decides (see the note below).
 *
 * THE THREE MISSING STATES, named so their absence reads as a decision:
 * `Cancelled` (23 rows), `Superseded` (18) and `Deferred` (7), measured
 * read-only on 2026-08-04. Each names an outcome the documented six cannot
 * express. Promoting them would change the ONE written lifecycle source and
 * sweep `board.ts`, the bash validator and the reconciler's terminal-set
 * reasoning (is a `Cancelled` brief terminal for C1/C2? a real design
 * question) — which is "changing the state machine itself", explicitly out of
 * TD-333's scope. So they stay non-canonical AND REPORTED: 3 values / 48 rows
 * of standing WARN, which is the pressure that gets the follow-up brief hunted.
 * Tolerance without observation has no gradient (TD-328's finding).
 *
 * ⚠ THIS ARRAY HAS A SECOND COPY, the same shape `CANONICAL_BRIEF_TYPES` and
 * `CANONICAL_PRIORITIES` already carry: `scripts/validate_brief_status_vocabulary.sh`
 * holds a `CANONICAL_STATUSES` bash array that MUST stay element-identical.
 * There is no build step generating one from the other and the bats trio only
 * SPOT-CHECKS presence, so editing this array is a two-file edit you have to
 * remember. TD-330 now owes a real element-for-element parity guard for THREE
 * bash canonical arrays, not one.
 */
export const CANONICAL_STATUSES = [
  'Draft',
  'Ready',
  'In Progress',
  'Blocked',
  'Done',
  'Archived',
] as const;

/**
 * status alias fold map (spelling → documented member).
 *
 * Keys are LOWERCASE and TRIMMED; lookup is `value.trim().toLowerCase()`.
 *
 * THE TD-311 ARGUMENT, because `status` is the canonical build-state source and
 * a status edit is exactly what TD-311 forbids:
 *
 *   TD-311 says brief-state contradictions must NEVER be resolved by editing
 *   brief data. This table does not resolve one. A brief's STATE is what the
 *   operator recorded; a predicate's VERDICT is what a consumer computes. The
 *   operator who typed `Completed` recorded *"this work is finished"*, and
 *   `Done` is the documented member that means *"this work is finished"*. After
 *   the fold the brief still means what it meant. No brief ends up in a state
 *   the operator did not record.
 *
 *   THE INVARIANT A REVIEWER CAN CHECK IN ONE PASS: every entry here maps to a
 *   target whose documented meaning is IDENTICAL to the source's, not merely
 *   ADJACENT. Adjacency is a state edit.
 *
 * Each entry, argued individually:
 *   `completed` → `Done` (24 rows). English past participle of the same verb,
 *     and the codebase already asserts they are one state:
 *     `tools/projects.ts` counts `status IN ('Done','Completed','Closed')` as a
 *     single terminal bucket. That is evidence from the code, not from taste.
 *   `complete`  → `Done` (1 row). Adjectival form of the same word; no consumer
 *     names it anywhere in the tree.
 *   `inprogress` → `In Progress` (4 rows). A whitespace difference and nothing
 *     else. `cli/dashboard/src/layers/board.ts` already normalises exactly this
 *     pair to one sort key and its test pins
 *     `statusRank('InProgress') === statusRank('In Progress')` — the codebase
 *     has already asserted these are the same lifecycle slot. The fold makes
 *     the store agree with the UI rather than the reverse.
 *
 * ⛔ THE EXCLUSION LIST — folds a well-meaning future editor might add. EVERY
 *    ONE OF THESE IS A STATE EDIT AND IS FORBIDDEN HERE. A test pins their
 *    absence, so adding one goes red rather than silently retyping briefs:
 *
 *   `Cancelled` → `Archived`   moves "we decided not to do this" to "we
 *                              finished it and shelved it" — opposite meanings
 *                              for a release audit.
 *   `Superseded` → `Archived`/`Done`  `Superseded` says another brief carries
 *                              the work; `Done` says the work happened.
 *   `Deferred`  → `Blocked`    `Blocked` is externally prevented; `Deferred` is
 *                              deliberately postponed.
 *   `Draft` → `Ready`, `Blocked` → `In Progress`   advance a brief through the
 *                              state machine. Categorically forbidden.
 *   `Done(Resolved…)` → `Done` not a state edit but a DATA edit: the trailing
 *                              token is a commit sha with no other copy, and
 *                              folding destroys it. Hand-migrated instead (the
 *                              payload moves into the brief's own content as a
 *                              `## Resolution` line, then the row is retyped by
 *                              hand through `igris_brief_update`).
 *   `Split (see …)` → anything THREE plausible targets (`Done`, `Archived`,
 *                              `Superseded`) and the operator chose none of
 *                              them. Picking one is the planner deciding a
 *                              brief's state. The lineage belongs in the edge
 *                              graph (`derived_from`), which is ADDITIVE and
 *                              destroys nothing; the state stays untouched.
 */
export const STATUS_ALIASES: Record<string, string> = {
  completed: 'Done',
  complete: 'Done',
  inprogress: 'In Progress',
};

/**
 * Canonical status lookup, keyed by lowercase, for idempotent case-folding
 * (`'done'` / `'  DONE  '` → `'Done'`, `'in progress'` → `'In Progress'`).
 */
const STATUS_CANONICAL: Record<string, string> = Object.fromEntries(
  CANONICAL_STATUSES.map((s) => [s.toLowerCase(), s]),
);

/**
 * Normalize a brief status to its canonical spelling.
 *
 * Known aliases (STATUS_ALIASES — `Completed`/`Complete` → `Done`,
 * `InProgress` → `In Progress`) fold, and any case/padding variant of a
 * canonical status folds to its canonical form. Unknown values pass through
 * UNCHANGED (read-widen — never drop operator data) and the caller is expected
 * to REPORT them.
 *
 * ⚠ ONE DELIBERATE ASYMMETRY WITH THE OTHER THREE NORMALIZERS, and it is a
 * SCHEMA fact rather than a style choice: `normalizePriority` / `normalizePhase`
 * / `normalizeBriefType` map the empty string to SQL NULL because their columns
 * are NULLABLE and NULL is a legitimate *unset*. **`brief_status.status` is
 * `TEXT NOT NULL`** (`db.ts`, and confirmed against the live schema). There is
 * no "unset" status — `_create` defaults to `'Ready'` — so folding `''` to NULL
 * would not canonicalise anything: it would turn a tolerated, meaningless write
 * into a NOT NULL constraint violation at the write boundary, and into a
 * SILENTLY DROPPED ROW at replication ingress (the per-row try/catch). That is a
 * hard reject, which this module's whole posture forbids. So an empty or
 * whitespace-only status passes through UNCHANGED like any other unrecognised
 * value, and `isCanonicalStatus('')` is false so the write-boundary echo names
 * it. (Residual, stated rather than hidden: `normalizeSyncRow`'s shared reporter
 * skips a stored value whose `trim()` is empty — that clause is correct for the
 * three NULLABLE fields and means an empty status arriving over SYNC is stored
 * verbatim and NOT reported. Zero such rows exist; a fixture row pins the
 * behaviour so it is visible rather than assumed.)
 *
 * `null`/`undefined` → `null` (the field was not supplied; there is nothing to
 * normalize).
 *
 * Idempotent: canonical input returns itself, and every alias TARGET is itself
 * canonical (pinned by a test), so `f(f(x)) === f(x)` holds for the whole table.
 */
export function normalizeStatus(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const key = v.trim().toLowerCase();
  // Alias fold first, then canonical case-fold, else passthrough untouched.
  // NOTE the missing `if (trimmed === '') return null` the three siblings have —
  // see the NOT NULL asymmetry above. `''` falls through to the passthrough.
  return STATUS_ALIASES[key] ?? STATUS_CANONICAL[key] ?? v;
}

/**
 * Is `v` a canonical status? Case-insensitive and trim-tolerant, so `'done'`
 * does not trigger a spurious "non-canonical" report.
 *
 * The empty string is FALSE — an offender, not an *unset*. Unlike `priority`,
 * `status` is NOT NULL and has no unset member (see `normalizeStatus`).
 */
export function isCanonicalStatus(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  return STATUS_CANONICAL[v.trim().toLowerCase()] !== undefined;
}

/**
 * The status twin of {@link nonCanonicalBriefTypeNote} (TD-333).
 *
 * `status` is the CANONICAL BUILD-STATE SOURCE and it had no observer at all:
 * 15 distinct values accumulated, including three spellings of *finished*, two
 * of *in-flight*, a status with a commit sha welded on and two whole SENTENCES.
 * Returns a NOTE for a non-canonical STORED value, or `null` when there is
 * nothing to say. Informs; never rejects, never rewrites.
 *
 * DIVERGENCE FROM THE TWO TWINS, deliberate: they return `null` for an empty
 * stored value because NULL/empty is *unset* for their nullable columns. This
 * one REPORTS it, because `status` is NOT NULL and an empty status is a broken
 * row rather than an unset field.
 *
 * @param stored - the value as normalized and written (NOT the raw input)
 */
export function nonCanonicalStatusNote(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (isCanonicalStatus(stored)) return null;
  return (
    `NOTE: status ${JSON.stringify(stored)} is not a canonical status (stored as-is).\n` +
    `      Canonical: ${CANONICAL_STATUSES.join(', ')}.\n` +
    '      Unknown values are kept, never dropped — but they are reported (TD-333).'
  );
}

// ===========================================================================
// TD-338 — REPLICATION-INGRESS NORMALIZATION
// ===========================================================================
//
// Every MCP write boundary (`igris_brief_create` / `_sync` / `_update`) folds
// these fields before storing. `mergeRows` — the row writer for BOTH sync
// ingress doors — did not, so an inbound row was copied byte-for-byte into the
// same columns the write boundary defends. TD-338 makes ingress a normalization
// boundary too, by making it read THIS map.
//
// WHY A MAP AND NOT THREE CALLS AT EACH SITE: there are two `mergeRows` copies
// (brain + CLI, separate npm packages, zero cross-imports). Three inline calls
// per site is four hand-written lists of "which fields normalize" across the
// repo — the TD-330 defect class. One exported map, read by both sites and
// GENERATED into the CLI mirror.
//
// THE FULL COST OF ADDING A NORMALIZED FIELD, stated exactly (it is not "one
// line" — that claim was corrected in review, then made true by construction):
//   1. one entry in `SYNC_NORMALIZED_FIELDS` below;
//   2. if the field needs a NEW normalizer id, its `normalizeX`/`isCanonicalX`
//      pair here, its `SYNC_NORMALIZERS` row below, and its body in
//      `NORMALIZER_BODIES` (brief-normalize-mirror.ts);
//   3. `npm run gen:brief-normalize-mirror`, plus one test.
// The mirror's `SyncNormalizerId` union and its dispatch table are DERIVED from
// this map, so they move on their own, and a mapped id with no body THROWS at
// generation time naming what to add. **But the DATA layer of the mirror is NOT
// derived**: `renderCliModule` hand-lists each canonical set and each fold map
// by name, so a NEW normalizer id also costs its `renderStringArray` /
// `renderRecord` calls, any lookup const its body reads, one push in each of
// the two fixture builders, and its seeds in the fixture corpora. TD-333 paid
// six edits in `brief-normalize-mirror.ts`, not one. The exact list is in the
// `NORMALIZER_BODIES` docstring there — read it before estimating the next one.
//
// WHAT IS DELIBERATELY ABSENT:
//   - `updated_at` — the LWW comparison column. A fold that bumped it would
//     manufacture a write no operator made and make folded rows fight an
//     un-migrated remote. Its absence from this map is what makes the fold
//     non-oscillating, and it is asserted by a test, not trusted to this
//     comment (`sync-ingress-normalize.test.ts`).
//   (`status` used to be listed here as "absent until TD-333 ships
//   `normalizeStatus`". TD-333 shipped: it is now in the map above, and it is
//   the FOURTH normalizer id. What that brief actually cost in the mirror
//   builder is recorded in the `NORMALIZER_BODIES` docstring — the "one line
//   plus one body" figure above is true of the LOGIC layer and undercounts the
//   DATA layer by five edits.)
//   - `sessions.phase` — `sessions` is an append-strategy table (insert-only,
//     no LWW update) with no observed drift, and MAINTAINING row 64 scopes the
//     phase vocabulary contract to `brief_status`.
//   - `title` / `effort` — free text with no canonical vocabulary to fold to.

/**
 * Stable normalizer id. The generated CLI mirror dispatches on this string —
 * and DERIVES its own copy of this union from the values used in
 * `SYNC_NORMALIZED_FIELDS`, so only this declaration is hand-maintained.
 */
export type SyncNormalizerId = 'priority' | 'brief_type' | 'phase' | 'status';

/**
 * Which synced columns pass through a write-boundary normalizer on INGRESS,
 * per table. Table names are `SYNC_TABLES` table names; a table absent from
 * this map is copied verbatim, exactly as before TD-338.
 *
 * THE SINGLE EXTENSION POINT for WHICH COLUMNS fold. Adding a field that reuses
 * an existing normalizer id really is one entry here plus a regeneration; a
 * field needing a NEW id also needs its normalizer pair, its `SYNC_NORMALIZERS`
 * row, and its body in the mirror builder — see the header block above for the
 * full, exact cost.
 */
export const SYNC_NORMALIZED_FIELDS: Record<string, Record<string, SyncNormalizerId>> = {
  brief_status: {
    brief_type: 'brief_type',
    priority: 'priority',
    phase: 'phase',
    status: 'status',
  },
};

/** A normalizer + its canonicality predicate, resolved from a normalizer id. */
interface SyncNormalizerEntry {
  normalize(v: string | null | undefined): string | null;
  isCanonical(v: string | null | undefined): boolean;
}

const SYNC_NORMALIZERS: Record<SyncNormalizerId, SyncNormalizerEntry> = {
  priority: { normalize: normalizePriority, isCanonical: isCanonicalPriority },
  brief_type: { normalize: normalizeBriefType, isCanonical: isCanonicalBriefType },
  phase: { normalize: normalizePhase, isCanonical: isCanonicalPhase },
  status: { normalize: normalizeStatus, isCanonical: isCanonicalStatus },
};

/** One field folded on ingress: what it arrived as, what was stored. */
export interface SyncFieldFold {
  field: string;
  from: string;
  to: string | null;
}

/** One field that arrived non-canonical and was stored AS-IS (never folded). */
export interface SyncFieldPassthrough {
  field: string;
  value: string;
}

/** The result of normalizing one inbound sync row. */
export interface SyncRowNormalizeResult {
  /**
   * The row to store. **The SAME object** as the input when nothing folded, so
   * an unmapped table (or a already-canonical row) costs one map lookup and no
   * allocation on the hot full-re-pull path.
   */
  row: Record<string, unknown>;
  /** Fields whose stored value differs from the inbound value. */
  folds: SyncFieldFold[];
  /** Fields stored verbatim whose value is not canonical (the observer). */
  nonCanonical: SyncFieldPassthrough[];
}

const NO_FOLDS: SyncFieldFold[] = [];
const NO_PASSTHROUGHS: SyncFieldPassthrough[] = [];

/**
 * Fold an inbound replication row through the write-boundary normalizers.
 *
 * FOLD-KNOWN / PASSTHROUGH-UNKNOWN / REPORT-BOTH — the same total function the
 * remote's own write boundary would have applied had it been running current
 * code. `PRIORITY_ALIASES` declares `P1 ≡ P1-High`; folding a declared synonym
 * destroys nothing the fold table does not already call synonymous. An UNKNOWN
 * value (`P4-Trivial`, `Spike`) is stored verbatim and REPORTED — the fold
 * never invents (the reasoning TD-328 used to refuse folding `Spike`).
 *
 * Idempotent, because every underlying normalizer is: `f(f(x)) === f(x)`, so a
 * row that arrives twice folds to the same value both times.
 *
 * @param table - the SYNC_TABLES table name the row belongs to
 * @param row   - the inbound wire row (never mutated)
 */
export function normalizeSyncRow(
  table: string,
  row: Record<string, unknown>,
): SyncRowNormalizeResult {
  const fields = SYNC_NORMALIZED_FIELDS[table];
  if (!fields) return { row, folds: NO_FOLDS, nonCanonical: NO_PASSTHROUGHS };

  let out = row;
  let folds: SyncFieldFold[] | null = null;
  let nonCanonical: SyncFieldPassthrough[] | null = null;

  for (const field of Object.keys(fields)) {
    const raw = row[field];
    // Column absent from this payload — the INSERT branch filters on
    // `!== undefined`, so introducing the key here would widen the INSERT.
    if (raw === undefined) continue;
    // Defensive: a non-string, non-null value is not ours to normalize. Leave
    // it for the row-level try/catch to reject at bind time if it is unbindable.
    if (raw !== null && typeof raw !== 'string') continue;

    const entry = SYNC_NORMALIZERS[fields[field]];
    const next = entry.normalize(raw);

    if (next !== raw) {
      if (out === row) out = { ...row };
      out[field] = next;
      (folds ??= []).push({ field, from: raw as string, to: next });
    }

    // Report the STORED value, not the inbound one. NULL/empty is *unset*, not
    // an offender — the dashboard renders NULL as "Unset".
    if (next !== null && next.trim() !== '' && !entry.isCanonical(next)) {
      (nonCanonical ??= []).push({ field, value: next });
    }
  }

  return {
    row: out,
    folds: folds ?? NO_FOLDS,
    nonCanonical: nonCanonical ?? NO_PASSTHROUGHS,
  };
}
