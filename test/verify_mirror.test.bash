#!/usr/bin/env bats

# verify_mirror.test.bash - Tests for core/scripts/verify_mirror.sh
#
# Created in response to BR-062. The primitive's contract is:
#   - Every pair gets a self-evidencing block (realpath, command, RC, output, verdict).
#   - Exit 0 only when all pairs MATCH.
#   - Exit 1 on any MISMATCH | MISSING | SAME_INODE | ERROR.
#   - Exit 2 on usage errors.
#   - SAME_INODE (path == path) is a hard FAIL, not a PASS.
#
# These tests cover the 7 scenarios in the architect's plan plus the
# self-evidencing assertion that proves the report includes evidence.

load test_helper

setup() {
  # Path to the primitive under test (repo path, not deployed path —
  # tests run against the source per architect's recommendation Q6).
  VERIFY_MIRROR="$IGRIS_ROOT/core/scripts/verify_mirror.sh"
  FIXTURES="$IGRIS_ROOT/test/fixtures/mirror_check"

  # Sanity: primitive exists and is executable.
  [ -x "$VERIFY_MIRROR" ] || skip "verify_mirror.sh missing or not executable at $VERIFY_MIRROR"
  [ -d "$FIXTURES/source" ] || skip "fixture source/ missing at $FIXTURES"
  [ -d "$FIXTURES/deployed" ] || skip "fixture deployed/ missing at $FIXTURES"

  # Per-test scratch space for SAME_INODE cases (test_helper only sets
  # TEST_TEMP_DIR globally; we want test isolation).
  SCRATCH="$TEST_TEMP_DIR/verify_mirror_$BATS_TEST_NUMBER"
  mkdir -p "$SCRATCH"
}

teardown() {
  [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
}

@test "test_all_pairs_match: two MATCH pairs yield exit 0" {
  run "$VERIFY_MIRROR" \
    "$FIXTURES/source/a.txt" "$FIXTURES/deployed/a.txt" \
    "$FIXTURES/source/c.txt" "$FIXTURES/deployed/c.txt"

  [ "$status" -eq 0 ]
  # Both pairs reported MATCH.
  [[ "$output" == *"verdict:    MATCH"* ]]
  # Summary shows 2 MATCH, 0 of everything else.
  [[ "$output" == *"SUMMARY: 2 pairs — 2 MATCH, 0 MISMATCH, 0 MISSING, 0 SAME_INODE, 0 ERROR"* ]]
}

@test "test_single_mismatch_fails_overall: one MATCH + one MISMATCH yields exit 1" {
  run "$VERIFY_MIRROR" \
    "$FIXTURES/source/a.txt" "$FIXTURES/deployed/a.txt" \
    "$FIXTURES/source/b.txt" "$FIXTURES/deployed/b.txt"

  [ "$status" -eq 1 ]
  # Both verdicts present.
  [[ "$output" == *"verdict:    MATCH"* ]]
  [[ "$output" == *"verdict:    MISMATCH"* ]]
  # Summary shows the split.
  [[ "$output" == *"SUMMARY: 2 pairs — 1 MATCH, 1 MISMATCH, 0 MISSING, 0 SAME_INODE, 0 ERROR"* ]]
  # Mismatched pair shows a diff sample.
  [[ "$output" == *"sample:"* ]]
}

@test "test_missing_file_reported: missing target yields MISSING verdict and exit 1" {
  # source/d.txt exists; deployed/d.txt is intentionally absent in fixtures.
  run "$VERIFY_MIRROR" \
    "$FIXTURES/source/d.txt" "$FIXTURES/deployed/d.txt"

  [ "$status" -eq 1 ]
  [[ "$output" == *"verdict:    MISSING"* ]]
  [[ "$output" == *"SUMMARY: 1 pairs — 0 MATCH, 0 MISMATCH, 1 MISSING, 0 SAME_INODE, 0 ERROR"* ]]
}

@test "test_same_inode_caught: comparing a path to itself is a hard FAIL" {
  # Create a file in scratch and pass its path twice.
  local p="$SCRATCH/identical.txt"
  echo "this is a single file" > "$p"

  run "$VERIFY_MIRROR" "$p" "$p"

  [ "$status" -eq 1 ]
  [[ "$output" == *"verdict:    SAME_INODE"* ]]
  [[ "$output" == *"SUMMARY: 1 pairs — 0 MATCH, 0 MISMATCH, 0 MISSING, 1 SAME_INODE, 0 ERROR"* ]]
}

@test "test_odd_arg_count_usage_error: 3 args yields exit 2" {
  run "$VERIFY_MIRROR" "a" "b" "c"

  [ "$status" -eq 2 ]
  # Stderr/stdout merged by bats `run`; usage message must appear.
  [[ "$output" == *"arg count must be even"* ]]
}

@test "test_self_evidencing_output_contains_command: report includes command + exit code" {
  # The whole point of BR-062: every pair's block must show the command run
  # and its exit code so the verdict is auditable, not narrative.
  run "$VERIFY_MIRROR" \
    "$FIXTURES/source/a.txt" "$FIXTURES/deployed/a.txt"

  [ "$status" -eq 0 ]
  [[ "$output" == *"realpath A:"* ]]
  [[ "$output" == *"realpath B:"* ]]
  [[ "$output" == *"command:"* ]]
  [[ "$output" == *"exit code:"* ]]
  [[ "$output" == *"verdict:"* ]]
}

@test "test_summary_line_present: final line is the SUMMARY aggregate" {
  run "$VERIFY_MIRROR" \
    "$FIXTURES/source/a.txt" "$FIXTURES/deployed/a.txt"

  [ "$status" -eq 0 ]
  # Last non-empty line begins with "SUMMARY: " and reports a pair count.
  local last_line
  last_line=$(echo "$output" | grep -E "^SUMMARY:" | tail -1)
  [ -n "$last_line" ]
  [[ "$last_line" == "SUMMARY: 1 pairs"* ]]
}
