#!/bin/bash

# Description: Detached perception-extract wrapper (TD-066).
#              Spawned (DETACHED via nohup) by session_end / pre_compact hooks.
#              Resolves brain MCP location, locates transcript file, enforces
#              60s min-window guard, then invokes the TS CLI which writes
#              pending learnings directly to the brain DB.
#
# Triggers:    session_end.sh, pre_compact.sh (via nohup ... & disown)
#
# Input contract:
#   stdin: same JSON the parent hook received (project_dir, transcript_path,
#          payload, etc.)
#   args:  $1 = project slug (required — derived by caller via basename)
#          $2 = trigger label (optional, default 'detached'; e.g. 'session_end',
#               'pre_compact'). Threaded to the CLI as --source for log/audit.
#
# Min-window guard:
#   ~/.igris/projects/{slug}/session/perception_extract_watermark.txt
#   Records epoch seconds of last invocation. If <60s elapsed, exits 0
#   without invoking the CLI. Prevents thrash from rapid hook fires.
#
# Brain MCP resolution (in order):
#   1. $IGRIS_BRAIN_MCP_DIR env var (testing / explicit override)
#   2. source_repo from ~/.igris/config.json + /brain-mcp-server
#   3. FAIL FAST with explicit error message
#
# Dependencies: python3, node, npx, tsx (provided by brain-mcp-server deps)
# Exit codes:   0 — always (hooks must never fail).

set -e
set -u
set -o pipefail

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------

PROJECT_SLUG="${1:-}"
if [ -z "$PROJECT_SLUG" ]; then
  echo "perception_extract_and_persist: project slug arg is required" >&2
  exit 0
fi

# Trigger label threaded from the parent hook ($2). Default 'detached' so a
# direct invocation (or older caller without the 2nd arg) still labels its
# events. Safe under set -u via ${2:-default}.
TRIGGER_LABEL="${2:-detached}"

# ---------------------------------------------------------------------------
# Read stdin (the JSON payload the parent hook received)
# ---------------------------------------------------------------------------

INPUT=$(cat 2>/dev/null || true)

# ---------------------------------------------------------------------------
# Resolve session paths
# ---------------------------------------------------------------------------

SESSION_DIR="$HOME/.igris/projects/$PROJECT_SLUG/session"
WATERMARK_FILE="$SESSION_DIR/perception_extract_watermark.txt"
LOG_FILE="$SESSION_DIR/perception_extract.log"

if [ ! -d "$SESSION_DIR" ]; then
  # Project not registered with Igris — nothing to do.
  exit 0
fi

# ---------------------------------------------------------------------------
# 60s min-window guard — prevents thrash from rapid hook fires
# ---------------------------------------------------------------------------

now_epoch=$(date +%s)
if [ -f "$WATERMARK_FILE" ]; then
  last_epoch=$(cat "$WATERMARK_FILE" 2>/dev/null || echo "0")
  # Validate it's a number; treat non-numeric content as "never ran"
  if ! [[ "$last_epoch" =~ ^[0-9]+$ ]]; then
    last_epoch=0
  fi
  elapsed=$((now_epoch - last_epoch))
  if [ "$elapsed" -lt 60 ]; then
    # TD-074: emit a `perception.run_skipped` row so /scan can see the
    # guard fire. Defensive — every step is `|| true` so no failure mode
    # blocks the hook (`sqlite3` may be absent on minimal VPS, brain DB
    # may be missing pre-bootstrap, project slug is basename-derived but
    # we still escape single quotes to harden the SQL surface).
    if command -v sqlite3 >/dev/null 2>&1; then
      DB_PATH="$HOME/.igris/memory/knowledge.db"
      if [ -f "$DB_PATH" ]; then
        slug_escaped=$(printf '%s' "$PROJECT_SLUG" | sed "s/'/''/g")
        host=$(hostname 2>/dev/null || echo "unknown")
        host_escaped=$(printf '%s' "$host" | sed "s/'/''/g")
        payload=$(printf '{"project":"%s","reason":"min_window_guard","window_seconds":60,"elapsed_seconds":%d,"trigger":"detached"}' "$slug_escaped" "$elapsed")
        sqlite3 "$DB_PATH" \
          "INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug, instance_id, created_at) VALUES ('perception.run_skipped', 'perception', '$payload', '$host_escaped', '$slug_escaped', NULL, datetime('now'));" \
          2>/dev/null || true
      fi
    fi
    # Too soon — exit silently.
    exit 0
  fi
fi

# Watermark write deferred to immediately before the CLI invocation so a
# pre-flight failure (missing brain dir, missing npx, no transcript) does not
# burn the next 60s window. See finding #5 in TD-068.

# ---------------------------------------------------------------------------
# Locate transcript path from stdin JSON
# ---------------------------------------------------------------------------

TRANSCRIPT_PATH=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // .payload.transcript_path // ""' 2>/dev/null || echo "")
  else
    TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    p = d.get('payload') or {}
    print(d.get('transcript_path') or (p.get('transcript_path') if isinstance(p, dict) else '') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")
  fi
fi

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  # No transcript to process — exit clean.
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve brain MCP server directory (fail fast if not found)
# ---------------------------------------------------------------------------

BRAIN_DIR=""

if [ -n "${IGRIS_BRAIN_MCP_DIR:-}" ]; then
  BRAIN_DIR="$IGRIS_BRAIN_MCP_DIR"
fi

if [ -z "$BRAIN_DIR" ] && [ -f "$HOME/.igris/config.json" ]; then
  source_repo=$(python3 -c "
import json
try:
    with open('$HOME/.igris/config.json') as f:
        c = json.load(f)
    print(c.get('source_repo', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")
  if [ -n "$source_repo" ]; then
    BRAIN_DIR="$source_repo/brain-mcp-server"
  fi
fi

if [ -z "$BRAIN_DIR" ] || [ ! -d "$BRAIN_DIR" ]; then
  echo "perception_extract_and_persist: cannot locate brain-mcp-server. Set IGRIS_BRAIN_MCP_DIR or fix source_repo in ~/.igris/config.json" >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve npx — required for tsx subprocess invocation
# ---------------------------------------------------------------------------

NPX_BIN=$(command -v npx 2>/dev/null || true)
if [ -z "$NPX_BIN" ]; then
  echo "perception_extract_and_persist: npx not on PATH — install Node.js >= 20" >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Rotate log if it grows past 1 MB
# ---------------------------------------------------------------------------

if [ -f "$LOG_FILE" ]; then
  log_size=$(wc -c < "$LOG_FILE" 2>/dev/null | tr -d ' ' || echo "0")
  if [ "$log_size" -gt 1048576 ]; then
    tail -c 524288 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null || true
    mv "$LOG_FILE.tmp" "$LOG_FILE" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Invoke the CLI
# ---------------------------------------------------------------------------

cd "$BRAIN_DIR" 2>/dev/null || exit 0

# Risk #1: give the parent hook's async fsync a beat before the child re-opens
# the transcript / log files. Cheap insurance against a half-flushed transcript
# being read at offset zero.
sleep 1

# Watermark only written here, after all dependency checks succeed and right
# before we hand off to the CLI. If the CLI is killed mid-run we still record
# this attempt to prevent thrash within the 60s window. See finding #5 / TD-068.
echo "$now_epoch" > "$WATERMARK_FILE" 2>/dev/null || true

{
  echo "---"
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] perception_extract_and_persist: starting (project=$PROJECT_SLUG transcript=$TRANSCRIPT_PATH source=$TRIGGER_LABEL)"
} >> "$LOG_FILE" 2>/dev/null || true

"$NPX_BIN" tsx scripts/perception_extract_cli.ts \
  --project "$PROJECT_SLUG" \
  --transcript-path "$TRANSCRIPT_PATH" \
  --source "$TRIGGER_LABEL" \
  >> "$LOG_FILE" 2>&1 || true

exit 0
