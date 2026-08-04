#!/bin/bash
set -e

# Description: Brief-state reconciliation validator (TD-257). Read-only check
#   that flags contradictions between the canonical build-state source
#   (brief_status.status in the brain DB), the supporting phase field
#   (brief_status.phase), and physical ground truth (a closing commit in
#   git log). Surfaces the status<->phase<->git invariant violations C1/C2/C3.
#
#   Modeled on scripts/validate_brain_stewardship_enums.sh (header convention,
#   env overrides, exit-code contract) and on the phase-guard's brain-DB read
#   idiom in scripts/git-hooks/pre-commit (single-quote-escape interpolated
#   SQL, fail-open when sqlite3/DB absent).
#
#   The canonical source of truth is brief_status.status. Plan docs describe
#   INTENT, never build-state — this validator never reads plan docs.
#   See docs/architecture/brief-state-source-of-truth.md.
#
# The invariant (per TD-257 Goal #2):
#   status IN ('Done','Archived')  <=>  phase = 'COMPLETE'  <=>  a closing
#   commit referencing the brief exists in git log.
#
# Contradiction classes flagged:
#   C1 Done-but-not-COMPLETE: status='Done' (or 'Archived') AND phase != 'COMPLETE'.
#   C2 Done-but-no-commit:    status='Done' (or 'Archived') AND no commit in
#                             git log references the brief id.
#   C3 committed-but-open:    a closing commit exists for the brief AND
#                             status IN ('Ready','Draft') (the #811 inverse —
#                             committed work the store still calls unbuilt).
#
# In-flight briefs satisfy the invariant vacuously and are NOT flagged: a
# brief mid-hunt is correctly 'In Progress'/phase='BUILDING' with no commit
# yet. The invariant only fires for TERMINAL states.
#
# TD-333 — WHAT COUNTS AS A TERMINAL STATUS HERE:
#   The `case` below folds NOTATION (case, space, hyphen, underscore — the same
#   fold TD-340 applied in portable SQL at the five gate sites) and names the
#   two retained VOCABULARY synonyms `completed`/`complete`. Before TD-333 it
#   matched three bare literals, so 26 terminal rows spelled `Completed` /
#   `Complete` / `Done(Resolvedbydec8d1f)` fell to the default arm — commented
#   "other in-flight states", which was FALSE for every one of them — and were
#   exempt from this invariant for their entire lifetime.
#
#   EXPECT THE C1/C2 COUNTS TO RISE the first time this runs against a corpus
#   that still holds those spellings. That is the exemption closing, not a
#   regression: every contradiction it surfaces was already true. The rows are
#   then handed to a human, which is what TD-311 requires — this validator
#   never edits brief state, and neither did the TD-333 fold that made the
#   spellings uniform.
#
# Usage: scripts/validate_brief_state_reconciliation.sh
# Env overrides (test injection):
#   BRAIN_DB   override brain DB path (default: ~/.igris/memory/knowledge.db)
#   REPO_DIR   override git repo to scan for closing commits
#              (default: the repo containing this script)
#   PROJECT    override the project slug to query
#              (default: basename of REPO_DIR)
# Exit codes:
#   0 - No contradictions (clean), OR fail-open (sqlite3/DB absent, no rows).
#   1 - One or more contradictions (C1/C2/C3) detected. The pre-commit hook
#       block decides WARN vs block — TD-257 ships it as WARN.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Env overrides for test injection. BRAIN_DB / REPO_DIR / PROJECT mirror the
# phase-guard's brain-DB read inputs so a bats fixture can point this at a
# throwaway DB + git repo.
BRAIN_DB="${BRAIN_DB:-$HOME/.igris/memory/knowledge.db}"
REPO_DIR="${REPO_DIR:-$REPO_ROOT}"
PROJECT="${PROJECT:-$(basename "$REPO_DIR")}"

# --- Canonical phase enum (the SHARED CONSTANT) ------------------------------
# This is the single definition of the valid brief phase set. TD-257 defines it
# here for READING (the reconciliation invariant); TD-238 will source it for
# WRITING (write-time phase validation at the igris_brief_sync boundary). The
# terminal phase is COMPLETE; the invariant pivots on it.
# Source of truth confirmed in core/skills/hunt/SKILL.md (state-machine table).
CANONICAL_PHASES=(INIT PLANNING APPROVAL BUILDING TESTING REVIEWING DOCUMENTING COMMITTING COMPLETE BLOCKED)
TERMINAL_PHASE="COMPLETE"
# (CANONICAL_PHASES is exported as documentation of the shared constant; it is
# referenced in the literal-pin test. Mark it used for shellcheck.)
export CANONICAL_PHASES TERMINAL_PHASE

# --- Fail-open: never break commits in projects that don't use the workflow --
# Matches the phase-guard posture exactly: missing sqlite3, missing DB, or no
# rows => exit 0 silently.
if ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$BRAIN_DB" ]; then
  exit 0
fi

# --- has_closing_commit <brief_id> -> 0 if a commit references the brief ------
# A closing commit references the brief id via the `closes #<ID>` footer
# convention (00-igris-universal.md) OR a bare `<ID>` token anywhere in the
# message (subject or body). `git log --grep` searches the whole message; the
# brief id (e.g. FR-200) is a fixed token, so a fixed-string grep is correct
# and injection-safe. Returns 0 (true) when at least one commit matches.
has_closing_commit() {
  local brief_id="$1"
  local matches
  # -F fixed-string (the id is literal); -i case-insensitive for safety; the id
  # shape ([A-Z]+-[0-9]+) is validated by the caller before this is reached.
  matches="$(git -C "$REPO_DIR" log --grep="$brief_id" -F -i --format='%H' 2>/dev/null | head -1)"
  [ -n "$matches" ]
}

# --- Query the canonical store -----------------------------------------------
# Pull every brief's id/status/phase for the project. $PROJECT is a slug
# (basename of repo or an env override) — single-quote-escape it (doubling any
# embedded quote) before interpolation so a stray quote cannot break the SQL,
# matching the phase-guard idiom.
PROJECT_SQL="${PROJECT//\'/\'\'}"
rows="$(sqlite3 -separator '|' "$BRAIN_DB" \
  "SELECT brief_id, status, COALESCE(phase, '') FROM brief_status
     WHERE project='$PROJECT_SQL'
     ORDER BY brief_id;" \
  2>/dev/null || true)"

# Fail-open on no rows (empty DB / unmigrated project / wrong project slug).
if [ -z "$rows" ]; then
  exit 0
fi

# --- Evaluate the invariant per row ------------------------------------------
contradictions=0
report=""

while IFS='|' read -r brief_id status phase; do
  [ -n "$brief_id" ] || continue

  # Only evaluate well-formed brief ids ([A-Z]+-[0-9]+); skip anything else so
  # the git grep is never fed an unexpected token. Defense-in-depth.
  if ! [[ "$brief_id" =~ ^[A-Z]+-[0-9]+$ ]]; then
    continue
  fi

  # --- TD-333: fold NOTATION before matching -------------------------------
  # Byte-identical in effect to TD-340's portable SQL fold at the five gate
  # sites: replace(replace(replace(lower(status),' ',''),'-',''),'_','').
  # bash 3.2 has no ${var,,}, so `tr` does the case half.
  #
  # WHY THIS ARM EXISTS AT ALL. Before TD-333 the `case` matched three literal
  # spellings and everything else fell to a SILENT no-op arm commented "other
  # in-flight states". `Completed` and `Complete` are not in-flight — they are
  # TERMINAL, and they had therefore been EXEMPT from the
  # Done<->COMPLETE<->commit invariant for their entire lifetime. That is 25
  # rows the canonical build-state validator never once evaluated. Widening the
  # arm does not create contradictions; it stops a spelling from hiding them.
  #
  # `Done(Resolvedbydec8d1f)` is a 26th terminal row that this widening does
  # NOT recover: the notation fold yields `done(resolvedbydec8d1f)`, which
  # still falls to `*)`. That is deliberate — see the `*)` arm below, which
  # names it as vacuous BY DESIGN because a welded commit sha is an operator
  # note in the wrong field, not a spelling. Do not "fix" it with a prefix
  # match; v25 has a test asserting that row survives byte-identical.
  status_folded="$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')"
  status_folded="${status_folded// /}"
  status_folded="${status_folded//-/}"
  status_folded="${status_folded//_/}"

  case "$status_folded" in
    done|archived|completed|complete)
      # RETAINED SYNONYMS, deliberately (TD-289's rule, applied to `status`).
      # After schema v25 `completed`/`complete` match ZERO rows in the local
      # brain — the fold emptied them. They stay as DEFENSE IN DEPTH, because a
      # fold only folds what the fold table DECLARES and the column is still
      # reachable by paths outside it: `igris import` (FR-230) is a deliberate
      # NON-consumer of the sync-ingress fold, an older direct writer can still
      # write any string, and the write boundary never hard-rejects. Deleting
      # these two entries would silently re-open the exemption above.
      # DO NOT "CLEAN UP" THIS LIST.

      # C1 Done-but-not-COMPLETE: terminal status, non-terminal phase.
      if [ "$phase" != "$TERMINAL_PHASE" ]; then
        report+="  CONTRADICTION C1 (Done-but-not-COMPLETE): $brief_id status='$status' phase='${phase:-<none>}' — expected phase='$TERMINAL_PHASE'"$'\n'
        contradictions=$((contradictions + 1))
      fi
      # C2 Done-but-no-commit: terminal status, no closing commit in git.
      if ! has_closing_commit "$brief_id"; then
        report+="  CONTRADICTION C2 (Done-but-no-commit): $brief_id status='$status' — no commit in git log references the brief"$'\n'
        contradictions=$((contradictions + 1))
      fi
      ;;
    ready|draft)
      # NOT WIDENED — and that is a decision. Only the NOTATION of `Ready` and
      # `Draft` is folded here; no third state was added. Adding one (say
      # `Deferred`) would change what C3 MEANS, which is a lifecycle question
      # and not a normalisation one. C3's count must be identical before and
      # after the v25 fold — it is the cheapest tripwire TD-333 has.

      # C3 committed-but-open: a closing commit exists, store still calls it open.
      if has_closing_commit "$brief_id"; then
        report+="  CONTRADICTION C3 (committed-but-open): $brief_id status='$status' — a closing commit exists but the canonical status is not terminal (#811 inverse)"$'\n'
        contradictions=$((contradictions + 1))
      fi
      ;;
    *)
      # GENUINELY in-flight or genuinely undecided — the invariant is vacuous
      # and the row is not flagged. Since TD-333 this arm holds ONLY:
      #   - `In Progress` / `InProgress` / `Blocked` — in flight;
      #   - `Cancelled` / `Superseded` / `Deferred` — the three MISSING STATES
      #     (scripts/validate_brief_status_vocabulary.sh reports them by name;
      #     whether they are terminal for C1/C2 is the follow-up brief's
      #     question, not this validator's to assume);
      #   - a value carrying an operator PAYLOAD (a commit sha, a split
      #     lineage). Those are named by the vocabulary validator too.
      # It no longer holds a terminal status wearing a different spelling.
      :
      ;;
  esac
done <<< "$rows"

if [ "$contradictions" -gt 0 ]; then
  echo "Brief-state reconciliation: $contradictions contradiction(s) found (project '$PROJECT')"
  printf '%s' "$report"
  echo ""
  echo "The canonical build-state source is brief_status.status. Resolve each row:"
  echo "  C1 -> sync the terminal phase: igris_brief_sync with phase='$TERMINAL_PHASE'"
  echo "  C2 -> either the brief is not actually done (re-open) or the closing commit is missing/un-referenced"
  echo "  C3 -> the work is committed; advance the canonical status to a terminal state"
  echo "See docs/architecture/brief-state-source-of-truth.md for the invariant."
  exit 1
fi

echo "OK: brief-state reconciliation clean (project '$PROJECT') — status<->phase<->git invariant holds"
exit 0
