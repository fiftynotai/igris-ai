#!/usr/bin/env bats

# home-fence.bats — TD-456: the HOME fence the whole tier stands on.
#
# `igris install` step 11 and `igris init` write ~/.claude.json (+ the other
# harness configs) from os.homedir(); IGRIS_BRAIN_DIR alone is not a fence.
# `fence_home` / `stage_brain` export HOME=$BATS_TEST_TMPDIR/home and
# `assert_home_fenced` proves it. These cases pin the assertion's four refusals
# and the one seed the fence carries (a .gitconfig, so a fenced test can commit).
#
# The refusals run in a CHILD bash that re-sources _helpers.bash under the bad
# HOME, so the assertion is exercised as a fresh process would see it and the
# test's own environment is never left pointing at the real home. IGRIS_REAL_HOME
# is exported by the helper at load, so the child keeps the parent's value.

load _helpers.bash

HELPERS="$BATS_TEST_DIRNAME/_helpers.bash"

@test "F0: fence_home exports HOME=\$BATS_TEST_TMPDIR/home and assert_home_fenced returns 0" {
  fence_home
  [ "$HOME" = "$BATS_TEST_TMPDIR/home" ]
  [ -d "$HOME" ]
  run assert_home_fenced
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "F4: assert_home_fenced with HOME=\$IGRIS_REAL_HOME returns 1 and names the reason" {
  [ -n "$IGRIS_REAL_HOME" ]
  run bash -c "export HOME='$IGRIS_REAL_HOME'; source '$HELPERS'; assert_home_fenced"
  [ "$status" -eq 1 ]
  [[ "$output" == *"assert_home_fenced: HOME is the real home"* ]] || return 1
}

@test "F5: assert_home_fenced with HOME outside \$BATS_TEST_TMPDIR returns 1 and names the reason" {
  OUTSIDE="$(mktemp -d "${TMPDIR:-/tmp}/td456-outside.XXXXXX")"
  case "$OUTSIDE" in "$BATS_TEST_TMPDIR"/*) return 1 ;; esac  # the control is really outside
  run bash -c "export HOME='$OUTSIDE'; source '$HELPERS'; assert_home_fenced"
  rm -rf "$OUTSIDE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"assert_home_fenced: HOME is outside BATS_TEST_TMPDIR"* ]] || return 1
}

@test "F5b: assert_home_fenced with a fenced-looking but MISSING HOME returns 1" {
  run bash -c "export HOME='$BATS_TEST_TMPDIR/home-that-does-not-exist'; source '$HELPERS'; assert_home_fenced"
  [ "$status" -eq 1 ]
  [[ "$output" == *"assert_home_fenced: HOME does not exist"* ]] || return 1
}

@test "F5c: assert_home_fenced with an EMPTY HOME returns 1" {
  run bash -c "export HOME=''; source '$HELPERS'; assert_home_fenced"
  [ "$status" -eq 1 ]
  [[ "$output" == *"assert_home_fenced: HOME is empty"* ]] || return 1
}

@test "G1: git commit inside a fenced HOME succeeds (the .gitconfig seed gives git an identity)" {
  fence_home
  [ -f "$HOME/.gitconfig" ]
  PROJ="$(stage_git_project gcommit)"
  printf 'x\n' > "$PROJ/file.txt"
  git -C "$PROJ" add file.txt
  run git -C "$PROJ" commit -q -m "fenced commit"
  [ "$status" -eq 0 ]
  run git -C "$PROJ" log -1 --format='%an <%ae>'
  [ "$status" -eq 0 ]
  # The author IS the seed — a commit that fell back to a machine-derived
  # identity would read back a different name.
  [ "$output" = "igris-bats <bats@igris.invalid>" ]
}
