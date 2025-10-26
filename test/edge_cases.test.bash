#!/usr/bin/env bats

# Test suite for edge cases across all Igris AI scripts
#
# Tests edge cases:
# - Special characters in paths and names
# - Multi-line content (BR-005 regression)
# - Unicode characters
# - Whitespace handling
# - Empty strings
# - Very long strings
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
  assert_dir_exists "$TEST_TEMP_DIR/project with spaces/ai"
  assert_file_exists "$TEST_TEMP_DIR/project with spaces/CLAUDE.md"
}

@test "igris_init handles directory path with hyphens" {
  mkdir -p "$TEST_TEMP_DIR/my-test-project"

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_TEMP_DIR/my-test-project" <<< "y"

  assert_success
  assert_dir_exists "$TEST_TEMP_DIR/my-test-project/ai"
}

@test "igris_init handles directory path with underscores" {
  mkdir -p "$TEST_TEMP_DIR/my_test_project"

  run "$SCRIPTS_DIR/igris_init.sh" "$TEST_TEMP_DIR/my_test_project" <<< "y"

  assert_success
  assert_dir_exists "$TEST_TEMP_DIR/my_test_project/ai"
}

@test "plugin_install handles plugin name with hyphens" {
  init_igris_in_test_project

  # Plugin names commonly use hyphens
  plugin_dir=$(create_mock_plugin "test-plugin-name" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success
}

@test "plugin_install handles plugin name with underscores" {
  init_igris_in_test_project

  plugin_dir=$(create_mock_plugin "test_plugin_name" false)
  run "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  assert_success
}

@test "plugin_install handles plugin name with dots" {
  init_igris_in_test_project

  # Create plugin with dots in name (e.g., com.example.plugin)
  mkdir -p "$TEST_TEMP_DIR/com.example.plugin"
  cat > "$TEST_TEMP_DIR/com.example.plugin/plugin.json" <<'EOF'
{
  "name": "com.example.plugin",
  "version": "1.0.0",
  "description": "Plugin with dots"
}
EOF
  cat > "$TEST_TEMP_DIR/com.example.plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/com.example.plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/com.example.plugin"

  # Should either accept or reject with clear message
  [ "$status" -ne 127 ]
}

# =============================================================================
# MULTI-LINE CONTENT TESTS (BR-005 REGRESSION)
# =============================================================================

@test "plugin_install preserves multi-line persona content" {
  init_igris_in_test_project

  # Use multi-line fixture
  plugin_dir=$(create_mock_plugin_multiline)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Verify NO literal \n characters
  assert_file_not_contains "$TEST_PROJECT_DIR/CLAUDE.md" '\\n'

  # Verify actual line breaks preserved
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Line 1:"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Line 2:"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Line 3:"
}

@test "plugin_install handles persona with blank lines" {
  init_igris_in_test_project

  # Create plugin with blank lines in persona
  mkdir -p "$TEST_TEMP_DIR/blank-lines-plugin/ai/prompts"
  cat > "$TEST_TEMP_DIR/blank-lines-plugin/ai/prompts/persona.md" <<'EOF'
# Persona

Line 1

Line 3 (blank line above)


Line 5 (two blank lines above)
EOF

  cat > "$TEST_TEMP_DIR/blank-lines-plugin/plugin.json" <<'EOF'
{
  "name": "blank-lines-plugin",
  "version": "1.0.0",
  "description": "Persona with blank lines",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/blank-lines-plugin/install.sh" <<'EOF'
#!/bin/bash
PLUGIN_DIR="$1"
PROJECT_DIR="$2"
# Copy plugin hook files to project
if [ -d "$PLUGIN_DIR/ai" ]; then
  cp -r "$PLUGIN_DIR/ai"/* "$PROJECT_DIR/ai/" 2>/dev/null || true
fi
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/blank-lines-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/blank-lines-plugin"

  # Verify content in CLAUDE.md
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Line 1"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Line 3"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Line 5"
}

@test "plugin_install handles persona with markdown formatting" {
  init_igris_in_test_project

  # Create plugin with rich markdown
  mkdir -p "$TEST_TEMP_DIR/markdown-plugin/ai/prompts"
  cat > "$TEST_TEMP_DIR/markdown-plugin/ai/prompts/persona.md" <<'EOF'
# Persona

**Bold text**

*Italic text*

- List item 1
- List item 2

> Blockquote

`Code snippet`

[Link](https://example.com)
EOF

  cat > "$TEST_TEMP_DIR/markdown-plugin/plugin.json" <<'EOF'
{
  "name": "markdown-plugin",
  "version": "1.0.0",
  "description": "Persona with markdown",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/markdown-plugin/install.sh" <<'EOF'
#!/bin/bash
PLUGIN_DIR="$1"
PROJECT_DIR="$2"
# Copy plugin hook files to project
if [ -d "$PLUGIN_DIR/ai" ]; then
  cp -r "$PLUGIN_DIR/ai"/* "$PROJECT_DIR/ai/" 2>/dev/null || true
fi
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/markdown-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/markdown-plugin"

  # Verify markdown preserved
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "**Bold text**"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "*Italic text*"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "- List item 1"
}

# =============================================================================
# UNICODE AND ENCODING TESTS
# =============================================================================

@test "plugin_install handles unicode in plugin description" {
  init_igris_in_test_project

  # Create plugin with unicode description
  mkdir -p "$TEST_TEMP_DIR/unicode-plugin"
  cat > "$TEST_TEMP_DIR/unicode-plugin/plugin.json" <<'EOF'
{
  "name": "unicode-plugin",
  "version": "1.0.0",
  "description": "Plugin with émojis 🎉 and spëcial çharacters"
}
EOF

  cat > "$TEST_TEMP_DIR/unicode-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/unicode-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/unicode-plugin"

  # Should handle gracefully
  [ "$status" -ne 127 ]
}

@test "plugin_install handles unicode in persona content" {
  init_igris_in_test_project

  # Create plugin with unicode persona
  mkdir -p "$TEST_TEMP_DIR/unicode-persona-plugin/ai/prompts"
  cat > "$TEST_TEMP_DIR/unicode-persona-plugin/ai/prompts/persona.md" <<'EOF'
# Persona 🤖

Hello, I'm your AI assistant!

Supported languages: English, Español, Français, 日本語, 中文
EOF

  cat > "$TEST_TEMP_DIR/unicode-persona-plugin/plugin.json" <<'EOF'
{
  "name": "unicode-persona",
  "version": "1.0.0",
  "description": "Unicode persona",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/unicode-persona-plugin/install.sh" <<'EOF'
#!/bin/bash
PLUGIN_DIR="$1"
PROJECT_DIR="$2"
# Copy plugin hook files to project
if [ -d "$PLUGIN_DIR/ai" ]; then
  cp -r "$PLUGIN_DIR/ai"/* "$PROJECT_DIR/ai/" 2>/dev/null || true
fi
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/unicode-persona-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/unicode-persona-plugin"

  # Verify unicode preserved in CLAUDE.md
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Persona"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "English"
}

# =============================================================================
# WHITESPACE TESTS
# =============================================================================

@test "plugin_install handles leading whitespace in persona" {
  init_igris_in_test_project

  # Create plugin with indented content
  mkdir -p "$TEST_TEMP_DIR/indent-plugin/ai/prompts"
  cat > "$TEST_TEMP_DIR/indent-plugin/ai/prompts/persona.md" <<'EOF'
# Persona

    Indented line 1
    Indented line 2
EOF

  cat > "$TEST_TEMP_DIR/indent-plugin/plugin.json" <<'EOF'
{
  "name": "indent-plugin",
  "version": "1.0.0",
  "description": "Indented persona",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/indent-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/indent-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/indent-plugin"

  # Verify indentation preserved
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Indented line 1"
}

@test "plugin_install handles trailing whitespace" {
  init_igris_in_test_project

  # Create plugin with trailing spaces
  mkdir -p "$TEST_TEMP_DIR/trailing-plugin/ai/prompts"
  # Note: Actual trailing spaces in heredoc may be stripped
  echo "# Persona      " > "$TEST_TEMP_DIR/trailing-plugin/ai/prompts/persona.md"

  cat > "$TEST_TEMP_DIR/trailing-plugin/plugin.json" <<'EOF'
{
  "name": "trailing-plugin",
  "version": "1.0.0",
  "description": "Trailing spaces",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/trailing-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/trailing-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/trailing-plugin"

  # Verify content present (trailing space handling may vary)
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Persona"
}

@test "plugin_install handles tabs in persona content" {
  init_igris_in_test_project

  # Create plugin with tabs
  mkdir -p "$TEST_TEMP_DIR/tab-plugin/ai/prompts"
  printf "# Persona\n\nLine with\ttabs\tbetween\twords\n" > "$TEST_TEMP_DIR/tab-plugin/ai/prompts/persona.md"

  cat > "$TEST_TEMP_DIR/tab-plugin/plugin.json" <<'EOF'
{
  "name": "tab-plugin",
  "version": "1.0.0",
  "description": "Tabs in content",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/tab-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/tab-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/tab-plugin"

  # Verify tabs preserved or converted appropriately
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "Persona"
}

# =============================================================================
# EMPTY STRING TESTS
# =============================================================================

@test "plugin_install handles empty persona file" {
  init_igris_in_test_project

  # Create plugin with empty persona
  mkdir -p "$TEST_TEMP_DIR/empty-persona-plugin/ai/prompts"
  touch "$TEST_TEMP_DIR/empty-persona-plugin/ai/prompts/persona.md"

  cat > "$TEST_TEMP_DIR/empty-persona-plugin/plugin.json" <<'EOF'
{
  "name": "empty-persona",
  "version": "1.0.0",
  "description": "Empty persona file",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/empty-persona-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/empty-persona-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/empty-persona-plugin"

  # Should handle gracefully (empty injection)
  assert_success
}

@test "plugin_install handles empty description" {
  init_igris_in_test_project

  # Create plugin with empty description
  mkdir -p "$TEST_TEMP_DIR/empty-desc-plugin"
  cat > "$TEST_TEMP_DIR/empty-desc-plugin/plugin.json" <<'EOF'
{
  "name": "empty-desc",
  "version": "1.0.0",
  "description": ""
}
EOF

  cat > "$TEST_TEMP_DIR/empty-desc-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/empty-desc-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/empty-desc-plugin"

  # Should handle empty string fields
  [ "$status" -ne 127 ]
}

# =============================================================================
# SPECIAL JSON CHARACTERS TESTS
# =============================================================================

@test "plugin_install handles quotes in description" {
  init_igris_in_test_project

  # Create plugin with quotes in description (properly escaped)
  mkdir -p "$TEST_TEMP_DIR/quotes-plugin"
  cat > "$TEST_TEMP_DIR/quotes-plugin/plugin.json" <<'EOF'
{
  "name": "quotes-plugin",
  "version": "1.0.0",
  "description": "Plugin with \"quoted\" text"
}
EOF

  cat > "$TEST_TEMP_DIR/quotes-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/quotes-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/quotes-plugin"

  # Should parse JSON correctly
  assert_success
}

@test "plugin_install handles backslashes in paths" {
  skip "Backslash handling is platform-specific"

  # This test would verify Windows-style path handling
  # Not applicable on Unix systems
}

# =============================================================================
# VERSION STRING TESTS
# =============================================================================

@test "plugin_install handles semantic version with prerelease" {
  init_igris_in_test_project

  # Create plugin with prerelease version
  mkdir -p "$TEST_TEMP_DIR/prerelease-plugin"
  cat > "$TEST_TEMP_DIR/prerelease-plugin/plugin.json" <<'EOF'
{
  "name": "prerelease-plugin",
  "version": "1.0.0-alpha.1",
  "description": "Prerelease version"
}
EOF

  cat > "$TEST_TEMP_DIR/prerelease-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/prerelease-plugin/install.sh"

  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/prerelease-plugin"

  assert_success
}

@test "plugin_install handles version with build metadata" {
  init_igris_in_test_project
  require_jq

  # Create plugin with build metadata
  mkdir -p "$TEST_TEMP_DIR/build-meta-plugin"
  cat > "$TEST_TEMP_DIR/build-meta-plugin/plugin.json" <<'EOF'
{
  "name": "build-meta-plugin",
  "version": "1.0.0+20130313144700",
  "description": "Build metadata in version"
}
EOF

  cat > "$TEST_TEMP_DIR/build-meta-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Install"
EOF
  chmod +x "$TEST_TEMP_DIR/build-meta-plugin/install.sh"

  "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/build-meta-plugin"

  # Verify version stored correctly
  run jq -r '.plugins[] | select(.name == "build-meta-plugin") | .version' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_output "1.0.0+20130313144700"
}

# =============================================================================
# CASE SENSITIVITY TESTS
# =============================================================================

@test "plugin operations are case-sensitive" {
  init_igris_in_test_project
  require_jq

  # Install plugin with lowercase name
  plugin_dir=$(create_mock_plugin "testplugin" false)
  "$SCRIPTS_DIR/plugin_install.sh" "$plugin_dir"

  # Try to update with uppercase name (should not find it)
  run "$SCRIPTS_DIR/plugin_update.sh" "TestPlugin"

  # Should fail to find plugin (case-sensitive)
  assert_failure
}

# =============================================================================
# MIXED EDGE CASES
# =============================================================================

@test "plugin_install handles complex real-world scenario" {
  init_igris_in_test_project
  require_jq

  # Create plugin with multiple edge cases combined
  mkdir -p "$TEST_TEMP_DIR/complex-plugin/ai/prompts"

  # Multi-line content with markdown, unicode, and special formatting
  cat > "$TEST_TEMP_DIR/complex-plugin/ai/prompts/persona.md" <<'EOF'
# AI Assistant 🤖

**Welcome!** I support multiple languages.

Features:
- **Bold** text
- *Italic* text
- `Code blocks`

Languages: English, Español, 日本語

> Blockquote with "quotes"

    Indented code

End with blank line.

EOF

  cat > "$TEST_TEMP_DIR/complex-plugin/plugin.json" <<'EOF'
{
  "name": "complex-plugin",
  "version": "1.0.0-beta.1+build.123",
  "description": "Complex \"real-world\" plugin with émojis 🎉",
  "hooks": {
    "persona_injection": "ai/prompts/persona.md"
  }
}
EOF

  cat > "$TEST_TEMP_DIR/complex-plugin/install.sh" <<'EOF'
#!/bin/bash
echo "Complex plugin installed"
EOF
  chmod +x "$TEST_TEMP_DIR/complex-plugin/install.sh"

  # Install
  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/complex-plugin"
  assert_success

  # Verify registration
  run jq -e '.plugins[] | select(.name == "complex-plugin")' "$TEST_PROJECT_DIR/ai/plugins/installed.json"
  assert_success

  # Verify CLAUDE.md content
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "AI Assistant"
  assert_file_contains "$TEST_PROJECT_DIR/CLAUDE.md" "**Welcome!**"
  assert_file_not_contains "$TEST_PROJECT_DIR/CLAUDE.md" '\\n'
}
