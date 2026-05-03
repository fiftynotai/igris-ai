#!/bin/bash

# Description: Generic fire-and-forget brain push helper (TD-080, FR-118).
#              Spawned by background actors (perception extractor today;
#              subconscious tomorrow per FR-118) to propagate this machine's
#              local delta to the remote brain without waiting for /rest.
#
# Triggers:    perception_extract_and_persist.sh (success path).
#              Future: subconscious runner.
#
# Input contract:
#   args:  $1 = project slug (required)
#   env:   IGRIS_BRAIN_MCP_DIR (optional override; same convention as
#          perception_extract_and_persist.sh)
#
# Behaviour:
#   - Reads remote_brain.url + remote_brain.api_key from ~/.igris/config.json
#   - If either is missing/empty, exits 0 silently (remote not configured is
#     a normal state, not an error)
#   - Invokes brain_push_cli.ts via npx tsx (synchronous body — the OUTER
#     caller is the one that detached us via nohup)
#   - All errors swallowed; exit 0 always (must never block hooks)
#   - Logs to ~/.igris/projects/{slug}/session/brain_push.log (rotated at 1MB)
#
# Detach contract (Q-1 design decision, TD-080 plan):
#   This helper's body is SYNCHRONOUS. The caller is responsible for
#   detaching the helper via `nohup ... & disown` so the helper does not
#   delay the caller's own exit. Same pattern session_end.sh uses to spawn
#   perception_extract_and_persist.sh.
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
  echo "brain_push_async: project slug arg is required" >&2
  exit 0
fi

# Defense-in-depth (TD-080 Q-3 / warden M-1): the slug is interpolated into
# downstream paths and CLI args. Reject anything outside the registered slug
# shape (lowercase alphanumeric + dash + underscore). Belt-and-suspenders
# against any future caller that broadens slug sourcing. Exit 0 to preserve
# the "never block hooks" contract.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  echo "brain_push_async: project slug arg '$PROJECT_SLUG' does not match ^[a-z0-9_-]+\$ — skipping" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve session paths
# ---------------------------------------------------------------------------

SESSION_DIR="$HOME/.igris/projects/$PROJECT_SLUG/session"
LOG_FILE="$SESSION_DIR/brain_push.log"

if [ ! -d "$SESSION_DIR" ]; then
  # Project not registered with Igris — nothing to do. Silent because the
  # caller may legitimately fire us before a project is fully bootstrapped.
  exit 0
fi

# ---------------------------------------------------------------------------
# Probe remote_brain config from ~/.igris/config.json
# ---------------------------------------------------------------------------
# We probe BEFORE resolving brain dir / npx so the common "remote not
# configured" path (fresh installs, local-only setups) exits as fast as
# possible without spinning up python or npx subshells.

CONFIG_FILE="$HOME/.igris/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  # Config file absent — remote definitionally not configured. Silent exit.
  exit 0
fi

# Use python3 per coding guidelines §10 — same shape as
# perception_extract_and_persist.sh uses for its config probe.
remote_url=$(python3 -c "
import json
try:
    with open('$CONFIG_FILE') as f:
        c = json.load(f)
    rb = c.get('remote_brain') or {}
    print(rb.get('url', '') if isinstance(rb, dict) else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

remote_key=$(python3 -c "
import json
try:
    with open('$CONFIG_FILE') as f:
        c = json.load(f)
    rb = c.get('remote_brain') or {}
    print(rb.get('api_key', '') if isinstance(rb, dict) else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

if [ -z "$remote_url" ] || [ -z "$remote_key" ]; then
  # Remote not configured — silent exit. No log spam; this is a normal state.
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve brain MCP server directory (same 3-step ladder as the perception
# extractor: env override → config.json source_repo → fail-with-log)
# ---------------------------------------------------------------------------

BRAIN_DIR=""

if [ -n "${IGRIS_BRAIN_MCP_DIR:-}" ]; then
  BRAIN_DIR="$IGRIS_BRAIN_MCP_DIR"
fi

if [ -z "$BRAIN_DIR" ]; then
  source_repo=$(python3 -c "
import json
try:
    with open('$CONFIG_FILE') as f:
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
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] brain_push_async: cannot locate brain-mcp-server. Set IGRIS_BRAIN_MCP_DIR or fix source_repo in ~/.igris/config.json" >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve npx — required for tsx subprocess invocation
# ---------------------------------------------------------------------------

NPX_BIN=$(command -v npx 2>/dev/null || true)
if [ -z "$NPX_BIN" ]; then
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] brain_push_async: npx not on PATH — install Node.js >= 20" >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Rotate log if it grows past 1 MB (same pattern as perception extractor)
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

{
  echo "---"
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] brain_push_async: starting (project=$PROJECT_SLUG)"
} >> "$LOG_FILE" 2>/dev/null || true

"$NPX_BIN" tsx scripts/brain_push_cli.ts \
  --project "$PROJECT_SLUG" \
  >> "$LOG_FILE" 2>&1 || true

exit 0
