#!/bin/bash
set -e

# Description: TeammateIdle hook for Agent Teams work assignment.
#              When a teammate is about to go idle, queries the brain's task
#              queue for the next available task. Exit code 2 sends feedback
#              with the new assignment and keeps the teammate working.
#              Exit code 0 allows the teammate to go idle (no work available).
#              Also POSTs to the brain API for event_log tracking.
# Usage: Called automatically by Claude Code when a teammate is about to go idle.
#        Reads JSON from stdin with hook_event_name, teammate context.
# Dependencies: python3 or jq, curl or python3 urllib
# Exit codes:
#   0 - Allow idle (no tasks available or brain unreachable)
#   2 - Assign work (task found, teammate gets feedback with assignment)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON payload)
INPUT=$(cat)

# Parse fields from input
parse_input() {
  if command -v jq &> /dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null) || HOOK_EVENT=""
    TEAMMATE_ID=$(echo "$INPUT" | jq -r '.teammate_id // .agent_id // ""' 2>/dev/null) || TEAMMATE_ID=""
  else
    local py_output
    py_output=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('hook_event_name', ''))
    print(data.get('teammate_id', data.get('agent_id', '')))
except Exception:
    print('')
    print('')
" 2>/dev/null) || {
      HOOK_EVENT=""
      TEAMMATE_ID=""
      return
    }
    HOOK_EVENT=$(echo "$py_output" | sed -n '1p')
    TEAMMATE_ID=$(echo "$py_output" | sed -n '2p')
  fi
}

# Query brain for next available task and output assignment
query_and_assign() {
  python3 << 'PYEOF'
import json
import os
import sys
import urllib.request

project_slug = os.environ.get("_IGRIS_SLUG", "")
teammate_id = os.environ.get("_IGRIS_TEAMMATE_ID", "")

# Try to get the next available task from the brain
task = None

# Try localhost brain first
for base_url in ["http://localhost:3001"]:
    try:
        payload = {"project_slug": project_slug}
        if teammate_id:
            payload["agent_name"] = teammate_id

        url = f"{base_url}/api/tasks/next"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read().decode("utf-8"))

        if data.get("ok") and data.get("task"):
            task = data["task"]
            break
    except Exception:
        continue

# Also try remote brain if configured
if not task:
    try:
        config_path = os.path.expanduser("~/.igris/config.json")
        if os.path.exists(config_path):
            with open(config_path) as f:
                config = json.load(f)
            brain_url = config.get("remote_brain", {}).get("url", "")
            api_key = config.get("remote_brain", {}).get("api_key", "")
            if brain_url and api_key:
                payload = {"project_slug": project_slug}
                if teammate_id:
                    payload["agent_name"] = teammate_id

                url = f"{brain_url.rstrip('/')}/api/tasks/next"
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                    method="POST",
                )
                resp = urllib.request.urlopen(req, timeout=5)
                data = json.loads(resp.read().decode("utf-8"))

                if data.get("ok") and data.get("task"):
                    task = data["task"]
    except Exception:
        pass

if not task:
    # No tasks available — let teammate go idle
    sys.exit(0)

# Build assignment description for the teammate
task_id = task.get("id", "unknown")
title = task.get("title", "Untitled task")
description = task.get("description", "")
brief_id = task.get("brief_id", "")
task_type = task.get("task_type", "")
priority = task.get("priority", 3)

assignment_lines = [
    f"New task assigned: {title}",
    f"Task ID: {task_id}",
]
if brief_id:
    assignment_lines.append(f"Brief: {brief_id}")
if description:
    assignment_lines.append(f"Description: {description}")
assignment_lines.append(f"Priority: {priority} | Type: {task_type}")
assignment_lines.append("")
assignment_lines.append("Execute this task following the coding guidelines.")
assignment_lines.append("Run linter and tests before completing.")
assignment_lines.append("Commit with conventional format when done.")

assignment_text = "\n".join(assignment_lines)

# Output feedback JSON for Claude Code to relay to the teammate
result = {"description": assignment_text}
print(json.dumps(result))

# Log the assignment event to brain (fire-and-forget)
try:
    event_payload = {
        "hook_event_name": "TeammateIdle",
        "teammate_id": teammate_id,
        "assigned_task_id": task_id,
        "assigned_task_title": title,
    }
    url = f"http://localhost:3001/api/hooks/event?project={project_slug}"
    req = urllib.request.Request(
        url,
        data=json.dumps(event_payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=2)
except Exception:
    pass

# Exit with code 2 to keep teammate working
sys.exit(2)
PYEOF
}

# Main execution
main() {
  parse_input

  if [ "$HOOK_EVENT" != "TeammateIdle" ]; then
    exit 0
  fi

  local slug
  slug=$(basename "$PROJECT_DIR")

  # Export for python3 subprocess
  export _IGRIS_SLUG="$slug"
  export _IGRIS_TEAMMATE_ID="$TEAMMATE_ID"

  # Query brain and assign — python3 handles exit codes
  # Disable set -e temporarily: exit code 2 is intentional (assign work)
  set +e
  query_and_assign
  local exit_code=$?
  set -e
  exit "$exit_code"
}

# Run main — preserve exit code 2 (assign work) while catching unexpected errors
# Exit code 2 is intentional (keep working), so we must not swallow it
main "$@" 2>/dev/null
exit_code=$?
if [ "$exit_code" -eq 2 ]; then
  exit 2
fi
exit 0
