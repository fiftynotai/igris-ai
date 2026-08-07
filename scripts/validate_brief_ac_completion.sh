#!/bin/bash
set -e

# Description: Acceptance-criteria completion validator (TD-325). Read-only
#   check that reports every TERMINAL brief whose stored acceptance criteria are
#   still open — or whose deferral is missing its reason or its follow-up brief.
#
#   The fourth sibling of the brief-state validator family
#   (validate_brief_state_reconciliation.sh TD-257,
#    validate_brief_type_vocabulary.sh TD-328,
#    validate_brief_priority_vocabulary.sh TD-338,
#    validate_brief_status_vocabulary.sh TD-333) — same header convention, same
#   env overrides, same fail-open posture, same exit-code contract. Wired into
#   scripts/git-hooks/pre-commit as WARN-only.
#
# TWO JOBS, and the second is why it exists at all:
#
#   (1) L3 ACCUMULATION OBSERVER. The commit-msg gate (L2) refuses a CLOSING
#       COMMIT. It cannot see a brief closed with no commit — /archive, a direct
#       igris_brief_sync, the dashboard, remote sync. Those land here, on the
#       next commit that touches a brief-state surface. It blocks nothing by
#       design: it is the net, not the gate.
#
#   (2) THE DRIVER FOR TD-075's RETROACTIVE SWEEP. `--list` emits the worklist.
#       This matters more than it looks. TD-075 was previously driven off the
#       cognition gap-candidate queue, which was a LOSSY INDEX of the signal:
#       45% coverage, 2.5x duplication, and 194 affected briefs it never indexed
#       at all. A sweep driven off that queue would have read as "handled" while
#       more than half the population stayed invisible — the founding failure of
#       TD-325. Because this validator and the gate call the SAME parser
#       (core/scripts/brief_ac_check.sh), the audit population and the gate's
#       refusal set are IDENTICAL BY CONSTRUCTION. There is no third number.
#
# THE NUMBER GAP — PRE-DECLARED, so the first run cannot be read as a miscount.
#   The figure quoted in TD-325 and FR-241 (353, later 362, 379 today) comes
#   from `content LIKE '%- [ ]%'`. That substring is not a checkbox test. It
#   matches inline code spans in prose — TD-325's own body contains `- [ ]`
#   twice while DESCRIBING the problem — and it matches checkboxes anywhere in
#   the document, including a `## Scope` task list or an `## Out of scope` note.
#   It also MISSES entire populations: 37 terminal igris-ai briefs write at least
#   some criteria as `1. [ ]` (the v4-era template), which contains no `- [ ]`
#   substring at all, and it cannot express a malformed deferral in any form.
#
#   Measured 2026-08-07 over the 447 Done/Archived igris-ai briefs that have a
#   brief_files row:
#       LIKE '%- [ ]%'      379
#       this parser (FAIL)  388
#       LIKE-only            2   (FR-241 correctly deferred; TD-022's boxes sit
#                                 outside the AC block)
#       parser-only         11   (9 ordered-marker briefs LIKE cannot see,
#                                 2 briefs whose [~] carries no reason)
#   So the anchored parse is LARGER, not smaller. Do not reconcile the two
#   numbers by loosening this validator — the LIKE figure is the one that is
#   wrong, in both directions at once.
#
# WHAT THIS FILE DELIBERATELY DOES NOT DO (TD-325 AC #7):
#   It does not read, count, dismiss or otherwise touch the cognition candidate
#   queue. Those pending rows are the operator's STANDING REMINDER until the
#   retroactive ticks are actually done; clearing them is the last step of
#   TD-075, not the first step of the fix. test/brief_ac_gate.test.bash asserts
#   this file never even names that table.
#
#   It also never edits a brief. Ticking is a per-brief, per-AC, evidence-cited
#   act (TD-311: a tick you cannot evidence invents the record). This produces a
#   WORKLIST, never a patch.
#
# Usage: scripts/validate_brief_ac_completion.sh [--list]
#   --list   emit bare brief ids, one per line, and nothing else. The TD-075
#            worklist driver.
# Env overrides (test injection):
#   BRAIN_DB   override brain DB path (default: ~/.igris/memory/knowledge.db)
#   PROJECT    override the project slug to query. Unset/empty => ALL projects.
# Exit codes:
#   0 - No findings (clean), OR fail-open (sqlite3/DB/parser absent, no rows).
#   1 - One or more terminal briefs with an open or malformed criterion. The
#       pre-commit hook block decides WARN vs block — TD-325 ships L3 as WARN
#       and puts the hard-fail on L2 (the closing commit) instead.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

BRAIN_DB="${BRAIN_DB:-$HOME/.igris/memory/knowledge.db}"
PROJECT="${PROJECT:-}"
LIST_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_MODE=1; shift ;;
    -h|--help) sed -n '/^# Usage:/,/^#       and puts/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "validate_brief_ac_completion.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# --- The ONE parser. Repo copy first, runtime mirror second ------------------
# A second checkbox-parsing implementation here would re-open the exact hole
# this validator exists to close, so it resolves the shared script rather than
# reimplementing the grammar.
AC_CHECK=""
if [ -f "$REPO_ROOT/core/scripts/brief_ac_check.sh" ]; then
  AC_CHECK="$REPO_ROOT/core/scripts/brief_ac_check.sh"
elif [ -f "$HOME/.igris/core/scripts/brief_ac_check.sh" ]; then
  AC_CHECK="$HOME/.igris/core/scripts/brief_ac_check.sh"
fi

# --- Fail-open: never break commits in projects that don't use the workflow --
if [ -z "$AC_CHECK" ]; then
  exit 0
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$BRAIN_DB" ]; then
  exit 0
fi
if ! command -v awk >/dev/null 2>&1; then
  exit 0
fi

# --- Query the store (read-only) ---------------------------------------------
# TERMINAL SET: the TD-333 notation fold, byte-aligned with the expression at
# the five other gate sites — replace(replace(replace(lower(status),' ',''),
# '-',''),'_','') — plus the two RETAINED SYNONYMS `completed`/`complete` that
# validate_brief_state_reconciliation.sh keeps as defense in depth. This is
# deliberately NOT a fresh literal list: a fifth definition of "terminal" is how
# 26 rows sat exempt from the reconciliation invariant for their whole lifetime.
#
# $PROJECT is a slug (env override) — single-quote-escaped (doubling any
# embedded quote) before interpolation, matching the phase-guard idiom.
if [ -n "$PROJECT" ]; then
  PROJECT_SQL="${PROJECT//\'/\'\'}"
  WHERE_PROJECT="AND bs.project='$PROJECT_SQL'"
  SCOPE="project '$PROJECT'"
else
  WHERE_PROJECT=""
  SCOPE="all projects"
fi

# ONE sqlite3 invocation for the whole corpus, not one per brief. Brief content
# is multi-line markdown, so it is selected as HEX: every row then occupies
# exactly one output line, and the multi-line problem disappears instead of
# being escaped around.
#
# Control-character separators were tried first and DO NOT WORK: the sqlite3
# 3.51 CLI renders unprintable bytes in caret notation, so `char(30)` arrives as
# the two literal characters `^^` rather than 0x1E. Verified by od(1) on this
# machine. Anything relying on a raw control byte surviving the CLI is broken in
# a way that silently yields zero records.
dump="$(sqlite3 -readonly "$BRAIN_DB" \
  "SELECT bs.project || ' ' || bs.brief_id || ' ' || hex(bf.content)
     FROM brief_status bs
     JOIN brief_files bf
       ON bf.project = bs.project AND bf.brief_id = bs.brief_id
    WHERE replace(replace(replace(lower(bs.status),' ',''),'-',''),'_','')
          IN ('done','archived','completed','complete')
      $WHERE_PROJECT
    ORDER BY bs.project, bs.brief_id;" \
  2>/dev/null || true)"

# Fail-open on no rows (empty DB / unmigrated project / wrong project slug).
if [ -z "$dump" ]; then
  exit 0
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/acval.XXXXXX")"

# No EXIT trap: an EXIT trap makes every later `printf | grep -q` in a script
# report "write error: Broken pipe". Cleanup happens explicitly at each return
# point instead.
cleanup() { rm -rf "$WORKDIR"; }

# Decode each hex payload back to a file. xxd ships with macOS and every Linux
# distro carrying vim; if it is absent, fail open rather than half-report.
if ! command -v xxd >/dev/null 2>&1; then
  cleanup
  exit 0
fi

seq_no=0
while read -r proj id hex; do
  [ -n "$hex" ] || continue
  seq_no=$((seq_no + 1))
  printf '%s' "$hex" | xxd -r -p > "$WORKDIR/$seq_no.md" 2>/dev/null || continue
  printf '%s|%s|%s\n' "$seq_no" "$proj" "$id" >> "$WORKDIR/index.txt"
done <<< "$dump"

if [ ! -f "$WORKDIR/index.txt" ]; then
  cleanup
  exit 0
fi

# --- Run every brief through the shared parser --------------------------------
total_briefs=0
unticked_briefs=0
no_reason_briefs=0
no_followup_briefs=0
no_items_briefs=0
affected_ids=""
report=""
no_items_report=""

while IFS='|' read -r seq proj id; do
  [ -n "$seq" ] || continue
  total_briefs=$((total_briefs + 1))
  out="$(bash "$AC_CHECK" --brief-id "$id" "$WORKDIR/$seq.md" 2>/dev/null || true)"
  headline="$(printf '%s' "$out" | head -n1)"

  case "$headline" in
    *"VERDICT=NO_ITEMS"*)
      no_items_briefs=$((no_items_briefs + 1))
      no_items_report+="  NO PARSEABLE CRITERIA: $proj/$id"$'\n'
      continue
      ;;
    *"VERDICT=FAIL"*) : ;;
    *) continue ;;
  esac

  n_unticked="$(printf '%s' "$headline" | sed -n 's/.* unticked=\([0-9]*\).*/\1/p')"
  n_noreason="$(printf '%s' "$headline" | sed -n 's/.* deferred_no_reason=\([0-9]*\).*/\1/p')"
  n_nofollow="$(printf '%s' "$headline" | sed -n 's/.* deferred_no_followup=\([0-9]*\).*/\1/p')"
  n_total="$(printf '%s' "$headline" | sed -n 's/.* total=\([0-9]*\).*/\1/p')"

  affected_ids+="$id"$'\n'

  if [ "${n_unticked:-0}" -gt 0 ]; then
    unticked_briefs=$((unticked_briefs + 1))
    report+="  UNTICKED: $proj/$id — $n_unticked of $n_total criteria still open"$'\n'
  fi
  if [ "${n_noreason:-0}" -gt 0 ]; then
    no_reason_briefs=$((no_reason_briefs + 1))
    report+="  DEFERRAL WITHOUT A REASON: $proj/$id — $n_noreason deferral(s) carry no DEFERRED token"$'\n'
  fi
  if [ "${n_nofollow:-0}" -gt 0 ]; then
    no_followup_briefs=$((no_followup_briefs + 1))
    report+="  DEFERRAL WITHOUT A FOLLOW-UP BRIEF: $proj/$id — $n_nofollow deferral(s) name nowhere to go"$'\n'
  fi
done < "$WORKDIR/index.txt"

cleanup

# --- --list: the TD-075 worklist, and nothing else ----------------------------
if [ "$LIST_MODE" -eq 1 ]; then
  if [ -z "$affected_ids" ]; then
    exit 0
  fi
  printf '%s' "$affected_ids"
  exit 1
fi

affected_count=0
if [ -n "$affected_ids" ]; then
  affected_count="$(printf '%s' "$affected_ids" | grep -c '' || true)"
fi

echo "brief AC completion ($SCOPE): $total_briefs terminal brief(s) with stored content"

if [ "$affected_count" -eq 0 ]; then
  if [ "$no_items_briefs" -gt 0 ]; then
    echo ""
    echo "NOTE: $no_items_briefs brief(s) have an Acceptance Criteria heading but no"
    echo "  parseable checkbox — criteria written as prose, or in a notation the parser"
    echo "  does not know. They are NOT counted as findings and NOT in --list: the"
    echo "  remedy is rewriting the criteria as '- [ ]', which is a different job from"
    echo "  ticking one. Reported so they cannot pass as clean."
    printf '%s' "$no_items_report"
  fi
  echo ""
  echo "OK: acceptance criteria complete ($SCOPE) — every terminal brief is ticked or explicitly deferred"
  exit 0
fi

echo ""
echo "$affected_count terminal brief(s) closed with an unmet or malformed criterion"
echo "  unticked: $unticked_briefs   deferral-without-reason: $no_reason_briefs   deferral-without-follow-up: $no_followup_briefs"
echo ""
printf '%s' "$report"

if [ "$no_items_briefs" -gt 0 ]; then
  echo ""
  echo "  Plus $no_items_briefs brief(s) whose AC block holds no parseable checkbox (not counted above):"
  printf '%s' "$no_items_report"
fi

echo ""
echo "Resolve each brief PER CRITERION, against its closing commit:"
echo "  - [x]  the criterion IS met -> tick it, and cite the evidence (a test name,"
echo "         a file:line, a measured figure, the commit sha). A tick you cannot"
echo "         evidence invents the record, which is the move TD-311 forbids."
echo "  - [~]  the criterion is NOT met -> defer it explicitly:"
echo "             - [~] **DEFERRED: <why it is unmet>** -> TD-XXX"
echo "         The follow-up brief is required: a deferral with nowhere to go is"
echo "         indistinguishable from one that was forgotten."
echo "NEVER a bulk UPDATE and never a sed — this is a worklist, not a patch."
echo "The retroactive sweep is owned by TD-075, driven by this script's --list."
exit 1
