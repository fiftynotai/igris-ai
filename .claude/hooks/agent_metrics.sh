#!/bin/bash
set -e  # Note: overridden at main() invocation because hooks must always exit 0

# Description: SubagentStart/SubagentStop hook for Claude Code lifecycle integration.
#              Tracks agent invocations, timing, token usage, and success rates in the
#              local Igris AI metrics system. Uses flock for concurrency safety.
#              v3.0.0: Auto-records agent metrics to the brain via REST API on SubagentStop.
#              Parses last_assistant_message for success/failure verdict, maps agent_type
#              to action, and reads active brief from CURRENT_SESSION.md.
#              v2.0.0: Adds token parsing from transcripts, schema migration, events.jsonl,
#              agent name normalization, and non-blocking dashboard POST.
# Usage: Called automatically by Claude Code on subagent start/stop. Reads JSON from stdin.
# Dependencies: python3, flock (optional - degrades gracefully)
# Exit codes:
#   0 - Always (hooks must never fail)
#
# DEPRECATION NOTICE (FR-088):
#   As of FR-088, SubagentStart/SubagentStop hooks are now HTTP hooks that POST
#   directly to the brain REST API (POST /api/hooks/event). This shell script is
#   no longer registered in settings.json but is kept for:
#   - Local metrics file tracking (agent-metrics.json, events.jsonl)
#   - Transcript token parsing (requires local file I/O)
#   - Dashboard POST (non-brain dashboard endpoints)
#   The brain-side agent_events/agent_metrics recording is handled by the HTTP hook.

# Navigate to project root
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Constants
SLUG=$(basename "$PROJECT_DIR")
METRICS_DIR="$HOME/.igris/cache/$SLUG/metrics"
METRICS_FILE="${METRICS_DIR}/agent-metrics.json"
LOCK_FILE="/tmp/igris_agent_metrics.lock"
TIMESTAMP_DIR="/tmp"

# Read stdin (Claude Code sends JSON with hook_event_name, agent_type or agent_id)
INPUT=$(cat)

# Parse hook event name, agent type, agent id, transcript path, and last_assistant_message from input
parse_input() {
  if command -v jq &> /dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null) || HOOK_EVENT=""
    AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // .agent_id // "unknown"' 2>/dev/null) || AGENT_TYPE="unknown"
    AGENT_TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null) || AGENT_TRANSCRIPT_PATH=""
    AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null) || AGENT_ID=""
    LAST_ASSISTANT_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null) || LAST_ASSISTANT_MSG=""
  else
    local py_output
    py_output=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('hook_event_name', ''))
    print(data.get('agent_type', data.get('agent_id', 'unknown')))
    print(data.get('agent_transcript_path', ''))
    print(data.get('agent_id', ''))
    print(data.get('last_assistant_message', ''))
except Exception:
    print('')
    print('unknown')
    print('')
    print('')
    print('')
" 2>/dev/null) || {
      HOOK_EVENT=""
      AGENT_TYPE="unknown"
      AGENT_TRANSCRIPT_PATH=""
      AGENT_ID=""
      LAST_ASSISTANT_MSG=""
      return
    }
    # Read each line into its own variable - no eval needed
    HOOK_EVENT=$(echo "$py_output" | sed -n '1p')
    AGENT_TYPE=$(echo "$py_output" | sed -n '2p')
    AGENT_TRANSCRIPT_PATH=$(echo "$py_output" | sed -n '3p')
    AGENT_ID=$(echo "$py_output" | sed -n '4p')
    LAST_ASSISTANT_MSG=$(echo "$py_output" | sed -n '5p')
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
  local agent_id="$3"
  local transcript_path="$4"
  local timestamp_file="${TIMESTAMP_DIR}/igris_agent_${agent_type}_start"

  python3 << 'PYEOF'
import json
import os
import time
import tempfile
from datetime import datetime, timezone

# Shell variables passed via environment-style embedding would break the heredoc
# quoting, so we read them from a small JSON blob on a known path instead.
# Actually, we use the simpler approach: write args to a temp file or use env vars.
# Simplest: just re-parse from the variables we know.
import sys
import urllib.request

# Arguments passed via the heredoc boundary trick: we write them to env before calling python
hook_event = os.environ.get("_IGRIS_HOOK_EVENT", "")
agent_type = os.environ.get("_IGRIS_AGENT_TYPE", "")
agent_id = os.environ.get("_IGRIS_AGENT_ID", "")
transcript_path = os.environ.get("_IGRIS_TRANSCRIPT_PATH", "")
metrics_file = os.environ.get("_IGRIS_METRICS_FILE", "")
timestamp_file = os.environ.get("_IGRIS_TIMESTAMP_FILE", "")
last_assistant_msg = os.environ.get("_IGRIS_LAST_ASSISTANT_MSG", "")
project_slug = os.environ.get("_IGRIS_PROJECT_SLUG", "")

# Read VPS dashboard URL and brain API URL from config
vps_dashboard_url = None
brain_api_url = None
brain_api_key = None
try:
    config_path = os.path.expanduser("~/.igris/config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)
        vps_dashboard_url = config.get("remote_dashboard", {}).get("url")
        brain_api_url = config.get("remote_brain", {}).get("url")
        brain_api_key = config.get("remote_brain", {}).get("api_key")
        if not vps_dashboard_url:
            # Derive from remote_brain.url (swap port 3001 -> 8001)
            if brain_api_url:
                vps_dashboard_url = brain_api_url.replace(":3001", ":8001")
except Exception:
    pass

# Agent name normalization map: old/built-in names -> v3.4 canonical names
AGENT_NAME_MAP = {
    "planner": "architect",
    "coder": "forger",
    "tester": "sentinel",
    "reviewer": "warden",
    "debugger": "mender",
    "explorer": "seeker",
    "Explore": "seeker",
    "claude-code-guide": "seeker",
    "documenter": "forger",
    "releaser": "forger",
    "auditor": "warden",
    "ideator": "architect",
}

# Store the raw type before normalization (for events log)
raw_agent_type = agent_type
agent_type = AGENT_NAME_MAP.get(agent_type, agent_type)


def parse_transcript_tokens(tp):
    """Parse transcript JSONL for token usage totals."""
    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
    }
    if not tp or not os.path.isfile(tp):
        return totals
    try:
        with open(tp, "r") as f:
            for line in f:
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
    except Exception:
        pass
    return totals


# Default metrics structure (v2.0.0)
default_metrics = {
    "version": "2.0.0",
    "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "agents": {},
    "totals": {
        "total_invocations": 0,
        "most_used_agent": "",
        "least_used_agent": "",
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_tokens": 0,
    },
}

# Load existing metrics or create default
try:
    with open(metrics_file, "r") as f:
        metrics = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    metrics = default_metrics

# Ensure structure
if "agents" not in metrics:
    metrics["agents"] = {}
if "totals" not in metrics:
    metrics["totals"] = {
        "total_invocations": 0,
        "most_used_agent": "",
        "least_used_agent": "",
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_tokens": 0,
    }

# Schema migration v1.0.0 -> v2.0.0
if metrics.get("version") == "1.0.0":
    old_agents = dict(metrics.get("agents", {}))
    new_agents = {}
    for name, data in old_agents.items():
        canonical = AGENT_NAME_MAP.get(name, name)
        if canonical in new_agents:
            # Merge: sum invocations, keep latest last_used, weighted avg duration
            existing = new_agents[canonical]
            total_inv = existing["invocations"] + data.get("invocations", 0)
            if total_inv > 0:
                existing["avg_duration_seconds"] = round(
                    (
                        existing["avg_duration_seconds"] * existing["invocations"]
                        + data.get("avg_duration_seconds", 0)
                        * data.get("invocations", 0)
                    )
                    / total_inv,
                    2,
                )
            existing["invocations"] = total_inv
            # Keep latest last_used
            if (data.get("last_used") or "") > (existing.get("last_used") or ""):
                existing["last_used"] = data["last_used"]
        else:
            new_agents[canonical] = {
                "invocations": data.get("invocations", 0),
                "last_used": data.get("last_used", ""),
                "avg_duration_seconds": data.get("avg_duration_seconds", 0),
                "success_rate": data.get("success_rate", 1.0),
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_cache_read_tokens": 0,
                "total_cache_create_tokens": 0,
            }
    metrics["agents"] = new_agents
    metrics["version"] = "2.0.0"
    # Remove stale totals field
    metrics["totals"].pop("total_duration_seconds", None)

# Initialize agent entry if needed (v2.0.0 schema)
if agent_type not in metrics["agents"]:
    metrics["agents"][agent_type] = {
        "invocations": 0,
        "last_used": "",
        "avg_duration_seconds": 0,
        "success_rate": 1.0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_read_tokens": 0,
        "total_cache_create_tokens": 0,
    }

agent = metrics["agents"][agent_type]
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# Event data for events.jsonl (built up per event type)
event_data = None

if hook_event == "SubagentStart":
    # Increment invocations
    agent["invocations"] += 1
    agent["last_used"] = now

    # Write start timestamp
    try:
        with open(timestamp_file, "w") as f:
            f.write(str(time.time()))
    except Exception:
        pass

    # Update totals
    metrics["totals"]["total_invocations"] += 1

    # Build event record
    event_data = {
        "ts": now,
        "event": "start",
        "agent": agent_type,
        "agent_id": agent_id,
        "raw_type": raw_agent_type,
    }

elif hook_event == "SubagentStop":
    duration = 0.0
    # Calculate duration if start timestamp exists
    try:
        with open(timestamp_file, "r") as f:
            start_time = float(f.read().strip())
        duration = round(time.time() - start_time, 2)

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

    # Parse token usage from transcript JSONL
    tokens = parse_transcript_tokens(transcript_path)
    agent["total_input_tokens"] = agent.get("total_input_tokens", 0) + tokens["input_tokens"]
    agent["total_output_tokens"] = agent.get("total_output_tokens", 0) + tokens["output_tokens"]
    agent["total_cache_read_tokens"] = agent.get("total_cache_read_tokens", 0) + tokens["cache_read_input_tokens"]
    agent["total_cache_create_tokens"] = agent.get("total_cache_create_tokens", 0) + tokens["cache_creation_input_tokens"]

    # Build event record
    event_data = {
        "ts": now,
        "event": "stop",
        "agent": agent_type,
        "agent_id": agent_id,
        "raw_type": raw_agent_type,
        "duration_s": duration,
        "input_tokens": tokens["input_tokens"],
        "output_tokens": tokens["output_tokens"],
        "cache_read": tokens["cache_read_input_tokens"],
        "cache_create": tokens["cache_creation_input_tokens"],
    }

# Update most/least used
if metrics["agents"]:
    sorted_agents = sorted(
        metrics["agents"].items(),
        key=lambda x: x[1].get("invocations", 0),
        reverse=True,
    )
    metrics["totals"]["most_used_agent"] = sorted_agents[0][0]
    metrics["totals"]["least_used_agent"] = sorted_agents[-1][0]

# Update token totals
metrics["totals"]["total_input_tokens"] = sum(
    a.get("total_input_tokens", 0) for a in metrics["agents"].values()
)
metrics["totals"]["total_output_tokens"] = sum(
    a.get("total_output_tokens", 0) for a in metrics["agents"].values()
)
metrics["totals"]["total_cache_tokens"] = sum(
    a.get("total_cache_read_tokens", 0) + a.get("total_cache_create_tokens", 0)
    for a in metrics["agents"].values()
)

metrics["last_updated"] = now

# Write metrics atomically (tempfile + rename)
try:
    dir_name = os.path.dirname(os.path.abspath(metrics_file))
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(metrics, f, indent=2)
        f.write("\n")
    os.rename(tmp_path, metrics_file)
except Exception as e:
    print(f"agent_metrics.sh: failed to write metrics: {e}", file=sys.stderr)

# Append event to events.jsonl
if event_data:
    try:
        events_file = os.path.join(os.path.dirname(os.path.abspath(metrics_file)), "events.jsonl")
        with open(events_file, "a") as f:
            f.write(json.dumps(event_data, separators=(",", ":")) + "\n")
    except Exception:
        pass

    # Non-blocking POST to local dashboard (fail-silent)
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

# -------------------------------------------------------------------
# Brain metrics auto-recording on SubagentStop (FR-089)
# Posts agent performance metrics to the brain API so the orchestrator
# no longer needs to manually call igris_metrics_record.
# -------------------------------------------------------------------
if hook_event == "SubagentStop" and brain_api_url:
    try:
        # Agent-to-action mapping
        AGENT_ACTION_MAP = {
            "architect": "plan",
            "forger": "implement",
            "sentinel": "test",
            "warden": "review",
            "mender": "debug",
            "seeker": "research",
            "sage": "advise",
        }
        action = AGENT_ACTION_MAP.get(agent_type, "execute")

        # Parse result from last_assistant_message
        result = "success"  # default optimistic
        if last_assistant_msg:
            msg_lower = last_assistant_msg.lower()
            # Check for explicit failure indicators
            fail_indicators = [
                "fail", "failed", "failure",
                "reject", "rejected",
                "error", "errors found",
                "blocked",
                "not pass", "did not pass",
                "tests failing",
            ]
            pass_indicators = [
                "pass", "passed", "success",
                "approve", "approved",
                "complete", "completed",
                "all tests pass",
                "lgtm", "looks good",
            ]
            # Check failure first (more specific)
            has_fail = any(ind in msg_lower for ind in fail_indicators)
            has_pass = any(ind in msg_lower for ind in pass_indicators)
            if has_fail and not has_pass:
                result = "failure"
            elif has_fail and has_pass:
                # Ambiguous: check last occurrence position
                last_fail_pos = max(msg_lower.rfind(ind) for ind in fail_indicators if ind in msg_lower)
                last_pass_pos = max(msg_lower.rfind(ind) for ind in pass_indicators if ind in msg_lower)
                result = "success" if last_pass_pos > last_fail_pos else "failure"

        # Read active brief from CURRENT_SESSION.md
        brief_id = ""
        try:
            session_file = os.path.expanduser(
                f"~/.igris/cache/{project_slug}/session/CURRENT_SESSION.md"
            )
            if os.path.isfile(session_file):
                with open(session_file, "r") as sf:
                    for line in sf:
                        # Look for "Active Brief" or brief ID pattern in session
                        if "Active Brief" in line or "Last Active" in line:
                            import re as _re
                            m = _re.search(r'([A-Z]+-\d+)', line)
                            if m:
                                brief_id = m.group(1)
                                break
        except Exception:
            pass

        # Duration in milliseconds (convert from seconds)
        duration_ms = int(duration * 1000) if duration > 0 else 0

        # Build metrics payload
        metrics_payload = {
            "project": project_slug,
            "agent": agent_type,
            "action": action,
            "result": result,
            "duration_ms": duration_ms,
            "brief_id": brief_id,
        }

        # POST to local brain API (localhost:3001)
        try:
            local_url = "http://localhost:3001/api/metrics"
            req = urllib.request.Request(
                local_url,
                data=json.dumps(metrics_payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass  # Local brain not running, try remote

        # POST to remote brain API (VPS) if configured
        if brain_api_key:
            try:
                remote_url = brain_api_url.rstrip("/") + "/api/metrics"
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {brain_api_key}",
                }
                req = urllib.request.Request(
                    remote_url,
                    data=json.dumps(metrics_payload).encode("utf-8"),
                    headers=headers,
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3)
            except Exception:
                pass  # Remote brain unreachable, that's fine

    except Exception:
        pass  # Brain metrics are fire-and-forget, never block
PYEOF
}

# Main execution
main() {
  parse_input

  if [ -z "$HOOK_EVENT" ] || [ -z "$AGENT_TYPE" ]; then
    exit 0
  fi

  ensure_metrics_dir

  # Export variables for python3 heredoc (quoted single-quote PYEOF prevents shell expansion)
  export _IGRIS_HOOK_EVENT="$HOOK_EVENT"
  export _IGRIS_AGENT_TYPE="$AGENT_TYPE"
  export _IGRIS_AGENT_ID="$AGENT_ID"
  export _IGRIS_TRANSCRIPT_PATH="$AGENT_TRANSCRIPT_PATH"
  export _IGRIS_METRICS_FILE="$METRICS_FILE"
  export _IGRIS_TIMESTAMP_FILE="${TIMESTAMP_DIR}/igris_agent_${AGENT_TYPE}_start"
  export _IGRIS_LAST_ASSISTANT_MSG="$LAST_ASSISTANT_MSG"
  export _IGRIS_PROJECT_SLUG="$SLUG"

  # Use flock for concurrency safety if available
  if command -v flock &> /dev/null; then
    (
      flock -w 3 200 2>/dev/null || true
      update_metrics "$HOOK_EVENT" "$AGENT_TYPE" "$AGENT_ID" "$AGENT_TRANSCRIPT_PATH"
    ) 200>"$LOCK_FILE" 2>/dev/null || update_metrics "$HOOK_EVENT" "$AGENT_TYPE" "$AGENT_ID" "$AGENT_TRANSCRIPT_PATH" 2>/dev/null || true
  else
    update_metrics "$HOOK_EVENT" "$AGENT_TYPE" "$AGENT_ID" "$AGENT_TRANSCRIPT_PATH" 2>/dev/null || true
  fi

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
