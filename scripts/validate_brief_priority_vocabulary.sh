#!/bin/bash
set -e

# Description: brief_priority vocabulary validator (TD-338). Read-only check
#   that reports the `brief_status.priority` distribution and names every value
#   that is NOT one of the canonical priorities.
#
#   The priority TWIN of scripts/validate_brief_type_vocabulary.sh (TD-328) —
#   same header convention, env overrides, fail-open posture and exit-code
#   contract. Wired into scripts/git-hooks/pre-commit as WARN-only.
#
# WHY THIS EXISTS:
#   `priority` is insert-narrow / read-widen exactly like `brief_type`: the
#   write boundary NORMALIZES known spellings (`P1` -> `P1-High`) and lets
#   unknown values through rather than hard-rejecting. But unlike `brief_type`
#   it had NO OBSERVER AT ALL. The TD-328 write-boundary echo covers brief_type
#   only, and there was no repo validator, so a `P4-Trivial` could sit in the
#   corpus indefinitely with nothing naming it — which is precisely what
#   happened (1 row, fifty-agent-sdk TD-002, minted 2026-07-30 and unnoticed
#   until a hand-written census found it).
#
#   Read-widen is a TOLERANCE policy, not a SILENCE policy. TD-338 gives
#   priority the observer brief_type already had.
#
# WHAT IT DOES *NOT* DO — read this before "fixing" a P4-Trivial report:
#   `P4-Trivial` is REPORTED, deliberately NOT adopted and NOT folded.
#     - ADOPTING it (adding a 5th canonical priority) triggers the FR-247
#       dashboard-picker mirror sweep (MAINTAINING row 66) — a permanent
#       vocabulary change for one row of unknown provenance.
#     - FOLDING it to `P3-Low` would be INVENTING. No fold table says
#       `Trivial` = `Low`. This is the same reasoning TD-328 used to refuse
#       folding `Spike`/`Investigation`.
#   The correct resolution is a HUMAN retyping the brief via
#   `igris_brief_update`, which canonicalises it as a side effect of a correct
#   write (and bumps `updated_at`, so it also heals an un-migrated remote).
#
# CANONICAL SET: must stay element-identical to CANONICAL_PRIORITIES in
#   brain-mcp-server/src/tools/brief-normalize.ts. NULL is the *unset* family
#   and is NOT an offender — the dashboard renders NULL as "Unset", and
#   normalizePriority maps '' / whitespace / 'Unset' to SQL NULL by design.
#
# Usage: scripts/validate_brief_priority_vocabulary.sh
# Env overrides (test injection):
#   BRAIN_DB   override brain DB path (default: ~/.igris/memory/knowledge.db)
#   PROJECT    override the project slug to query. Unset/empty => ALL projects
#              (accumulation is a cross-project problem: a stray value minted in
#              any project ends up in the same dashboard filter).
# Exit codes:
#   0 - Every non-NULL value is canonical, OR fail-open (sqlite3/DB absent, no
#       rows).
#   1 - One or more non-canonical values present. The pre-commit hook block
#       decides WARN vs block — TD-338 ships it as WARN.

BRAIN_DB="${BRAIN_DB:-$HOME/.igris/memory/knowledge.db}"
PROJECT="${PROJECT:-}"

# --- Canonical priority set (the SHARED CONSTANT) ----------------------------
# MUST match CANONICAL_PRIORITIES in
# brain-mcp-server/src/tools/brief-normalize.ts element-for-element.
# FOUR values plus SQL NULL (the unset family). There is no fifth.
CANONICAL_PRIORITIES=(
  "P0-Critical"
  "P1-High"
  "P2-Medium"
  "P3-Low"
)
export CANONICAL_PRIORITIES

# --- Fail-open: never break commits in projects that don't use the workflow --
if ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$BRAIN_DB" ]; then
  exit 0
fi

# --- Query the store (read-only) ---------------------------------------------
# $PROJECT is a slug (env override) — single-quote-escape it (doubling any
# embedded quote) before interpolation so a stray quote cannot break the SQL,
# matching the phase-guard idiom.
if [ -n "$PROJECT" ]; then
  PROJECT_SQL="${PROJECT//\'/\'\'}"
  WHERE="WHERE project='$PROJECT_SQL'"
  SCOPE="project '$PROJECT'"
else
  WHERE=""
  SCOPE="all projects"
fi

rows="$(sqlite3 -separator '|' "$BRAIN_DB" \
  "SELECT COALESCE(priority, '<NULL>'), COUNT(*) FROM brief_status
     $WHERE
     GROUP BY 1
     ORDER BY 2 DESC, 1;" \
  2>/dev/null || true)"

# Fail-open on no rows (empty DB / unmigrated project / wrong project slug).
if [ -z "$rows" ]; then
  exit 0
fi

# --- Classify each distinct value --------------------------------------------
is_canonical() {
  local candidate="$1" p
  for p in "${CANONICAL_PRIORITIES[@]}"; do
    [ "$candidate" = "$p" ] && return 0
  done
  return 1
}

distribution=""
offenders=""
offender_count=0
offender_rows=0
total_rows=0
null_rows=0

while IFS='|' read -r value count; do
  [ -n "$value" ] || continue
  total_rows=$((total_rows + count))
  distribution+="  $(printf '%6s' "$count")  $value"$'\n'

  # NULL is *unset*, not an offender. normalizePriority folds the whole unset
  # family (''/whitespace/'Unset') to SQL NULL on purpose.
  if [ "$value" = "<NULL>" ]; then
    null_rows=$((null_rows + count))
    continue
  fi

  if ! is_canonical "$value"; then
    offenders+="  NON-CANONICAL: \"$value\" ($count row(s))"$'\n'
    offender_count=$((offender_count + 1))
    offender_rows=$((offender_rows + count))
  fi
done <<< "$rows"

echo "priority vocabulary ($SCOPE): $total_rows row(s), $null_rows unset (NULL)"
echo "Distribution:"
printf '%s' "$distribution"

if [ "$offender_count" -gt 0 ]; then
  echo ""
  echo "priority vocabulary: $offender_count non-canonical value(s), $offender_rows row(s)"
  printf '%s' "$offenders"
  echo ""
  echo "Canonical priorities: ${CANONICAL_PRIORITIES[*]} (or NULL for unset)"
  echo "Resolve each value:"
  echo "  - an unambiguous SPELLING of a canonical priority -> add it to PRIORITY_ALIASES in"
  echo "    brain-mcp-server/src/tools/brief-normalize.ts, regenerate the CLI mirror"
  echo "    (npm run gen:brief-normalize-mirror in brain-mcp-server/) AND fold it in a NEW"
  echo "    migration version (never edit a shipped one)"
  echo "  - a value with NO canonical target (e.g. P4-Trivial) -> RETYPE the brief by hand via"
  echo "    igris_brief_update. Do NOT fold it to a neighbour (that is inventing) and do NOT"
  echo "    adopt it as a 5th canonical value without the FR-247 picker mirror sweep"
  echo "    (MAINTAINING row 66)"
  echo "  - values are NEVER rejected at the write boundary or at sync ingress; this report is"
  echo "    the observer that keeps read-widen from becoming permanent silence."
  exit 1
fi

echo ""
echo "OK: priority vocabulary clean ($SCOPE) — every non-NULL value is canonical"
exit 0
