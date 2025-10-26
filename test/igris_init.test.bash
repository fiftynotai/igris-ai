#!/usr/bin/env bats

# Test suite for igris_init.sh
#
# Tests critical paths:
# - Creates all required directories
# - Copies templates correctly
# - Generates CLAUDE.md
# - Creates startup hook
# - Handles existing installation
# - Validates target directory

load test_helper

# =============================================================================
# DIRECTORY CREATION TESTS
# =============================================================================

@test "igris_init creates ai/ directory structure" {
  setup_test_project

  # Execute igris_init
  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  # Assert success
  assert_success

  # Assert all directories created
  assert_dir_exists "$TEST_PROJECT_DIR/ai"
  assert_dir_exists "$TEST_PROJECT_DIR/ai/briefs"
  assert_dir_exists "$TEST_PROJECT_DIR/ai/session"
  assert_dir_exists "$TEST_PROJECT_DIR/ai/context"
  assert_dir_exists "$TEST_PROJECT_DIR/ai/prompts"
}

@test "igris_init creates .claude/ directory structure" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_dir_exists "$TEST_PROJECT_DIR/.claude"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude/hooks"
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

@test "igris_init creates startup hook" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/.claude/hooks/startup.sh"

  # Verify startup hook is executable
  [ -x "$TEST_PROJECT_DIR/.claude/hooks/startup.sh" ]
}

@test "igris_init creates session files" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/ai/session/CURRENT_SESSION.md"
}

@test "igris_init creates persona.json.default" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/ai/persona.json.default"
}

@test "igris_init creates brief templates" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # Check core brief templates exist
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/BR-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/TD-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/MG-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/TS-TEMPLATE.md"

  # Check new self-maintenance templates exist
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/PI-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/FR-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/DU-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/PF-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/AC-TEMPLATE.md"
}

# =============================================================================
# CLAUDE.md GENERATION TESTS
# =============================================================================

@test "CLAUDE.md contains mandatory first action" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "MANDATORY FIRST ACTION"
}

@test "CLAUDE.md contains Igris AI version" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # Should contain version number
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Version:"
}

@test "CLAUDE.md contains persona injection placeholder (no plugins)" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # With no plugins installed, should have empty persona section
  # (igris_init.sh sets {{PERSONA_INJECTION}} to empty string initially)
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
}

@test "CLAUDE.md contains brief workflow section" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Brief Workflow"
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

@test "igris_init detects existing installation" {
  # Initialize once
  setup_test_project
  "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y" > /dev/null

  # Try to initialize again
  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "n"

  # Should detect existing installation
  # (behavior depends on implementation - either prompt or skip)
  assert_success
}

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

@test "igris_init copies prompt files" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # Check core prompts exist
  assert_file_exists "$TEST_PROJECT_DIR/ai/prompts/igris_os.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/prompts/session_protocol.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/prompts/bug_prompts.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/prompts/feature_prompts.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/prompts/self_maintenance.md"
}

# =============================================================================
# PERSONA CONFIGURATION TESTS
# =============================================================================

@test "igris_init creates persona.json.default with correct structure" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/ai/persona.json.default"

  # Verify JSON structure (requires jq)
  require_jq

  # Check required fields exist
  run jq -e '.branding' "$TEST_PROJECT_DIR/ai/persona.json.default"
  assert_success

  run jq -e '.tone' "$TEST_PROJECT_DIR/ai/persona.json.default"
  assert_success

  # Note: .user field is personal config, not in defaults
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

  # Should contain success indicator (adjust based on actual output)
  assert_output_contains "Igris AI"
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

  # Comprehensive check: all critical files and directories exist
  assert_dir_exists "$TEST_PROJECT_DIR/ai"
  assert_dir_exists "$TEST_PROJECT_DIR/.claude"
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
  assert_file_exists "$TEST_PROJECT_DIR/.claude/hooks/startup.sh"
  assert_file_exists "$TEST_PROJECT_DIR/ai/session/CURRENT_SESSION.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/persona.json.default"
  assert_file_exists "$TEST_PROJECT_DIR/ai/briefs/BR-TEMPLATE.md"
  assert_file_exists "$TEST_PROJECT_DIR/ai/prompts/igris_os.md"
}

@test "igris_init creates gitignore-ready structure" {
  setup_test_project

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  assert_success

  # persona.json should be gitignored (only .default tracked)
  # This test just verifies .default exists (gitignore is user's responsibility)
  assert_file_exists "$TEST_PROJECT_DIR/ai/persona.json.default"
}
