#!/usr/bin/env bats

# Test suite for edge cases across Igris AI scripts
#
# Tests edge cases:
# - Special characters in paths and names
# - Whitespace handling
# - Unusual but valid inputs

load test_helper

# =============================================================================
# SPECIAL CHARACTER TESTS
# =============================================================================

@test "igris_init handles directory path with spaces" {
  # Create directory with spaces in name
  mkdir -p "$TEST_TEMP_DIR/project with spaces"

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_TEMP_DIR/project with spaces" <<< "y"

  assert_success
  assert_dir_exists "$TEST_TEMP_DIR/project with spaces/.claude"
  assert_file_exists "$TEST_TEMP_DIR/project with spaces/CLAUDE.md"
}

@test "igris_init handles directory path with hyphens" {
  mkdir -p "$TEST_TEMP_DIR/my-test-project"

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_TEMP_DIR/my-test-project" <<< "y"

  assert_success
  assert_dir_exists "$TEST_TEMP_DIR/my-test-project/.claude"
}

@test "igris_init handles directory path with underscores" {
  mkdir -p "$TEST_TEMP_DIR/my_test_project"

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_TEMP_DIR/my_test_project" <<< "y"

  assert_success
  assert_dir_exists "$TEST_TEMP_DIR/my_test_project/.claude"
}
