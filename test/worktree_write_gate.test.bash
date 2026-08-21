#!/usr/bin/env bats

# worktree_write_gate.test.bash — TD-408.
#
# The gate's whole value is that it needs no model of the mechanism, so these
# tests drive it with plain shell commands rather than with the CLI: if the gate
# only caught writes it recognised, it would be a pattern-matcher and would miss
# the next instance the way TD-406's sweep did.
#
# Every arm below asserts BOTH the verdict line and the exit code. The verdict
# line alone would pass if the script printed FAIL and exited 0, and the exit
# code alone would pass if it failed for an unrelated reason.

load test_helper

GATE="$IGRIS_ROOT/scripts/worktree_write_gate.sh"

setup() {
  [ -f "$GATE" ] || skip "worktree_write_gate.sh missing at $GATE"
  SBX="$TEST_TEMP_DIR/sbx"
  mkdir -p "$SBX/sub"
  cd "$SBX"
  git init -q .
  printf 'one\n' > tracked.txt
  printf 'two\n' > sub/other.txt
  git add -A
  git -c user.email=t@t -c user.name=t commit -qm init
}

@test "ARM: the sandbox is a git worktree with tracked files (else every arm is vacuous)" {
  run git -C "$SBX" ls-files
  [ "$status" -eq 0 ] || return 1
  [ -n "$output" ] || return 1
}

@test "a command that changes nothing is CLEAN and passes exit 0 through" {
  run bash "$GATE" --repo "$SBX" -- true
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "GATE CLEAN: 0 tracked files changed" || return 1
}

@test "a tracked file modified during the run FAILS and is named" {
  run bash "$GATE" --repo "$SBX" -- sh -c "printf 'x\n' >> '$SBX/tracked.txt'"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "GATE FAIL: tracked file" || return 1
  assert_output_contains "tracked.txt" || return 1
}

@test "a tracked file DELETED during the run FAILS and is named" {
  run bash "$GATE" --repo "$SBX" -- rm "$SBX/sub/other.txt"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "sub/other.txt" || return 1
}

@test "an UNTRACKED file created during the run is INFO, not a failure" {
  run bash "$GATE" --repo "$SBX" -- sh -c "printf 'x\n' > '$SBX/build.log'"
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "GATE CLEAN" || return 1
  assert_output_contains "new untracked:   1" || return 1
}

@test "a FAILING command that mutates nothing is CLEAN, and its exit code passes through" {
  # The point: a suite with pre-existing failures must still be usable under the
  # gate. If the gate collapsed both signals into one code, nobody could tell a
  # red suite from a polluting one, and the gate would be turned off.
  run bash "$GATE" --repo "$SBX" -- sh -c "exit 3"
  [ "$status" -eq 3 ] || return 1
  assert_output_contains "GATE CLEAN" || return 1
}

@test "a file ALREADY modified before the run, modified AGAIN, is still named" {
  # A name-set comparison cannot see this: the path is in both snapshots. Only
  # the per-path content hash separates the two states.
  printf 'pre-existing\n' >> "$SBX/tracked.txt"
  run bash "$GATE" --repo "$SBX" -- sh -c "printf 'again\n' >> '$SBX/tracked.txt'"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "tracked.txt" || return 1
}

@test "a file already modified before the run and NOT touched is CLEAN" {
  # The complement of the arm above — the gate measures the run's delta, not the
  # worktree's absolute cleanliness, so a dirty tree is a legal starting state.
  printf 'pre-existing\n' >> "$SBX/tracked.txt"
  run bash "$GATE" --repo "$SBX" -- true
  [ "$status" -eq 0 ] || return 1
  assert_output_contains "GATE CLEAN" || return 1
}

@test "a command that COMMITS is a failure even though the worktree ends clean" {
  run bash "$GATE" --repo "$SBX" -- sh -c \
    "printf 'x\n' >> '$SBX/tracked.txt' && git -C '$SBX' add -A && git -C '$SBX' -c user.email=t@t -c user.name=t commit -qm sneak"
  [ "$status" -eq 1 ] || return 1
  assert_output_contains "HEAD moved during the run" || return 1
}

@test "a repo dir that is not a git worktree is a usage error, and the command never runs" {
  local marker="$TEST_TEMP_DIR/should-not-exist"
  mkdir -p "$TEST_TEMP_DIR/notrepo"
  run bash "$GATE" --repo "$TEST_TEMP_DIR/notrepo" -- sh -c "printf 'x' > '$marker'"
  [ "$status" -eq 2 ] || return 1
  assert_output_contains "not a git worktree" || return 1
  [ ! -f "$marker" ] || return 1
}

@test "no command is a usage error, not a silent pass" {
  run bash "$GATE" --repo "$SBX"
  [ "$status" -eq 2 ] || return 1
  assert_output_contains "no command given" || return 1
}
