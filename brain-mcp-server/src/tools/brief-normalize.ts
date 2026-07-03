/**
 * Igris Brain -- Brief Metadata Normalization (TD-238)
 *
 * Canonicalizes the three free-text metadata fields written at the brief
 * write boundaries (`igris_brief_sync` / `_create` / `_update`):
 *   - phase
 *   - priority
 *   - brief_type
 *
 * Design posture (insert-narrow / read-widen — memory #228):
 *   These helpers NORMALIZE; they do NOT hard-reject. Known legacy forms are
 *   folded to their canonical spelling; UNKNOWN values pass through unchanged.
 *   A hard reject at the write boundary would break a legacy caller mid-
 *   transition and could silently drop operator data — so the conservative
 *   posture is to canonicalize what we recognize and let everything else
 *   through. Reads stay tolerant; writes get cleaner over time.
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
 * Canonical brief types — keyed to the register brief-id prefixes + their
 * template titles. Unknown types pass through unchanged (read-widen).
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
 * brief_type alias fold map (legacy form → canonical form). Keys matched
 * case-insensitively against the trimmed input.
 */
const BRIEF_TYPE_ALIASES: Record<string, string> = {
  'tech debt': 'Technical Debt',
  'bug fix': 'Bug',
};

/**
 * Canonical brief_type lookup, keyed by lowercase, for idempotent
 * case-folding (e.g. "technical debt" → "Technical Debt").
 */
const BRIEF_TYPE_CANONICAL: Record<string, string> = Object.fromEntries(
  CANONICAL_BRIEF_TYPES.map((t) => [t.toLowerCase(), t]),
);

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
 * Known aliases (`Tech Debt` → `Technical Debt`, `Bug Fix` → `Bug`) fold to
 * canonical, and any case variant of a canonical type folds to its canonical
 * casing (`technical debt` → `Technical Debt`). Unknown values pass through
 * UNCHANGED (read-widen — do not drop operator data). null/undefined/empty →
 * null.
 *
 * Idempotent: canonical input returns itself.
 */
export function normalizeBriefType(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  // Alias fold first, then canonical case-fold, else passthrough untouched.
  return BRIEF_TYPE_ALIASES[key] ?? BRIEF_TYPE_CANONICAL[key] ?? v;
}
