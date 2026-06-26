#!/bin/bash

# Description: Portable PreToolUse hook for multi-CLI lifecycle integration.
#              Enforces the brief-first protocol by checking for an active brief
#              before allowing file modifications. Exempt paths (~/.igris/, .claude/,
#              tests, etc.) are always allowed through.
# Usage: Invoked by a per-CLI bridge. Reads JSON from stdin.
#
# Input contract:
#   stdin (preferred): JSON object. Two shapes accepted:
#     Unified shape (from bridges):
#       { "source": "claude"|"opencode", "event": "pre_tool_use",
#         "project_dir": "...",
#         "payload": { "tool_name": "...", "tool_input": { "file_path": "..." } } }
#     Native Claude shape:
#       { "tool_name": "Write|Edit", "tool_input": { "file_path": "..." } }
#   env fallback:
#     IGRIS_HOOK_SOURCE, IGRIS_HOOK_EVENT, IGRIS_PROJECT_DIR,
#     IGRIS_TOOL_NAME, IGRIS_FILE_PATH
#
# Dependencies: jq (preferred), python3 (fallback); sqlite3 (optional — brief-DB lookup)
#
# Brief-first resolution order (TD-146, hardened TD-150):
#   1. Brain DB (sqlite3): SELECT brief_id FROM brief_status
#      WHERE project = <slug> AND status = 'In Progress'  -- canonical (v5+)
#   2. Filesystem fallback: grep for '**Status:** In Progress' in
#      ~/.igris/projects/<slug>/briefs/  -- v6 brain-directory cache
#   3. Neither -> deny via JSON output.
# Slug is resolved by walking PROJECT_DIR up its ancestors and matching
# `projects.path` in the brain DB after pwd -P realpath normalisation
# (TD-150); falls back to basename(PROJECT_DIR).
# Slug is validated against ^[a-z0-9_-]+$ before any SQL interpolation;
# a non-matching slug skips the brain-DB branch (degrades to step 2).
# No verdict caching: every call queries the brain DB fresh (TD-150).
#   Closes parked candidate C2 (per-user /tmp cache isolation no longer needed
#   because the /tmp cache itself is gone).
# sqlite3 absent or brain DB missing => silently degrade to step 2.
#
# Escape hatch (TD-150):
#   IGRIS_BYPASS_BRIEF_GATE=1  => gate ALLOWS with a loud WARNING on stderr
#                                 and a `brief_gate.bypassed` event_log row.
#                                 Emergency use only. Never `export` it; pass
#                                 it as a one-shot env var per command, or it
#                                 leaks into subagent processes (forger,
#                                 sentinel) and silently disables the gate
#                                 across the whole /hunt loop.
#
# Exit codes:
#   0 - Always (hooks must never fail; denial is via JSON output, not exit code)

set -e

# FR-212c: resolve the gate-helper path NOW, while cwd is still the invocation
# directory. `${BASH_SOURCE[0]}` is relative when the hook is launched by a
# relative path (tests/bridges); the later `cd "$PROJECT_DIR"` would then break
# a relative dirname, so we capture the absolute dir up front.
_IGRIS_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

INPUT=$(cat 2>/dev/null || true)

resolve_project_dir() {
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

PROJECT_DIR=$(resolve_project_dir)
[ -d "$PROJECT_DIR" ] && cd "$PROJECT_DIR"

# ---------------------------------------------------------------------------
# FR-212c REGISTRATION GATE — sits ABOVE the bypass + brief-gate.
# The shared hooks project GLOBALLY (one ~/.claude/settings.json block fires
# them in EVERY project on the machine). If the cwd is NOT inside a registered
# Igris project, this hook MUST no-op: exit 0 (ALLOW the write — never deny a
# non-Igris project's writes). Only a registered project reaches the bypass +
# brief-gate below, where behaviour is exactly as before.
# FAIL-OPEN-TO-NO-OP: brain DB absent/locked/error -> not-registered -> allow.
# ---------------------------------------------------------------------------
if [ -n "$_IGRIS_HOOK_DIR" ] && [ -f "$_IGRIS_HOOK_DIR/_gate.sh" ]; then
  # shellcheck source=/dev/null
  . "$_IGRIS_HOOK_DIR/_gate.sh"
  if ! is_registered_igris_project "$PROJECT_DIR"; then
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# TD-150: best-effort event_log INSERT (component='brief_gate').
# Never blocks the gate: corrupt DB / locked DB / missing sqlite3 all
# silently succeed. Uses named columns (NOT positional VALUES) so future
# event_log migrations cannot break this call.
# ---------------------------------------------------------------------------
emit_brief_gate_event() {
  local event_name="$1"   # e.g. brief_gate.bypassed | brief_gate.fallback_fired | brief_gate.db_error
  local payload_json="$2" # already-valid JSON string; pass '{}' if none
  local slug="${3:-}"
  local db="$HOME/.igris/memory/knowledge.db"
  local hostname
  hostname=$(hostname 2>/dev/null || echo "")

  command -v sqlite3 >/dev/null 2>&1 || return 0
  [ -f "$db" ] || return 0

  # Escape single quotes for SQL string-literal interpolation.
  local p_esc s_esc h_esc e_esc
  p_esc=$(printf '%s' "$payload_json" | sed "s/'/''/g")
  s_esc=$(printf '%s' "$slug" | sed "s/'/''/g")
  h_esc=$(printf '%s' "$hostname" | sed "s/'/''/g")
  e_esc=$(printf '%s' "$event_name" | sed "s/'/''/g")

  sqlite3 "$db" \
    "INSERT INTO event_log (event_name, component, payload, machine_hostname, project_slug) VALUES ('$e_esc', 'brief_gate', '$p_esc', '$h_esc', '$s_esc');" \
    2>/dev/null || true
}

# ---------------------------------------------------------------------------
# TD-150: build a compact JSON object from key/value pairs.
# Args: key1 val1 [key2 val2 ...]. Values are JSON-safe-escaped by jq.
# Returns '{}' on missing jq or build error.
# ---------------------------------------------------------------------------
build_payload_json() {
  if ! command -v jq >/dev/null 2>&1; then
    echo '{}'
    return 0
  fi
  local args=("$@")
  local jq_args=()
  local jq_filter='{'
  local i=0
  while [ "$i" -lt "${#args[@]}" ]; do
    local k="${args[$i]}"
    local v="${args[$((i+1))]:-}"
    jq_args+=(--arg "k$i" "$k" --arg "v$i" "$v")
    [ "$i" -gt 0 ] && jq_filter+=','
    jq_filter+="(\$k$i):\$v$i"
    i=$((i+2))
  done
  jq_filter+='}'
  jq -nc "${jq_args[@]}" "$jq_filter" 2>/dev/null || echo '{}'
}

# ---------------------------------------------------------------------------
# Resolve project slug by walking PROJECT_DIR's ancestors against the brain
# DB's `projects.path`. Falls back to basename(PROJECT_DIR). TD-146.
# Echoes the slug. Never fails (errors -> fallback).
# TD-150 candidate C1: normalise symlinks via `pwd -P` so a symlinked
# checkout resolves to the real path that matches `projects.path` rows.
# ---------------------------------------------------------------------------
find_project_slug() {
  local db="$HOME/.igris/memory/knowledge.db"
  local fallback
  fallback=$(basename "$PROJECT_DIR")

  if ! command -v sqlite3 >/dev/null 2>&1 || [ ! -f "$db" ]; then
    echo "$fallback"
    return
  fi

  # TD-150: realpath-normalise so symlinked checkouts match the registered path.
  local current
  current=$(cd "$PROJECT_DIR" 2>/dev/null && pwd -P || echo "$PROJECT_DIR")

  while [ -n "$current" ] && [ "$current" != "/" ]; do
    local current_esc
    current_esc=$(printf '%s' "$current" | sed "s/'/''/g")
    local hit
    hit=$(sqlite3 "$db" "SELECT slug FROM projects WHERE path = '$current_esc' LIMIT 1;" 2>/dev/null) || hit=""
    if [ -n "$hit" ]; then
      echo "$hit"
      return
    fi
    current=$(dirname "$current")
  done

  echo "$fallback"
}

# ---------------------------------------------------------------------------
# Query the brain DB for an active (In Progress) brief for <slug>. TD-146.
# TD-150: splits hard sqlite error from empty result set via the
# _BRAIN_QUERY_STATUS global, so the caller can decide whether to emit a
# WARNING / event_log row vs degrade quietly.
#
# Sets globals (READ THESE — function is NOT meant to be invoked in $()
# command-substitution; the subshell would discard the globals and `set -e`
# would propagate `return 2` to the caller):
#   _BRAIN_QUERY_RESULT = brief_id, or empty string
#   _BRAIN_QUERY_STATUS = "ok" | "error" | "skipped"
#   _BRAIN_QUERY_STDERR = captured stderr from sqlite3 (truncated to 200 chars)
# Returns:
#   0 always (errors are reported via _BRAIN_QUERY_STATUS, not exit code, to
#   keep this safe to call without `|| true` under `set -e`).
# ---------------------------------------------------------------------------
_BRAIN_QUERY_RESULT=""
_BRAIN_QUERY_STATUS=""
_BRAIN_QUERY_STDERR=""

find_active_brief_in_brain() {
  local slug="$1"
  local db="$HOME/.igris/memory/knowledge.db"
  _BRAIN_QUERY_RESULT=""
  _BRAIN_QUERY_STATUS=""
  _BRAIN_QUERY_STDERR=""

  case "$slug" in
    *[!a-z0-9_-]*|"")
      _BRAIN_QUERY_STATUS="skipped"
      return 0
      ;;
  esac

  if ! command -v sqlite3 >/dev/null 2>&1 || [ ! -f "$db" ]; then
    _BRAIN_QUERY_STATUS="skipped"
    return 0
  fi

  # Capture stdout AND stderr AND exit code distinctly so we can distinguish
  # an exit-0 empty-result from an exit-non-zero hard error. `set +e`
  # required so a non-zero sqlite3 exit doesn't kill the gate under `set -e`.
  local stdout stderr_file rc
  stderr_file=$(mktemp -t igris_brief_gate.XXXXXX 2>/dev/null || echo "/tmp/igris_brief_gate_stderr.$$")
  set +e
  stdout=$(sqlite3 "$db" \
    "SELECT brief_id FROM brief_status WHERE project = '$slug' AND status = 'In Progress' ORDER BY updated_at DESC LIMIT 1;" \
    2>"$stderr_file")
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    _BRAIN_QUERY_STATUS="error"
    _BRAIN_QUERY_STDERR=$(head -c 200 "$stderr_file" 2>/dev/null || echo "")
    rm -f "$stderr_file" 2>/dev/null || true
    return 0
  fi

  rm -f "$stderr_file" 2>/dev/null || true
  _BRAIN_QUERY_STATUS="ok"
  # sqlite3 with default flags returns empty string for no rows -> stdout empty.
  _BRAIN_QUERY_RESULT=$(echo "$stdout" | head -1)
  return 0
}

# ---------------------------------------------------------------------------
# TD-150: escape hatch — IGRIS_BYPASS_BRIEF_GATE=1 makes the gate ALLOW with
# a loud WARNING + a `brief_gate.bypassed` event_log row. Pattern mirrors
# IGRIS_BYPASS_PHASE_GUARD in scripts/git-hooks/pre-commit (env-var idiom)
# but upgrades the body from silent-exit to loud-allow. Existence is
# intentional friction: emergency use only (e.g. a corrupt brain DB blocking
# all writes during recovery).
#
# WARNING: do NOT `export IGRIS_BYPASS_BRIEF_GATE=1` — it will leak into
# subagent processes (forger, sentinel) and silently disable the gate for
# every Task-tool spawn in the session. Use it one-shot per command:
#   IGRIS_BYPASS_BRIEF_GATE=1 <command>
# ---------------------------------------------------------------------------
if [ "${IGRIS_BYPASS_BRIEF_GATE:-0}" = "1" ]; then
  echo "[brief-gate] WARNING: gate bypassed via IGRIS_BYPASS_BRIEF_GATE=1 (one-shot per command; never \`export\` it — leaks into subagent processes)" >&2
  _slug_for_event=$(find_project_slug 2>/dev/null || echo "")
  emit_brief_gate_event \
    "brief_gate.bypassed" \
    "$(build_payload_json bypass_var IGRIS_BYPASS_BRIEF_GATE slug "$_slug_for_event")" \
    "$_slug_for_event"
  exit 0
fi

# ---------------------------------------------------------------------------
# Extract file_path from tool_input (both shapes)
# ---------------------------------------------------------------------------
extract_file_path() {
  if [ -z "$INPUT" ]; then
    echo "${IGRIS_FILE_PATH:-}"
    return
  fi
  if command -v jq &> /dev/null; then
    # Try payload.tool_input.file_path first (unified), then tool_input.file_path (Claude)
    local result
    result=$(echo "$INPUT" | jq -r '.payload.tool_input.file_path // .tool_input.file_path // ""' 2>/dev/null || echo "")
    echo "$result"
  else
    echo "$INPUT" | python3 -c "
import json, sys, os
try:
    data = json.load(sys.stdin)
    p = data.get('payload') or {}
    tool_input = None
    if isinstance(p, dict):
        tool_input = p.get('tool_input')
    if not tool_input:
        tool_input = data.get('tool_input')
    if isinstance(tool_input, dict):
        print(tool_input.get('file_path', ''))
    else:
        print(os.environ.get('IGRIS_FILE_PATH', ''))
except Exception:
    print(os.environ.get('IGRIS_FILE_PATH', ''))
" 2>/dev/null || echo "${IGRIS_FILE_PATH:-}"
  fi
}

# ---------------------------------------------------------------------------
# Check if path is exempt from brief gate
# ---------------------------------------------------------------------------
is_exempt() {
  local file_path="$1"

  # Empty path: allow (safety)
  if [ -z "$file_path" ]; then
    return 0
  fi

  case "$file_path" in
    */.igris/*)        return 0 ;;
    */core/*)          return 0 ;;
    */.claude/*)       return 0 ;;
    */test/*)          return 0 ;;
    */tests/*)         return 0 ;;
  esac

  local filename
  filename=$(basename "$file_path")
  case "$filename" in
    CLAUDE.md)       return 0 ;;
    CLAUDE.local.md) return 0 ;;
    AGENTS.md)       return 0 ;;
  esac

  return 1
}

# ---------------------------------------------------------------------------
# Check for active brief (TD-150: no cache, every call queries fresh).
# Branches on _BRAIN_QUERY_STATUS so brain-DB-empty vs brain-DB-error are
# treated distinctly: empty is quiet (the AC), error is LOUD with a WARNING
# + event_log row, fallback-fire (brain ok but .md found a stale brief) is
# also LOUD with a different event name.
# ---------------------------------------------------------------------------
check_active_brief() {
  local slug
  slug=$(find_project_slug)

  # 1. Canonical source: brain DB (v5+).
  #    NOTE: call WITHOUT $() — find_active_brief_in_brain sets globals
  #    (_BRAIN_QUERY_RESULT, _BRAIN_QUERY_STATUS, _BRAIN_QUERY_STDERR), and a
  #    subshell-via-$() would discard them. The function returns 0 in every
  #    branch (error path is reported via _BRAIN_QUERY_STATUS, not exit code).
  find_active_brief_in_brain "$slug"
  local active_brief="$_BRAIN_QUERY_RESULT"
  local brain_status="$_BRAIN_QUERY_STATUS"
  local brain_stderr="$_BRAIN_QUERY_STDERR"

  # 1a. Hard sqlite error: loud WARNING + event. Still try fallback below
  #     (operator instinct: don't hard-crash mid-task if a stale .md exists).
  if [ "$brain_status" = "error" ]; then
    echo "[brief-gate] WARNING: brain DB query errored — falling back to filesystem brief-cache; the brain DB may be corrupt, locked, or mid-migration" >&2
    emit_brief_gate_event \
      "brief_gate.db_error" \
      "$(build_payload_json slug "$slug" stderr "$brain_stderr")" \
      "$slug"
    # Continue to fallback below.
  fi

  # 2. Filesystem fallback: v6 brain-directory cache fallback.
  if [ -z "$active_brief" ]; then
    local cache_briefs="$HOME/.igris/projects/$slug/briefs"
    if [ -d "$cache_briefs" ]; then
      active_brief=$(grep -rl '^\*\*Status:\*\* In Progress' "$cache_briefs/" 2>/dev/null | head -1) || true
    fi

    # 2a. Fallback fired AND found something. Three sub-cases:
    #   - brain_status="ok"  + .md hit -> brain says no active brief but a
    #     stale .md exists. LOUD (the brain may be mid-migration or corrupt).
    #   - brain_status="error" + .md hit -> db_error already logged above;
    #     log fallback_fired too to evidence the recovery path.
    #   - brain_status="skipped" + .md hit -> un-bootstrapped env (no sqlite3,
    #     no DB, or invalid slug). Quiet: this is the legitimate fallback
    #     case, no point spamming users without a brain DB.
    if [ -n "$active_brief" ]; then
      case "$brain_status" in
        ok|error)
          echo "[brief-gate] WARNING: brain DB returned no active brief — falling back to filesystem brief-cache; the brain DB may be migrating or corrupt" >&2
          emit_brief_gate_event \
            "brief_gate.fallback_fired" \
            "$(build_payload_json slug "$slug" reason brain_db_empty_but_md_found brain_status "$brain_status" fallback_result "$active_brief")" \
            "$slug"
          ;;
        skipped)
          # No-op: brain absent is a known un-bootstrapped state.
          :
          ;;
      esac
    fi
    # If active_brief is still empty after both probes: quiet deny (the AC).
    # No WARNING, no event_log row.
  fi

  if [ -n "$active_brief" ]; then
    return 0
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Output deny decision as JSON
# ---------------------------------------------------------------------------
output_deny() {
  if command -v jq &> /dev/null; then
    jq -n '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "No active brief found. Create a brief first: use REGISTER or '\''create a brief for...'\''"
      }
    }'
  else
    python3 -c "
import json
result = {
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': \"No active brief found. Create a brief first: use REGISTER or 'create a brief for...'\"
    }
}
print(json.dumps(result))
" 2>/dev/null || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"No active brief found. Create a brief first: use REGISTER or create a brief for..."}}'
  fi
}

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------
main() {
  local file_path
  file_path=$(extract_file_path)

  if is_exempt "$file_path"; then
    exit 0
  fi

  if check_active_brief; then
    exit 0
  fi

  output_deny
  exit 0
}

# shellcheck disable=SC2317  # 'main "$@"' is the entrypoint; appears-unreachable is a false positive
# TD-150: stderr is NOT redirected to /dev/null here — the gate emits loud
# WARNINGs to stderr on bypass/error/fallback-fire, and those must reach the
# operator. `set -e` + every code path's explicit `exit 0` already guarantees
# the hook never crashes the host CLI.
main "$@" || exit 0
