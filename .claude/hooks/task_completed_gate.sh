#!/bin/bash
set -e

# Description: TaskCompleted hook for Agent Teams quality gate enforcement.
#              Verifies that tests passed before allowing a teammate's task to
#              be marked complete. Exit code 2 prevents completion and sends
#              feedback to the teammate. Exit code 0 allows completion.
#              Also POSTs to the brain API for event_log tracking.
# Usage: Called automatically by Claude Code when a teammate task is completed.
#        Reads JSON from stdin with hook_event_name, task_id, last_assistant_message.
# Dependencies: python3 or jq
# Exit codes:
#   0 - Allow completion (tests passed or no test evidence required)
#   2 - Deny completion (tests failed, teammate gets feedback to fix)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Read stdin (Claude Code sends JSON payload)
INPUT=$(cat)

# Parse fields from input
parse_input() {
  if command -v jq &> /dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null) || HOOK_EVENT=""
    LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null) || LAST_MSG=""
    TASK_ID=$(echo "$INPUT" | jq -r '.task_id // ""' 2>/dev/null) || TASK_ID=""
  else
    local py_output
    py_output=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('hook_event_name', ''))
    print(data.get('last_assistant_message', ''))
    print(data.get('task_id', ''))
except Exception:
    print('')
    print('')
    print('')
" 2>/dev/null) || {
      HOOK_EVENT=""
      LAST_MSG=""
      TASK_ID=""
      return
    }
    HOOK_EVENT=$(echo "$py_output" | sed -n '1p')
    LAST_MSG=$(echo "$py_output" | sed -n '2p')
    TASK_ID=$(echo "$py_output" | sed -n '3p')
  fi
}

# Check if last_assistant_message indicates tests passed
check_test_evidence() {
  local msg="$1"

  # If no message, allow through (no evidence to check)
  if [ -z "$msg" ]; then
    return 0
  fi

  # Use python3 for reliable text analysis
  python3 << 'PYEOF'
import os
import sys

msg = os.environ.get("_IGRIS_LAST_MSG", "")
if not msg:
    sys.exit(0)  # No message = allow

lower = msg.lower()

# Explicit test failure indicators
fail_indicators = [
    "tests failing",
    "test failed",
    "tests failed",
    "test failure",
    "test failures",
    "linter failed",
    "lint errors",
    "lint error",
    "build failed",
    "build error",
    "compilation error",
    "compile error",
    "does not compile",
    "failing tests",
    "test suite failed",
]

# Explicit test pass indicators
pass_indicators = [
    "tests pass",
    "tests passed",
    "all tests pass",
    "all tests passed",
    "test suite passed",
    "tests green",
    "all green",
    "linter passed",
    "lint passed",
    "no lint errors",
    "build succeeded",
    "build passed",
    "compilation succeeded",
]

has_fail = any(ind in lower for ind in fail_indicators)
has_pass = any(ind in lower for ind in pass_indicators)

if has_fail and not has_pass:
    # Tests explicitly failed — deny completion
    sys.exit(2)
elif has_pass:
    # Tests explicitly passed — allow completion
    sys.exit(0)
else:
    # No explicit test evidence — allow through
    # (not all tasks require tests; don't block on ambiguity)
    sys.exit(0)
PYEOF
}

# Output feedback JSON for denied completions
output_deny_feedback() {
  if command -v jq &> /dev/null; then
    jq -n '{
      "description": "Task completion blocked by quality gate. Tests must pass before completing. Please run tests, fix any failures, and try again. Report PASS/FAIL status explicitly."
    }'
  else
    python3 -c "
import json
print(json.dumps({
    'description': 'Task completion blocked by quality gate. Tests must pass before completing. Please run tests, fix any failures, and try again. Report PASS/FAIL status explicitly.'
}))
" 2>/dev/null || echo '{"description":"Task completion blocked by quality gate. Tests must pass before completing."}'
  fi
}

# POST event to brain API for tracking (fire-and-forget)
post_brain_event() {
  local slug
  slug=$(basename "$PROJECT_DIR")

  python3 << 'PYEOF' 2>/dev/null || true
import json
import os
import urllib.request

project_slug = os.environ.get("_IGRIS_SLUG", "")
task_id = os.environ.get("_IGRIS_TASK_ID", "")
gate_result = os.environ.get("_IGRIS_GATE_RESULT", "allowed")

if not project_slug:
    exit(0)

payload = {
    "hook_event_name": "TaskCompleted",
    "task_id": task_id,
    "gate_result": gate_result,
}

try:
    url = f"http://localhost:3001/api/hooks/event?project={project_slug}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=2)
except Exception:
    pass
PYEOF
}

# Main execution
main() {
  parse_input

  if [ "$HOOK_EVENT" != "TaskCompleted" ]; then
    exit 0
  fi

  local slug
  slug=$(basename "$PROJECT_DIR")

  # Export for python3 subprocesses
  export _IGRIS_LAST_MSG="$LAST_MSG"
  export _IGRIS_SLUG="$slug"
  export _IGRIS_TASK_ID="$TASK_ID"

  # Check test evidence
  if check_test_evidence "$LAST_MSG"; then
    # Tests passed or no test evidence — allow completion
    export _IGRIS_GATE_RESULT="allowed"
    post_brain_event "allowed"
    exit 0
  else
    # Tests failed — deny completion with feedback
    export _IGRIS_GATE_RESULT="denied"
    post_brain_event "denied"
    output_deny_feedback
    exit 2
  fi
}

# Run main — preserve exit code 2 (deny) while catching unexpected errors
# Exit code 2 is intentional (deny completion), so we must not swallow it
main "$@" 2>/dev/null
exit_code=$?
if [ "$exit_code" -eq 2 ]; then
  exit 2
fi
exit 0
