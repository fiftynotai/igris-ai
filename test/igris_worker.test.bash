#!/usr/bin/env bats

# Test suite for igris_worker.sh and igris_worker_config.sh
#
# Tests:
# - Config loading and validation
# - Command parsing (start, stop, status)
# - Dependency checks
# - PID file management
# - Usage errors and edge cases

load test_helper

# =============================================================================
# SETUP / TEARDOWN
# =============================================================================

setup() {
  mkdir -p "$TEST_TEMP_DIR"
  export FAKE_BRAIN_DIR="$TEST_TEMP_DIR/fake-igris"
  mkdir -p "$FAKE_BRAIN_DIR"
}

teardown() {
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# =============================================================================
# CONFIG LOADER TESTS (igris_worker_config.sh)
# =============================================================================

@test "config loader fails when config.json is missing" {
  require_python3

  # Point HOME to a temp dir with no config
  export HOME="$TEST_TEMP_DIR/no-config-home"
  mkdir -p "$HOME/.igris"
  # Do NOT create config.json

  run bash -c "source '$SCRIPTS_DIR/igris_worker_config.sh'"

  assert_failure
  assert_output_contains "config not found"
}

@test "config loader parses default values when worker section is absent" {
  require_python3

  # Create a minimal config.json without worker section
  export HOME="$TEST_TEMP_DIR/minimal-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "remote_brain": {
    "url": "http://test-brain:3001",
    "api_key": "test-key-123"
  }
}
EOF

  run bash -c "source '$SCRIPTS_DIR/igris_worker_config.sh' && echo \"ENABLED=\$WORKER_ENABLED\" && echo \"POLL=\$WORKER_POLL_INTERVAL\" && echo \"MAX=\$WORKER_MAX_CONCURRENT\" && echo \"TYPES=\$WORKER_ALLOWED_TYPES\" && echo \"NAME=\$WORKER_AGENT_NAME\" && echo \"CAPS=\$WORKER_CAPABILITIES\" && echo \"SLEEP=\$WORKER_AUTO_SLEEP_MINUTES\" && echo \"URL=\$REMOTE_BRAIN_URL\" && echo \"KEY=\$REMOTE_BRAIN_API_KEY\""

  assert_success
  assert_output_contains "ENABLED=false"
  assert_output_contains "POLL=30"
  assert_output_contains "MAX=2"
  assert_output_contains "TYPES=dev,research,operational"
  assert_output_contains "NAME=worker"
  assert_output_contains "CAPS=code,test,research"
  assert_output_contains "SLEEP=60"
  assert_output_contains "URL=http://test-brain:3001"
  assert_output_contains "KEY=test-key-123"
}

@test "config loader parses custom worker values" {
  require_python3

  export HOME="$TEST_TEMP_DIR/custom-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "worker": {
    "enabled": true,
    "poll_interval_seconds": 15,
    "max_concurrent_tasks": 4,
    "allowed_task_types": ["dev", "content"],
    "agent_name": "my-worker",
    "capabilities": ["code", "ops"],
    "auto_sleep_minutes": 120,
    "log_dir": "/tmp/test-worker-logs"
  },
  "remote_brain": {
    "url": "http://custom-brain:3001",
    "api_key": "custom-key"
  }
}
EOF

  run bash -c "source '$SCRIPTS_DIR/igris_worker_config.sh' && echo \"ENABLED=\$WORKER_ENABLED\" && echo \"POLL=\$WORKER_POLL_INTERVAL\" && echo \"MAX=\$WORKER_MAX_CONCURRENT\" && echo \"TYPES=\$WORKER_ALLOWED_TYPES\" && echo \"NAME=\$WORKER_AGENT_NAME\" && echo \"CAPS=\$WORKER_CAPABILITIES\" && echo \"SLEEP=\$WORKER_AUTO_SLEEP_MINUTES\" && echo \"LOGDIR=\$WORKER_LOG_DIR\" && echo \"URL=\$REMOTE_BRAIN_URL\""

  assert_success
  assert_output_contains "ENABLED=true"
  assert_output_contains "POLL=15"
  assert_output_contains "MAX=4"
  assert_output_contains "TYPES=dev,content"
  assert_output_contains "NAME=my-worker"
  assert_output_contains "CAPS=code,ops"
  assert_output_contains "SLEEP=120"
  assert_output_contains "LOGDIR=/tmp/test-worker-logs"
  assert_output_contains "URL=http://custom-brain:3001"
}

@test "config loader fails on invalid JSON" {
  require_python3

  export HOME="$TEST_TEMP_DIR/bad-json-home"
  mkdir -p "$HOME/.igris"
  echo "NOT VALID JSON {{{" > "$HOME/.igris/config.json"

  run bash -c "source '$SCRIPTS_DIR/igris_worker_config.sh'"

  assert_failure
  assert_output_contains "Failed to load worker config"
}

# =============================================================================
# WORKER COMMAND PARSING TESTS
# =============================================================================

@test "worker shows usage when no command given" {
  run "$SCRIPTS_DIR/igris_worker.sh"

  [ "$status" -eq 2 ]
  assert_output_contains "Usage"
  assert_output_contains "start"
  assert_output_contains "stop"
  assert_output_contains "status"
}

@test "worker rejects unknown command" {
  run "$SCRIPTS_DIR/igris_worker.sh" foobar

  [ "$status" -eq 2 ]
  assert_output_contains "Unknown command"
}

# =============================================================================
# WORKER STATUS TESTS
# =============================================================================

@test "worker status reports not running when no PID file" {
  require_python3

  # Create minimal config so the config loader passes
  export HOME="$TEST_TEMP_DIR/status-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "remote_brain": {
    "url": "http://test:3001",
    "api_key": "test"
  }
}
EOF

  run "$SCRIPTS_DIR/igris_worker.sh" status

  assert_success
  assert_output_contains "not running"
}

@test "worker status cleans up stale PID file" {
  require_python3

  export HOME="$TEST_TEMP_DIR/stale-pid-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "remote_brain": {
    "url": "http://test:3001",
    "api_key": "test"
  }
}
EOF

  # Write a PID that definitely doesn't exist (very high number)
  echo "9999999" > "$HOME/.igris/worker.pid"

  run "$SCRIPTS_DIR/igris_worker.sh" status

  assert_success
  assert_output_contains "not running"
  assert_output_contains "Stale PID file"

  # PID file should be removed
  [ ! -f "$HOME/.igris/worker.pid" ]
}

# =============================================================================
# WORKER START VALIDATION TESTS
# =============================================================================

@test "worker start fails when worker is disabled" {
  require_python3

  export HOME="$TEST_TEMP_DIR/disabled-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "worker": {
    "enabled": false
  },
  "remote_brain": {
    "url": "http://test:3001",
    "api_key": "test"
  }
}
EOF

  run "$SCRIPTS_DIR/igris_worker.sh" start

  assert_failure
  assert_output_contains "not enabled"
}

@test "worker start fails when remote brain URL is missing" {
  require_python3

  export HOME="$TEST_TEMP_DIR/no-remote-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "worker": {
    "enabled": true
  }
}
EOF

  run "$SCRIPTS_DIR/igris_worker.sh" start

  assert_failure
  assert_output_contains "Remote brain URL"
}

# =============================================================================
# WORKER STOP TESTS
# =============================================================================

@test "worker stop reports not running when no daemon active" {
  require_python3

  export HOME="$TEST_TEMP_DIR/stop-home"
  mkdir -p "$HOME/.igris"
  cat > "$HOME/.igris/config.json" << 'EOF'
{
  "version": "4.0.0",
  "remote_brain": {
    "url": "http://test:3001",
    "api_key": "test"
  }
}
EOF

  run "$SCRIPTS_DIR/igris_worker.sh" stop

  assert_success
  assert_output_contains "not running"
}

# =============================================================================
# SCRIPT STRUCTURE TESTS
# =============================================================================

@test "worker script is executable" {
  [ -x "$SCRIPTS_DIR/igris_worker.sh" ]
}

@test "worker config script is executable" {
  [ -x "$SCRIPTS_DIR/igris_worker_config.sh" ]
}

@test "worker script starts with set -e" {
  assert_file_contains "$SCRIPTS_DIR/igris_worker.sh" "set -e"
}

@test "worker config script starts with set -e" {
  assert_file_contains "$SCRIPTS_DIR/igris_worker_config.sh" "set -e"
}

@test "worker script has proper header documentation" {
  assert_file_contains "$SCRIPTS_DIR/igris_worker.sh" "Description:"
  assert_file_contains "$SCRIPTS_DIR/igris_worker.sh" "Usage:"
  assert_file_contains "$SCRIPTS_DIR/igris_worker.sh" "Dependencies:"
  assert_file_contains "$SCRIPTS_DIR/igris_worker.sh" "Exit codes:"
}

@test "worker config script has proper header documentation" {
  assert_file_contains "$SCRIPTS_DIR/igris_worker_config.sh" "Description:"
  assert_file_contains "$SCRIPTS_DIR/igris_worker_config.sh" "Usage:"
  assert_file_contains "$SCRIPTS_DIR/igris_worker_config.sh" "Dependencies:"
}
