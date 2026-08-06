#!/bin/bash
set -e

# Description: brief_type vocabulary validator (TD-328). Read-only check that
#   reports the `brief_status.brief_type` distribution and names every value
#   that is NOT one of the canonical types.
#
#   Modeled on scripts/validate_brief_state_reconciliation.sh (header
#   convention, env overrides, fail-open posture, exit-code contract) and on the
#   phase-guard's brain-DB read idiom in scripts/git-hooks/pre-commit
#   (single-quote-escape interpolated SQL, fail-open when sqlite3/DB absent).
#
# WHY THIS EXISTS (the half of memory #228 that was missing):
#   `brief_type` is insert-narrow / read-widen — the write boundary NORMALIZES
#   known spellings and lets unknown values through rather than hard-rejecting
#   (a reject would break a legacy caller mid-transition and could drop operator
#   work that has no retry path). The old code comment claimed "writes get
#   cleaner over time". The live data falsified it: 50 distinct non-NULL
#   spellings accumulated for ~10 concepts, because TOLERANCE WITHOUT
#   OBSERVATION HAS NO GRADIENT. Read-widen is a tolerance policy, not a silence
#   policy — so the widening needs an observer. There are two:
#     - the WRITE-BOUNDARY ECHO (brain-mcp-server/src/tools/briefs.ts) catches
#       the MINTING of a new spelling, in whichever harness is running;
#     - THIS VALIDATOR catches ACCUMULATION — a spelling that arrived via remote
#       sync or an older client, where nobody saw the echo.
#
# CANONICAL SET: must stay element-identical to CANONICAL_BRIEF_TYPES in
#   brain-mcp-server/src/tools/brief-normalize.ts. There is no build step
#   generating one from the other (the same shape as the CANONICAL_PHASES /
#   validate_brief_state_reconciliation.sh pair), so do NOT hand-edit one copy
#   without the other.
#
#   THE GAP IS CLOSED (TD-330). The bats trio only SPOT-CHECKED that the TD-328
#   additions were present on both sides — it could not catch a 13th type added
#   to the TS array, a removal of one of the nine pre-existing members, or an
#   order change, and all three were measured passing silently.
#   test/validate_brief_type_parity.test.bash now extracts BOTH definitions and
#   asserts element-identity IN ORDER, the same shape as the CANONICAL_PHASES
#   guard (test/validate_canonical_phase_parity.test.bash). Edit one copy
#   without the other and it goes red.
#
#   The array below is the OBSERVER; the TS export is the OWNER (the executable
#   path imports it). If they disagree, this file follows.
#
# Usage: scripts/validate_brief_type_vocabulary.sh
# Env overrides (test injection):
#   BRAIN_DB   override brain DB path (default: ~/.igris/memory/knowledge.db)
#   PROJECT    override the project slug to query. Unset/empty => ALL projects
#              (accumulation is a cross-project problem: a stray spelling minted
#              in any project ends up in the same dashboard filter).
# Exit codes:
#   0 - Every non-NULL value is canonical, OR fail-open (sqlite3/DB absent, no
#       rows).
#   1 - One or more non-canonical values present. The pre-commit hook block
#       decides WARN vs block — TD-328 ships it as WARN.

BRAIN_DB="${BRAIN_DB:-$HOME/.igris/memory/knowledge.db}"
PROJECT="${PROJECT:-}"

# --- Canonical brief_type set (the SHARED CONSTANT) --------------------------
# MUST match CANONICAL_BRIEF_TYPES in
# brain-mcp-server/src/tools/brief-normalize.ts element-for-element.
#
# The defining rule: the canonical set is the image of the /register brief-ID
# prefix map (core/skills/register/SKILL.md §2) union {Documentation}.
#   UNGUARDED COPY (TD-357): this prose map is one of six copies of the mint
#   mapping and nothing pins it — corrupting a line here leaves the suite green
#   (measured). The CANONICAL_BRIEF_TYPES array below IS pinned
#   (test/validate_brief_type_parity.test.bash); this comment is not.
#
#   BR -> Bug           FR -> Feature   MG -> Migration   TD -> Technical Debt
#     (BR is 1:1 since TD-331; `feature` mints FR-. Rows typed literally `BR`
#      predate that and stay ambiguous — see brief-type-vocabulary.md)
#   TS -> Testing       PI -> Process Improvement         DU -> Dependency Update
#   PF -> Performance   AC -> Architecture                (none) -> Documentation
#
# DELIBERATE EXCEPTION: `Refactor` is canonical WITHOUT a mint prefix. It was
# promoted on MEASURED evidence, not on the prefix rule — only 19 of its 46 live
# rows (41%) carried a TD- prefix, below the 70% flip criterion, and the BR-
# titles read as genuine refactor work minted under BR- only because no refactor
# prefix exists. The operator DECLINED adding an RF- prefix. DO NOT "correct"
# this back by applying the prefix rule mechanically.
CANONICAL_BRIEF_TYPES=(
  "Feature"
  "Bug"
  "Migration"
  "Technical Debt"
  "Testing"
  "Process Improvement"
  "Documentation"
  "Acceptance"
  "Performance"
  "Architecture"
  "Dependency Update"
  "Refactor"
)
export CANONICAL_BRIEF_TYPES

# D4 escalation tripwire — if compound values (a second fact crammed into the
# single-value field, e.g. "Bug Fix / Compliance") ever exceed EITHER threshold,
# file the `brief_subtype` column brief. Recorded here and in
# core/enforcement/brief-type-vocabulary.md so the deferral is a tripwire rather
# than an omission.
COMPOUND_ROW_THRESHOLD=25
COMPOUND_PCT_THRESHOLD=5

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
  "SELECT COALESCE(brief_type, '<NULL>'), COUNT(*) FROM brief_status
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
  local candidate="$1" t
  for t in "${CANONICAL_BRIEF_TYPES[@]}"; do
    [ "$candidate" = "$t" ] && return 0
  done
  return 1
}

distribution=""
offenders=""
offender_count=0
offender_rows=0
compound_rows=0
total_rows=0
null_rows=0

while IFS='|' read -r value count; do
  [ -n "$value" ] || continue
  total_rows=$((total_rows + count))
  distribution+="  $(printf '%6s' "$count")  $value"$'\n'

  if [ "$value" = "<NULL>" ]; then
    null_rows=$((null_rows + count))
    continue
  fi

  # A compound crams a second fact into the field (a '/' separator or a
  # parenthesised qualifier). Counted for the escalation tripwire.
  case "$value" in
    */*|*\(*) compound_rows=$((compound_rows + count)) ;;
  esac

  if ! is_canonical "$value"; then
    offenders+="  NON-CANONICAL: \"$value\" ($count row(s))"$'\n'
    offender_count=$((offender_count + 1))
    offender_rows=$((offender_rows + count))
  fi
done <<< "$rows"

echo "brief_type vocabulary ($SCOPE): $total_rows row(s), $null_rows with no type"
echo "Distribution:"
printf '%s' "$distribution"

# --- D4 escalation tripwire ---------------------------------------------------
if [ "$total_rows" -gt 0 ]; then
  compound_pct=$(( compound_rows * 100 / total_rows ))
  if [ "$compound_rows" -gt "$COMPOUND_ROW_THRESHOLD" ] || \
     [ "$compound_pct" -gt "$COMPOUND_PCT_THRESHOLD" ]; then
    echo ""
    echo "D4 ESCALATION TRIPWIRE: $compound_rows compound value row(s) (${compound_pct}% of corpus)"
    echo "  exceeds the >${COMPOUND_ROW_THRESHOLD}-row / >${COMPOUND_PCT_THRESHOLD}% threshold."
    echo "  FILE THE brief_subtype COLUMN BRIEF — the field is now carrying two facts at scale."
    echo "  See core/enforcement/brief-type-vocabulary.md."
  fi
fi

if [ "$offender_count" -gt 0 ]; then
  echo ""
  echo "brief_type vocabulary: $offender_count non-canonical value(s), $offender_rows row(s)"
  printf '%s' "$offenders"
  echo ""
  echo "Canonical types: ${CANONICAL_BRIEF_TYPES[*]}"
  echo "Resolve each value:"
  echo "  - an unambiguous SPELLING of a canonical type -> add it to BRIEF_TYPE_ALIASES in"
  echo "    brain-mcp-server/src/tools/brief-normalize.ts AND fold it in a NEW migration"
  echo "    version (never edit a shipped one), then re-run"
  echo "    npx tsx brain-mcp-server/scripts/normalize_brief_types.ts"
  echo "  - a genuinely NEW kind of work -> add the /register mint prefix and the canonical"
  echo "    type together (the two sets move as one), or retype the brief by hand"
  echo "  - values are NEVER rejected at the write boundary; this report is the observer"
  echo "    that keeps read-widen from becoming permanent silence."
  exit 1
fi

echo ""
echo "OK: brief_type vocabulary clean ($SCOPE) — every non-NULL value is canonical"
exit 0
