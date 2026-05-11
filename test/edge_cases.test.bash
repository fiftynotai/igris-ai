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

@test "igris_init rejects slug with spaces (v7 hardened validation)" {
  # M2 (V7): the new CLI hardens slug validation in cli/src/verbs/install.ts
  # (SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/). Old igris_install.sh
  # silently accepted spaces in slugs, which always caused DB row collisions
  # and path-quoting issues downstream. The new behavior — rejecting these
  # at install time with a clear error — is the correct one.
  mkdir -p "$TEST_TEMP_DIR/project with spaces"

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_TEMP_DIR/project with spaces" <<< "y"

  assert_failure
  assert_output_contains "Invalid slug"
  assert_output_contains "must match"
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
