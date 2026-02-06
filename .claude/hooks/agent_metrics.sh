#!/bin/bash
set -e

# Description: SubagentStart/SubagentStop hook for Claude Code lifecycle integration.
#              Tracks agent invocations, timing, and success rates in the Igris AI
#              metrics system. Uses flock for concurrency safety.
# Usage: Called automatically by Claude Code on subagent start/stop. Reads JSON from stdin.
# Dependencies: python3, flock (optional - degrades gracefully)
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Constants
METRICS_DIR="ai/session/metrics"
METRICS_FILE="${METRICS_DIR}/agent-metrics.json"
LOCK_FILE="/tmp/igris_agent_metrics.lock"
TIMESTAMP_DIR="/tmp"

# Read stdin (Claude Code sends JSON with hook_event_name, agent_type or agent_id)
INPUT=$(cat)

# Parse hook event name and agent type from input
parse_input() {
  if command -v jq &> /dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null) || HOOK_EVENT=""
    AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // .agent_id // "unknown"' 2>/dev/null) || AGENT_TYPE="unknown"
  else
    eval "$(echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    hook = data.get('hook_event_name', '')
    agent = data.get('agent_type', data.get('agent_id', 'unknown'))
    print(f'HOOK_EVENT=\"{hook}\"')
    print(f'AGENT_TYPE=\"{agent}\"')
except Exception:
    print('HOOK_EVENT=\"\"')
    print('AGENT_TYPE=\"unknown\"')
" 2>/dev/null)" || {
      HOOK_EVENT=""
      AGENT_TYPE="unknown"
    }
  fi
}

# Ensure metrics directory exists
ensure_metrics_dir() {
  mkdir -p "$METRICS_DIR" 2>/dev/null || true
}

# Update metrics using python3 for reliable JSON handling
update_metrics() {
  local hook_event="$1"
  local agent_type="$2"
  local timestamp_file="${TIMESTAMP_DIR}/igris_agent_${agent_type}_start"

  python3 << PYEOF
import json
import os
import time
import tempfile
from datetime import datetime, timezone

metrics_file = "${METRICS_FILE}"
hook_event = "${hook_event}"
agent_type = "${agent_type}"
timestamp_file = "${timestamp_file}"

# Default metrics structure
default_metrics = {
    "version": "1.0.0",
    "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "agents": {},
    "totals": {
        "total_invocations": 0,
        "most_used_agent": "",
        "least_used_agent": ""
    }
}

# Load existing metrics or create default
try:
    with open(metrics_file, 'r') as f:
        metrics = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    metrics = default_metrics

# Ensure structure
if "agents" not in metrics:
    metrics["agents"] = {}
if "totals" not in metrics:
    metrics["totals"] = {"total_invocations": 0, "most_used_agent": "", "least_used_agent": ""}

# Initialize agent entry if needed
if agent_type not in metrics["agents"]:
    metrics["agents"][agent_type] = {
        "invocations": 0,
        "last_used": "",
        "avg_duration_seconds": 0,
        "success_rate": 1.0
    }

agent = metrics["agents"][agent_type]
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

if hook_event == "SubagentStart":
    # Increment invocations
    agent["invocations"] += 1
    agent["last_used"] = now

    # Write start timestamp
    try:
        with open(timestamp_file, 'w') as f:
            f.write(str(time.time()))
    except Exception:
        pass

    # Update totals
    metrics["totals"]["total_invocations"] += 1

elif hook_event == "SubagentStop":
    # Calculate duration if start timestamp exists
    try:
        with open(timestamp_file, 'r') as f:
            start_time = float(f.read().strip())
        duration = time.time() - start_time

        # Update rolling average duration
        prev_avg = agent.get("avg_duration_seconds", 0)
        prev_count = max(agent.get("invocations", 1) - 1, 1)
        agent["avg_duration_seconds"] = round(
            ((prev_avg * prev_count) + duration) / (prev_count + 1), 2
        )

        # Clean up timestamp file
        os.remove(timestamp_file)
    except (FileNotFoundError, ValueError):
        pass

# Update most/least used
if metrics["agents"]:
    sorted_agents = sorted(
        metrics["agents"].items(),
        key=lambda x: x[1].get("invocations", 0),
        reverse=True
    )
    metrics["totals"]["most_used_agent"] = sorted_agents[0][0]
    metrics["totals"]["least_used_agent"] = sorted_agents[-1][0]

metrics["last_updated"] = now

# Write metrics atomically
try:
    dir_name = os.path.dirname(os.path.abspath(metrics_file))
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix='.tmp')
    with os.fdopen(fd, 'w') as f:
        json.dump(metrics, f, indent=2)
        f.write('\n')
    os.rename(tmp_path, metrics_file)
except Exception as e:
    import sys
    print(f"agent_metrics.sh: failed to write metrics: {e}", file=sys.stderr)
PYEOF
}

# Main execution
main() {
  parse_input

  if [ -z "$HOOK_EVENT" ] || [ -z "$AGENT_TYPE" ]; then
    exit 0
  fi

  ensure_metrics_dir

  # Use flock for concurrency safety if available
  if command -v flock &> /dev/null; then
    (
      flock -w 3 200 2>/dev/null || true
      update_metrics "$HOOK_EVENT" "$AGENT_TYPE"
    ) 200>"$LOCK_FILE" 2>/dev/null || update_metrics "$HOOK_EVENT" "$AGENT_TYPE" 2>/dev/null || true
  else
    update_metrics "$HOOK_EVENT" "$AGENT_TYPE" 2>/dev/null || true
  fi

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
