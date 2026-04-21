#!/bin/bash

# Description: Portable PostToolUse dispatcher. Runs every executable handler under
#              `post_tool_use.d/*.sh` (in lexicographic sort order) inside its own
#              subshell with a per-handler timeout. Preserves the per-handler
#              timeout isolation the Claude config used before FR-104 (10s / 5s / 5s).
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin and fans it out to each
#        handler. Handlers receive the same stdin payload.
#
# Input contract:
#   stdin (preferred): JSON object. Unified or native shape (see handler scripts).
#   env fallback: IGRIS_HOOK_*
#
# Handler discovery:
#   Any file matching `post_tool_use.d/*.sh` that is executable is invoked in sort
#   order. Files not executable are skipped silently (allows disabling by chmod -x).
#   Ordering convention: `NN-name.sh` where NN is a two-digit prefix.
#
# Per-handler timeout:
#   Uniform 10 seconds. Longer than the original per-entry 10/5/5 distribution
#   — we intentionally favor allowing the slower lint path to complete on slow
#   machines rather than chopping off shellcheck output.
#
# Dependencies:
#   timeout (or gtimeout on macOS via brew coreutils). If neither is present the
#   dispatcher falls back to running the handler without a watchdog.
#
# Exit codes:
#   0 - Always (hooks must never fail)

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DISPATCHER_DIR="$SCRIPT_DIR/post_tool_use.d"

# Allow tests/integrators to override handler discovery dir.
if [ -n "${IGRIS_POST_TOOL_USE_D:-}" ] && [ -d "$IGRIS_POST_TOOL_USE_D" ]; then
  DISPATCHER_DIR="$IGRIS_POST_TOOL_USE_D"
fi

# Read stdin once, fan out to each handler via its own stdin.
INPUT=$(cat 2>/dev/null || true)

# Resolve a timeout binary. macOS base install lacks `timeout`; `gtimeout` comes
# with `brew install coreutils`. If neither is available, we run handlers without
# a watchdog — hook contract still exits 0.
TIMEOUT_BIN=""
TIMEOUT_SECS="${IGRIS_POST_TOOL_USE_TIMEOUT:-10}"
if command -v timeout &> /dev/null; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout &> /dev/null; then
  TIMEOUT_BIN="gtimeout"
fi

# No handlers directory = nothing to do; still exit success.
if [ ! -d "$DISPATCHER_DIR" ]; then
  exit 0
fi

# Iterate lexicographically. `LC_ALL=C` keeps the sort deterministic across locales.
for handler in $(LC_ALL=C ls "$DISPATCHER_DIR"/*.sh 2>/dev/null | sort); do
  [ -f "$handler" ] || continue
  [ -x "$handler" ] || continue

  if [ -n "$TIMEOUT_BIN" ]; then
    # shellcheck disable=SC2086  # TIMEOUT_BIN / TIMEOUT_SECS intentionally unquoted.
    printf '%s' "$INPUT" | $TIMEOUT_BIN "$TIMEOUT_SECS" bash "$handler" > /dev/null 2>&1 || true
  else
    printf '%s' "$INPUT" | bash "$handler" > /dev/null 2>&1 || true
  fi
done

exit 0
