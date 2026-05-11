#!/bin/bash
set -e

# Description: Config loader for igris_worker.sh — loads worker settings from ~/.igris/config.json
# Usage: source igris_worker_config.sh
# Dependencies: python3
# Exit codes:
#   0 - Success (variables exported)
#   1 - Error (config missing, python3 unavailable)

# Loads worker config from ~/.igris/config.json into shell variables:
# WORKER_ENABLED, WORKER_POLL_INTERVAL, WORKER_MAX_CONCURRENT,
# WORKER_ALLOWED_TYPES, WORKER_AGENT_NAME, WORKER_CAPABILITIES,
# WORKER_AUTO_SLEEP_MINUTES, WORKER_LOG_DIR,
# REMOTE_BRAIN_URL, REMOTE_BRAIN_API_KEY

IGRIS_CONFIG_FILE="$HOME/.igris/config.json"

# Validates that python3 is installed and accessible
# Exits with error code 1 and helpful message if not found
check_python3_available() {
  if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS:  brew install python3"
    echo "  Ubuntu: sudo apt install python3"
    echo "  WSL:    sudo apt install python3"
    echo ""
    exit 1
  fi
}

# Validates that ~/.igris/config.json exists and is readable
check_config_exists() {
  if [ ! -f "$IGRIS_CONFIG_FILE" ]; then
    echo "Error: Igris config not found at $IGRIS_CONFIG_FILE"
    echo ""
    echo "Run brain init first:"
    echo "  igris init"
    echo ""
    exit 1
  fi
}

# Loads all worker config values from config.json into shell variables
# Uses python3 for reliable JSON parsing (per coding_guidelines.md)
load_worker_config() {
  local config_output
  # Use || true to prevent set -e from killing the script on python3 failure
  config_output=$(python3 -c "
import json, sys, os

config_path = sys.argv[1]

try:
    with open(config_path, 'r') as f:
        config = json.load(f)
except (json.JSONDecodeError, IOError) as e:
    print('PARSE_ERROR:' + str(e))
    sys.exit(1)

# Worker config (nested under 'worker' key, with defaults)
worker = config.get('worker', {})

enabled = str(worker.get('enabled', False)).lower()
poll_interval = worker.get('poll_interval_seconds', 30)
max_concurrent = worker.get('max_concurrent_tasks', 2)
allowed_types = ','.join(worker.get('allowed_task_types', ['dev', 'research', 'operational']))
agent_name = worker.get('agent_name', 'worker')
capabilities = ','.join(worker.get('capabilities', ['code', 'test', 'research']))
auto_sleep = worker.get('auto_sleep_minutes', 60)
log_dir = worker.get('log_dir', os.path.expanduser('~/.igris/logs/worker'))

# Remote brain config
remote = config.get('remote_brain', {})
remote_url = remote.get('url', '')
remote_api_key = remote.get('api_key', '')

# Output as KEY=VALUE pairs for shell eval
print('WORKER_ENABLED=' + enabled)
print('WORKER_POLL_INTERVAL=' + str(poll_interval))
print('WORKER_MAX_CONCURRENT=' + str(max_concurrent))
print('WORKER_ALLOWED_TYPES=' + allowed_types)
print('WORKER_AGENT_NAME=' + agent_name)
print('WORKER_CAPABILITIES=' + capabilities)
print('WORKER_AUTO_SLEEP_MINUTES=' + str(auto_sleep))
print('WORKER_LOG_DIR=' + log_dir)
print('REMOTE_BRAIN_URL=' + remote_url)
print('REMOTE_BRAIN_API_KEY=' + remote_api_key)
" "$IGRIS_CONFIG_FILE" 2>&1) || true

  # Check if python3 reported a parse error
  if echo "$config_output" | grep -q "^PARSE_ERROR:"; then
    echo "Error: Failed to load worker config from $IGRIS_CONFIG_FILE"
    echo "$config_output"
    exit 1
  fi

  # Check if output is empty (python3 failed without our error marker)
  if [ -z "$config_output" ]; then
    echo "Error: Failed to load worker config from $IGRIS_CONFIG_FILE"
    exit 1
  fi

  # Eval the KEY=VALUE output into shell variables
  eval "$config_output"
}

# Main config loading sequence
check_python3_available
check_config_exists
load_worker_config
