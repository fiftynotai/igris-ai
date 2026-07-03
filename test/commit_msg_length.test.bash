#!/usr/bin/env bats

# commit_msg_length.test.bash — TD-180. Tests for the commit-msg summary-length
# hook at scripts/git-hooks/commit-msg.
#
# Contract: the hook measures the FIRST non-comment, non-blank line of the
# commit message file ($1) and hard-fails (exit 1) when its length exceeds 72
# characters. The operator locked ≤72 — a 72-char summary passes, 73 fails.
#
# Test isolation
# --------------
# No git repo, no HOME, no brain DB needed — the hook is a pure function of its
# $1 message file. Each test writes a temp message file via mktemp and invokes
# the source hook directly with that file as $1. Simpler isolation than
# phase_guard.test.bash (which needs a sandbox git repo + fake HOME).

load test_helper

HOOK_SRC="$IGRIS_ROOT/scripts/git-hooks/commit-msg"

setup() {
  [ -f "$HOOK_SRC" ] || { echo "hook not found at $HOOK_SRC"; return 1; }
  MSG_FILE="$(mktemp "${BATS_TMPDIR:-/tmp}/cm.XXXXXX")"
}

teardown() {
  [ -n "${MSG_FILE:-}" ] && rm -f "$MSG_FILE"
}

# run_hook — invoke the source hook with the current $MSG_FILE as $1, capturing
# combined stdout+stderr + exit status via bats `run`.
run_hook() {
  run bash "$HOOK_SRC" "$MSG_FILE"
}

# repeat_char <char> <count> — echo <char> repeated <count> times (builds an
# exact-length summary without hand-counting).
repeat_char() {
  local ch="$1" n="$2"
  printf '%*s' "$n" '' | tr ' ' "$ch"
}

# -----------------------------------------------------------------------------
# Boundary: 71 chars -> pass (exit 0).
# -----------------------------------------------------------------------------
@test "71-char summary -> pass (exit 0)" {
  s="$(repeat_char x 71)"
  [ "${#s}" -eq 71 ]  # sanity: fixture is exactly 71
  printf '%s\n' "$s" > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# Boundary: 72 chars -> pass (exit 0). THE boundary the operator locked (≤72).
# -----------------------------------------------------------------------------
@test "72-char summary -> pass (exit 0, the locked boundary)" {
  s="$(repeat_char x 72)"
  [ "${#s}" -eq 72 ]  # sanity: fixture is exactly 72
  printf '%s\n' "$s" > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# Boundary: 73 chars -> fail (exit 1) with actionable output (length + max 72).
# -----------------------------------------------------------------------------
@test "73-char summary -> fail (exit 1) with length + 'max 72'" {
  s="$(repeat_char x 73)"
  [ "${#s}" -eq 73 ]  # sanity: fixture is exactly 73
  printf '%s\n' "$s" > "$MSG_FILE"

  run_hook
  [ "$status" -eq 1 ]
  [[ "$output" == *"73 chars"* ]]
  [[ "$output" == *"max 72"* ]]
  [[ "$output" == *"--no-verify"* ]]
}

# -----------------------------------------------------------------------------
# Comment-line skip: leading `#` comment lines above the summary are ignored;
# the summary is measured from the first non-comment line.
# -----------------------------------------------------------------------------
@test "leading '#' comment lines are skipped -> summary measured from first real line" {
  {
    echo "# this is a git comment line that is intentionally longer than seventy-two characters to prove it is skipped"
    echo "#"
    echo "fix(hooks): add commit-msg length guard"
  } > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# First-line-only: a long (>72) BODY line with a short summary -> pass. Only the
# summary (first non-comment/non-blank line) is measured, never the body.
# -----------------------------------------------------------------------------
@test "long body line with a short summary -> pass (only summary measured)" {
  {
    echo "fix(hooks): short summary"
    echo ""
    echo "$(repeat_char y 120)"
  } > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# Empty message -> pass-through (exit 0). Don't block; git rejects empty commits.
# -----------------------------------------------------------------------------
@test "empty message -> pass-through (exit 0)" {
  : > "$MSG_FILE"  # truncate to empty

  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# Comment-only message -> pass-through (exit 0). No real summary to measure.
# -----------------------------------------------------------------------------
@test "comment-only message -> pass-through (exit 0)" {
  {
    echo "# Please enter the commit message for your changes."
    echo "#"
    echo "# On branch develop"
  } > "$MSG_FILE"

  run_hook
  [ "$status" -eq 0 ]
}

# -----------------------------------------------------------------------------
# Missing message file -> pass-through (exit 0). Defensive: git always passes a
# real file, but the hook must not crash if $1 is absent.
# -----------------------------------------------------------------------------
@test "missing message file argument -> pass-through (exit 0)" {
  run bash "$HOOK_SRC"
  [ "$status" -eq 0 ]
}
