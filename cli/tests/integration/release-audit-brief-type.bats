#!/usr/bin/env bats

# release-audit-brief-type.bats — TD-289 regression test for the /release
# Step 0 broken-feature audit (coding_guidelines §17.2, executor in
# core/skills/release/SKILL.md).
#
# THE HOLE (TD-289): the Step 0 predicate used to filter
#   brief_type IN ('Bug','Feature Request')
# but the live brief_status vocabulary is inconsistent — feature/bug blockers
# are also typed 'FR', 'Feature', 'BR'. So a P0/P1 Ready/In-Progress/Blocked
# blocker typed 'FR'/'Feature' (e.g. FR-201) ESCAPED the predicate and the
# release gate would PASS a tag with open blockers.
#
# LIMITATION: Step 0 is a skill-only markdown procedure with an inline sqlite3
# query — there is no CLI verb or extracted script to invoke. This test is the
# most faithful reproduction available: it (a) source-guards the exact widened
# IN-list in the committed skill so the executor cannot silently revert, and
# (b) runs that same predicate against a seeded temp DB to prove the widening
# is load-bearing (old list misses the blocker, new list catches it).

load _helpers.bash

# The widened brief_type IN-list, byte-aligned with core/skills/release/SKILL.md
# Step 0 and coding_guidelines §17.2 (the two move in lockstep).
WIDENED_IN_LIST="brief_type IN ('Bug','BR','Feature','FR','Feature Request')"
OLD_IN_LIST="brief_type IN ('Bug','Feature Request')"

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
  # The escaping blocker: P1-High, In Progress, typed 'Feature' (like FR-201).
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-999','igris-ai','P1-High','In Progress','Feature','feature-typed P1 blocker');"
  # An 'FR'-short-code blocker: P0-Critical, Ready.
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-998','igris-ai','P0-Critical','Ready','FR','FR-short-code P0 blocker');"
  # Out-of-scope rows that must NOT be caught: wrong priority, wrong status,
  # wrong type (Technical Debt is not the §17.2 broken-feature/bug class).
  sqlite3 "$DB" "INSERT INTO brief_status VALUES
    ('FR-100','igris-ai','P2-Medium','Ready','Feature','P2 feature — not blocking'),
    ('FR-101','igris-ai','P1-High','Done','Feature','done feature — not blocking'),
    ('TD-100','igris-ai','P0-Critical','Ready','Technical Debt','tech-debt — not §17.2 class');"
}

# audit_rows <in-list> — run the §17.2 predicate with the given brief_type
# clause and echo matching rows (empty = PASS, non-empty = BLOCK).
audit_rows() {
  sqlite3 -noheader "$DB" "
    SELECT brief_id
    FROM brief_status
    WHERE project='igris-ai'
      AND priority IN ('P0-Critical','P1-High')
      AND status IN ('Ready','In Progress','Blocked')
      AND $1;"
}

@test "widened predicate BLOCKS: Feature/FR-typed P0/P1 blockers are caught" {
  run audit_rows "$WIDENED_IN_LIST"
  [ "$status" -eq 0 ]
  [ -n "$output" ]                 # non-empty => AUDIT=BLOCK
  [[ "$output" == *"FR-999"* ]]    # the 'Feature'-typed blocker
  [[ "$output" == *"FR-998"* ]]    # the 'FR'-short-code blocker
}

@test "widened predicate does NOT over-catch: P2 / Done / Technical-Debt excluded" {
  run audit_rows "$WIDENED_IN_LIST"
  [ "$status" -eq 0 ]              # query ran (guards against error-to-empty)
  [[ "$output" != *"FR-100"* ]]    # P2 — wrong priority
  [[ "$output" != *"FR-101"* ]]    # Done — wrong status
  [[ "$output" != *"TD-100"* ]]    # Technical Debt — not the §17.2 class
}

@test "negative control: OLD predicate MISSES the blockers (the hole TD-289 closed)" {
  # Proves the widening is load-bearing: with the pre-TD-289 IN-list the same
  # seeded blockers produce zero rows => a false AUDIT=PASS.
  run audit_rows "$OLD_IN_LIST"
  [ "$status" -eq 0 ]
  [ -z "$output" ]                 # empty => the old gate would have PASSED
}

@test "source guard: committed skill Step 0 carries the widened IN-list" {
  # Ties this test to the real executor. If someone reverts the predicate to
  # the old ('Bug','Feature Request') form, this fails — enforcing that the
  # shipped gate stays byte-aligned with §17.2 and TD-289.
  run grep -F "$WIDENED_IN_LIST" "$SKILL_MD"
  [ "$status" -eq 0 ]
  run grep -F "$OLD_IN_LIST;" "$SKILL_MD"
  [ "$status" -ne 0 ]              # the bare old list must no longer appear
}
