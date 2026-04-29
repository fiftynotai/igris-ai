#!/bin/bash

# Description: Portable perception-extract hook (FR-109).
#              Captures the current transcript window and queues it into the
#              perception inbox for later draining by /awaken or /rest.
#              The hook is dumb — extraction (rules + LLM) runs server-side
#              when the inbox is drained.
#
# Triggers:    Called from session_end.sh and pre_compact.sh after their
#              core work completes.
#
# Input contract:
#   stdin: same JSON the parent hook received (project_dir, payload, etc.)
#   env:   IGRIS_PROJECT_DIR fallback for project resolution
#
# Inbox path:
#   ~/.igris/projects/{slug}/session/perception_inbox.jsonl
#   Each line is a JSON object: { project, source, brief_id?, transcript, ts }
#   Drained by /awaken section 3.6.5 and /rest section 2.6.6.
#
# Watermark:
#   ~/.igris/projects/{slug}/session/perception_watermark.txt
#   Single line — epoch seconds of the last successfully extracted window.
#   Read by the drain to bound the next ingest. The hook itself only writes
#   if the transcript is empty (to avoid stale watermarks).
#
# Dependencies: python3 (for JSON munging)
# Exit codes:   0 — always (hooks must never fail).

set -e

# ---------------------------------------------------------------------------
# Resolve project directory + slug
# ---------------------------------------------------------------------------

INPUT=$(cat 2>/dev/null || true)

resolve_project_dir() {
  local from_input=""
  if [ -n "$INPUT" ]; then
    if command -v jq >/dev/null 2>&1; then
      from_input=$(echo "$INPUT" | jq -r '.project_dir // .cwd // ""' 2>/dev/null || echo "")
    else
      from_input=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('project_dir') or d.get('cwd') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")
    fi
  fi
  if [ -n "$from_input" ]; then
    echo "$from_input"
  elif [ -n "${IGRIS_PROJECT_DIR:-}" ]; then
    echo "$IGRIS_PROJECT_DIR"
  elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    echo "$CLAUDE_PROJECT_DIR"
  else
    echo "$PWD"
  fi
}

PROJECT_DIR=$(resolve_project_dir)
PROJECT_SLUG=$(basename "$PROJECT_DIR")

INBOX_DIR="$HOME/.igris/projects/$PROJECT_SLUG/session"
INBOX_FILE="$INBOX_DIR/perception_inbox.jsonl"

# Bail silently if the project session dir doesn't exist — Igris isn't
# initialized for this directory, so there's nothing to capture.
if [ ! -d "$INBOX_DIR" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Locate transcript file from the input payload
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

# If no transcript path in input, exit cleanly — nothing to queue.
if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# Resolve trigger source from input (defaults to "perception_extract").
SOURCE_LABEL="perception_extract"
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    EVENT=$(echo "$INPUT" | jq -r '.event // "perception_extract"' 2>/dev/null || echo "perception_extract")
    SOURCE_LABEL="$EVENT"
  fi
fi

# ---------------------------------------------------------------------------
# Append the transcript window to the inbox as a single JSONL row.
# Atomic-ish: we write to a temp file alongside the inbox then `cat >> inbox`.
# Concurrent hook fires would be rare (sessions don't end concurrently from
# the same project), but we use `flock` when available for safety.
# ---------------------------------------------------------------------------

queue_transcript() {
  local ts
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

  # Build a single JSONL row using python (handles JSON-escaping the
  # transcript content reliably without needing jq).
  python3 - "$TRANSCRIPT_PATH" "$PROJECT_SLUG" "$SOURCE_LABEL" "$ts" "$INBOX_FILE" << 'PYEOF'
import json
import os
import sys

transcript_path = sys.argv[1]
project_slug = sys.argv[2]
source_label = sys.argv[3]
ts = sys.argv[4]
inbox_file = sys.argv[5]

# Soft cap on transcript bytes embedded in the inbox row. Larger windows
# will be truncated — the conscious channel deliberately doesn't need the
# whole transcript, just the latest delta, and the perception submit
# handler caps at 5 MB anyway.
MAX_BYTES = 4 * 1024 * 1024  # 4 MB

try:
    size = os.path.getsize(transcript_path)
    if size > MAX_BYTES:
        # Read the tail of the file when it's oversize.
        with open(transcript_path, 'rb') as f:
            f.seek(-MAX_BYTES, os.SEEK_END)
            data = f.read().decode('utf-8', errors='replace')
    else:
        with open(transcript_path, 'r', encoding='utf-8', errors='replace') as f:
            data = f.read()
except Exception as exc:
    print(f"perception_extract: read failed: {exc}", file=sys.stderr)
    sys.exit(0)

if not data.strip():
    sys.exit(0)

row = {
    "project": project_slug,
    "source": source_label,
    "transcript": data,
    "queued_at": ts,
}

try:
    with open(inbox_file, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False))
        f.write('\n')
except Exception as exc:
    print(f"perception_extract: queue write failed: {exc}", file=sys.stderr)

sys.exit(0)
PYEOF
}

# Use flock if available so concurrent fires can't tear the file.
LOCK_FILE="$INBOX_FILE.lock"
if command -v flock >/dev/null 2>&1; then
  (
    flock -n 9 || exit 0
    queue_transcript
  ) 9>"$LOCK_FILE" 2>/dev/null || true
else
  queue_transcript 2>/dev/null || true
fi

exit 0
