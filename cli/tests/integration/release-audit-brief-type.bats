#!/usr/bin/env bats

# release-audit-brief-type.bats — TD-289 + TD-340 regression test for the
# /release Step 0 broken-feature audit (coding_guidelines §17.2, executor in
# core/skills/release/SKILL.md).
#
# THE §17.2 PREDICATE HAS TWO HALVES. Each has been holed once:
#
#   HOLE 1 — brief_type (TD-289). The filter was
#     brief_type IN ('Bug','Feature Request')
#   but the live vocabulary is inconsistent — feature/bug blockers are also
#   typed 'FR', 'Feature', 'BR'. A P0/P1 blocker typed 'FR'/'Feature' (e.g.
#   FR-201) ESCAPED and the gate PASSED a tag with open blockers.
#
#   HOLE 2 — status (TD-340). The filter was
#     status IN ('Ready','In Progress','Blocked')
#   but the live brain also holds 'InProgress' (no space). The three P1-High
#   attendance_app blockers BR-002/BR-003/BR-004 are spelled that way, so
#   `/release attendance_app` printed AUDIT=PASS with three P1 blockers open.
#
# WHY HOLE 2 SURVIVED HOLE 1'S FIX: TD-289 widened the brief_type half AND
# wrote a source guard — but the guard pinned ONLY the brief_type half. The
# status half was never pinned, so nothing noticed it was still a bare literal
# list. This file now pins BOTH halves. Do not narrow it back to one.
#
# THE FIX SHAPE (TD-340): the status half FOLDS NOTATION rather than
# enumerating one more literal. Hardcoding 'InProgress' alongside
# 'In Progress' would leave a FOURTH notation ('in_progress', 'IN-PROGRESS')
# free to escape. The fold collapses case + space + hyphen + underscore, so
# every notation of the same word gates identically.
#
# THE FOLD IS NOTATION-ONLY, NEVER VOCABULARY. The IN-list enumerates states
# that BLOCK a release, so terminal states ('Done','Completed','Complete',
# 'Archived') are ABSENT BY DESIGN — a finished brief must not block a
# release. Adding them would INVERT the gate. See the asymmetry test below.
#
# SIBLING FILE — READ BOTH. This file pins the §17.2 PREDICATE. Its companion
# release-audit-bypass-ids.bats (BR-091) pins how the predicate's RESULT becomes
# the durable CHANGELOG bypass record, and carries the counting guard that keeps
# the predicate bound EXACTLY ONCE in the skill. That guard exists because the
# `grep -F` pins below are whole-file SUBSTRING tests: a second, drifting copy of
# the predicate would still satisfy them. Splitting the pin set across two files
# is itself the TD-289 → TD-340 hazard (a pin that covers one surface while
# another rots), so neither file may be widened without checking the other.
#
# LIMITATION: Step 0 is a skill-only markdown procedure with an inline sqlite3
# query — there is no CLI verb or extracted script to invoke. This test is the
# most faithful reproduction available: it (a) source-guards the exact
# predicate in the committed skill so the executor cannot silently revert, and
# (b) runs that same predicate against a seeded temp DB to prove each widening
# is load-bearing (old form misses the blocker, new form catches it).
#
# HARNESS NOTE: every substring assertion below is written `[[ ... ]] ||
# return 1`. bash does NOT fire the ERR trap for a `[[ ]]` compound
# conditional and bats-core detects mid-test failures via that trap (errexit
# is OFF inside a test body), so a bare non-final `[[ ... ]]` fails SILENTLY
# and the test still reports ok. Single-bracket `[ ... ]` IS trapped.

load _helpers.bash

# ---------------------------------------------------------------------------
# The §17.2 predicate halves, byte-aligned with core/skills/release/SKILL.md
# Step 0 and coding_guidelines §17.2. All three move in lockstep.
# ---------------------------------------------------------------------------

# brief_type half (TD-289). Named *_TYPE_LIST — it was called WIDENED_IN_LIST
# back when it was the only pinned half; TD-340 renamed it because its meaning
# NARROWED to one of two halves.
WIDENED_TYPE_LIST="brief_type IN ('Bug','BR','Feature','FR','Feature Request')"
OLD_TYPE_LIST="brief_type IN ('Bug','Feature Request')"

# status half (TD-340). The notation-folding expression.
FOLDED_STATUS_LIST="replace(replace(replace(lower(status),' ',''),'-',''),'_','') IN ('ready','inprogress','blocked')"
OLD_STATUS_LIST="status IN ('Ready','In Progress','Blocked')"

setup() {
  # Repo skill path — the committed executor artifact (SKILL.md at
  # core/skills/). Derived from CLI_DIST (=<repo>/cli/dist, exported by
  # _helpers) because under bats ${BASH_SOURCE[0]} points at a preprocessed
  # temp file, not this .bats file's real location.
  SKILL_MD="$CLI_DIST/../../core/skills/release/SKILL.md"

  DB="$BATS_TEST_TMPDIR/knowledge.db"
  sqlite3 "$DB" "CREATE TABLE brief_status (
    brief_id TEXT, project TEXT, priority TEXT, status TEXT,
    brief_type TEXT, title TEXT
  );"
  # TD-289 escapees — the brief_type half.
  # The escaping blocker: P1-High, In Progress, typed 'Feature' (like FR-201).
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-999','igris-ai','P1-High','In Progress','Feature','feature-typed P1 blocker');"
  # An 'FR'-short-code blocker: P0-Critical, Ready.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-998','igris-ai','P0-Critical','Ready','FR','FR-short-code P0 blocker');"

  # TD-340 escapees — the status half. Modelled on the live attendance_app
  # rows (P1-High / 'InProgress' / Feature+Bug) that the gate could not see.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('BR-002','igris-ai','P1-High','InProgress','Feature','InProgress-spelled P1 blocker'),
    ('BR-003','igris-ai','P1-High','InProgress','Bug','InProgress-spelled P1 bug');"
  # A FOURTH notation — must also be caught, which a second hardcoded literal
  # would NOT achieve.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('BR-004','igris-ai','P0-Critical','in_progress','Bug','fourth-notation P0 blocker');"

  # Out-of-scope rows that must NOT be caught: wrong priority, wrong status,
  # wrong type (Technical Debt is not the §17.2 broken-feature/bug class).
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-100','igris-ai','P2-Medium','Ready','Feature','P2 feature — not blocking'),
    ('FR-101','igris-ai','P1-High','Done','Feature','done feature — not blocking'),
    ('TD-100','igris-ai','P0-Critical','Ready','Technical Debt','tech-debt — not §17.2 class');"

  # TERMINAL-STATE rows. These are the asymmetry control: they are finished,
  # so they must NEVER block a release no matter how they are spelled.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-102','igris-ai','P0-Critical','Completed','Feature','completed — must NOT block'),
    ('FR-103','igris-ai','P0-Critical','Complete','Bug','complete — must NOT block'),
    ('FR-104','igris-ai','P0-Critical','Archived','Feature','archived — must NOT block');"
}

# audit_rows <status-clause> <type-clause> — run the §17.2 predicate with the
# given halves and echo matching rows (empty = PASS, non-empty = BLOCK).
audit_rows() {
  sqlite3 -noheader "$DB" "
    SELECT brief_id
    FROM brief_status
    WHERE project='igris-ai'
      AND priority IN ('P0-Critical','P1-High')
      AND $1
      AND $2;"
}

# current_audit_rows — both halves in their shipped form.
current_audit_rows() {
  audit_rows "$FOLDED_STATUS_LIST" "$WIDENED_TYPE_LIST"
}

@test "TD-289: widened brief_type BLOCKS Feature/FR-typed P0/P1 blockers" {
  run current_audit_rows
  [ "$status" -eq 0 ]
  [ -n "$output" ]                          # non-empty => AUDIT=BLOCK
  [[ "$output" == *"FR-999"* ]] || return 1 # the 'Feature'-typed blocker
  [[ "$output" == *"FR-998"* ]] || return 1 # the 'FR'-short-code blocker
}

@test "TD-340: folded status BLOCKS 'InProgress'-spelled P0/P1 blockers" {
  run current_audit_rows
  [ "$status" -eq 0 ]
  [[ "$output" == *"BR-002"* ]] || return 1 # 'InProgress' Feature blocker
  [[ "$output" == *"BR-003"* ]] || return 1 # 'InProgress' Bug blocker
}

@test "TD-340: a FOURTH notation ('in_progress') is also caught by the fold" {
  # This is the test a "just add 'InProgress' to the list" fix would FAIL.
  run current_audit_rows
  [ "$status" -eq 0 ]
  [[ "$output" == *"BR-004"* ]] || return 1
}

@test "predicate does NOT over-catch: P2 / Done / Technical-Debt excluded" {
  run current_audit_rows
  [ "$status" -eq 0 ]                       # query ran (guards error-to-empty)
  [[ "$output" != *"FR-100"* ]] || return 1 # P2 — wrong priority
  [[ "$output" != *"FR-101"* ]] || return 1 # Done — wrong status
  [[ "$output" != *"TD-100"* ]] || return 1 # Technical Debt — not §17.2 class
}

@test "ASYMMETRY: terminal states are NOT folded into the blocking set" {
  # THE POINT: the IN-list enumerates states that BLOCK a release. A FINISHED
  # brief must not block one, so 'Completed'/'Complete'/'Archived' are absent
  # BY DESIGN — their absence is CORRECT, not an oversight. Adding them would
  # INVERT the gate's meaning and make every release un-taggable.
  #
  # The fold collapses NOTATION ('In Progress' == 'InProgress' == 'in_progress')
  # but never VOCABULARY: 'Completed' folds to 'completed', which is not in the
  # list. This test is the guard against a future reader "completing" the list.
  run current_audit_rows
  [ "$status" -eq 0 ]
  [[ "$output" != *"FR-102"* ]] || return 1 # Completed
  [[ "$output" != *"FR-103"* ]] || return 1 # Complete
  [[ "$output" != *"FR-104"* ]] || return 1 # Archived
}

@test "negative control: OLD brief_type list MISSES its blockers (TD-289 hole)" {
  # Proves the brief_type widening is load-bearing: with the pre-TD-289 list
  # the Feature/FR-typed blockers produce zero rows => a false AUDIT=PASS.
  # Status half held at its shipped form so only the type half varies.
  run audit_rows "$FOLDED_STATUS_LIST" "$OLD_TYPE_LIST"
  [ "$status" -eq 0 ]
  [[ "$output" != *"FR-999"* ]] || return 1
  [[ "$output" != *"FR-998"* ]] || return 1
}

@test "negative control: OLD status list MISSES its blockers (TD-340 hole)" {
  # Proves the status fold is load-bearing: with the pre-TD-340 literal list
  # the 'InProgress' blockers produce zero rows => a false AUDIT=PASS. Type
  # half held at its shipped form so only the status half varies — the control
  # travels the SAME query path as the behaviour under test.
  run audit_rows "$OLD_STATUS_LIST" "$WIDENED_TYPE_LIST"
  [ "$status" -eq 0 ]
  [[ "$output" != *"BR-002"* ]] || return 1
  [[ "$output" != *"BR-003"* ]] || return 1
  [[ "$output" != *"BR-004"* ]] || return 1
  # ...while the TD-289 blockers ARE still seen, proving the query ran and the
  # miss is attributable to the status half alone (not to a broken fixture).
  [[ "$output" == *"FR-999"* ]] || return 1
}

@test "source guard: committed skill Step 0 carries BOTH widened halves" {
  # Ties this test to the real executor. TD-289 pinned only the brief_type
  # half — which is exactly why the status hole (TD-340) survived it. Pin
  # BOTH, and assert BOTH old forms are gone.
  run grep -F "$WIDENED_TYPE_LIST" "$SKILL_MD"
  [ "$status" -eq 0 ]
  run grep -F "$FOLDED_STATUS_LIST" "$SKILL_MD"
  [ "$status" -eq 0 ]

  run grep -F "$OLD_TYPE_LIST;" "$SKILL_MD"
  [ "$status" -ne 0 ]              # the bare old type list must not appear
  run grep -F "AND $OLD_STATUS_LIST" "$SKILL_MD"
  [ "$status" -ne 0 ]              # the bare old status list must not appear
}

@test "source guard: terminal spellings never enter the blocking IN-list" {
  # Whole-file scan of the shipped executor: no blocking IN-list may name a
  # terminal state. Catches a future "let's complete the list" edit even if it
  # is made in a copy of the predicate this file does not otherwise pin.
  # Deliberately NOT anchored on 'ready' being first: a reordered blocking list
  # (IN ('inprogress','ready','done')) would escape an anchored pattern, and
  # reordering is exactly the kind of edit that accompanies "let's complete the
  # list". Case-insensitive for the same reason.
  run grep -niE "IN \([^)]*'(completed|complete|done|archived|cancelled|superseded)'" "$SKILL_MD"
  [ "$status" -ne 0 ]
}
