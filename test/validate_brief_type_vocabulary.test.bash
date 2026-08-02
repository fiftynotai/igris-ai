#!/usr/bin/env bats

# Tests for scripts/validate_brief_type_vocabulary.sh (TD-328).
#
# The validator reads brief_status.brief_type from a brain DB, prints the
# distinct-value distribution, and names every value that is not one of the
# canonical types. It is the D6(d) ACCUMULATION observer — the companion to the
# write-boundary echo, which catches MINTING. Together they are the reporting
# surface that keeps read-widen (memory #228) from becoming permanent silence.
#
# It is fail-open (exit 0 silent) when sqlite3/DB absent or no rows, and honors
# BRAIN_DB / PROJECT env overrides for test injection. Each test builds a
# throwaway brain DB so the live DB is never touched.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_brief_type_vocabulary.sh"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"

  SCRATCH="$TEST_TEMP_DIR/brieftype_$BATS_TEST_NUMBER"
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
  brief_type TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
SQL
}

# seed_brief <brief_id> <brief_type|NULL> [project]
seed_brief() {
  local bid="$1" btype="$2" proj="${3:-$FIXTURE_PROJECT}"
  if [ "$btype" = "NULL" ]; then
    sqlite3 "$FIXTURE_DB" \
      "INSERT INTO brief_status (project, brief_id, brief_type, title, status)
         VALUES ('$proj', '$bid', NULL, 'T $bid', 'Ready');"
  else
    sqlite3 "$FIXTURE_DB" \
      "INSERT INTO brief_status (project, brief_id, brief_type, title, status)
         VALUES ('$proj', '$bid', '$btype', 'T $bid', 'Ready');"
  fi
}

run_validator() {
  run env BRAIN_DB="$FIXTURE_DB" PROJECT="$FIXTURE_PROJECT" bash "$VALIDATOR"
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

@test "literal-pin: the TD-328 canonical additions are present on BOTH sides (NOT a full parity check)" {
  # SCOPE, STATED HONESTLY: this greps 12 literals out of the validator and 3
  # out of the TS file. It CANNOT detect a type added to either side, the
  # removal of the nine pre-existing members, or an order change. It is a
  # presence spot-check, not the element-for-element parity guard that
  # CANONICAL_PHASES has (test/validate_canonical_phase_parity.test.bash).
  # Building that real guard is TD-330's job, not this file's.
  grep -q "CANONICAL_BRIEF_TYPES" "$VALIDATOR"
  for t in "Feature" "Bug" "Migration" "Technical Debt" "Testing" \
           "Process Improvement" "Documentation" "Acceptance" "Performance" \
           "Architecture" "Dependency Update" "Refactor"; do
    grep -q "\"$t\"" "$VALIDATOR" || {
      echo "canonical type '$t' missing from the validator's array"
      return 1
    }
  done

  # And the TS source must carry exactly the same members.
  local ts="$IGRIS_ROOT/brain-mcp-server/src/tools/brief-normalize.ts"
  [ -f "$ts" ] || skip "brief-normalize.ts not present"
  for t in "Architecture" "Dependency Update" "Refactor"; do
    grep -q "'$t'," "$ts" || {
      echo "canonical type '$t' missing from CANONICAL_BRIEF_TYPES in brief-normalize.ts"
      return 1
    }
  done
}

@test "literal-pin: the Refactor no-mint-prefix exception is documented in the validator" {
  # The operator DECLINED an RF- prefix, so the canonical set is deliberately
  # NOT exactly the image of the /register prefix map. If this rationale is
  # deleted, someone will "correct" Refactor back out by applying the rule.
  grep -q "DELIBERATE EXCEPTION" "$VALIDATOR"
  grep -q "Refactor" "$VALIDATOR"
  grep -qi "declined" "$VALIDATOR"
}

@test "positive: an all-canonical DB passes and prints the distribution" {
  init_fixture_db
  seed_brief "FR-001" "Feature"
  seed_brief "TD-001" "Technical Debt"
  seed_brief "AC-001" "Architecture"
  seed_brief "DU-001" "Dependency Update"
  seed_brief "BR-010" "Refactor"

  run_validator
  assert_success
  assert_output_contains "vocabulary clean"
  assert_output_contains "Distribution:"
  assert_output_contains "Technical Debt"
}

@test "positive: NULL types do not count as non-canonical (unset is not a bad spelling)" {
  init_fixture_db
  seed_brief "FR-001" "Feature"
  seed_brief "BR-900" "NULL"

  run_validator
  assert_success
  assert_output_contains "vocabulary clean"
  assert_output_contains "with no type"
}

@test "negative: a new spelling is NAMED and exits 1 (AC-5 — visible, not silent)" {
  init_fixture_db
  seed_brief "FR-001" "Feature"
  seed_brief "BR-050" "Frobnicate"

  run_validator
  assert_failure
  assert_output_contains "NON-CANONICAL"
  assert_output_contains "Frobnicate"
  # And it tells the committer what to do about it.
  assert_output_contains "BRIEF_TYPE_ALIASES"
}

@test "negative: the pre-TD-328 spelling zoo is fully surfaced" {
  init_fixture_db
  seed_brief "TD-001" "TechDebt"
  seed_brief "TD-002" "Debt"
  seed_brief "FR-001" "Feature Request"
  seed_brief "BR-001" "Bug Fix / Compliance"

  run_validator
  assert_failure
  assert_output_contains "TechDebt"
  assert_output_contains "Debt"
  assert_output_contains "Feature Request"
  assert_output_contains "Bug Fix / Compliance"
}

@test "D4 tripwire: fires when compound values exceed 5% of the corpus" {
  init_fixture_db
  # 4 compounds out of 10 rows = 40%.
  seed_brief "BR-001" "Bug Fix / Compliance"
  seed_brief "BR-002" "Feature / Demo"
  seed_brief "BR-003" "Bug (pub.dev Score)"
  seed_brief "BR-004" "Feature(Rebrand)"
  for i in 1 2 3 4 5 6; do seed_brief "FR-00$i" "Feature"; done

  run_validator
  assert_failure
  assert_output_contains "D4 ESCALATION TRIPWIRE"
  assert_output_contains "brief_subtype"
}

@test "D4 tripwire: stays quiet below the threshold" {
  init_fixture_db
  seed_brief "BR-001" "Bug Fix / Compliance"
  for i in $(seq 1 40); do seed_brief "FR-$i" "Feature"; done

  run_validator
  # Still exits 1 for the one non-canonical compound, but no tripwire.
  assert_failure
  run bash -c "echo '$output' | grep 'ESCALATION TRIPWIRE' || true"
  [ -z "$output" ]
}

@test "fail-open: nonexistent BRAIN_DB path exits 0 with no output" {
  run env BRAIN_DB="$SCRATCH/does-not-exist.db" PROJECT="$FIXTURE_PROJECT" \
    bash "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "fail-open: empty DB (no rows for project) exits 0 with no output" {
  init_fixture_db
  run_validator
  assert_success
  [ -z "$output" ]
}

@test "fail-open: sqlite3 simulated-absent exits 0 with no output" {
  init_fixture_db
  seed_brief "BR-050" "Frobnicate"   # a value that WOULD flag

  # Simulate sqlite3 absence WITHOUT breaking the rest of PATH: a curated bin
  # dir symlinking every command the validator + bash need EXCEPT sqlite3.
  local fakebin="$SCRATCH/curatedbin"
  mkdir -p "$fakebin"
  for cmd in bash sh grep sed tr basename dirname realpath cat env head printf; do
    local p
    p="$(command -v "$cmd" 2>/dev/null || true)"
    [ -n "$p" ] && ln -sf "$p" "$fakebin/$cmd"
  done

  run env PATH="$fakebin" BRAIN_DB="$FIXTURE_DB" PROJECT="$FIXTURE_PROJECT" \
    "$fakebin/bash" "$VALIDATOR"
  assert_success
  [ -z "$output" ]
}

@test "env override: PROJECT scopes the query (other projects ignored)" {
  init_fixture_db
  seed_brief "BR-700" "Frobnicate" "other-proj"
  seed_brief "FR-701" "Feature"

  run_validator
  assert_success
  assert_output_contains "vocabulary clean"
}

@test "no PROJECT override scans ALL projects (accumulation is cross-project)" {
  init_fixture_db
  seed_brief "BR-700" "Frobnicate" "other-proj"
  seed_brief "FR-701" "Feature"

  run env BRAIN_DB="$FIXTURE_DB" PROJECT="" bash "$VALIDATOR"
  assert_failure
  assert_output_contains "all projects"
  assert_output_contains "Frobnicate"
}

@test "pre-commit integration: a non-canonical value WARNs but does NOT block" {
  # Mirrors the hook's WARN downgrade: the validator exits 1 internally, but the
  # hook block must still exit 0.
  init_fixture_db
  seed_brief "BR-050" "Frobnicate"

  run env BRAIN_DB="$FIXTURE_DB" PROJECT="$FIXTURE_PROJECT" \
    bash -c '
      if ! bash "'"$VALIDATOR"'"; then
        echo "[pre-commit] brief_type vocabulary drift surfaced above (WARN only — not blocking)."
      fi
      exit 0
    '
  assert_success
  assert_output_contains "Frobnicate"
  assert_output_contains "WARN only"
}
