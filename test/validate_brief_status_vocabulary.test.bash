#!/usr/bin/env bats

# Tests for scripts/validate_brief_status_vocabulary.sh (TD-333).
#
# The validator reads brief_status.status from a brain DB, prints the
# distinct-value distribution, and names every value that is not one of the six
# canonical statuses — SPLIT INTO TWO CLASSES:
#   CLASS 1 DOCUMENTED GAP  Cancelled / Superseded / Deferred. Non-canonical by
#                           DECISION (they are MISSING STATES, not spellings).
#                           A standing, expected WARN with its own resolution.
#   CLASS 2 STRAY           anything else — a new spelling, an empty status, or
#                           an operator note written into the state field.
# The split exists so a permanent expected WARN cannot train the reader to
# ignore a genuinely stray value.
#
# It is fail-open (exit 0 silent) when sqlite3/DB absent or no rows, and honors
# BRAIN_DB / PROJECT env overrides for test injection. Each test builds a
# throwaway brain DB so the live DB is never touched.
#
# NOTE ON ASSERTION STYLE (TD-341): a bare `[[ ... ]]` mid-test does NOT fire
# bash's ERR trap, so bats reports `ok` on a FALSE assertion. Every raw
# conditional below is written `... || return 1`.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_status_vocabulary.sh"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  SCRATCH="$TEST_TEMP_DIR/briefstatus_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
  FIXTURE_DB="$SCRATCH/knowledge.db"
  FIXTURE_PROJECT="repo"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# Minimal brief_status table mirroring the columns the validator SELECTs.
# `status TEXT NOT NULL` is reproduced deliberately — it is the schema fact the
# whole empty/NULL handling turns on.
init_fixture_db() {
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  sqlite3 "$FIXTURE_DB" <<'SQL'
CREATE TABLE brief_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  brief_id TEXT NOT NULL,
  priority TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
SQL
}

# seed_brief <brief_id> <status> [project]
seed_brief() {
  local bid="$1" st="$2" proj="${3:-$FIXTURE_PROJECT}"
  sqlite3 "$FIXTURE_DB" \
    "INSERT INTO brief_status (project, brief_id, title, status)
       VALUES ('$proj', '$bid', 'T $bid', '$(printf '%s' "$st" | sed "s/'/''/g")');"
}

run_validator() {
  run env BRAIN_DB="$FIXTURE_DB" PROJECT="$FIXTURE_PROJECT" bash "$VALIDATOR"
}

# assert_output_contains uses bash `=~` (a REGEX), so any expectation carrying
# `(`, `)` or `"` would be interpreted as a pattern rather than matched
# literally. These reports are full of `(2 row(s))`, so assert LITERALLY here.
assert_output_has() {
  local needle="$1"
  if [[ "$output" != *"$needle"* ]]; then
    echo "Expected output to contain (literal): $needle" >&2
    echo "Actual output: $output" >&2
    return 1
  fi
}

refute_output_has() {
  local needle="$1"
  if [[ "$output" == *"$needle"* ]]; then
    echo "Expected output NOT to contain (literal): $needle" >&2
    echo "Actual output: $output" >&2
    return 1
  fi
}

@test "validator is executable and shellcheck-clean" {
  [ -x "$VALIDATOR" ]
  if command -v shellcheck &> /dev/null; then
    run shellcheck "$VALIDATOR"
    assert_success
  else
    skip "shellcheck not available"
  fi
}

@test "parity: the six canonical statuses are present on BOTH sides, and there is no seventh" {
  # The THIRD bash mirror of a TS canonical array. Small enough to check
  # EXHAUSTIVELY in both directions, like the priority pair — so this IS a real
  # parity guard rather than the brief_type presence spot-check. TD-330 still
  # owes the generic element-for-element guard for all three.
  grep -q "CANONICAL_STATUSES" "$VALIDATOR" || return 1

  local ts="$IGRIS_ROOT/brain-mcp-server/src/tools/brief-normalize.ts"
  [ -f "$ts" ] || skip "brief-normalize.ts not present"

  local s
  for s in "Draft" "Ready" "In Progress" "Blocked" "Done" "Archived"; do
    grep -q "\"$s\"" "$VALIDATOR" || {
      echo "canonical status '$s' missing from the validator's array"
      return 1
    }
    grep -q "'$s'," "$ts" || {
      echo "canonical status '$s' missing from CANONICAL_STATUSES in brief-normalize.ts"
      return 1
    }
  done

  # Element COUNT parity, both directions — what catches an addition or a
  # removal on either side.
  local sh_count ts_count
  sh_count="$(sed -n '/^CANONICAL_STATUSES=(/,/^)/p' "$VALIDATOR" | grep -c '^  "')"
  ts_count="$(sed -n '/^export const CANONICAL_STATUSES = \[/,/^\] as const;/p' "$ts" | grep -c "^  '")"
  [ "$sh_count" -eq 6 ] || { echo "validator has $sh_count statuses, expected 6"; return 1; }
  [ "$ts_count" -eq 6 ] || { echo "brief-normalize.ts has $ts_count statuses, expected 6"; return 1; }
}

@test "documents WHY the three MISSING STATES are neither folded nor promoted" {
  # If this rationale is deleted, someone will "resolve" the standing WARN by
  # folding Cancelled to Archived (a STATE EDIT — TD-311) or by promoting all
  # three (a lifecycle change that sweeps board.ts and the reconciler).
  grep -q "Cancelled" "$VALIDATOR" || return 1
  grep -q "Superseded" "$VALIDATOR" || return 1
  grep -q "Deferred" "$VALIDATOR" || return 1
  grep -q "TD-311" "$VALIDATOR" || return 1
  grep -qi "STATE EDIT" "$VALIDATOR" || return 1
  # ...and the WARN must carry its own resolution path.
  grep -q "GAP_FOLLOW_UP" "$VALIDATOR" || return 1
}

@test "positive: an all-canonical DB passes and prints the distribution" {
  init_fixture_db
  seed_brief "FR-001" "Draft"
  seed_brief "FR-002" "Ready"
  seed_brief "FR-003" "In Progress"
  seed_brief "FR-004" "Blocked"
  seed_brief "FR-005" "Done"
  seed_brief "FR-006" "Archived"

  run_validator
  assert_success
  assert_output_contains "vocabulary clean"
  assert_output_contains "Distribution:"
  assert_output_has "In Progress"
  # A clean corpus must print NEITHER class header.
  refute_output_has "CLASS 1"
  refute_output_has "CLASS 2"
}

@test "negative: a Completed row is named with its count, in the STRAY class" {
  init_fixture_db
  seed_brief "FR-001" "Done"
  seed_brief "BR-001" "Completed"
  seed_brief "BR-002" "Completed"

  run_validator
  assert_failure
  assert_output_has "STRAY: \"Completed\" (2 row(s))"
  assert_output_has "1 non-canonical value(s), 2 row(s)"
  # It is a SPELLING, not a documented gap — the classes must not blur.
  refute_output_has "DOCUMENTED GAP: \"Completed\""
  refute_output_has "CLASS 1"
}

@test "the two classes are SPLIT in the output, each with its own count" {
  init_fixture_db
  seed_brief "FR-001" "Done"
  # class 1 — expected, decided
  seed_brief "TD-010" "Cancelled"
  seed_brief "TD-011" "Superseded"
  seed_brief "TD-012" "Deferred"
  # class 2 — wants a human now
  seed_brief "FR-054" "Split (see FR-061, FR-062, FR-063)"
  seed_brief "BR-128" "Done(Resolvedbydec8d1f)"

  run_validator
  assert_failure
  assert_output_has "CLASS 1 — DOCUMENTED GAP (3 value(s), 3 row(s))"
  assert_output_has "DOCUMENTED GAP: \"Cancelled\" (1 row(s))"
  assert_output_has "DOCUMENTED GAP: \"Superseded\" (1 row(s))"
  assert_output_has "DOCUMENTED GAP: \"Deferred\" (1 row(s))"
  assert_output_has "CLASS 2 — STRAY (2 value(s), 2 row(s))"
  assert_output_has "STRAY: \"Split (see FR-061, FR-062, FR-063)\" (1 row(s))"
  assert_output_has "STRAY: \"Done(Resolvedbydec8d1f)\" (1 row(s))"
  # The gap class must never appear under STRAY, or the split is decorative.
  refute_output_has "STRAY: \"Cancelled\""
  refute_output_has "DOCUMENTED GAP: \"Done(Resolvedbydec8d1f)\""
  assert_output_has "5 non-canonical value(s), 5 row(s)"
}

@test "the DOCUMENTED GAP class carries its resolution path, the STRAY class its own" {
  init_fixture_db
  seed_brief "TD-010" "Cancelled"
  seed_brief "BR-128" "Done(Resolvedbydec8d1f)"

  run_validator
  assert_failure
  # Class 1: the follow-up, and the two things NOT to do.
  assert_output_has "RESOLUTION -> the documented brief lifecycle has six states"
  assert_output_has "STATE EDIT"
  # Class 2: the fold-table route, and the payload route.
  assert_output_has "STATUS_ALIASES"
  assert_output_has "in the edge graph, never in the state"
  assert_output_contains "RETYPE the brief by hand"
}

@test "class 1 ALONE still exits 1 — an expected WARN is still a WARN" {
  init_fixture_db
  seed_brief "FR-001" "Done"
  seed_brief "TD-010" "Cancelled"

  run_validator
  assert_failure
  assert_output_has "CLASS 1"
  refute_output_has "CLASS 2"
}

@test "an EMPTY status is an offender (NOT NULL column has no unset member)" {
  # The priority/brief_type twins skip an empty first field in their read loop,
  # which would make this row INVISIBLE. status is TEXT NOT NULL, so an empty
  # value is a broken row, not an unset field — it must be NAMED.
  init_fixture_db
  seed_brief "FR-001" "Done"
  seed_brief "BR-500" ""

  run_validator
  assert_failure
  assert_output_has "STRAY: \"<EMPTY>\" (1 row(s))"
  assert_output_contains "TEXT NOT NULL"
}

@test "a whitespace-only status is an offender too" {
  init_fixture_db
  seed_brief "FR-001" "Done"
  seed_brief "BR-501" "   "

  run_validator
  assert_failure
  assert_output_has "STRAY: \"<EMPTY>\" (1 row(s))"
}

@test "case and notation variants are STRAY — this validator folds vocabulary, not notation" {
  # Deliberate divergence from the TD-340 SQL gates, which fold notation. A
  # vocabulary validator that silently accepted `done` would hide exactly the
  # drift it exists to report, and the fold table (STATUS_ALIASES) is what makes
  # `done` become `Done` at the write boundary.
  init_fixture_db
  seed_brief "FR-001" "Done"
  seed_brief "FR-002" "done"
  seed_brief "FR-003" "IN-PROGRESS"

  run_validator
  assert_failure
  assert_output_has "STRAY: \"done\" (1 row(s))"
  assert_output_has "STRAY: \"IN-PROGRESS\" (1 row(s))"
}

@test "scope: PROJECT unset scans ALL projects (accumulation is cross-project)" {
  init_fixture_db
  seed_brief "FR-001" "Done" "repo"
  seed_brief "BR-001" "Completed" "other-project"

  # PROJECT scoped to 'repo' -> the other project's offender is invisible.
  run env BRAIN_DB="$FIXTURE_DB" PROJECT="repo" bash "$VALIDATOR"
  assert_success
  assert_output_contains "vocabulary clean"

  # PROJECT unset -> all projects -> the offender surfaces. This matters more
  # here than for the two twins: the TD-257 reconciler is REPO-scoped and
  # structurally cannot see a project whose repo is not on this machine.
  run env BRAIN_DB="$FIXTURE_DB" PROJECT="" bash "$VALIDATOR"
  assert_failure
  assert_output_contains "all projects"
  assert_output_has "Completed"
}

@test "fail-open: a missing DB exits 0 silently (never blocks a commit)" {
  run env BRAIN_DB="$SCRATCH/does-not-exist.db" PROJECT="repo" bash "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "fail-open: an empty brief_status exits 0 silently" {
  init_fixture_db
  run_validator
  assert_success
  [ -z "$output" ]
}

@test "fail-open: a project slug with no rows exits 0 silently" {
  init_fixture_db
  seed_brief "FR-001" "Done" "repo"

  run env BRAIN_DB="$FIXTURE_DB" PROJECT="nonexistent-slug" bash "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "fail-open: sqlite3 simulated-absent exits 0 with no output" {
  init_fixture_db
  seed_brief "BR-001" "Completed"   # an offender that WOULD be reported

  # Simulate sqlite3 absence WITHOUT breaking the rest of PATH.
  local fakebin="$SCRATCH/curatedbin"
  mkdir -p "$fakebin"
  local cmd p
  for cmd in bash sh grep sed tr basename dirname cat env head printf; do
    p="$(command -v "$cmd" 2>/dev/null || true)"
    [ -n "$p" ] && ln -sf "$p" "$fakebin/$cmd"
  done

  run env PATH="$fakebin" BRAIN_DB="$FIXTURE_DB" PROJECT="$FIXTURE_PROJECT" \
    "$fakebin/bash" "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "read-only: the validator never writes to the DB" {
  init_fixture_db
  seed_brief "BR-001" "Completed"
  local before after
  before="$(sqlite3 "$FIXTURE_DB" "SELECT status FROM brief_status WHERE brief_id='BR-001';")"

  run_validator
  assert_failure

  after="$(sqlite3 "$FIXTURE_DB" "SELECT status FROM brief_status WHERE brief_id='BR-001';")"
  [ "$before" = "$after" ] || return 1
  [ "$after" = "Completed" ] || return 1
}
