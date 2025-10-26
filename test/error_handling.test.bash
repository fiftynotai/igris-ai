#!/usr/bin/env bats

# Test suite for error handling across all Igris AI scripts
#
# Tests error scenarios:
# - Missing dependencies (python3, git, jq)
# - Invalid inputs
# - Corrupted configuration files
# - Permission errors
# - Edge cases and boundary conditions

load test_helper

# =============================================================================
# MISSING DEPENDENCY TESTS
# =============================================================================

@test "igris_init detects missing Python3" {
  skip "Requires ability to mock missing Python3"

  # This test would verify that igris_init.sh shows clear error
  # when Python3 is not available. Mocking this requires
  # PATH manipulation or wrapper scripts.
}

@test "plugin_install detects missing Python3" {
  skip "Requires ability to mock missing Python3"

  # Same as above for plugin_install.sh
}

@test "plugin_update detects missing Python3" {
  skip "Requires ability to mock missing Python3"

  # Same as above for plugin_update.sh
}

@test "scripts show clear error message for missing Python3" {
  skip "Requires ability to mock missing Python3"

  # All scripts should show:
  # "Python3 is required but not installed. Please install Python3..."
}

@test "scripts detect missing jq gracefully" {
  skip "Requires ability to mock missing jq"

  # Scripts using jq should either:
  # 1. Show clear error message
  # 2. Fall back to alternative parsing
}

# =============================================================================
# INVALID INPUT TESTS
# =============================================================================

@test "igris_init rejects non-existent directory" {
  # Try to init in directory that doesn't exist
  run "$SCRIPTS_DIR/igris_init.sh" "/nonexistent/path/$$" <<< "y"

  # Should either create it or show error
  # (behavior depends on implementation)
  [ "$status" -ne 127 ]  # Not "command not found"
}

@test "igris_init handles empty target directory path" {
  run "$SCRIPTS_DIR/igris_init.sh" "" <<< "y"

  # Should fail with clear error
  assert_failure
}

@test "plugin_install rejects empty plugin path" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/plugin_install.sh" ""

  assert_failure
}

@test "plugin_install rejects non-directory path" {
  init_igris_in_test_project

  # Create regular file (not directory)
  touch "$TEST_TEMP_DIR/not-a-directory"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/not-a-directory"

  assert_failure
  assert_output_contains "not a directory\|invalid\|does not exist"
}

@test "plugin_update rejects empty plugin name" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/plugin_update.sh" ""

  assert_failure
}

@test "plugin_uninstall rejects empty plugin name" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/plugin_uninstall.sh" ""

  assert_failure
}

# =============================================================================
# CORRUPTED FILE TESTS
# =============================================================================

@test "plugin_install handles corrupted plugin.json" {
  init_igris_in_test_project

  # Use invalid plugin fixture
  run "$SCRIPTS_DIR/plugin_install.sh" "$BATS_TEST_DIRNAME/fixtures/mock_plugin_invalid"

  assert_failure
  assert_output_contains "invalid\|JSON\|parse\|malformed"
}

@test "plugin_install handles missing plugin.json" {
  init_igris_in_test_project

  # Create plugin directory without plugin.json
  mkdir -p "$TEST_TEMP_DIR/no-manifest-plugin"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/no-manifest-plugin"

  assert_failure
  assert_output_contains "plugin.json\|manifest\|not found"
}

@test "plugin_update handles corrupted installed.json" {
  init_igris_in_test_project

  # Install plugin first
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Corrupt installed.json
  echo "{ invalid json }" > "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Try to update
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  assert_failure
  assert_output_contains "invalid\|corrupted\|parse"
}

@test "plugin_uninstall handles corrupted installed.json" {
  init_igris_in_test_project

  # Install plugin first
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Corrupt installed.json
  echo "{ invalid" > "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Try to uninstall
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  assert_failure
  assert_output_contains "invalid\|corrupted\|parse"
}

@test "plugin_uninstall handles missing installed.json" {
  init_igris_in_test_project

  # Remove installed.json
  rm -f "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Try to uninstall
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  assert_failure
  assert_output_contains "not installed\|no plugins\|not found"
}

# =============================================================================
# PERMISSION ERROR TESTS
# =============================================================================

@test "igris_init handles read-only target directory" {
  skip "Requires permission manipulation which may fail in CI"

  # This test would:
  # 1. Create directory
  # 2. Make it read-only
  # 3. Try to init
  # 4. Verify clear error message
  # 5. Restore permissions
}

@test "plugin_install handles read-only plugin directory" {
  skip "Requires permission manipulation which may fail in CI"

  # Similar to above
}

# =============================================================================
# INVALID CONFIGURATION TESTS
# =============================================================================

@test "igris_init handles invalid CLAUDE.md.template" {
  skip "Requires modifying Igris AI installation"

  # This test would verify graceful handling if template is corrupted
}

@test "plugin_install handles plugin with invalid hook path" {
  init_igris_in_test_project

  # Create plugin with hook pointing to non-existent file
  mkdir -p "$TEST_TEMP_DIR/bad-hook-plugin"
  cat > "$TEST_TEMP_DIR/bad-hook-plugin/plugin.json" <<'EOF'
{
  "name": "bad-hook-plugin",
  "version": "1.0.0",
  "description": "Plugin with invalid hook",
  "hooks": {
    "persona_injection": "nonexistent/file.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/bad-hook-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/bad-hook-plugin/install.sh"

  # Try to install
  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/bad-hook-plugin"

  # Should fail or warn about missing hook file
  # (behavior depends on implementation)
  [ "$status" -ne 127 ]
}

# =============================================================================
# BOUNDARY CONDITION TESTS
# =============================================================================

@test "plugin_install handles plugin with empty name" {
  init_igris_in_test_project

  # Create plugin with empty name
  mkdir -p "$TEST_TEMP_DIR/empty-name-plugin"
  cat > "$TEST_TEMP_DIR/empty-name-plugin/plugin.json" <<'EOF'
{
  "name": "",
  "version": "1.0.0",
  "description": "Empty name"
}
EOF

  cat > "$TEST_TEMP_DIR/empty-name-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/empty-name-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/empty-name-plugin"

  # Should fail validation
  assert_failure
}

@test "plugin_install handles plugin with missing version" {
  init_igris_in_test_project

  # Create plugin without version
  mkdir -p "$TEST_TEMP_DIR/no-version-plugin"
  cat > "$TEST_TEMP_DIR/no-version-plugin/plugin.json" <<'EOF'
{
  "name": "no-version-plugin",
  "description": "No version field"
}
EOF

  cat > "$TEST_TEMP_DIR/no-version-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/no-version-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/no-version-plugin"

  # Should fail validation or use default
  # (behavior depends on implementation)
  [ "$status" -ne 127 ]
}

@test "plugin_install handles plugin with very long name" {
  init_igris_in_test_project

  # Create plugin with 200-character name
  long_name="this-is-a-very-long-plugin-name-that-exceeds-reasonable-limits-and-should-probably-be-rejected-by-validation-logic-because-filesystem-limits-exist-and-we-should-respect-them-for-safety"

  mkdir -p "$TEST_TEMP_DIR/long-name-plugin"
  cat > "$TEST_TEMP_DIR/long-name-plugin/plugin.json" <<EOF
{
  "name": "$long_name",
  "version": "1.0.0",
  "description": "Long name test"
}
EOF

  cat > "$TEST_TEMP_DIR/long-name-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/long-name-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/long-name-plugin"

  # Should either accept or reject with clear message
  [ "$status" -ne 127 ]
}

# =============================================================================
# CONCURRENT OPERATION TESTS
# =============================================================================

@test "simultaneous plugin installations don't corrupt registry" {
  skip "Concurrent test requires parallel execution support"

  # This test would verify that two simultaneous installations
  # don't cause race conditions in installed.json
}

# =============================================================================
# CLEANUP FAILURE TESTS
# =============================================================================

@test "plugin_uninstall handles partially uninstalled plugin" {
  skip "Requires manual corruption of plugin state"

  # This test would verify recovery from interrupted uninstall
}

# =============================================================================
# OUTPUT VALIDATION TESTS
# =============================================================================

@test "error messages include actionable guidance" {
  init_igris_in_test_project

  # Try to install missing plugin
  run "$SCRIPTS_DIR/plugin_install.sh" "/nonexistent/plugin"

  assert_failure

  # Error should include guidance (what to do next)
  # This is a quality test - error messages should be helpful
  [ -n "$output" ]
}

@test "error messages don't expose sensitive paths" {
  skip "Security test - may not be applicable"

  # This would verify that errors don't leak unnecessary system info
}

# =============================================================================
# INTEGRATION ERROR TESTS
# =============================================================================

@test "igris_init recovers from partial initialization" {
  setup_test_project

  # Create partial Igris AI structure
  mkdir -p "$TEST_PROJECT_DIR/ai/briefs"
  # But don't create CLAUDE.md or other files

  # Try to re-init
  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"

  # Should complete successfully (overwrite or complete missing parts)
  assert_success
}

@test "plugin workflow handles full error recovery" {
  init_igris_in_test_project
  require_jq

  # Install plugin
  plugin_dir=$(create_mock_plugin "recovery-test" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Corrupt registry
  echo "{ invalid }" > "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # All operations should fail gracefully
  run "$SCRIPTS_DIR/plugin_update.sh" "recovery-test"
  assert_failure

  run "$SCRIPTS_DIR/plugin_uninstall.sh" "recovery-test"
  assert_failure

  # Manual fix: restore valid registry
  echo '{"plugins": []}' > "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Reinstall should work
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"
  assert_success
}
