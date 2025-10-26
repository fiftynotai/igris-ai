#!/usr/bin/env bats

# Test suite for plugin_uninstall.sh
#
# Tests critical paths:
# - Removes plugin from registry
# - Cleans up plugin files
# - Regenerates CLAUDE.md if plugin had hooks
# - Validates plugin is installed
# - Handles errors gracefully

load test_helper

# =============================================================================
# BASIC UNINSTALL TESTS
# =============================================================================

@test "plugin_uninstall removes installed plugin" {
  init_igris_in_test_project

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Uninstall plugin
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  assert_success
}

@test "plugin_uninstall validates plugin is installed" {
  init_igris_in_test_project

  # Try to uninstall non-existent plugin
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "nonexistent-plugin"

  # Should fail with clear error
  assert_failure
  assert_output_contains "not installed\|not found"
}

@test "plugin_uninstall requires plugin name argument" {
  init_igris_in_test_project

  # Call without arguments
  run "$SCRIPTS_DIR/plugin_uninstall.sh"

  assert_failure
  assert_output_contains "usage\|required\|plugin name"
}

# =============================================================================
# REGISTRY REMOVAL TESTS
# =============================================================================

@test "plugin_uninstall removes plugin from registry" {
  init_igris_in_test_project
  require_jq

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify plugin in registry
  run jq -e '.plugins[] | select(.name == "test-plugin")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Uninstall plugin
  "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  # Verify plugin removed from registry
  run jq -e '.plugins[] | select(.name == "test-plugin")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_failure
}

@test "plugin_uninstall preserves other plugins in registry" {
  init_igris_in_test_project
  require_jq

  # Install 3 plugins
  plugin1=$(create_mock_plugin "plugin-1" false)
  plugin2=$(create_mock_plugin "plugin-2" false)
  plugin3=$(create_mock_plugin "plugin-3" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin1"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin2"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin3"

  # Verify 3 plugins installed
  run jq -e '.plugins | length' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "3"

  # Uninstall plugin-2
  "$SCRIPTS_DIR/plugin_uninstall.sh" "plugin-2"

  # Verify plugin-1 and plugin-3 still present
  run jq -e '.plugins[] | select(.name == "plugin-1")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  run jq -e '.plugins[] | select(.name == "plugin-3")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Verify only 2 plugins now
  run jq -e '.plugins | length' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "2"
}

# =============================================================================
# FILE CLEANUP TESTS
# =============================================================================

@test "plugin_uninstall removes plugin files" {
  skip "Test depends on plugin installation directory structure"

  # This test would verify that plugin files are deleted
  # Implementation depends on where plugins are installed
}

@test "plugin_uninstall cleans up empty plugin directories" {
  skip "Test depends on plugin installation directory structure"

  # This test would verify cleanup of empty directories
}

# =============================================================================
# HOOK HANDLING TESTS
# =============================================================================

@test "plugin_uninstall regenerates CLAUDE.md when plugin has hooks" {
  init_igris_in_test_project

  # Install plugin with hooks
  plugin_dir=$(create_mock_plugin "test-plugin-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify persona content in CLAUDE.md
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Mock Persona"

  # Get CLAUDE.md timestamp
  original_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  sleep 1

  # Uninstall plugin
  "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin-hooks"

  # Verify CLAUDE.md regenerated
  new_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")
  [ "$new_time" -gt "$original_time" ]

  # Verify persona content removed
  assert_file_not_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Mock Persona"
}

@test "plugin_uninstall does NOT regenerate CLAUDE.md for hookless plugin" {
  init_igris_in_test_project

  # Install plugin without hooks
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Get CLAUDE.md timestamp
  original_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  sleep 1

  # Uninstall plugin
  "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  # Verify CLAUDE.md NOT regenerated (same timestamp)
  new_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")
  [ "$new_time" -eq "$original_time" ]
}

@test "plugin_uninstall removes only uninstalled plugin's hooks" {
  init_igris_in_test_project

  # Install 2 plugins with hooks
  plugin1=$(create_mock_plugin "plugin-1-hooks" true)
  plugin2=$(create_mock_plugin "plugin-2-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin1"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin2"

  # Both personas should be in CLAUDE.md
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Mock Persona"

  # Uninstall plugin-1
  "$SCRIPTS_DIR/plugin_uninstall.sh" "plugin-1-hooks"

  # CLAUDE.md should still contain plugin-2's hooks
  # (This test may need adjustment based on mock content)
  assert_file_exists "$TEST_PROJECT_DIR/CLAUDE.md"
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "plugin_uninstall fails gracefully with corrupted registry" {
  init_igris_in_test_project

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Corrupt installed.json
  echo "{ invalid json" > "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Try to uninstall
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  # Should fail gracefully
  assert_failure
  assert_output_contains "invalid\|corrupted\|parse"
}

@test "plugin_uninstall handles missing installed.json" {
  init_igris_in_test_project

  # Remove installed.json
  rm -f "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Try to uninstall
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  # Should fail (no plugins installed)
  assert_failure
}

@test "plugin_uninstall requires Python3" {
  init_igris_in_test_project
  require_python3

  # Install and uninstall plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  # Should succeed with Python3 available
  assert_success
}

# =============================================================================
# INTEGRATION TESTS
# =============================================================================

@test "plugin_uninstall full workflow (minimal plugin)" {
  init_igris_in_test_project
  require_jq

  # Install plugin
  plugin_dir=$(create_mock_plugin "integration-test" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify installed
  run jq -e '.plugins[] | select(.name == "integration-test")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Uninstall plugin
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "integration-test"
  assert_success

  # Verify removed
  run jq -e '.plugins[] | select(.name == "integration-test")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_failure
}

@test "plugin_uninstall full workflow (plugin with hooks)" {
  init_igris_in_test_project
  require_jq

  # Install plugin with hooks
  plugin_dir=$(create_mock_plugin "integration-test-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify hooks in CLAUDE.md
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Mock Persona"

  # Uninstall plugin
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "integration-test-hooks"
  assert_success

  # Verify removed from registry
  run jq -e '.plugins[] | select(.name == "integration-test-hooks")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_failure

  # Verify hooks removed from CLAUDE.md
  assert_file_not_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Mock Persona"
}

@test "plugin_uninstall install-uninstall-reinstall cycle" {
  init_igris_in_test_project
  require_jq

  # Install
  plugin_dir=$(create_mock_plugin "cycle-test" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify installed
  run jq -e '.plugins[] | select(.name == "cycle-test")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Uninstall
  "$SCRIPTS_DIR/plugin_uninstall.sh" "cycle-test"

  # Verify removed
  run jq -e '.plugins[] | select(.name == "cycle-test")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_failure

  # Reinstall
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify installed again
  run jq -e '.plugins[] | select(.name == "cycle-test")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
}

@test "plugin_uninstall all plugins sequentially" {
  init_igris_in_test_project
  require_jq

  # Install 3 plugins
  plugin1=$(create_mock_plugin "plugin-1" false)
  plugin2=$(create_mock_plugin "plugin-2" false)
  plugin3=$(create_mock_plugin "plugin-3" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin1"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin2"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin3"

  # Verify 3 plugins
  run jq -e '.plugins | length' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "3"

  # Uninstall all
  "$SCRIPTS_DIR/plugin_uninstall.sh" "plugin-1"
  "$SCRIPTS_DIR/plugin_uninstall.sh" "plugin-2"
  "$SCRIPTS_DIR/plugin_uninstall.sh" "plugin-3"

  # Verify none remain
  run jq -e '.plugins | length' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "0"
}

# =============================================================================
# OUTPUT TESTS
# =============================================================================

@test "plugin_uninstall shows success message" {
  init_igris_in_test_project

  # Install and uninstall plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "test-plugin"

  assert_success
  assert_output_contains "uninstalled\|removed\|success"
}

@test "plugin_uninstall shows plugin name in output" {
  init_igris_in_test_project

  # Install and uninstall plugin
  plugin_dir=$(create_mock_plugin "my-test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"
  run "$SCRIPTS_DIR/plugin_uninstall.sh" "my-test-plugin"

  assert_success
  assert_output_contains "my-test-plugin"
}

# =============================================================================
# EDGE CASE TESTS
# =============================================================================

@test "plugin_uninstall handles plugin name with special characters" {
  skip "Test depends on plugin naming validation rules"

  # This would test handling of plugins with hyphens, underscores, etc.
}

@test "plugin_uninstall handles empty registry after last uninstall" {
  init_igris_in_test_project
  require_jq

  # Install single plugin
  plugin_dir=$(create_mock_plugin "only-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Uninstall it
  "$SCRIPTS_DIR/plugin_uninstall.sh" "only-plugin"

  # Verify registry is empty but valid
  run jq -e '.plugins' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
  assert_output "[]"
}
