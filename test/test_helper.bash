#!/usr/bin/env bash

# test_helper.bash - Shared test utilities for Igris AI test suite
#
# Usage: load test_helper

# Set up test environment
export IGRIS_TEST_MODE=1
export BATS_TEST_DIRNAME="${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}"
export IGRIS_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
export SCRIPTS_DIR="$IGRIS_ROOT/scripts"

# Test directory for temporary files
export TEST_TEMP_DIR="${BATS_TMPDIR:-/tmp}/igris-test-$$"

# Cleanup function (called automatically by bats)
teardown() {
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# =============================================================================
# PROJECT SETUP HELPERS
# =============================================================================

# Create a temporary test project directory
# Usage: setup_test_project
setup_test_project() {
  mkdir -p "$TEST_TEMP_DIR/test-project"
  cd "$TEST_TEMP_DIR/test-project"
  export TEST_PROJECT_DIR="$TEST_TEMP_DIR/test-project"
}

# Initialize Igris AI in test project
# Usage: init_igris_in_test_project
init_igris_in_test_project() {
  setup_test_project
  "$SCRIPTS_DIR/igris_init.sh" "$TEST_PROJECT_DIR" <<< "y"
}

# =============================================================================
# MOCK PLUGIN HELPERS
# =============================================================================

# Create a minimal mock plugin
# Usage: create_mock_plugin <plugin_name> [with_hooks]
create_mock_plugin() {
  local plugin_name="${1:-mock-plugin}"
  local with_hooks="${2:-false}"
  local plugin_dir="$TEST_TEMP_DIR/$plugin_name"

  mkdir -p "$plugin_dir"
  cd "$plugin_dir"

  # Create plugin.json
  if [ "$with_hooks" = "true" ]; then
    cat > plugin.json <<EOF
{
  "name": "$plugin_name",
  "version": "1.0.0",
  "description": "Mock plugin for testing",
  "hooks": {
    "persona_injection": "ai/prompts/mock_persona.md"
  }
}
EOF

    # Create hook file
    mkdir -p ai/prompts
    cat > ai/prompts/mock_persona.md <<'EOF'
## Mock Persona

This is a mock persona for testing purposes.
EOF
  else
    cat > plugin.json <<EOF
{
  "name": "$plugin_name",
  "version": "1.0.0",
  "description": "Mock plugin for testing"
}
EOF
  fi

  # Create install.sh that copies hook files to project
  if [ "$with_hooks" = "true" ]; then
    cat > install.sh <<'EOF'
#!/bin/bash
PLUGIN_DIR="$1"
PROJECT_DIR="$2"

# Copy plugin hook files to project
if [ -d "$PLUGIN_DIR/ai" ]; then
  cp -r "$PLUGIN_DIR/ai"/* "$PROJECT_DIR/ai/" 2>/dev/null || true
fi

echo "Mock plugin installed"
EOF
  else
    cat > install.sh <<'EOF'
#!/bin/bash
echo "Mock plugin installed"
EOF
  fi
  chmod +x install.sh

  echo "$plugin_dir"
}

# Create a mock plugin with multi-line persona content
# Usage: create_mock_plugin_multiline
create_mock_plugin_multiline() {
  local plugin_name="mock-plugin-multiline"
  local plugin_dir="$TEST_TEMP_DIR/$plugin_name"

  mkdir -p "$plugin_dir/ai/prompts"
  cd "$plugin_dir"

  # Create plugin.json with hook
  cat > plugin.json <<EOF
{
  "name": "$plugin_name",
  "version": "1.0.0",
  "description": "Mock plugin with multi-line content",
  "hooks": {
    "persona_injection": "ai/prompts/multiline_persona.md"
  }
}
EOF

  # Create multi-line persona content
  cat > ai/prompts/multiline_persona.md <<'EOF'
## Multi-Line Persona

Line 1: First line of persona
Line 2: Second line of persona
Line 3: Third line of persona

**This tests newline handling.**
EOF

  # Create install.sh that copies hook files to project
  cat > install.sh <<'EOF'
#!/bin/bash
PLUGIN_DIR="$1"
PROJECT_DIR="$2"

# Copy plugin hook files to project
if [ -d "$PLUGIN_DIR/ai" ]; then
  cp -r "$PLUGIN_DIR/ai"/* "$PROJECT_DIR/ai/" 2>/dev/null || true
fi

echo "Multiline plugin installed"
EOF
  chmod +x install.sh

  echo "$plugin_dir"
}

# =============================================================================
# ASSERTION HELPERS
# =============================================================================

# Assert file exists
# Usage: assert_file_exists <file_path>
assert_file_exists() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "Expected file to exist: $file" >&2
    return 1
  fi
}

# Assert directory exists
# Usage: assert_dir_exists <dir_path>
assert_dir_exists() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "Expected directory to exist: $dir" >&2
    return 1
  fi
}

# Assert file contains text
# Usage: assert_file_contains <file_path> <text>
assert_file_contains() {
  local file="$1"
  local text="$2"

  assert_file_exists "$file" || return 1

  if ! grep -q "$text" "$file"; then
    echo "Expected file '$file' to contain: $text" >&2
    echo "File contents:" >&2
    cat "$file" >&2
    return 1
  fi
}

# Assert file does NOT contain text
# Usage: assert_file_not_contains <file_path> <text>
assert_file_not_contains() {
  local file="$1"
  local text="$2"

  assert_file_exists "$file" || return 1

  if grep -q "$text" "$file"; then
    echo "Expected file '$file' to NOT contain: $text" >&2
    echo "File contents:" >&2
    cat "$file" >&2
    return 1
  fi
}

# Assert command succeeds (exit code 0)
# Usage: assert_success
assert_success() {
  if [ "$status" -ne 0 ]; then
    echo "Expected success (exit 0), got: $status" >&2
    echo "Output: $output" >&2
    return 1
  fi
}

# Assert command fails (exit code non-zero)
# Usage: assert_failure
assert_failure() {
  if [ "$status" -eq 0 ]; then
    echo "Expected failure (non-zero exit), got success" >&2
    echo "Output: $output" >&2
    return 1
  fi
}

# Assert output contains text
# Usage: assert_output_contains <text>
assert_output_contains() {
  local text="$1"
  if [[ ! "$output" =~ $text ]]; then
    echo "Expected output to contain: $text" >&2
    echo "Actual output: $output" >&2
    return 1
  fi
}

# =============================================================================
# MOCK DEPENDENCY HELPERS
# =============================================================================

# Skip test if Python3 not available
# Usage: require_python3
require_python3() {
  if ! command -v python3 &> /dev/null; then
    skip "Python3 not available"
  fi
}

# Skip test if git not available
# Usage: require_git
require_git() {
  if ! command -v git &> /dev/null; then
    skip "Git not available"
  fi
}

# Skip test if jq not available
# Usage: require_jq
require_jq() {
  if ! command -v jq &> /dev/null; then
    skip "jq not available"
  fi
}

# =============================================================================
# DEBUGGING HELPERS
# =============================================================================

# Print debug info (only if IGRIS_TEST_DEBUG=1)
# Usage: debug "message"
debug() {
  if [ "${IGRIS_TEST_DEBUG:-0}" = "1" ]; then
    echo "DEBUG: $*" >&2
  fi
}

# Show directory tree (for debugging)
# Usage: show_tree <dir>
show_tree() {
  local dir="${1:-.}"
  echo "Directory tree for: $dir" >&2
  if command -v tree &> /dev/null; then
    tree "$dir" >&2
  else
    find "$dir" -print | sed -e "s;$dir;.;g" >&2
  fi
}

# =============================================================================
# INITIALIZATION
# =============================================================================

# Ensure test temp directory is clean
mkdir -p "$TEST_TEMP_DIR"

# Export helper functions
export -f setup_test_project
export -f init_igris_in_test_project
export -f create_mock_plugin
export -f create_mock_plugin_multiline
export -f assert_file_exists
export -f assert_dir_exists
export -f assert_file_contains
export -f assert_file_not_contains
export -f assert_success
export -f assert_failure
export -f assert_output_contains
export -f require_python3
export -f require_git
export -f require_jq
export -f debug
export -f show_tree
