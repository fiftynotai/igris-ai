#!/bin/bash
set -e

# Description: Emits a skill_invoke event to events.jsonl and optional dashboard endpoints.
#              Appends a JSONL event to events.jsonl, POSTs to local endpoint,
#              and optionally POSTs to VPS endpoint if configured.
# Usage: emit_skill_event.sh <skill_name>
#   e.g. emit_skill_event.sh hunt
#   e.g. emit_skill_event.sh scan
# Dependencies: python3
# Exit codes:
#   0 - Always (this script must NEVER cause a skill to fail)

# Trap any error to guarantee exit 0 — skill execution must not break
trap 'exit 0' ERR

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Constants
SLUG=$(basename "$PROJECT_DIR")
METRICS_DIR="$HOME/.igris/cache/$SLUG/metrics"
EVENTS_FILE="${METRICS_DIR}/events.jsonl"

# Validate skill name argument
skill_name="${1:-}"
if [ -z "$skill_name" ]; then
  exit 0
fi

# Ensure metrics directory exists
ensure_metrics_dir() {
  mkdir -p "$METRICS_DIR" 2>/dev/null || true
}

# Emit the skill_invoke event via python3 for reliable JSON handling
emit_event() {
  python3 << 'PYEOF'
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

skill_name = os.environ.get("_IGRIS_SKILL_NAME", "")
events_file = os.environ.get("_IGRIS_EVENTS_FILE", "")

if not skill_name or not events_file:
    sys.exit(0)

# Generate UTC ISO timestamp
ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# Construct event payload
event_data = {
    "ts": ts,
    "event": "skill_invoke",
    "skill_name": skill_name,
    "agent": "orchestrator",
    "agent_id": "",
}

# 1. Append to local events.jsonl
try:
    with open(events_file, "a") as f:
        f.write(json.dumps(event_data, separators=(",", ":")) + "\n")
except Exception:
    pass

# 2. POST to local dashboard (1-second timeout, fail-silent)
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

# 3. POST to VPS dashboard if configured (fail-silent)
try:
    config_path = os.path.expanduser("~/.igris/config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)
        vps_url = config.get("remote_dashboard", {}).get("url")
        if not vps_url:
            # Derive from remote_brain.url (swap port 3001 -> 8001)
            brain_url = config.get("remote_brain", {}).get("url", "")
            if brain_url:
                vps_url = brain_url.replace(":3001", ":8001")
        if vps_url:
            vps_endpoint = vps_url.rstrip("/") + "/api/event"
            req = urllib.request.Request(
                vps_endpoint,
                data=json.dumps(event_data).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=1)
except Exception:
    pass  # VPS dashboard unreachable, that's fine
PYEOF
}

# Main execution
main() {
  ensure_metrics_dir

  # Export variables for python3 heredoc
  export _IGRIS_SKILL_NAME="$skill_name"
  export _IGRIS_EVENTS_FILE="$EVENTS_FILE"

  emit_event 2>/dev/null || true

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
