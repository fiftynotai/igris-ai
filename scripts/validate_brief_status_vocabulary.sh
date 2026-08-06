#!/bin/bash
set -e

# Description: brief_status.status vocabulary validator (TD-333). Read-only
#   check that reports the `brief_status.status` distribution and names every
#   value that is NOT one of the canonical statuses.
#
#   The THIRD twin of scripts/validate_brief_type_vocabulary.sh (TD-328) and
#   scripts/validate_brief_priority_vocabulary.sh (TD-338) — same header
#   convention, env overrides, fail-open posture and exit-code contract. Wired
#   into scripts/git-hooks/pre-commit as WARN-only.
#
# WHY THIS EXISTS, and why it matters more than its two siblings:
#   `brief_status.status` is THE CANONICAL BUILD-STATE SOURCE — the single
#   authoritative answer to "is this brief built?" (#811 / TD-257,
#   docs/architecture/brief-state-source-of-truth.md). It is the field a
#   release gate, a phase guard, a brief gate, four different terminal-set
#   definitions inside the brain and every audit agent read. And until TD-333
#   it had NO normalizer and NO observer at all.
#
#   The result, measured read-only across all projects on 2026-08-04: FIFTEEN
#   distinct values for six documented states — including THREE spellings of
#   *finished* (`Done` 1212 / `Completed` 24 / `Complete` 1), TWO of *in flight*
#   (`In Progress` 26 / `InProgress` 4), a status with a commit sha welded onto
#   it, and two whole SENTENCES recording a brief's split lineage.
#
#   Read-widen is a TOLERANCE policy, not a SILENCE policy (TD-328's finding).
#   This validator is the accumulation observer; the write-boundary echo in
#   brain-mcp-server/src/tools/briefs.ts catches the MINTING of a new spelling.
#
# THE TWO OFFENDER CLASSES — and why the output SPLITS them:
#   A standing WARN that lumps a known, decided gap together with a genuinely
#   stray value trains the reader to ignore both. So:
#
#   (1) DOCUMENTED GAP — `Cancelled` / `Superseded` / `Deferred`. These are
#       MISSING STATES, not spellings: each names an outcome the documented six
#       cannot express. TD-333 deliberately did NOT fold them (folding
#       `Cancelled` to `Archived` moves "we decided not to do this" to "we
#       finished it and shelved it" — a STATE EDIT, which TD-311 forbids) and
#       deliberately did NOT promote them (that changes the documented
#       lifecycle and sweeps board.ts, this array and the reconciler's
#       terminal-set reasoning — "changing the state machine itself", out of
#       TD-333's scope). They are reported ON PURPOSE, every run, until the
#       follow-up brief decides. Their resolution path is named below.
#
#   (2) STRAY — anything else. A new spelling nobody has classified, an empty
#       status, or an operator note written into the state field. These want a
#       human NOW.
#
# CANONICAL SET: must stay element-identical to CANONICAL_STATUSES in
#   brain-mcp-server/src/tools/brief-normalize.ts. This is the THIRD bash mirror
#   of a TS canonical array. CANONICAL_PHASES (TD-257) and CANONICAL_BRIEF_TYPES
#   (TD-330) BOTH have element-identical parity guards; this pair and the
#   priority pair have only element-COUNT checks in their bats suites — which
#   see an add or a delete but CANNOT see a rename or a swap of two members.
#   Upgrading these two is TD-356. There is no build step generating one from
#   the other, so until then this remains partly a two-file edit you have to
#   remember.
#
#   `status` is `TEXT NOT NULL`, so unlike `priority` there is NO unset family:
#   a NULL or an empty status is an OFFENDER (class 2), not an "unset".
#
# Usage: scripts/validate_brief_status_vocabulary.sh
# Env overrides (test injection):
#   BRAIN_DB   override brain DB path (default: ~/.igris/memory/knowledge.db)
#   PROJECT    override the project slug to query. Unset/empty => ALL projects
#              (accumulation is a cross-project problem: a stray spelling minted
#              in any project ends up in the same dashboard filter — and the
#              TD-257 reconciler is repo-scoped, so it structurally CANNOT see
#              a project whose repo is not on this machine).
# Exit codes:
#   0 - Every value is canonical, OR fail-open (sqlite3/DB absent, no rows).
#   1 - One or more non-canonical values present (either class). The pre-commit
#       hook block decides WARN vs block — TD-333 ships it as WARN.

BRAIN_DB="${BRAIN_DB:-$HOME/.igris/memory/knowledge.db}"
PROJECT="${PROJECT:-}"

# --- Canonical status set (the SHARED CONSTANT) ------------------------------
# MUST match CANONICAL_STATUSES in
# brain-mcp-server/src/tools/brief-normalize.ts element-for-element and in the
# SAME ORDER. The source of the six is the documented lifecycle at
# docs/architecture/brief-state-source-of-truth.md, which
# cli/dashboard/src/layers/board.ts also mirrors as KNOWN_BRIEF_STATUSES.
# TD-333 normalises the vocabulary; it does NOT widen this set.
CANONICAL_STATUSES=(
  "Draft"
  "Ready"
  "In Progress"
  "Blocked"
  "Done"
  "Archived"
)
export CANONICAL_STATUSES

# --- The DOCUMENTED GAP values (TD-333 class 1) -------------------------------
# Non-canonical BY DECISION, not by oversight. Each names an outcome the
# documented six cannot express. Reported separately so a standing, expected
# WARN never hides a genuinely stray value.
DOCUMENTED_GAP_STATUSES=(
  "Cancelled"
  "Superseded"
  "Deferred"
)
export DOCUMENTED_GAP_STATUSES

# The follow-up that resolves class 1. FILED as TD-342 — it also owns the two
# operator-only rows this validator names (the welded commit sha on
# fifty_eco_system/BR-128, and the two `Split (…)` sentence statuses whose
# lineage belongs in derived_from edges).
GAP_FOLLOW_UP="TD-342 — the documented brief lifecycle has six states; the brain \
uses nine. Promote Cancelled / Superseded / Deferred, or document them as \
deliberately non-canonical. Folding them would change which state a brief is IN, \
which TD-311 forbids as a data migration."

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

# NULL and EMPTY get SENTINELS rather than falling out of the read loop. The
# priority/brief_type twins skip an empty first field with `[ -n "$value" ]`,
# which would make an empty status — an offender for a NOT NULL column —
# INVISIBLE to the very report that exists to name it.
rows="$(sqlite3 -separator '|' "$BRAIN_DB" \
  "SELECT CASE
            WHEN status IS NULL THEN '<NULL>'
            WHEN TRIM(status) = '' THEN '<EMPTY>'
            ELSE status
          END, COUNT(*) FROM brief_status
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
  local candidate="$1" s
  for s in "${CANONICAL_STATUSES[@]}"; do
    [ "$candidate" = "$s" ] && return 0
  done
  return 1
}

is_documented_gap() {
  local candidate="$1" s
  for s in "${DOCUMENTED_GAP_STATUSES[@]}"; do
    [ "$candidate" = "$s" ] && return 0
  done
  return 1
}

distribution=""
gap_offenders=""
stray_offenders=""
gap_count=0
gap_rows=0
stray_count=0
stray_rows=0
total_rows=0

while IFS='|' read -r value count; do
  [ -n "$value" ] || continue
  total_rows=$((total_rows + count))
  distribution+="  $(printf '%6s' "$count")  $value"$'\n'

  if is_canonical "$value"; then
    continue
  fi

  if is_documented_gap "$value"; then
    gap_offenders+="  DOCUMENTED GAP: \"$value\" ($count row(s))"$'\n'
    gap_count=$((gap_count + 1))
    gap_rows=$((gap_rows + count))
  else
    stray_offenders+="  STRAY: \"$value\" ($count row(s))"$'\n'
    stray_count=$((stray_count + 1))
    stray_rows=$((stray_rows + count))
  fi
done <<< "$rows"

echo "status vocabulary ($SCOPE): $total_rows row(s)"
echo "Distribution:"
printf '%s' "$distribution"

if [ "$gap_count" -eq 0 ] && [ "$stray_count" -eq 0 ]; then
  echo ""
  echo "OK: status vocabulary clean ($SCOPE) — every value is canonical"
  exit 0
fi

echo ""
echo "status vocabulary: $((gap_count + stray_count)) non-canonical value(s), $((gap_rows + stray_rows)) row(s)"
echo "Canonical statuses: ${CANONICAL_STATUSES[*]}"

if [ "$gap_count" -gt 0 ]; then
  echo ""
  echo "CLASS 1 — DOCUMENTED GAP ($gap_count value(s), $gap_rows row(s)). Expected; decided; NOT a new problem."
  printf '%s' "$gap_offenders"
  echo "  These name outcomes the documented six cannot express. TD-333 refused to"
  echo "  FOLD them (adjacency is a STATE EDIT, and TD-311 forbids resolving brief"
  echo "  state by editing brief data) and refused to PROMOTE them (that changes the"
  echo "  documented lifecycle and sweeps board.ts, this validator's array and the"
  echo "  reconciler's terminal-set reasoning)."
  echo "  RESOLUTION -> $GAP_FOLLOW_UP"
fi

if [ "$stray_count" -gt 0 ]; then
  echo ""
  echo "CLASS 2 — STRAY ($stray_count value(s), $stray_rows row(s)). Wants a human now."
  printf '%s' "$stray_offenders"
  echo "  Resolve each value:"
  echo "  - an unambiguous SPELLING of a canonical status -> add it to STATUS_ALIASES in"
  echo "    brain-mcp-server/src/tools/brief-normalize.ts, regenerate the CLI mirror"
  echo "    (npm run gen:brief-normalize-mirror in brain-mcp-server/) AND fold it in a NEW"
  echo "    migration version (never edit a shipped one). Read the exclusion list in that"
  echo "    file first: a target whose meaning is merely ADJACENT is a state edit."
  echo "  - a value carrying a PAYLOAD (a commit sha, a list of child brief ids) -> the"
  echo "    payload belongs in the brief's content or in the edge graph, never in the state"
  echo "    field. Move it first, then RETYPE the brief by hand via igris_brief_update."
  echo "  - <EMPTY> / <NULL> -> brief_status.status is TEXT NOT NULL and has no unset"
  echo "    member; retype the brief."
  echo "  - values are NEVER rejected at the write boundary or at sync ingress; this report"
  echo "    is the observer that keeps read-widen from becoming permanent silence."
fi

exit 1
