#!/bin/bash
set -e

# Description: Emits a skill_invoke event to events.jsonl, dashboard endpoints,
#              and the brain API (POST /api/hooks/event).
#              Appends a JSONL event to events.jsonl, POSTs to local endpoint,
#              optionally POSTs to VPS endpoint if configured, and POSTs to
#              the brain REST API for event_log ingestion.
# Usage: emit_skill_event.sh <skill_name>
#   e.g. emit_skill_event.sh hunt
#   e.g. emit_skill_event.sh scan
# Dependencies: python3
# Exit codes:
#   0 - Always (this script must NEVER cause a skill to fail)
#
# DEPRECATION NOTICE (FR-088):
#   This script will be replaced by HTTP hooks or a direct brain API call
#   when FR-066 (cross-CLI adapters) lands. Skills currently invoke this
#   script from SKILL.md bash commands. Keep functional until then.

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

# Derive project slug from CLAUDE_PROJECT_DIR
project_dir = os.environ.get("CLAUDE_PROJECT_DIR", "")
project_slug = os.path.basename(project_dir) if project_dir else ""

# Construct event payload
event_data = {
    "ts": ts,
    "event": "skill_invoke",
    "skill_name": skill_name,
    "project_slug": project_slug,
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

# 4. POST to brain API for event_log ingestion (FR-088)
try:
    brain_payload = {
        "hook_event_name": "SkillInvoke",
        "skill_name": skill_name,
        "project_slug": project_slug,
    }
    brain_url = f"http://localhost:3001/api/hooks/event?project={project_slug}"
    req = urllib.request.Request(
        brain_url,
        data=json.dumps(brain_payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=2)
except Exception:
    pass  # Brain API unreachable, that's fine
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
