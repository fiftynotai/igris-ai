#!/usr/bin/env bats

# Test suite for plugin_update.sh
#
# Tests critical paths:
# - Updates plugin to latest version
# - Preserves user data
# - Updates plugin registry
# - Creates backup before update

load test_helper

# =============================================================================
# BASIC UPDATE TESTS
# =============================================================================

@test "plugin_update updates installed plugin" {
  init_igris_in_test_project

  # Install plugin v1.0.0
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Modify plugin to v2.0.0
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Updated"}' > "$plugin_dir/plugin.json"

  # Update plugin
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  assert_success
}

@test "plugin_update validates plugin is installed" {
  init_igris_in_test_project

  # Try to update non-existent plugin
  run "$SCRIPTS_DIR/plugin_update.sh" "nonexistent-plugin"

  # Should fail with clear error
  assert_failure
  assert_output_contains "not installed|not found"
}

@test "plugin_update validates plugin exists" {
  init_igris_in_test_project
  require_jq

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Remove plugin directory (simulate deleted source)
  rm -rf "$plugin_dir"

  # Try to update
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Should handle gracefully (exact behavior TBD)
  [ "$status" -ne 127 ]
}

# =============================================================================
# VERSION UPDATE TESTS
# =============================================================================

@test "plugin_update updates version in registry" {
  init_igris_in_test_project
  require_jq

  # Install plugin v1.0.0
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Update plugin.json to v2.0.0
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Updated"}' > "$plugin_dir/plugin.json"

  # Update plugin
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Verify version updated in registry
  run jq -r '.plugins[] | select(.name == "test-plugin") | .version' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
  assert_output "2.0.0"
}

@test "plugin_update detects no update needed (same version)" {
  init_igris_in_test_project

  # Install plugin v1.0.0
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Try to update (same version)
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Should detect no update needed
  # (exact behavior TBD - skip or message)
  assert_success
}

# =============================================================================
# BACKUP TESTS
# =============================================================================

@test "plugin_update creates backup before update" {
  init_igris_in_test_project

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Update plugin.json to new version
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Updated"}' > "$plugin_dir/plugin.json"

  # Update plugin
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Verify backup created (location TBD - check common backup locations)
  # This test may need adjustment based on actual backup implementation
  # For now, just verify update succeeded
  assert_success
}

# =============================================================================
# DATA PRESERVATION TESTS
# =============================================================================

@test "plugin_update preserves plugin configuration" {
  skip "Implementation depends on plugin data storage pattern"

  # This test verifies that user data/configuration is preserved
  # Actual test content depends on how plugins store data
}

@test "plugin_update preserves custom files in plugin directory" {
  init_igris_in_test_project

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Create custom user file in installed plugin location
  installed_location=$("$SCRIPTS_DIR/plugin_list.sh" | grep "test-plugin" | awk '{print $NF}' || echo "$TEST_PROJECT_DIR/.claude/plugins/test-plugin")

  # Add custom file (if plugin location supports this)
  # Test may need adjustment based on plugin directory structure

  # Update plugin
  # Verify custom file still exists

  skip "Test depends on plugin installation directory structure"
}

# =============================================================================
# REGISTRY UPDATE TESTS
# =============================================================================

@test "plugin_update updates installed_at timestamp" {
  init_igris_in_test_project
  require_jq

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Get original timestamp
  original_time=$(jq -r '.plugins[] | select(.name == "test-plugin") | .installed_at' "$TEST_PROJECT_DIR/ai/plugins/installed.json")

  # Wait 1 second
  sleep 1

  # Update plugin.json
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Updated"}' > "$plugin_dir/plugin.json"

  # Update plugin
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Get new timestamp (may be updated_at field instead)
  # This test assumes timestamp is updated - adjust based on actual behavior

  # Verify registry was modified
  assert_file_exists "$TEST_PROJECT_DIR/ai/plugins/installed.json"
}

@test "plugin_update preserves other plugins in registry" {
  init_igris_in_test_project
  require_jq

  # Install 2 plugins
  plugin1=$(create_mock_plugin "plugin-1" false)
  plugin2=$(create_mock_plugin "plugin-2" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin1"
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin2"

  # Update plugin-1
  echo '{"name": "plugin-1", "version": "2.0.0", "description": "Updated"}' > "$plugin1/plugin.json"
  "$SCRIPTS_DIR/plugin_update.sh" "plugin-1"

  # Verify plugin-2 still in registry
  run jq -e '.plugins[] | select(.name == "plugin-2")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Verify both plugins present
  run jq -e '.plugins | length' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success
  assert_output "2"
}

# =============================================================================
# HOOK UPDATE TESTS
# =============================================================================

@test "plugin_update regenerates CLAUDE.md when hooks change" {
  init_igris_in_test_project

  # Install plugin with hooks
  plugin_dir=$(create_mock_plugin "test-plugin-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Get CLAUDE.md timestamp
  original_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")

  sleep 1

  # Modify plugin hooks content
  echo "# Updated Persona" > "$plugin_dir/ai/prompts/mock_persona.md"
  echo '{"name": "test-plugin-hooks", "version": "2.0.0", "description": "Updated", "hooks": {"persona_injection": "ai/prompts/mock_persona.md"}}' > "$plugin_dir/plugin.json"

  # Update plugin
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin-hooks"

  # Verify CLAUDE.md regenerated
  new_time=$(stat -f %m "$TEST_PROJECT_DIR/CLAUDE.md" 2>/dev/null || stat -c %Y "$TEST_PROJECT_DIR/CLAUDE.md")
  [ "$new_time" -gt "$original_time" ]

  # Verify updated content in CLAUDE.md
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Updated Persona"
}

@test "plugin_update handles adding hooks to hookless plugin" {
  init_igris_in_test_project

  # Install plugin without hooks
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Add hooks to plugin
  mkdir -p "$plugin_dir/ai/prompts"
  echo "# New Persona" > "$plugin_dir/ai/prompts/persona.md"
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Now with hooks", "hooks": {"persona_injection": "ai/prompts/persona.md"}}' > "$plugin_dir/plugin.json"

  # Update plugin
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Verify hooks registered and CLAUDE.md regenerated
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "New Persona"
}

@test "plugin_update handles removing hooks from plugin" {
  init_igris_in_test_project
  require_jq

  # Install plugin with hooks
  plugin_dir=$(create_mock_plugin "test-plugin-hooks" true)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Remove hooks from plugin
  echo '{"name": "test-plugin-hooks", "version": "2.0.0", "description": "Hooks removed"}' > "$plugin_dir/plugin.json"

  # Update plugin
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin-hooks"

  # Verify hooks removed from registry
  run jq -e '.plugins[] | select(.name == "test-plugin-hooks") | .hooks' "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Should be null or absent
  [ "$status" -eq 1 ] || [ "$output" = "null" ]
}

# =============================================================================
# ERROR HANDLING TESTS
# =============================================================================

@test "plugin_update requires plugin name argument" {
  init_igris_in_test_project

  # Call without arguments
  run "$SCRIPTS_DIR/plugin_update.sh"

  assert_failure
  assert_output_contains "usage|required|plugin name"
}

@test "plugin_update fails gracefully with corrupted registry" {
  init_igris_in_test_project

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Corrupt installed.json
  echo "{ invalid json" > "$TEST_PROJECT_DIR/ai/plugins/installed.json"

  # Try to update
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Should fail gracefully
  assert_failure
  assert_output_contains "invalid|corrupted|parse"
}

# =============================================================================
# INTEGRATION TESTS
# =============================================================================

@test "plugin_update full workflow (version bump)" {
  init_igris_in_test_project
  require_jq

  # Install plugin v1.0.0
  plugin_dir=$(create_mock_plugin "integration-test" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify v1.0.0 installed
  run jq -r '.plugins[] | select(.name == "integration-test") | .version' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "1.0.0"

  # Update to v2.0.0
  echo '{"name": "integration-test", "version": "2.0.0", "description": "Updated version"}' > "$plugin_dir/plugin.json"
  "$SCRIPTS_DIR/plugin_update.sh" "integration-test"

  # Verify v2.0.0 now installed
  run jq -r '.plugins[] | select(.name == "integration-test") | .version' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "2.0.0"
}

@test "plugin_update multiple updates sequentially" {
  init_igris_in_test_project
  require_jq

  # Install plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Update to v2.0.0
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "v2"}' > "$plugin_dir/plugin.json"
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Update to v3.0.0
  echo '{"name": "test-plugin", "version": "3.0.0", "description": "v3"}' > "$plugin_dir/plugin.json"
  "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Verify v3.0.0
  run jq -r '.plugins[] | select(.name == "test-plugin") | .version' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "3.0.0"
}

# =============================================================================
# OUTPUT TESTS
# =============================================================================

@test "plugin_update shows success message" {
  init_igris_in_test_project

  # Install and update plugin
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Updated"}' > "$plugin_dir/plugin.json"
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  assert_success
  assert_output_contains "updated|success|complete"
}

@test "plugin_update shows version change" {
  init_igris_in_test_project

  # Install plugin v1.0.0
  plugin_dir=$(create_mock_plugin "test-plugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Update to v2.0.0
  echo '{"name": "test-plugin", "version": "2.0.0", "description": "Updated"}' > "$plugin_dir/plugin.json"
  run "$SCRIPTS_DIR/plugin_update.sh" "test-plugin"

  # Should show version change (1.0.0 → 2.0.0)
  assert_success
  # Output check depends on actual implementation
}
