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
import re
import sys
import urllib.request
from datetime import datetime, timezone

session_id = os.environ.get("_IGRIS_SESSION_ID", "")
transcript_path = os.environ.get("_IGRIS_TRANSCRIPT_PATH", "")
metrics_dir = os.environ.get("_IGRIS_METRICS_DIR", "")

# Read VPS dashboard URL from config
vps_dashboard_url = None
try:
    config_path = os.path.expanduser("~/.igris/config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)
        vps_dashboard_url = config.get("remote_dashboard", {}).get("url")
        if not vps_dashboard_url:
            # Derive from remote_brain.url (swap port 3001 -> 8001)
            brain_url = config.get("remote_brain", {}).get("url", "")
            if brain_url:
                vps_dashboard_url = brain_url.replace(":3001", ":8001")
except Exception:
    pass

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

    # Context window awareness parsing (fail-safe)
    context_used = 0
    context_max = 0
    context_remaining = 0
    model_id = ""
    try:
        # Model context window defaults by model ID prefix
        MODEL_CONTEXT_DEFAULTS = {
            "claude-opus-4": 200000,
            "claude-sonnet-4": 200000,
            "claude-3-7-sonnet": 200000,
            "claude-3-5-sonnet": 200000,
            "claude-3-5-haiku": 200000,
            "claude-3-opus": 200000,
            "claude-3-sonnet": 200000,
            "claude-3-haiku": 200000,
        }

        context_max_cache_file = f"/tmp/igris_context_max_{session_id}"
        last_budget_used = None
        last_budget_max = None
        last_budget_remaining = None
        last_model_id = ""
        last_api_input = 0  # Fallback: estimate from API usage

        for line in new_data.splitlines():
            line_s = line.strip()
            if not line_s:
                continue

            # Parse budget:token_budget tag
            budget_match = re.search(r"<budget:token_budget>(\d+)</budget:token_budget>", line_s)
            if budget_match:
                context_max = int(budget_match.group(1))

            # Parse "Token usage: X/Y; Z remaining" — keep last occurrence
            usage_match = re.search(r"Token usage:\s*(\d+)/(\d+);\s*(\d+)\s*remaining", line_s)
            if usage_match:
                last_budget_used = int(usage_match.group(1))
                last_budget_max = int(usage_match.group(2))
                last_budget_remaining = int(usage_match.group(3))

            # Extract model ID and API usage from transcript JSON entries
            try:
                entry_ctx = json.loads(line_s)
                msg = entry_ctx.get("message", {})
                m = msg.get("model", "")
                if m:
                    last_model_id = m
                # Track last API input tokens as context fallback
                # context_used = input_tokens + cache_read (excludes cache_creation)
                # This matches Claude Code's /context calculation
                u = msg.get("usage", {})
                api_inp = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                if api_inp > 0:
                    last_api_input = api_inp
            except (json.JSONDecodeError, AttributeError):
                pass

        # Apply last-seen usage values
        if last_budget_used is not None:
            context_used = last_budget_used
        elif last_api_input > 0:
            # Fallback: use last API turn's total input as context estimate
            # This covers sessions that haven't hit compaction yet
            context_used = last_api_input
        if last_budget_max is not None and last_budget_max > 0:
            context_max = last_budget_max
        if last_budget_remaining is not None:
            context_remaining = last_budget_remaining

        if last_model_id:
            model_id = last_model_id

        # If context_max still unknown, try cached value or model lookup
        if context_max == 0:
            try:
                with open(context_max_cache_file, "r") as cf:
                    context_max = int(cf.read().strip())
            except (FileNotFoundError, ValueError):
                context_max = 0

        if context_max == 0 and model_id:
            for prefix, default_max in MODEL_CONTEXT_DEFAULTS.items():
                if model_id.startswith(prefix):
                    context_max = default_max
                    break

        if context_max == 0:
            context_max = 200000

        # Cache context_max for future invocations
        try:
            with open(context_max_cache_file, "w") as cf:
                cf.write(str(context_max))
        except Exception:
            pass

        # Derive remaining if not set from parsing
        if context_remaining == 0 and context_used > 0:
            context_remaining = max(0, context_max - context_used)

    except Exception:
        # Context parsing is best-effort; never crash the hook
        context_used = 0
        context_max = 200000
        context_remaining = 200000
        model_id = ""

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
        "context_used": context_used,
        "context_max": context_max,
        "context_remaining": context_remaining,
        "model_id": model_id,
    }

    # Append to events.jsonl
    events_file = os.path.join(metrics_dir, "events.jsonl")
    try:
        with open(events_file, "a") as f:
            f.write(json.dumps(event_data, separators=(",", ":")) + "\n")
    except Exception:
        pass

    # Non-blocking POST to local dashboard (fail-silent, 1s timeout)
    try:
        req = urllib.request.Request(
            "http://localhost:8001/api/event",
            data=json.dumps(event_data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # Local dashboard not running, that's fine

    # Non-blocking POST to VPS dashboard (fail-silent, independent)
    if vps_dashboard_url:
        try:
            vps_url = vps_dashboard_url.rstrip("/") + "/api/event"
            req = urllib.request.Request(
                vps_url,
                data=json.dumps(event_data).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass  # VPS dashboard unreachable, that's fine

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
