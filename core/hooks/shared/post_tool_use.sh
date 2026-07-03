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
#   dispatcher uses a pure-bash watchdog fallback (see run_with_watchdog) that
#   enforces the same per-handler time budget.
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

# ---------------------------------------------------------------------------
# FR-212c REGISTRATION GATE. The PostToolUse dispatcher projects GLOBALLY (one
# ~/.claude/settings.json block fans handlers out on EVERY Write/Edit in EVERY
# project on the machine). Outside a registered Igris project it MUST no-op:
# clean exit 0 BEFORE any handler (lint etc.) runs — so a non-Igris project's
# writes never trigger Igris post-processing. FAIL-OPEN-TO-NO-OP: a missing/
# locked brain DB resolves to not-registered -> clean exit.
#
# This dispatcher has no project-dir resolver of its own; derive it the same way
# the other shared hooks do (payload.project_dir > payload.cwd > env > PWD).
# ---------------------------------------------------------------------------
_gate_project_dir() {
  local from_input=""
  if [ -n "$INPUT" ]; then
    if command -v jq &> /dev/null; then
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

if [ -f "$SCRIPT_DIR/_gate.sh" ]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/_gate.sh"
  if ! is_registered_igris_project "$(_gate_project_dir)"; then
    exit 0
  fi
fi

# Resolve a timeout binary. macOS base install lacks `timeout`; `gtimeout` comes
# with `brew install coreutils`. If neither is available, the run_with_watchdog
# function below enforces the timeout in pure bash.
TIMEOUT_BIN=""
TIMEOUT_SECS="${IGRIS_POST_TOOL_USE_TIMEOUT:-10}"
if command -v timeout &> /dev/null; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout &> /dev/null; then
  TIMEOUT_BIN="gtimeout"
fi

# Pure-bash watchdog fallback for hosts without `timeout`/`gtimeout` (macOS base).
# Runs a handler with the caller's stdin piped in, sends SIGTERM after $1 seconds,
# then escalates to SIGKILL after a 1s grace period. Reaps the watchdog subshell
# AND its `sleep` child on the normal-exit path — see trap below for details.
#
# Args:
#   $1 - timeout in seconds (integer)
#   $2 - absolute handler path
# Stdin: payload — callers pipe via `printf '%s' "$INPUT" | run_with_watchdog ...`
# Stdout/stderr: suppressed (handlers must not write to the hook pipeline)
# Side effects: spawns two background processes (handler + watchdog subshell).
#               Both (and the watchdog's backgrounded `sleep` grandchild) are
#               guaranteed reaped before return — the trap in the subshell
#               propagates SIGTERM to its `sleep` child so no orphan is left.
# Returns: handler's exit code on clean exit, or the signal-based code when killed
run_with_watchdog() {
  local secs="$1"
  local handler="$2"
  local pid watchdog rc

  # Background the handler. Its stdin is the stdin of this function — the caller
  # pipes INPUT in via `printf '%s' "$INPUT" | run_with_watchdog ...`, and the
  # backgrounded `bash` inherits that pipe fd. Must stay inside the function so
  # the subsequent `wait "$pid"` sees the correct child.
  bash "$handler" > /dev/null 2>&1 &
  pid=$!

  # Watchdog subshell. The subshell backgrounds its `sleep` and installs an
  # EXIT trap that kills the sleep child on any subshell exit. A TERM trap
  # forwards SIGTERM to `exit` so the EXIT handler actually runs (default
  # SIGTERM action skips traps). This matters on the clean-exit path, where
  # the parent sends SIGTERM to reap us — without the TERM trap, bash would
  # die default-style and the sleep would reparent to init, leaking one
  # orphan per PostToolUse event. `kill` stderr is silenced because the
  # target pid may already be dead (benign fast-path race).
  (
    sleep "$secs" &
    sleep_pid=$!
    # shellcheck disable=SC2064  # Expand sleep_pid NOW, not when trap fires.
    trap "kill \"$sleep_pid\" 2>/dev/null; wait \"$sleep_pid\" 2>/dev/null" EXIT
    trap 'exit 0' TERM
    wait "$sleep_pid" 2>/dev/null
    # Sleep expired naturally — handler overran the budget. Escalate.
    # (The EXIT trap still fires when we `exit` below, but sleep is already
    #  dead by then, so `kill` silently no-ops.)
    kill -TERM "$pid" 2>/dev/null || exit 0
    sleep 1
    kill -KILL "$pid" 2>/dev/null || true
  ) &
  watchdog=$!

  # Block on the handler. `rc` captures its exit code, or the 128+signal code
  # if the watchdog killed it. `2>/dev/null` swallows the "Terminated" message
  # bash 3.2 prints when a child dies by signal.
  wait "$pid" 2>/dev/null
  rc=$?

  # Handler exited — reap the watchdog. `kill -TERM` fires the trap above,
  # which kills the watchdog's `sleep` child and exits the subshell. This is
  # the contract that prevents the orphan-sleep leak. `kill` may fail with
  # "no such process" if the watchdog already completed its own sleep+kill
  # cycle (handler ran past TIMEOUT_SECS); that's fine.
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true

  return "$rc"
}

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
    # macOS base install lacks `timeout`/`gtimeout`. Fall back to the pure-bash
    # watchdog so handlers still get time-enforced isolation.
    printf '%s' "$INPUT" | run_with_watchdog "$TIMEOUT_SECS" "$handler" || true
  fi
done

exit 0
