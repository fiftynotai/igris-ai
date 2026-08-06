#!/usr/bin/env bats

# Tests for scripts/validate_brief_priority_vocabulary.sh (TD-338).
#
# The validator reads brief_status.priority from a brain DB, prints the
# distinct-value distribution, and names every value that is not one of the four
# canonical priorities. It is the priority TWIN of the TD-328 brief_type
# validator — the observer `priority` never had, which is why a `P4-Trivial`
# sat unnoticed until a hand census found it.
#
# It is fail-open (exit 0 silent) when sqlite3/DB absent or no rows, and honors
# BRAIN_DB / PROJECT env overrides for test injection. Each test builds a
# throwaway brain DB so the live DB is never touched.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_priority_vocabulary.sh"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  SCRATCH="$TEST_TEMP_DIR/briefpriority_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
  FIXTURE_DB="$SCRATCH/knowledge.db"
  FIXTURE_PROJECT="repo"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

# Minimal brief_status table mirroring the columns the validator SELECTs.
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

# seed_brief <brief_id> <priority|NULL> [project]
seed_brief() {
  local bid="$1" prio="$2" proj="${3:-$FIXTURE_PROJECT}"
  if [ "$prio" = "NULL" ]; then
    sqlite3 "$FIXTURE_DB" \
      "INSERT INTO brief_status (project, brief_id, priority, title, status)
         VALUES ('$proj', '$bid', NULL, 'T $bid', 'Ready');"
  else
    sqlite3 "$FIXTURE_DB" \
      "INSERT INTO brief_status (project, brief_id, priority, title, status)
         VALUES ('$proj', '$bid', '$prio', 'T $bid', 'Ready');"
  fi
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

@test "validator is executable and shellcheck-clean" {
  [ -x "$VALIDATOR" ]
  if command -v shellcheck &> /dev/null; then
    run shellcheck "$VALIDATOR"
    assert_success
  else
    skip "shellcheck not available"
  fi
}

@test "parity: the four canonical priorities are present on BOTH sides, and there is no fifth" {
  # The priority set is small enough to check EXHAUSTIVELY in both directions,
  # so this IS a real parity guard. It is nonetheless WEAKER than the
  # element-identical guards CANONICAL_PHASES (TD-257) and CANONICAL_BRIEF_TYPES
  # (TD-330) have — a count + membership check sees an add or a delete but
  # cannot see a rename or a swap of two members. Upgrading this pair is TD-356.
  grep -q "CANONICAL_PRIORITIES" "$VALIDATOR"

  local ts="$IGRIS_ROOT/brain-mcp-server/src/tools/brief-normalize.ts"
  [ -f "$ts" ] || skip "brief-normalize.ts not present"

  for p in "P0-Critical" "P1-High" "P2-Medium" "P3-Low"; do
    grep -q "\"$p\"" "$VALIDATOR" || {
      echo "canonical priority '$p' missing from the validator's array"
      return 1
    }
    grep -q "'$p'," "$ts" || {
      echo "canonical priority '$p' missing from CANONICAL_PRIORITIES in brief-normalize.ts"
      return 1
    }
  done

  # Element COUNT parity, both directions — this is what catches an addition or
  # a removal on either side. It does NOT catch a rename or a swap; the
  # element-identical guards (TD-257's phases, TD-330's brief_type) do. TD-356
  # tracks bringing this pair up to that standard.
  local sh_count ts_count
  sh_count="$(sed -n '/^CANONICAL_PRIORITIES=(/,/^)/p' "$VALIDATOR" | grep -c '^  "')"
  ts_count="$(sed -n '/^export const CANONICAL_PRIORITIES = \[/,/^\] as const;/p' "$ts" | grep -c "^  '")"
  [ "$sh_count" -eq 4 ] || { echo "validator has $sh_count priorities, expected 4"; return 1; }
  [ "$ts_count" -eq 4 ] || { echo "brief-normalize.ts has $ts_count priorities, expected 4"; return 1; }
}

@test "documents that P4-Trivial is REPORTED, never folded and never adopted" {
  # If this rationale is deleted, someone will "resolve" the report by folding
  # P4-Trivial to P3-Low (inventing) or adopting it as a 5th canonical value
  # (a silent FR-247 picker-mirror break).
  grep -q "P4-Trivial" "$VALIDATOR"
  grep -qi "inventing" "$VALIDATOR"
  grep -q "FR-247" "$VALIDATOR"
}

@test "positive: an all-canonical DB passes and prints the distribution" {
  init_fixture_db
  seed_brief "FR-001" "P0-Critical"
  seed_brief "TD-001" "P1-High"
  seed_brief "TD-002" "P2-Medium"
  seed_brief "BR-010" "P3-Low"

  run_validator
  assert_success
  assert_output_contains "vocabulary clean"
  assert_output_contains "Distribution:"
  assert_output_contains "P2-Medium"
}

@test "positive: NULL priority is UNSET, not an offender" {
  init_fixture_db
  seed_brief "FR-001" "P1-High"
  seed_brief "BR-900" "NULL"

  run_validator
  assert_success
  assert_output_contains "vocabulary clean"
  assert_output_has "unset (NULL)"
}

@test "negative: a bare P2 is NAMED with its row count and exits 1" {
  init_fixture_db
  seed_brief "FR-001" "P1-High"
  seed_brief "TD-277" "P2"
  seed_brief "TD-278" "P2"

  run_validator
  assert_failure
  assert_output_has "NON-CANONICAL: \"P2\" (2 row(s))"
  assert_output_has "1 non-canonical value(s), 2 row(s)"
}

@test "negative: P4-Trivial is named, and the report tells the human to RETYPE it" {
  init_fixture_db
  seed_brief "FR-001" "P1-High"
  seed_brief "TD-002" "P4-Trivial"

  run_validator
  assert_failure
  assert_output_has "NON-CANONICAL: \"P4-Trivial\" (1 row(s))"
  assert_output_contains "RETYPE the brief by hand"
  # It must NOT suggest folding it to a neighbour.
  assert_output_has "Do NOT fold it to a neighbour"
}

@test "negative: multiple offenders are each named with their own counts" {
  init_fixture_db
  seed_brief "FR-001" "P1-High"
  seed_brief "TD-277" "P2"
  seed_brief "BR-045" "P1"
  seed_brief "TD-002" "P4-Trivial"

  run_validator
  assert_failure
  assert_output_has "3 non-canonical value(s), 3 row(s)"
  assert_output_has "\"P2\""
  assert_output_has "\"P1\""
  assert_output_has "\"P4-Trivial\""
}

@test "scope: PROJECT unset scans ALL projects (accumulation is cross-project)" {
  init_fixture_db
  seed_brief "FR-001" "P1-High" "repo"
  seed_brief "TD-002" "P4-Trivial" "other-project"

  # PROJECT scoped to 'repo' -> the other project's offender is invisible.
  run env BRAIN_DB="$FIXTURE_DB" PROJECT="repo" bash "$VALIDATOR"
  assert_success
  assert_output_contains "vocabulary clean"

  # PROJECT unset -> all projects -> the offender surfaces.
  run env BRAIN_DB="$FIXTURE_DB" PROJECT="" bash "$VALIDATOR"
  assert_failure
  assert_output_contains "all projects"
  assert_output_contains "P4-Trivial"
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
  seed_brief "FR-001" "P1-High" "repo"

  run env BRAIN_DB="$FIXTURE_DB" PROJECT="nonexistent-slug" bash "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "read-only: the validator never writes to the DB" {
  init_fixture_db
  seed_brief "TD-277" "P2"
  local before after
  before="$(sqlite3 "$FIXTURE_DB" "SELECT priority FROM brief_status WHERE brief_id='TD-277';")"

  run_validator
  assert_failure

  after="$(sqlite3 "$FIXTURE_DB" "SELECT priority FROM brief_status WHERE brief_id='TD-277';")"
  [ "$before" = "$after" ]
  [ "$after" = "P2" ]
}
