#!/bin/bash
set -e  # Note: overridden at main() invocation because hooks must always exit 0

# Description: Stop hook for main agent (orchestrator) token tracking.
#              Uses incremental parsing with byte offset cursor to read only
#              new transcript lines since last invocation. Appends events to
#              events.jsonl and POSTs to dashboard (non-blocking, fail-silent).
# Usage: Called automatically by Claude Code on Stop event. Reads JSON from stdin.
# Dependencies: python3
# Exit codes:
#   0 - Always (hooks must never fail)

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Constants
METRICS_DIR="ai/session/metrics"
LOCK_FILE="/tmp/igris_main_agent_metrics.lock"

# Read stdin (Claude Code sends JSON with session_id, transcript_path, etc.)
INPUT=$(cat)

# Parse session_id and transcript_path from input
parse_input() {
  if command -v jq &> /dev/null; then
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null) || SESSION_ID=""
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null) || TRANSCRIPT_PATH=""
  else
    local py_output
    py_output=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('session_id', ''))
    print(data.get('transcript_path', ''))
except Exception:
    print('')
    print('')
" 2>/dev/null) || {
      SESSION_ID=""
      TRANSCRIPT_PATH=""
      return
    }
    SESSION_ID=$(echo "$py_output" | sed -n '1p')
    TRANSCRIPT_PATH=$(echo "$py_output" | sed -n '2p')
  fi
}

# Ensure metrics directory exists
ensure_metrics_dir() {
  mkdir -p "$METRICS_DIR" 2>/dev/null || true
}

# Parse transcript incrementally and emit event
process_transcript() {
  python3 << 'PYEOF'
import json
import os
import sys
from datetime import datetime, timezone

session_id = os.environ.get("_IGRIS_SESSION_ID", "")
transcript_path = os.environ.get("_IGRIS_TRANSCRIPT_PATH", "")
metrics_dir = os.environ.get("_IGRIS_METRICS_DIR", "")

if not transcript_path or not os.path.isfile(transcript_path):
    sys.exit(0)

if not session_id:
    sys.exit(0)

# Cursor file for incremental parsing
cursor_file = f"/tmp/igris_main_cursor_{session_id}"

# Read cursor (byte offset)
cursor_offset = 0
try:
    with open(cursor_file, "r") as f:
        cursor_offset = int(f.read().strip())
except (FileNotFoundError, ValueError):
    cursor_offset = 0

# Read only new bytes from transcript
try:
    file_size = os.path.getsize(transcript_path)
    if cursor_offset >= file_size:
        sys.exit(0)

    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }

    with open(transcript_path, "r") as f:
        f.seek(cursor_offset)
        new_data = f.read()
        new_offset = f.tell()

    for line in new_data.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            usage = entry.get("message", {}).get("usage", {})
            if usage:
                for key in totals:
                    totals[key] += usage.get(key, 0)
        except json.JSONDecodeError:
            continue

    # Only emit event if tokens > 0
    total_all = sum(totals.values())
    if total_all == 0:
        # Still update cursor so we don't re-read
        with open(cursor_file, "w") as f:
            f.write(str(new_offset))
        sys.exit(0)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    event_data = {
        "ts": now,
        "event": "stop",
        "agent": "orchestrator",
        "agent_id": session_id,
        "raw_type": "main",
        "duration_s": 0,
        "input_tokens": totals["input_tokens"],
        "output_tokens": totals["output_tokens"],
        "cache_read": totals["cache_read_input_tokens"],
        "cache_create": totals["cache_creation_input_tokens"],
    }

    # Append to events.jsonl
    events_file = os.path.join(metrics_dir, "events.jsonl")
    try:
        with open(events_file, "a") as f:
            f.write(json.dumps(event_data, separators=(",", ":")) + "\n")
    except Exception:
        pass

    # Non-blocking POST to dashboard (fail-silent, 1s timeout)
    try:
        import urllib.request

        req = urllib.request.Request(
            "http://localhost:8001/api/event",
            data=json.dumps(event_data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # Dashboard not running, that's fine

    # Update cursor file with new byte offset
    with open(cursor_file, "w") as f:
        f.write(str(new_offset))

except Exception:
    pass
PYEOF
}

# Main execution
main() {
  parse_input

  if [ -z "$SESSION_ID" ] && [ -z "$TRANSCRIPT_PATH" ]; then
    exit 0
  fi

  ensure_metrics_dir

  # Export variables for python3 heredoc
  export _IGRIS_SESSION_ID="$SESSION_ID"
  export _IGRIS_TRANSCRIPT_PATH="$TRANSCRIPT_PATH"
  export _IGRIS_METRICS_DIR="$METRICS_DIR"

  # Use flock for concurrency safety if available
  if command -v flock &> /dev/null; then
    (
      flock -w 3 200 2>/dev/null || true
      process_transcript
    ) 200>"$LOCK_FILE" 2>/dev/null || process_transcript 2>/dev/null || true
  else
    process_transcript 2>/dev/null || true
  fi

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
