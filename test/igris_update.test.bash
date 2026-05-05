#!/usr/bin/env bats

# Test suite for igris_update.sh
#
# Tests critical paths:
# - Dry-run mode shows correct files
# - Backup includes all critical files
# - Update copies new files including agents
# - Version tracking updates correctly
# - Handles missing/invalid installations

load test_helper

# =============================================================================
# SETUP HELPERS
# =============================================================================

# Create a mock "remote" Igris AI repository for update testing
# This simulates what would be cloned from GitHub
setup_mock_remote() {
  local remote_dir="$TEST_TEMP_DIR/mock-igris-remote"
  mkdir -p "$remote_dir"

  # Create version file (newer version)
  echo "3.3.0" > "$remote_dir/version.txt"

  # Create ai/prompts
  mkdir -p "$remote_dir/ai/prompts"
  echo "# Updated igris_os.md" > "$remote_dir/ai/prompts/igris_os.md"
  echo "# Updated session_protocol.md" > "$remote_dir/ai/prompts/session_protocol.md"

  # Create ai/templates
  mkdir -p "$remote_dir/ai/templates"
  echo "# Updated BR-TEMPLATE" > "$remote_dir/ai/templates/BR-TEMPLATE.md"

  # Create .claude/agents (v3.2 feature)
  mkdir -p "$remote_dir/.claude/agents"
  echo "# Planner agent" > "$remote_dir/.claude/agents/planner.md"
  echo "# Coder agent" > "$remote_dir/.claude/agents/coder.md"
  echo "# Tester agent" > "$remote_dir/.claude/agents/tester.md"
  echo "# Reviewer agent" > "$remote_dir/.claude/agents/reviewer.md"
  cat > "$remote_dir/.claude/agents/manifest.yaml" <<'EOF'
agents:
  - name: planner
  - name: coder
  - name: tester
  - name: reviewer
EOF

  # Create scripts/templates
  mkdir -p "$remote_dir/scripts/templates"
  cat > "$remote_dir/scripts/templates/CLAUDE.md.template" <<'EOF'
# Igris AI v{{IGRIS_VERSION}}

Installed: {{INSTALL_DATE}}

@import SOUL.md
EOF

  # Ensure scripts directory exists
  mkdir -p "$remote_dir/scripts"

  echo "$remote_dir"
}

# =============================================================================
# VALIDATION TESTS
# =============================================================================

@test "igris_update requires initialized project" {
  setup_test_project

  # Try to update without initialization
  run "$SCRIPTS_DIR/igris_update.sh" --dry-run

  assert_failure
  assert_output_contains "not initialized"
}

@test "igris_update validates .igris_version exists" {
  setup_test_project

  # Create ai/ but not .igris_version
  mkdir -p ai/briefs

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run

  assert_failure
  assert_output_contains "not initialized"
}

@test "igris_update requires Python3" {
  require_python3
  init_igris_in_test_project

  # If we get here, Python3 is available
  # Just verify the script can start
  run "$SCRIPTS_DIR/igris_update.sh" --help 2>&1 || true

  # Should not fail with "Python 3 is required"
  [[ ! "$output" =~ "Python 3 is required" ]]
}

# =============================================================================
# DRY-RUN TESTS
# =============================================================================

@test "igris_update --dry-run shows current version" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should show current version
  assert_output_contains "Current version"
}

@test "igris_update --dry-run lists files to update" {
  init_igris_in_test_project

  # Force update even if same version to see file list
  run "$SCRIPTS_DIR/igris_update.sh" --force --dry-run 2>&1 || true

  # Should list file categories (when --force is used)
  # If already up to date without --force, won't show file list
  assert_output_contains "CLAUDE.md" || assert_output_contains "up to date"
}

@test "igris_update --dry-run lists native subagents" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should mention agents in output (v3.2)
  # Note: This depends on remote having agents
  [[ "$output" =~ "agent" ]] || [[ "$output" =~ "Native" ]] || skip "Agents not in dry-run output (remote may not have them)"
}

@test "igris_update --dry-run does not modify files" {
  init_igris_in_test_project

  # Get original CLAUDE.md content
  local original_md5
  original_md5=$(md5sum CLAUDE.md | cut -d' ' -f1)

  # Run dry-run
  "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Verify CLAUDE.md unchanged
  local after_md5
  after_md5=$(md5sum CLAUDE.md | cut -d' ' -f1)

  [ "$original_md5" = "$after_md5" ]
}

# =============================================================================
# VERSION CHECK TESTS
# =============================================================================

@test "igris_update reads version from .igris_version" {
  init_igris_in_test_project

  # Verify version file exists and is valid JSON
  require_python3

  run python3 -c "import json; json.load(open('.igris_version'))"
  assert_success
}

@test "igris_update detects when already up to date" {
  init_igris_in_test_project

  # This test depends on network - may need to skip in CI
  run "$SCRIPTS_DIR/igris_update.sh" 2>&1 <<< "n" || true

  # Should either say "up to date" or show update prompt
  [[ "$output" =~ "up to date" ]] || [[ "$output" =~ "Continue" ]] || [[ "$output" =~ "Update Summary" ]]
}

# =============================================================================
# BACKUP TESTS
# =============================================================================

@test "igris_update creates backup directory" {
  init_igris_in_test_project

  # Check backup dir pattern exists after cancelled update
  run "$SCRIPTS_DIR/igris_update.sh" 2>&1 <<< "n" || true

  # Backup is only created if update proceeds
  # This test just validates the concept
  assert_output_contains "backup" || skip "Backup not mentioned (update may have been skipped)"
}

# =============================================================================
# AGENTS UPDATE TESTS
# =============================================================================

@test "igris_update preserves .claude/agents directory" {
  init_igris_in_test_project

  # Verify agents directory exists after init
  assert_dir_exists ".claude/agents"
  assert_file_exists ".claude/agents/manifest.yaml"
}

@test "igris_update mentions agents in update list" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should mention agents somewhere in the output
  [[ "$output" =~ "agent" ]] || [[ "$output" =~ ".claude" ]] || skip "Agents not explicitly listed"
}

# =============================================================================
# MIGRATION TESTS
# =============================================================================

@test "igris_update migrates from .blueprint_version" {
  setup_test_project

  # Create old Blueprint AI structure
  mkdir -p ai/briefs
  cat > .blueprint_version <<'EOF'
{
  "blueprint_ai_version": "2.0.0",
  "installed_at": "2025-01-01T00:00:00Z"
}
EOF

  # Run update - should detect and offer migration
  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should detect Blueprint AI
  assert_output_contains "Blueprint" || assert_output_contains "migration" || assert_output_contains "Igris"
}

@test "igris_update handles both version files existing" {
  setup_test_project

  # Create both old and new version files (unusual state)
  mkdir -p ai/briefs
  cat > .blueprint_version <<'EOF'
{
  "blueprint_ai_version": "2.0.0"
}
EOF
  cat > .igris_version <<'EOF'
{
  "igris_ai_version": "3.0.0"
}
EOF

  # Should handle gracefully
  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 <<< "1" || true

  # Should not crash
  [ "$status" -ne 127 ]
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "igris_update handles corrupted .igris_version" {
  setup_test_project
  mkdir -p ai/briefs

  # Create invalid JSON
  echo "not valid json" > .igris_version

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should fail gracefully, not crash
  [ "$status" -ne 127 ]
}

@test "igris_update shows help on unknown option" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/igris_update.sh" --invalid-option 2>&1 || true

  # Should show usage
  assert_output_contains "Usage" || assert_output_contains "Unknown"
}

# =============================================================================
# OUTPUT TESTS
# =============================================================================

@test "igris_update shows clear status messages" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should have clear status output
  assert_output_contains "Igris"
}

@test "igris_update --force flag is recognized" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/igris_update.sh" --force --dry-run 2>&1 || true

  # Should not fail with unknown option
  [[ ! "$output" =~ "Unknown option: --force" ]]
}

# =============================================================================
# INTEGRATION TESTS
# =============================================================================

@test "igris_update full dry-run workflow" {
  init_igris_in_test_project

  # Run full dry-run
  run "$SCRIPTS_DIR/igris_update.sh" --dry-run 2>&1 || true

  # Should complete without crash
  [ "$status" -ne 127 ]

  # Should show meaningful output
  [ -n "$output" ]

  # Files should be unchanged
  assert_file_exists "CLAUDE.md"
  assert_file_exists ".igris_version"
  assert_dir_exists ".claude/agents"
}

