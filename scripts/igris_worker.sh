#!/bin/bash
set -e

# Description: Igris AI Worker Daemon — polls brain for tasks and spawns Claude Code sessions
# Usage: igris_worker.sh [start|stop|status]
# Dependencies: python3, claude CLI, curl
# Exit codes:
#   0 - Success / clean shutdown
#   1 - Error (config missing, dependency check failed)
#   2 - Usage error

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$HOME/.igris/worker.pid"
HEARTBEAT_INTERVAL=300  # 5 minutes in seconds

# ============================================================
# Dependency checks
# ============================================================

# Validates that python3 is installed and accessible
# Exits with error code 1 and helpful message if not found
check_python3() {
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

# Validates that the claude CLI is installed and accessible
# Exits with error code 1 and helpful message if not found
check_claude() {
  if ! command -v claude &> /dev/null; then
    echo "Error: claude CLI is required but not installed"
    echo ""
    echo "Install Claude Code:"
    echo "  npm install -g @anthropic-ai/claude-code"
    echo ""
    exit 1
  fi
}

# Validates that curl is available for HTTP API calls
check_curl() {
  if ! command -v curl &> /dev/null; then
    echo "Error: curl is required but not installed"
    echo ""
    echo "Install curl:"
    echo "  macOS:  brew install curl"
    echo "  Ubuntu: sudo apt install curl"
    echo ""
    exit 1
  fi
}

# Runs all dependency checks upfront before any work
check_dependencies() {
  check_python3
  check_claude
  check_curl
}

# ============================================================
# Logging
# ============================================================

# Writes a timestamped message to the worker log file and stdout
# Usage: log "message"
log() {
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local message="[$timestamp] $1"
  echo "$message"
  echo "$message" >> "$WORKER_LOG_DIR/worker.log"
}

# Writes an error-level timestamped message to the log and stderr
# Usage: log_error "message"
log_error() {
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local message="[$timestamp] ERROR: $1"
  echo "$message" >&2
  echo "$message" >> "$WORKER_LOG_DIR/worker.log"
}

# ============================================================
# PID file management
# ============================================================

# Writes the current process PID to the PID file
write_pid_file() {
  echo $$ > "$PID_FILE"
}

# Removes the PID file on shutdown
remove_pid_file() {
  rm -f "$PID_FILE"
}

# Returns 0 if the daemon is currently running, 1 otherwise
# Checks both PID file existence and whether the process is alive
is_daemon_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -z "$pid" ]; then
    return 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    return 0
  else
    # Stale PID file — process is dead
    return 1
  fi
}

# ============================================================
# Brain HTTP API interaction
# ============================================================

# Calls a brain MCP tool via the HTTP API using curl
# Much lighter than spawning a full claude session for each poll
# Usage: brain_api_call <tool_name> <json_args>
# Returns: tool response JSON on stdout, exit code 0 on success
brain_api_call() {
  local tool_name="$1"
  local json_args="$2"

  local response
  response=$(curl -s --connect-timeout 10 --max-time 30 \
    -X POST "${REMOTE_BRAIN_URL%/}/api/tools/${tool_name}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${REMOTE_BRAIN_API_KEY}" \
    -d "$json_args" 2>/dev/null) || return 1

  echo "$response"
}

# Polls the brain for the next available task matching worker capabilities
# Returns task JSON on stdout if a task is found, empty string otherwise
poll_for_task() {
  local capabilities_json
  capabilities_json=$(python3 -c "
import json, sys
caps = sys.argv[1].split(',')
print(json.dumps({'capabilities': caps, 'agent_name': sys.argv[2]}))
" "$WORKER_CAPABILITIES" "$WORKER_AGENT_NAME")

  local response
  response=$(brain_api_call "igris_task_next" "$capabilities_json" 2>/dev/null) || {
    log_error "Failed to poll brain for tasks"
    echo ""
    return 0
  }

  # Check if a task was returned (vs empty/null/error response)
  local has_task
  has_task=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    # The response might be nested under 'result' or 'content'
    result = data if isinstance(data, dict) else {}
    if result.get('result'):
        result = result['result']
    if isinstance(result, dict) and result.get('content'):
        content = result['content']
        if isinstance(content, list) and len(content) > 0:
            text = content[0].get('text', '')
            parsed = json.loads(text) if text else {}
            if parsed.get('task_id') or parsed.get('id'):
                print('yes')
                sys.exit(0)
    # Direct task object
    if result.get('task_id') or result.get('id'):
        print('yes')
        sys.exit(0)
    print('no')
except Exception:
    print('no')
" "$response" 2>/dev/null) || has_task="no"

  if [ "$has_task" = "yes" ]; then
    echo "$response"
  else
    echo ""
  fi
}

# Extracts the task ID from a brain API response JSON
# Usage: extract_task_id <response_json>
extract_task_id() {
  local response="$1"
  python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    result = data if isinstance(data, dict) else {}
    if result.get('result'):
        result = result['result']
    if isinstance(result, dict) and result.get('content'):
        content = result['content']
        if isinstance(content, list) and len(content) > 0:
            text = content[0].get('text', '')
            parsed = json.loads(text) if text else {}
            task_id = parsed.get('task_id') or parsed.get('id') or ''
            print(task_id)
            sys.exit(0)
    task_id = result.get('task_id') or result.get('id') or ''
    print(task_id)
except Exception:
    print('')
" "$response" 2>/dev/null || echo ""
}

# Extracts the task type from a brain API response JSON
# Usage: extract_task_type <response_json>
extract_task_type() {
  local response="$1"
  python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    result = data if isinstance(data, dict) else {}
    if result.get('result'):
        result = result['result']
    if isinstance(result, dict) and result.get('content'):
        content = result['content']
        if isinstance(content, list) and len(content) > 0:
            text = content[0].get('text', '')
            parsed = json.loads(text) if text else {}
            print(parsed.get('task_type', 'dev'))
            sys.exit(0)
    print(result.get('task_type', 'dev'))
except Exception:
    print('dev')
" "$response" 2>/dev/null || echo "dev"
}

# ============================================================
# Instance registration
# ============================================================

# Registers this worker instance with the brain via heartbeat
# Sends hostname, OS, capabilities so the brain knows this worker is online
register_instance() {
  local hostname_val
  hostname_val=$(hostname)
  local os_val
  os_val=$(uname -s | tr '[:upper:]' '[:lower:]')

  local capabilities_json
  capabilities_json=$(python3 -c "
import json, sys
caps = sys.argv[1].split(',')
print(json.dumps(caps))
" "$WORKER_CAPABILITIES")

  local args
  args=$(python3 -c "
import json, sys
print(json.dumps({
    'machine_hostname': sys.argv[1],
    'machine_os': sys.argv[2],
    'project_slug': 'igris-worker',
    'capabilities': json.loads(sys.argv[3])
}))
" "$hostname_val" "$os_val" "$capabilities_json")

  brain_api_call "igris_instance_heartbeat" "$args" > /dev/null 2>&1 || {
    log_error "Failed to register instance heartbeat"
    return 0
  }

  log "Instance registered (hostname=$hostname_val, os=$os_val, capabilities=$WORKER_CAPABILITIES)"
}

# Removes this worker instance from the brain registry on shutdown
remove_instance() {
  local hostname_val
  hostname_val=$(hostname)

  local args
  args=$(python3 -c "
import json, sys
print(json.dumps({'machine_hostname': sys.argv[1], 'project_slug': 'igris-worker'}))
" "$hostname_val")

  brain_api_call "igris_instance_remove" "$args" > /dev/null 2>&1 || {
    log_error "Failed to remove instance from brain"
    return 0
  }

  log "Instance removed from brain registry"
}

# ============================================================
# Task execution
# ============================================================

# Array to track spawned child process PIDs
declare -a CHILD_PIDS=()

# Returns the count of currently running child processes
# Cleans up finished processes from the tracking array
count_running_tasks() {
  local running=0
  local new_pids=()

  for pid in "${CHILD_PIDS[@]}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      running=$((running + 1))
      new_pids+=("$pid")
    fi
  done

  CHILD_PIDS=("${new_pids[@]}")
  echo "$running"
}

# Spawns a Claude Code session to execute a task
# Loads the task handler skill for the given task type and passes it to claude
# Usage: spawn_task <task_id> <task_type>
spawn_task() {
  local task_id="$1"
  local task_type="$2"

  # Resolve handler skill path — check both global and project-local locations
  local handler_path=""
  local global_handler="$HOME/.claude/skills/task-handlers/${task_type}.md"
  local project_handler="$SCRIPT_DIR/../.claude/skills/task-handlers/${task_type}.md"

  if [ -f "$global_handler" ]; then
    handler_path="$global_handler"
  elif [ -f "$project_handler" ]; then
    handler_path="$project_handler"
  else
    log_error "No handler skill found for task type '$task_type' (checked $global_handler and $project_handler)"
    return 1
  fi

  local handler_content
  handler_content=$(cat "$handler_path")

  local prompt="You are an Igris AI worker executing task ${task_id}.
Read the handler instructions below and execute the task.

Task ID: ${task_id}
Task Type: ${task_type}

Handler Instructions:
${handler_content}"

  # Spawn claude in the background — it reads global CLAUDE.md automatically
  claude -p "$prompt" >> "$WORKER_LOG_DIR/task_${task_id}.log" 2>&1 &
  local child_pid=$!
  CHILD_PIDS+=("$child_pid")

  log "Task ${task_id} (type=${task_type}) spawned (PID: ${child_pid})"
}

# ============================================================
# Graceful shutdown
# ============================================================

# Flag to signal the main loop to stop
SHUTDOWN_REQUESTED=false

# Handles SIGINT/SIGTERM for clean daemon shutdown
# Waits for child processes with a timeout, then cleans up
handle_shutdown() {
  SHUTDOWN_REQUESTED=true
  log "Shutdown requested, waiting for child processes..."

  local timeout=60
  local elapsed=0

  while [ "$(count_running_tasks)" -gt 0 ] && [ "$elapsed" -lt "$timeout" ]; do
    sleep 2
    elapsed=$((elapsed + 2))
    log "Waiting for $(count_running_tasks) child process(es)... (${elapsed}s/${timeout}s)"
  done

  local remaining
  remaining=$(count_running_tasks)
  if [ "$remaining" -gt 0 ]; then
    log "Timeout reached with $remaining process(es) still running, sending SIGTERM"
    for pid in "${CHILD_PIDS[@]}"; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done
  fi

  remove_instance
  remove_pid_file
  log "Worker daemon stopped"
  exit 0
}

# ============================================================
# Commands: start, stop, status
# ============================================================

# Displays the current daemon status — running/stopped, PID, task count
cmd_status() {
  if is_daemon_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "Worker daemon is running (PID: $pid)"

    # Count child processes of the daemon
    local children
    children=$(pgrep -P "$pid" 2>/dev/null | wc -l | tr -d ' ')
    echo "Active tasks: $children"
  else
    echo "Worker daemon is not running"
    if [ -f "$PID_FILE" ]; then
      echo "Stale PID file found at $PID_FILE (removing)"
      rm -f "$PID_FILE"
    fi
  fi
}

# Sends SIGTERM to the running daemon for clean shutdown
cmd_stop() {
  if ! is_daemon_running; then
    echo "Worker daemon is not running"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping worker daemon (PID: $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait briefly for clean shutdown
  local wait_count=0
  while kill -0 "$pid" 2>/dev/null && [ "$wait_count" -lt 15 ]; do
    sleep 1
    wait_count=$((wait_count + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "Daemon did not stop gracefully, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi

  echo "Worker daemon stopped"
}

# Main daemon loop — polls brain for tasks, spawns claude sessions, sends heartbeats
cmd_start() {
  # Prevent duplicate daemons
  if is_daemon_running; then
    local existing_pid
    existing_pid=$(cat "$PID_FILE")
    echo "Error: Worker daemon is already running (PID: $existing_pid)"
    echo "Use '$0 stop' to stop it first, or '$0 status' to check."
    exit 1
  fi

  # Validate worker is enabled in config
  if [ "$WORKER_ENABLED" != "true" ]; then
    echo "Error: Worker is not enabled in config"
    echo ""
    echo "Enable it by adding to ~/.igris/config.json:"
    echo '  "worker": { "enabled": true }'
    echo ""
    exit 1
  fi

  # Validate remote brain is configured (required for HTTP polling)
  if [ -z "$REMOTE_BRAIN_URL" ] || [ -z "$REMOTE_BRAIN_API_KEY" ]; then
    echo "Error: Remote brain URL and API key are required for worker daemon"
    echo ""
    echo "Configure remote brain in ~/.igris/config.json:"
    echo '  "remote_brain": { "url": "http://...", "api_key": "..." }'
    echo ""
    exit 1
  fi

  # Create log directory
  mkdir -p "$WORKER_LOG_DIR"

  # Set up signal handlers for clean shutdown
  trap handle_shutdown SIGINT SIGTERM

  # Write PID file
  write_pid_file
  log "Worker daemon started (PID: $$)"
  log "Config: poll_interval=${WORKER_POLL_INTERVAL}s, max_concurrent=${WORKER_MAX_CONCURRENT}, allowed_types=${WORKER_ALLOWED_TYPES}"
  log "Brain URL: ${REMOTE_BRAIN_URL}"

  # Register instance with the brain
  register_instance

  local last_heartbeat
  last_heartbeat=$(date +%s)
  local idle_count=0
  local current_sleep="$WORKER_POLL_INTERVAL"
  # Auto-sleep threshold: increase sleep after this many idle polls
  local auto_sleep_threshold
  auto_sleep_threshold=$(( (WORKER_AUTO_SLEEP_MINUTES * 60) / WORKER_POLL_INTERVAL ))

  # Main polling loop
  while [ "$SHUTDOWN_REQUESTED" = false ]; do
    local running
    running=$(count_running_tasks)

    # Poll for tasks if under concurrency limit
    if [ "$running" -lt "$WORKER_MAX_CONCURRENT" ]; then
      local task_response
      task_response=$(poll_for_task)

      if [ -n "$task_response" ]; then
        local task_id
        task_id=$(extract_task_id "$task_response")
        local task_type
        task_type=$(extract_task_type "$task_response")

        if [ -n "$task_id" ]; then
          log "Task found: ${task_id} (type=${task_type})"
          spawn_task "$task_id" "$task_type" || log_error "Failed to spawn task $task_id"

          # Reset idle state on task found
          idle_count=0
          current_sleep="$WORKER_POLL_INTERVAL"
        else
          idle_count=$((idle_count + 1))
        fi
      else
        idle_count=$((idle_count + 1))
      fi
    else
      log "At max concurrent tasks ($running/$WORKER_MAX_CONCURRENT), skipping poll"
    fi

    # Increase sleep interval when idle for too long (auto-sleep behavior)
    if [ "$idle_count" -gt "$auto_sleep_threshold" ]; then
      # Double the sleep interval, max 5 minutes
      local max_sleep=300
      if [ "$current_sleep" -lt "$max_sleep" ]; then
        current_sleep=$((current_sleep * 2))
        if [ "$current_sleep" -gt "$max_sleep" ]; then
          current_sleep="$max_sleep"
        fi
        log "Idle threshold reached ($idle_count polls), sleep interval increased to ${current_sleep}s"
      fi
    fi

    # Send heartbeat every 5 minutes
    local now
    now=$(date +%s)
    local heartbeat_elapsed=$((now - last_heartbeat))
    if [ "$heartbeat_elapsed" -ge "$HEARTBEAT_INTERVAL" ]; then
      register_instance
      last_heartbeat="$now"
    fi

    # Sleep for the poll interval (use a loop so we can respond to signals promptly)
    local sleep_remaining="$current_sleep"
    while [ "$sleep_remaining" -gt 0 ] && [ "$SHUTDOWN_REQUESTED" = false ]; do
      local sleep_chunk=1
      if [ "$sleep_remaining" -gt 5 ]; then
        sleep_chunk=5
      else
        sleep_chunk="$sleep_remaining"
      fi
      sleep "$sleep_chunk"
      sleep_remaining=$((sleep_remaining - sleep_chunk))
    done
  done
}

# ============================================================
# Main
# ============================================================

main() {
  check_dependencies

  # Source config loader to populate WORKER_* and REMOTE_BRAIN_* variables
  # shellcheck source=igris_worker_config.sh
  source "$SCRIPT_DIR/igris_worker_config.sh"

  local command="${1:-}"

  case "$command" in
    start)
      cmd_start
      ;;
    stop)
      cmd_stop
      ;;
    status)
      cmd_status
      ;;
    "")
      echo "Error: No command specified"
      echo ""
      echo "Usage: $0 [start|stop|status]"
      echo ""
      echo "Commands:"
      echo "  start   - Start the worker daemon (foreground)"
      echo "  stop    - Stop the running daemon"
      echo "  status  - Show daemon status"
      echo ""
      exit 2
      ;;
    *)
      echo "Error: Unknown command '$command'"
      echo ""
      echo "Usage: $0 [start|stop|status]"
      echo ""
      exit 2
      ;;
  esac
}

main "$@"
