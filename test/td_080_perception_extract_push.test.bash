#!/usr/bin/env bats

# TD-080 — bats tests for the perception_extract_and_persist.sh wiring change.
#
# Verifies that the extractor invokes brain_push_async.sh ONLY on the success
# path (CLI exit 0) and NOT on the failure path. Also confirms the
# "queued async push" log marker is written on success.
#
# We stub:
#   - npx — pretends to be the perception CLI; exit code controlled by env
#   - brain_push_async.sh — replaced with a sentinel-writer in a temp dir,
#     pointed at via PATH? No — the extractor invokes the helper by absolute
#     path ($HOME/.igris/core/hooks/shared/brain_push_async.sh), so we
#     intercept by overriding HOME and placing a stub at that location.

load test_helper

EXTRACTOR="$IGRIS_ROOT/core/hooks/shared/perception_extract_and_persist.sh"
PROJECT_SLUG="td080-extractor-test"

setup() {
  mkdir -p "$TEST_TEMP_DIR"
  export TEST_HOME="$TEST_TEMP_DIR/home"
  export TEST_BIN_DIR="$TEST_TEMP_DIR/bin"
  export TEST_BRAIN_DIR="$TEST_TEMP_DIR/brain-mcp-server"
  mkdir -p "$TEST_HOME/.igris/projects/$PROJECT_SLUG/session"
  mkdir -p "$TEST_BIN_DIR"
  mkdir -p "$TEST_BRAIN_DIR/scripts"

  # Place a stub brain_push_async.sh at the path the extractor invokes.
  # Drops a sentinel file so the test can assert "did/didn't run".
  mkdir -p "$TEST_HOME/.igris/core/hooks/shared"
  cat > "$TEST_HOME/.igris/core/hooks/shared/brain_push_async.sh" <<EOF
#!/bin/bash
echo "PUSH_INVOKED slug=\$1" > "$TEST_TEMP_DIR/push_sentinel"
exit 0
EOF
  chmod +x "$TEST_HOME/.igris/core/hooks/shared/brain_push_async.sh"

  # Stub npx that pretends to be the perception CLI. Exit code from
  # FAKE_CLI_RC env (default 0).
  cat > "$TEST_BIN_DIR/npx" <<'EOF'
#!/bin/bash
echo "FAKE_PERCEPTION_CLI args=$*"
exit "${FAKE_CLI_RC:-0}"
EOF
  chmod +x "$TEST_BIN_DIR/npx"

  export ORIGINAL_PATH="$PATH"
  export PATH="$TEST_BIN_DIR:$PATH"
  export IGRIS_BRAIN_MCP_DIR="$TEST_BRAIN_DIR"

  # Build a fake transcript file. The extractor reads its path from stdin
  # JSON and verifies it exists; content is opaque to this test.
  export FAKE_TRANSCRIPT="$TEST_TEMP_DIR/transcript.jsonl"
  echo '{"type":"text","text":"hello"}' > "$FAKE_TRANSCRIPT"

  # Reset min-window watermark so the guard doesn't short-circuit us.
  rm -f "$TEST_HOME/.igris/projects/$PROJECT_SLUG/session/perception_extract_watermark.txt"
}

teardown() {
  unset IGRIS_BRAIN_MCP_DIR FAKE_CLI_RC
  export PATH="${ORIGINAL_PATH:-$PATH}"
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# Build the JSON the parent hook would feed on stdin.
make_stdin() {
  printf '{"transcript_path":"%s"}' "$FAKE_TRANSCRIPT"
}

# =============================================================================
# Success path — push fires
# =============================================================================

@test "extractor invokes brain_push_async.sh when CLI exits 0" {
  FAKE_CLI_RC=0 HOME="$TEST_HOME" run bash -c "echo '$(make_stdin)' | bash '$EXTRACTOR' '$PROJECT_SLUG' 'session_end'"
  [ "$status" -eq 0 ]
  # Wait briefly for the detached helper to write its sentinel (nohup &).
  for _ in 1 2 3 4 5; do
    [ -f "$TEST_TEMP_DIR/push_sentinel" ] && break
    sleep 0.2
  done
  [ -f "$TEST_TEMP_DIR/push_sentinel" ]
  grep -q "slug=$PROJECT_SLUG" "$TEST_TEMP_DIR/push_sentinel"
}

@test "extractor logs 'queued async push' on success path" {
  FAKE_CLI_RC=0 HOME="$TEST_HOME" run bash -c "echo '$(make_stdin)' | bash '$EXTRACTOR' '$PROJECT_SLUG' 'session_end'"
  [ "$status" -eq 0 ]
  local log_file="$TEST_HOME/.igris/projects/$PROJECT_SLUG/session/perception_extract.log"
  [ -f "$log_file" ]
  grep -q "queued async push" "$log_file"
}

# =============================================================================
# Failure path — push does NOT fire
# =============================================================================

@test "extractor does NOT invoke brain_push_async.sh when CLI exits non-zero" {
  FAKE_CLI_RC=1 HOME="$TEST_HOME" run bash -c "echo '$(make_stdin)' | bash '$EXTRACTOR' '$PROJECT_SLUG' 'session_end'"
  [ "$status" -eq 0 ]
  # Allow same window as success-path test — proves absence not just slowness.
  for _ in 1 2 3 4 5; do
    [ -f "$TEST_TEMP_DIR/push_sentinel" ] && break
    sleep 0.2
  done
  [ ! -f "$TEST_TEMP_DIR/push_sentinel" ]
}

@test "extractor does NOT log 'queued async push' on failure path" {
  FAKE_CLI_RC=1 HOME="$TEST_HOME" run bash -c "echo '$(make_stdin)' | bash '$EXTRACTOR' '$PROJECT_SLUG' 'session_end'"
  [ "$status" -eq 0 ]
  local log_file="$TEST_HOME/.igris/projects/$PROJECT_SLUG/session/perception_extract.log"
  [ -f "$log_file" ]
  ! grep -q "queued async push" "$log_file"
}
