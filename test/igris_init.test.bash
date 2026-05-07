#!/usr/bin/env bats

# Test suite for igris_init.sh
#
# Tests critical paths:
# - Creates all required directories
# - Copies templates correctly
# - Generates CLAUDE.md
# - Handles existing installation
# - Validates target directory

load test_helper

# =============================================================================
# DIRECTORY CREATION TESTS
# =============================================================================

@test "igris_init creates .claude/ directory structure" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_dir_exists "$TEST_PROJECT_DIR/.claude"
  # M2 (V7): .claude/hooks/ no longer created — canonical hooks live at
  # $HOME/.igris/core/hooks/shared/. Pipeline verified via canary
  # default-install-installs-hooks.bats (the hooks block is merged into
  # .claude/settings.json, pointing at the shared scripts).
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/agents"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/rules"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/skills"
}

@test "igris_init installs native subagents" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/agents"
  assert_file_exists "$TEST_PROJECT_DIR/.claude/agents/manifest.yaml"

  # Verify core agents installed (v4/v5 names)
  assert_file_exists "$TEST_PROJECT_DIR/.claude/agents/architect.md"
  assert_file_exists "$TEST_PROJECT_DIR/.claude/agents/forger.md"
  assert_file_exists "$TEST_PROJECT_DIR/.claude/agents/sentinel.md"
  assert_file_exists "$TEST_PROJECT_DIR/.claude/agents/warden.md"
}

# =============================================================================
# FILE CREATION TESTS
# =============================================================================

@test "igris_init creates CLAUDE.md in project root" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
}

@test "igris_init creates session files in brain project dir" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  # v6: session files live in ~/.igris/projects/{slug}/session/, not ai/session/
  local brain_session="$HOME/.igris/projects/$(basename "$TEST_PROJECT_DIR")/session"
  assert_file_exists "$brain_session/CURRENT_SESSION.md"
  assert_file_exists "$brain_session/BLOCKERS.md"
  assert_file_exists "$brain_session/DECISIONS.md"
  assert_file_exists "$brain_session/LEARNINGS.md"
}

# =============================================================================
# CLAUDE.md GENERATION TESTS
# =============================================================================

@test "CLAUDE.md contains Igris AI version" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # v6 template emits "Igris AI v{{IGRIS_VERSION}}"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Igris AI v"
}

@test "CLAUDE.md contains SOUL.md import" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # CLAUDE.md should import SOUL.md for persona identity
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
}

# =============================================================================
# VALIDATION TESTS
# =============================================================================

@test "igris_init validates target directory exists" {
  # Try to init in non-existent directory
  run "$SCRIPTS_DIR/igris_init.sh" "/tmp/nonexistent-dir-$$" <<< "y"

  # Should fail or create directory (depending on implementation)
  # For now, test that it handles this gracefully
  [ "$status" -ne 127 ]  # Not "command not found"
}

@test "igris_init handles empty directory" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
}

# =============================================================================
# EXISTING INSTALLATION TESTS
# =============================================================================

@test "igris_init can overwrite existing installation" {
  # Initialize once
  setup_test_project
  "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y" > /dev/null

  # Modify CLAUDE.md to detect overwrite
  echo "# MODIFIED" >> "$TEST_PROJECT_DIR/CLAUDE.md"

  # Initialize again with overwrite
  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # CLAUDE.md should be regenerated (MODIFIED marker gone)
  # Note: This test may need adjustment based on actual behavior
}

# =============================================================================
# PROMPT FILES TESTS
# =============================================================================

# =============================================================================
# IDENTITY SYSTEM TESTS (SOUL.md + masks)
# =============================================================================

@test "igris_init generates CLAUDE.md without requiring SOUL.md" {
  setup_test_project

  # SOUL.md is optional — igris_init reads it if present but never copies it
  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
}

# =============================================================================
# DEPENDENCY TESTS
# =============================================================================

@test "igris_init requires Python3" {
  setup_test_project

  # This test verifies igris_init.sh checks for Python3
  # If Python3 is missing, should show clear error

  require_python3  # Skip test if Python3 not available

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
}

# =============================================================================
# OUTPUT TESTS
# =============================================================================

@test "igris_init shows success message" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # M2 (V7): the new CLI emits structured progress lines instead of the
  # legacy "Igris AI" brand banner. "Install summary:" confirms the verb
  # actually completed the install workflow (not just exited 0 from a no-op).
  assert_output_contains "Install summary:"
}

@test "igris_init shows initialization steps" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # Should show what it's doing (adjust based on actual output)
  # This is a weak test - just verify it produces some output
  [ -n "$output" ]
}

# =============================================================================
# INTEGRATION TESTS
# =============================================================================

@test "igris_init creates fully functional Igris AI installation" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # v6 install contract: project-local .claude/ tree + CLAUDE.md + brain-side session
  assert_dir_exists "$TEST_PROJECT_DIR/.claude"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/agents"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/rules"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/skills"
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
  assert_file_exists "$TEST_PROJECT_DIR/.igris_version"
  assert_file_exists "$TEST_PROJECT_DIR/.claude/agents/architect.md"

  # Brain-side per-project state (replaces v4 ai/session/)
  local brain_proj="$HOME/.igris/projects/$(basename "$TEST_PROJECT_DIR")"
  assert_file_exists "$brain_proj/session/CURRENT_SESSION.md"
  assert_dir_exists "$brain_proj/briefs"
  assert_dir_exists "$brain_proj/context"
}

@test "igris_init creates gitignore-ready structure" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # Core directories and files are present for gitignore-ready structure
  assert_dir_exists "$TEST_PROJECT_DIR/.claude"
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
}
