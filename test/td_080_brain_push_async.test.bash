#!/usr/bin/env bats

# TD-080 — bats tests for brain_push_async.sh.
#
# Covers the helper's defensive contract:
#   - Exits 0 when invoked without a project slug.
#   - Exits 0 silently when remote_brain config is missing/empty.
#   - Invokes brain_push_cli when configured (verified via stub npx).
#   - Always exits 0 (proves it never blocks the caller).
#   - Logs to brain_push.log on the configured-and-invoked path.
#   - Rotates the log when it grows past 1MB.
#
# We override the helper's two FS dependencies via env:
#   - HOME redirect → controls config.json + session log paths
#   - PATH stub → intercepts npx so no real network call fires
#
# This file does not exercise the real CLI subprocess; that's covered by
# brain_push_cli.test.ts in the brain-mcp-server vitest suite.

load test_helper

HELPER="$IGRIS_ROOT/core/hooks/shared/brain_push_async.sh"
PROJECT_SLUG="td080-test-project"

setup() {
  mkdir -p "$TEST_TEMP_DIR"
  export TEST_HOME="$TEST_TEMP_DIR/home"
  export TEST_BIN_DIR="$TEST_TEMP_DIR/bin"
  export TEST_BRAIN_DIR="$TEST_TEMP_DIR/brain-mcp-server"
  mkdir -p "$TEST_HOME/.igris/projects/$PROJECT_SLUG/session"
  mkdir -p "$TEST_BIN_DIR"
  mkdir -p "$TEST_BRAIN_DIR/scripts"

  # Stub npx that records its argv to a sentinel file. Always succeeds.
  cat > "$TEST_BIN_DIR/npx" <<'EOF'
#!/bin/bash
echo "STUB_NPX_INVOKED args=$*" >> "$STUB_LOG"
exit 0
EOF
  chmod +x "$TEST_BIN_DIR/npx"
  export STUB_LOG="$TEST_TEMP_DIR/stub_npx.log"

  # Hand the helper a sane PATH (need python3 + tail + wc) but with our
  # stubbed npx FIRST, so it intercepts the call.
  export ORIGINAL_PATH="$PATH"
  export PATH="$TEST_BIN_DIR:$PATH"

  # Brain dir override so the helper does not need to walk config.json's
  # source_repo lookup (we still test that path separately when needed).
  export IGRIS_BRAIN_MCP_DIR="$TEST_BRAIN_DIR"
}

teardown() {
  unset IGRIS_BRAIN_MCP_DIR
  export PATH="${ORIGINAL_PATH:-$PATH}"
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# Helper: write a config.json fixture.
write_config() {
  local url="$1"
  local key="$2"
  cat > "$TEST_HOME/.igris/config.json" <<EOF
{
  "remote_brain": {
    "url": "$url",
    "api_key": "$key"
  },
  "source_repo": "$TEST_TEMP_DIR"
}
EOF
}

# =============================================================================
# Argument validation
# =============================================================================

@test "helper exits 0 when project slug arg is missing" {
  HOME="$TEST_HOME" run bash "$HELPER"
  [ "$status" -eq 0 ]
}

# =============================================================================
# Malicious slug rejection (TD-080 warden M-1)
# -----------------------------------------------------------------------------
# The slug is interpolated into downstream filesystem paths and CLI args. Any
# slug not matching ^[a-z0-9_-]+$ must be rejected BEFORE the helper proceeds
# to spawn npx, even when remote_brain config is fully populated. The exit
# code MUST remain 0 so the hook contract holds.
# =============================================================================

@test "rejects malicious project slug (SQL-injection-shaped)" {
  # Stub config with valid remote so we know the helper would normally proceed.
  write_config "http://example.com:3001" "test-api-key"

  # Invoke with a SQL-injection-shaped slug.
  HOME="$TEST_HOME" run bash "$HELPER" "'; DROP TABLE event_log; --"

  # Must exit 0 (defensive) and must NOT have invoked the CLI.
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

@test "rejects project slug with spaces" {
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" "evil project"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

@test "rejects project slug with shell metachars" {
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" 'evil$(rm -rf /)'
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

@test "rejects project slug with uppercase" {
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" "EvilProject"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

@test "rejects project slug with path traversal" {
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" "../../etc"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

# =============================================================================
# Remote-not-configured paths (silent exits)
# =============================================================================

@test "helper exits 0 silently when config.json is absent" {
  # No config file written.
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  # Stub npx must NOT have fired.
  [ ! -f "$STUB_LOG" ]
}

@test "helper exits 0 when remote_brain.url is empty" {
  write_config "" "some-key"
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

@test "helper exits 0 when remote_brain.api_key is empty" {
  write_config "http://example.com:3001" ""
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

@test "helper exits 0 when session dir is missing for the project" {
  write_config "http://example.com:3001" "some-key"
  rm -rf "$TEST_HOME/.igris/projects/$PROJECT_SLUG"
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB_LOG" ]
}

# =============================================================================
# Configured invocation
# =============================================================================

@test "helper invokes brain_push_cli when remote is fully configured" {
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  [ -f "$STUB_LOG" ]
  grep -q "STUB_NPX_INVOKED" "$STUB_LOG"
  grep -q "brain_push_cli.ts" "$STUB_LOG"
  grep -q -- "--project $PROJECT_SLUG" "$STUB_LOG"
}

@test "helper writes 'starting' log entry on configured path" {
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  local log_file="$TEST_HOME/.igris/projects/$PROJECT_SLUG/session/brain_push.log"
  [ -f "$log_file" ]
  grep -q "brain_push_async: starting" "$log_file"
  grep -q "project=$PROJECT_SLUG" "$log_file"
}

# =============================================================================
# Always exits 0 (defensive contract)
# =============================================================================

@test "helper exits 0 even when stub CLI fails" {
  # Replace npx stub with one that fails hard.
  cat > "$TEST_BIN_DIR/npx" <<'EOF'
#!/bin/bash
echo "STUB_NPX_FAILED args=$*" >> "$STUB_LOG"
exit 17
EOF
  chmod +x "$TEST_BIN_DIR/npx"
  write_config "http://example.com:3001" "test-api-key"
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  # Stub did fire and did fail.
  [ -f "$STUB_LOG" ]
  grep -q "STUB_NPX_FAILED" "$STUB_LOG"
}

@test "helper exits 0 when brain MCP dir is missing" {
  write_config "http://example.com:3001" "test-api-key"
  rm -rf "$TEST_BRAIN_DIR"
  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]
  # Helper logs the error but still exits 0.
  local log_file="$TEST_HOME/.igris/projects/$PROJECT_SLUG/session/brain_push.log"
  [ -f "$log_file" ]
  grep -q "cannot locate brain-mcp-server" "$log_file"
}

# =============================================================================
# Log rotation (1MB threshold → tail-kept at 512KB)
# =============================================================================

@test "helper rotates log when it grows past 1MB" {
  write_config "http://example.com:3001" "test-api-key"
  local log_file="$TEST_HOME/.igris/projects/$PROJECT_SLUG/session/brain_push.log"
  # Pre-write 1.1MB of junk.
  perl -e 'print "x" x (1100 * 1024)' > "$log_file"
  local before
  before=$(wc -c < "$log_file" | tr -d ' ')
  [ "$before" -gt 1048576 ]

  HOME="$TEST_HOME" run bash "$HELPER" "$PROJECT_SLUG"
  [ "$status" -eq 0 ]

  local after
  after=$(wc -c < "$log_file" | tr -d ' ')
  # After rotation: tail-kept 512KB plus the new "starting" header line.
  # Should be well under the original 1.1MB.
  [ "$after" -lt 700000 ]
}
