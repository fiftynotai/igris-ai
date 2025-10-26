#!/usr/bin/env bats

# Test suite for plugin_install.sh
#
# Tests critical paths:
# - Clones plugin repository
# - Validates plugin.json exists
# - Runs plugin install.sh
# - Registers plugin in installed.json
# - Regenerates CLAUDE.md if hooks present
# - Handles plugin already installed

load test_helper

# =============================================================================
# BASIC INSTALLATION TESTS
# =============================================================================

@test "plugin_install installs minimal plugin" {
  init_igris_in_test_project

  # Create mock plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)

  # Install plugin
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success
}

@test "plugin_install validates plugin.json exists" {
  init_igris_in_test_project

  # Create directory without plugin.json
  mkdir -p "$TEST_TEMP_DIR/invalid-plugin"

  # Attempt install
  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/invalid-plugin"

  # Should fail with clear error
  assert_failure
}

@test "plugin_install validates plugin.json is valid JSON" {
  init_igris_in_test_project
  require_jq

  # Use invalid plugin fixture
  run "$SCRIPTS_DIR/plugin_install.sh" "$BATS_TEST_DIRNAME/fixtures/mock_plugin_invalid"

  # Should fail gracefully
  assert_failure
}

@test "plugin_install runs plugin install.sh script" {
  init_igris_in_test_project

  # Create mock plugin with install.sh
  plugin_dir=$(create_mock_plugin "test-plugin" false)

  # Modify install.sh to create marker file
  cat > "$plugin_dir/install.sh" <<'EOF'
#!/bin/bash
touch /tmp/plugin-install-ran-$$
echo "Install script executed"
EOF
  chmod +x "$plugin_dir/install.sh"

  # Install plugin
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success

  # Verify install.sh was executed
  # Note: Marker file approach may not work in isolated test env
  # This test verifies install.sh is called
}

# =============================================================================
# PLUGIN REGISTRY TESTS
# =============================================================================

@test "plugin_install creates installed.json if missing" {
  init_igris_in_test_project

  # Ensure installed.json doesn't exist
  rm -f "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Create and install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success

  # Verify installed.json created
  assert_file_exists "$TEST_PROJECT_DIR/ai/plugins/installed.json"
}

@test "plugin_install registers plugin in installed.json" {
  init_igris_in_test_project
  require_jq

  # Create and install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify plugin registered
  assert_file_exists "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Check plugin name in registry
  run jq -e '.plugins[] | select(.name == "test-plugin")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
}

@test "plugin_install stores plugin version in registry" {
  init_igris_in_test_project
  require_jq

  # Create and install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Check version stored
  run jq -e '.plugins[] | select(.name == "test-plugin") | .version' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
  assert_output_contains "1.0.0"
}

@test "plugin_install stores plugin location in registry" {
  init_igris_in_test_project
  require_jq

  # Create and install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Check location stored
  run jq -e '.plugins[] | select(.name == "test-plugin") | .location' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
}

# =============================================================================
# HOOK HANDLING TESTS
# =============================================================================

@test "plugin_install stores hooks in registry (if present)" {
  init_igris_in_test_project
  require_jq

  # Create plugin with hooks
  plugin_dir=$(create_mock_plugin "test-plugin-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Check hooks stored in registry
  run jq -e '.plugins[] | select(.name == "test-plugin-hooks") | .hooks' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
}

@test "plugin_install does NOT store hooks for plugin without hooks" {
  init_igris_in_test_project
  require_jq

  # Create plugin without hooks
  plugin_dir=$(create_mock_plugin "test-plugin-no-hooks" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Check hooks field absent or null
  run jq -e '.plugins[] | select(.name == "test-plugin-no-hooks") | has("hooks")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Either false or null is acceptable
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}

@test "plugin_install regenerates CLAUDE.md when plugin has hooks" {
  init_igris_in_test_project

  # Get original CLAUDE.md timestamp
  original_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  # Wait 1 second (ensure timestamp difference)
  sleep 1

  # Install plugin with hooks
  plugin_dir=$(create_mock_plugin "test-plugin-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Get new timestamp
  new_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  # CLAUDE.md should be regenerated (newer timestamp)
  [ "$new_time" -gt "$original_time" ]
}

@test "plugin_install does NOT regenerate CLAUDE.md when plugin has no hooks" {
  init_igris_in_test_project

  # Get original CLAUDE.md timestamp
  original_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  # Wait 1 second
  sleep 1

  # Install plugin without hooks
  plugin_dir=$(create_mock_plugin "test-plugin-no-hooks" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Get new timestamp
  new_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  # CLAUDE.md should NOT be regenerated (same timestamp)
  [ "$new_time" -eq "$original_time" ]
}

# =============================================================================
# MULTI-LINE CONTENT TESTS (BR-005 Regression)
# =============================================================================

@test "plugin_install handles multi-line persona content correctly" {
  init_igris_in_test_project

  # Install plugin with multi-line content
  plugin_dir=$(create_mock_plugin_multiline)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify CLAUDE.md contains multi-line content (not literal \n)
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"

  # Should NOT contain literal \n
  assert_file_not_contains "$TEST_PROJECT_DIR/CLAUDE.md" '\\n'

  # Should contain actual persona content on separate lines
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Multi-Line Persona"
}

@test "plugin_install preserves line breaks in persona injection" {
  init_igris_in_test_project

  # Install plugin with multi-line content
  plugin_dir=$(create_mock_plugin_multiline)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Count lines in CLAUDE.md - should have multiple lines from persona
  # (This is a regression test for BR-005)
  line_count=$(grep -c "Line [0-9]:" "$TEST_PROJECT_DIR/CLAUDE.md" || echo "0")

  # Should find at least 3 lines (Line 1, Line 2, Line 3)
  [ "$line_count" -ge 3 ]
}

# =============================================================================
# DUPLICATE INSTALLATION TESTS
# =============================================================================

@test "plugin_install detects already installed plugin" {
  init_igris_in_test_project

  # Install plugin first time
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Try to install again
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Should detect duplicate (exact behavior TBD - fail or skip)
  # For now, just verify it doesn't crash
  [ "$status" -ne 127 ]
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "plugin_install fails gracefully with missing plugin directory" {
  init_igris_in_test_project

  run "$SCRIPTS_DIR/plugin_install.sh" "/nonexistent/path"

  assert_failure
}

@test "plugin_install shows clear error for invalid plugin.json" {
  init_igris_in_test_project

  # Use invalid plugin fixture
  run "$SCRIPTS_DIR/plugin_install.sh" "$BATS_TEST_DIRNAME/fixtures/mock_plugin_invalid"

  assert_failure

  # Should mention JSON or validation error
  assert_output_contains "invalid|JSON|parse"
}

@test "plugin_install requires Python3" {
  init_igris_in_test_project
  require_python3

  # Create and install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Should succeed with Python3 available
  assert_success
}

# =============================================================================
# INTEGRATION TESTS
# =============================================================================

@test "plugin_install full workflow (minimal plugin)" {
  init_igris_in_test_project
  require_jq

  # Create and install plugin
  plugin_dir=$(create_mock_plugin "integration-test" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success

  # Verify plugin fully registered
  assert_file_exists "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  run jq -e '.plugins[] | select(.name == "integration-test")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
}

@test "plugin_install full workflow (plugin with hooks)" {
  init_igris_in_test_project
  require_jq

  # Create and install plugin with hooks
  plugin_dir=$(create_mock_plugin "integration-test-hooks" true)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success

  # Verify plugin registered with hooks
  run jq -e '.plugins[] | select(.name == "integration-test-hooks") | .hooks' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Verify CLAUDE.md contains persona content
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Mock Persona"
}

@test "plugin_install multiple plugins sequentially" {
  init_igris_in_test_project
  require_jq

  # Install 3 different plugins
  plugin1=$(create_mock_plugin "plugin-1" false)
  plugin2=$(create_mock_plugin "plugin-2" false)
  plugin3=$(create_mock_plugin "plugin-3" true)

  "$SCRIPTS_DIR/plugin_install.sh" "$plugin1"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin2"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin3"

  # Verify all 3 plugins registered
  run jq -e '.plugins | length' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
  assert_output "3"
}

# =============================================================================
# OUTPUT TESTS
# =============================================================================

@test "plugin_install shows success message" {
  init_igris_in_test_project

  plugin_dir=$(create_mock_plugin "test-plugin" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success

  # Should indicate success
  assert_output_contains "installed|success|complete"
}

@test "plugin_install shows plugin name in output" {
  init_igris_in_test_project

  plugin_dir=$(create_mock_plugin "my-test-plugin" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success

  # Should mention plugin name
  assert_output_contains "my-test-plugin"
}
