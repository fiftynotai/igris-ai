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

# Assert output contains text (case-insensitive)
# Usage: assert_output_contains <text>
assert_output_contains() {
  local text="$1"
  # Enable case-insensitive matching
  shopt -s nocasematch
  local result=0
  if [[ ! "$output" =~ $text ]]; then
    echo "Expected output to contain: $text" >&2
    echo "Actual output: $output" >&2
    result=1
  fi
  shopt -u nocasematch
  return $result
}

# Assert output matches exactly
# Usage: assert_output <expected_output>
assert_output() {
  local expected="$1"
  if [ "$output" != "$expected" ]; then
    echo "Expected output: $expected" >&2
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
