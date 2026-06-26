#!/bin/bash

# Description: Registration gate for the SHARED multi-CLI hooks (FR-212c).
#              The Igris hooks project GLOBALLY (one ~/.claude/settings.json
#              block, every project on the machine fires them). This helper is
#              the single source of truth for "is this directory inside a
#              REGISTERED Igris project?" — sourced by all 6 shared hooks so a
#              non-Igris project sees a clean NO-OP instead of the brief-gate /
#              session nudge / compaction side-effects.
#
# Usage: `source` this file, then call `is_registered_igris_project <dir>`.
#        Define nothing global the host scripts depend on EXCEPT the function
#        and `_GATE_RESOLVED_SLUG` (populated on a hit, for callers that want
#        the slug without a second DB walk).
#
# Contract — `is_registered_igris_project <dir>`:
#   exit 0  -> <dir> (or an ancestor) matches a `projects.path` row -> REGISTERED.
#   exit 1  -> no ancestor matches, OR the brain DB is absent/locked/errors, OR
#              sqlite3 is unavailable, OR <dir> is empty/unreadable.
#
# FAIL-OPEN-TO-NO-OP POLARITY (operator-locked, FR-212c):
#   Every uncertainty resolves to "NOT registered" (exit 1) so the host hook
#   no-ops (allows the write / emits empty context). We NEVER block a non-Igris
#   project's work because the brain happens to be missing or locked. This is
#   the INVERSE of the brief-gate's fail-toward-deny posture — the registration
#   gate sits ABOVE the brief-gate and is strictly permissive on uncertainty.
#
# Why a real DB-row match (NOT a basename fallback): the brief-gate's
# `find_project_slug` falls back to `basename(dir)` so an UN-bootstrapped env
# still resolves a slug. The registration gate must NOT do that — a basename
# fallback would false-POSITIVE every random directory as "registered" and
# re-introduce the global-misfire the gate exists to prevent. Only a genuine
# `projects.path` ancestor match counts as registered.
#
# Realpath normalisation mirrors find_project_slug (TD-150): a symlinked
# checkout is resolved via `pwd -P` so it matches the registered real path.

# The slug of the matched registered project (empty until a hit). Callers that
# already paid for the walk read this instead of walking again.
_GATE_RESOLVED_SLUG=""

is_registered_igris_project() {
  local dir="$1"
  _GATE_RESOLVED_SLUG=""

  # Empty / unreadable dir -> not registered (fail-open: the host no-ops).
  [ -n "$dir" ] || return 1

  local db="$HOME/.igris/memory/knowledge.db"

  # No sqlite3 or no brain DB -> NOT registered (fail-open). An un-bootstrapped
  # machine cannot have a registered project, and we must never block its work.
  if ! command -v sqlite3 >/dev/null 2>&1 || [ ! -f "$db" ]; then
    return 1
  fi

  # Realpath-normalise so a symlinked checkout matches the registered path
  # (TD-150 candidate C1 — the same normalisation find_project_slug uses).
  local current
  current=$(cd "$dir" 2>/dev/null && pwd -P) || current="$dir"

  # Walk ancestors against projects.path. A hard sqlite error (corrupt/locked
  # DB) is caught per-iteration via `|| hit=""` and treated as "no match here"
  # — the loop simply finds nothing and returns 1 (fail-open). We never surface
  # the error or block on it: an unavailable brain == not-registered == no-op.
  while [ -n "$current" ] && [ "$current" != "/" ]; do
    local current_esc
    current_esc=$(printf '%s' "$current" | sed "s/'/''/g")
    local hit
    hit=$(sqlite3 "$db" "SELECT slug FROM projects WHERE path = '$current_esc' LIMIT 1;" 2>/dev/null) || hit=""
    if [ -n "$hit" ]; then
      _GATE_RESOLVED_SLUG="$hit"
      return 0
    fi
    current=$(dirname "$current")
  done

  return 1
}
