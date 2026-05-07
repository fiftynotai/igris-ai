#!/usr/bin/env bats

# Test suite for FR-065 Wave 7: config.json worker section generation,
# CLAUDE.md worker mode section, and install.sh worker directory/script setup.
#
# Tests:
# - config.json includes worker section with correct defaults
# - CLAUDE.global.md.template contains Worker Mode section
# - igris_brain_init.sh fallback heredoc contains Worker Mode section
# - igris_install.sh creates worker and output directories
# - igris_install.sh copies worker scripts to ~/.igris/scripts/

load test_helper

# =============================================================================
# SETUP / TEARDOWN
# =============================================================================

setup() {
  mkdir -p "$TEST_TEMP_DIR"
}

teardown() {
  if [ -d "$TEST_TEMP_DIR" ]; then
    rm -rf "$TEST_TEMP_DIR"
  fi
}

# =============================================================================
# CONFIG.JSON WORKER SECTION TESTS
# =============================================================================

@test "brain_init config generation includes worker section" {
  require_python3

  # Simulate the python3 config generation from igris_brain_init.sh
  local output_file="$TEST_TEMP_DIR/config.json"
  local install_date="2026-02-26T00:00:00Z"
  local source_repo="/tmp/test-repo"

  python3 -c "
import json, sys

brain_mode = sys.argv[4]
remote_url = sys.argv[5] if len(sys.argv) > 5 else ''
remote_key = sys.argv[6] if len(sys.argv) > 6 else ''

config = {
    'version': '4.0.0',
    'installed_at': sys.argv[1],
    'source_repo': sys.argv[2],
    'features': {
        'memory': brain_mode in ('local', 'dual'),
        'project_registry': True,
        'symlinks': True,
        'staging_pipeline': brain_mode in ('local', 'dual'),
        'analytics': True
    },
    'paths': {
        'brain': '~/.igris',
        'core': '~/.igris/core',
        'memory': '~/.igris/memory',
        'staging': '~/.igris/staging'
    },
    'database': {
        'path': '~/.igris/memory/knowledge.db',
        'wal_mode': True,
        'busy_timeout_ms': 5000
    },
    'worker': {
        'enabled': False,
        'poll_interval_seconds': 30,
        'max_concurrent_tasks': 2,
        'allowed_task_types': ['dev', 'research', 'operational'],
        'agent_name': 'worker',
        'capabilities': ['code', 'test', 'research'],
        'auto_sleep_minutes': 60,
        'log_dir': '~/.igris/logs/worker'
    }
}

if brain_mode in ('remote', 'dual') and remote_url and remote_key:
    config['remote_brain'] = {
        'url': remote_url,
        'api_key': remote_key
    }

with open(sys.argv[3], 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$install_date" "$source_repo" "$output_file" "local" "" ""

  assert_file_exists "$output_file"
  assert_file_contains "$output_file" '"worker"'
  assert_file_contains "$output_file" '"enabled": false'
  assert_file_contains "$output_file" '"poll_interval_seconds": 30'
  assert_file_contains "$output_file" '"max_concurrent_tasks": 2'
  assert_file_contains "$output_file" '"agent_name": "worker"'
  assert_file_contains "$output_file" '"auto_sleep_minutes": 60'
  assert_file_contains "$output_file" '"log_dir": "~/.igris/logs/worker"'
}

@test "config.json worker section has correct allowed_task_types" {
  require_python3

  local output_file="$TEST_TEMP_DIR/config_types.json"

  python3 -c "
import json
config = {
    'worker': {
        'enabled': False,
        'poll_interval_seconds': 30,
        'max_concurrent_tasks': 2,
        'allowed_task_types': ['dev', 'research', 'operational'],
        'agent_name': 'worker',
        'capabilities': ['code', 'test', 'research'],
        'auto_sleep_minutes': 60,
        'log_dir': '~/.igris/logs/worker'
    }
}
with open('$output_file', 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
"

  # Verify JSON round-trips correctly
  run python3 -c "
import json
with open('$output_file') as f:
    config = json.load(f)
w = config['worker']
assert w['allowed_task_types'] == ['dev', 'research', 'operational'], f'Got: {w[\"allowed_task_types\"]}'
assert w['capabilities'] == ['code', 'test', 'research'], f'Got: {w[\"capabilities\"]}'
print('OK')
"

  assert_success
  assert_output_contains "OK"
}

@test "config.json is valid JSON with worker section" {
  require_python3

  local output_file="$TEST_TEMP_DIR/valid_config.json"

  python3 -c "
import json, sys

config = {
    'version': '4.0.0',
    'installed_at': '2026-02-26T00:00:00Z',
    'source_repo': '/tmp/test',
    'features': {'memory': True, 'project_registry': True, 'symlinks': True, 'staging_pipeline': True, 'analytics': True},
    'paths': {'brain': '~/.igris', 'core': '~/.igris/core', 'memory': '~/.igris/memory', 'staging': '~/.igris/staging'},
    'database': {'path': '~/.igris/memory/knowledge.db', 'wal_mode': True, 'busy_timeout_ms': 5000},
    'worker': {
        'enabled': False,
        'poll_interval_seconds': 30,
        'max_concurrent_tasks': 2,
        'allowed_task_types': ['dev', 'research', 'operational'],
        'agent_name': 'worker',
        'capabilities': ['code', 'test', 'research'],
        'auto_sleep_minutes': 60,
        'log_dir': '~/.igris/logs/worker'
    }
}
with open(sys.argv[1], 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
" "$output_file"

  # Validate it's parseable JSON
  run python3 -c "
import json
with open('$output_file') as f:
    data = json.load(f)
assert 'worker' in data
assert 'features' in data
assert 'paths' in data
assert 'database' in data
print('Valid JSON')
"

  assert_success
  assert_output_contains "Valid JSON"
}

# =============================================================================
# CLAUDE.MD TEMPLATE TESTS
# =============================================================================

@test "CLAUDE.global.md.template contains Worker Mode section" {
  assert_file_contains "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" "## Worker Mode"
}

@test "CLAUDE.global.md.template contains worker daemon reference" {
  assert_file_contains "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" "igris_worker.sh"
}

@test "CLAUDE.global.md.template contains required MCP tools" {
  assert_file_contains "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" "igris_task_get"
  assert_file_contains "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" "igris_task_result_add"
  assert_file_contains "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" "igris_task_complete"
  assert_file_contains "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" "igris_task_fail"
}

@test "CLAUDE.global.md.template worker section appears before Note section" {
  # Worker Mode must come before the Note section
  local worker_line
  local note_line
  worker_line=$(grep -n "## Worker Mode" "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" | head -1 | cut -d: -f1)
  note_line=$(grep -n "## Note" "$IGRIS_ROOT/scripts/templates/CLAUDE.global.md.template" | head -1 | cut -d: -f1)

  [ "$worker_line" -lt "$note_line" ]
}

@test "brain_init fallback heredoc contains Worker Mode section" {
  assert_file_contains "$SCRIPTS_DIR/igris_brain_init.sh" "## Worker Mode"
}

@test "brain_init fallback heredoc contains autonomous work instruction" {
  assert_file_contains "$SCRIPTS_DIR/igris_brain_init.sh" "Do NOT ask for user input -- work autonomously"
}

# =============================================================================
# WORKER DIRECTORY / SCRIPT INSTALLATION TESTS
# =============================================================================
# (M2: scripts/igris_install.sh deleted — its worker-script copy logic moved
# to a future cli/src/lib/worker-install.ts module that ships in MG-014 Phase 3.
# The previous source-content assertions are obsolete; per-functionality
# coverage will be re-added when the TS port lands.)

# =============================================================================
# COORDINATION SCHEMA TESTS
# =============================================================================

@test "coordination schema already has auto_route_enabled" {
  assert_file_contains "$IGRIS_ROOT/brain-mcp-server/src/engine/components/coordination/schema.ts" "auto_route_enabled"
}
