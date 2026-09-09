#!/usr/bin/env bats

# install-git-hooks.bats — FR-243 step 7b of `igris install`: the git-level
# gates as a property of a registered project.
#
# `igris install <path>` symlinks `<path>/.git/hooks/{pre-commit,commit-msg}`
# to `$IGRIS_BRAIN_DIR/core/git-hooks/<name>` (the runtime mirror `igris
# refresh` lands). Each case pins one consumer-safety rule of
# `cli/src/lib/git-hooks.ts` (plan §2.5):
#   I1 both symlinks land with the expected target (and the hook chain resolves
#      to an executable file — git ignores a non-executable hook silently);
#   I2 idempotent re-run: `already-installed`, the links untouched;
#   I3 a pre-existing hand-rolled hook is backed up byte-for-byte as
#      `<hook>.pre-igris.bak.<epoch>` and only then replaced;
#   I4 `--no-git-hooks` installs nothing;
#   I5 `core.hooksPath` set → refused, `.git/hooks/` untouched;
#   I6 `--dry-run` writes nothing (but the plan names the two symlinks);
#   I7 missing mirror (no `igris refresh` yet) → refused with the hint.
#
# Runs in the `cli-bats` CI job (no gitleaks there — nothing here needs it;
# the secret-scan RED lives in test/git_hooks_consumer.test.bash on the root
# matrix). HOME is sandboxed (TD-303) so the MCP-register step never touches
# the operator's ~/.claude.json.

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_KEEP_BAK=0
  HOME="$(stage_home)"
  export HOME
  MIRROR="$(stage_git_hooks_mirror)"
  PROJ="$(stage_git_project cproj)"
}

link_target() {
  # realpath of a symlink's target (portable: python3 is a cli-bats dependency
  # of the doctor tests already; fall back to readlink -f).
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
  else
    readlink -f "$1"
  fi
}

@test "I1: igris install lands both hook symlinks -> \$IGRIS_BRAIN_DIR/core/git-hooks/<name>, executable" {
  run $CLI_BIN install "$PROJ" --slug cproj
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"git hook pre-commit: installed"* ]] || return 1
  [[ "$output" == *"git hook commit-msg: installed"* ]] || return 1
  [ -L "$PROJ/.git/hooks/pre-commit" ]
  [ -L "$PROJ/.git/hooks/commit-msg" ]
  [ "$(link_target "$PROJ/.git/hooks/pre-commit")" = "$(link_target "$MIRROR/pre-commit")" ]
  [ "$(link_target "$PROJ/.git/hooks/commit-msg")" = "$(link_target "$MIRROR/commit-msg")" ]
  # The chain resolves to an EXECUTABLE file — the property git actually checks.
  [ -x "$PROJ/.git/hooks/pre-commit" ]
  [ -x "$PROJ/.git/hooks/commit-msg" ]
  # And the installed pre-commit is the FR-243 one (carries the layers line).
  grep -q '^echo "\[pre-commit\] layers: ' "$PROJ/.git/hooks/pre-commit"
}

@test "I2: a second igris install is idempotent — already-installed, links unchanged" {
  run $CLI_BIN install "$PROJ" --slug cproj
  [ "$status" -eq 0 ]
  before="$(link_target "$PROJ/.git/hooks/pre-commit")"
  ino_before="$(file_inode "$PROJ/.git/hooks/pre-commit")"
  run $CLI_BIN install "$PROJ" --slug cproj --verbose
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"already-installed"* ]] || return 1
  [[ "$output" != *"git hook pre-commit: installed"* ]] || return 1
  [ "$(link_target "$PROJ/.git/hooks/pre-commit")" = "$before" ]
  [ "$(file_inode "$PROJ/.git/hooks/pre-commit")" = "$ino_before" ]
}

@test "I3: a pre-existing hand-rolled pre-commit is backed up byte-for-byte, then replaced" {
  printf '#!/bin/sh\necho hand-rolled\nexit 0\n' > "$PROJ/.git/hooks/pre-commit"
  chmod +x "$PROJ/.git/hooks/pre-commit"
  orig_md5="$(file_md5 "$PROJ/.git/hooks/pre-commit")"
  run $CLI_BIN install "$PROJ" --slug cproj
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"git hook pre-commit: backed-up + installed"* ]] || return 1
  [[ "$output" == *"preserved at"* ]] || return 1
  backup="$(ls "$PROJ/.git/hooks/"pre-commit.pre-igris.bak.* | head -n1)"
  [ -f "$backup" ]
  [ "$(file_md5 "$backup")" = "$orig_md5" ]
  [ -L "$PROJ/.git/hooks/pre-commit" ]
  [ "$(link_target "$PROJ/.git/hooks/pre-commit")" = "$(link_target "$MIRROR/pre-commit")" ]
}

@test "I4: --no-git-hooks installs nothing (registration still succeeds)" {
  run $CLI_BIN install "$PROJ" --slug cproj --no-git-hooks
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Registered project: cproj"* ]] || return 1
  [[ "$output" == *"git hooks:      skipped (--no-git-hooks)"* ]] || return 1
  [ ! -e "$PROJ/.git/hooks/pre-commit" ]
  [ ! -L "$PROJ/.git/hooks/pre-commit" ]
  [ ! -e "$PROJ/.git/hooks/commit-msg" ]
}

@test "I5: core.hooksPath set (husky) -> refused, .git/hooks untouched, install still exit 0" {
  git -C "$PROJ" config core.hooksPath .husky
  mkdir -p "$PROJ/.husky"
  before="$(ls -A "$PROJ/.git/hooks" | grep -v '\.sample$' || true)"
  run $CLI_BIN install "$PROJ" --slug cproj
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"git hooks not installed: core.hooksPath=.husky"* ]] || return 1
  [[ "$output" == *"never run"* ]] || return 1
  after="$(ls -A "$PROJ/.git/hooks" | grep -v '\.sample$' || true)"
  [ "$before" = "$after" ]
  [ ! -L "$PROJ/.git/hooks/pre-commit" ]
}

@test "I6: --dry-run names the two symlinks and writes nothing" {
  run $CLI_BIN install "$PROJ" --slug cproj --dry-run
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$PROJ/.git/hooks/pre-commit"* ]] || return 1
  [[ "$output" == *"$PROJ/.git/hooks/commit-msg"* ]] || return 1
  [[ "$output" == *"symlink -> $MIRROR/pre-commit"* ]] || return 1
  [ ! -e "$PROJ/.git/hooks/pre-commit" ]
  [ ! -L "$PROJ/.git/hooks/pre-commit" ]
  # No registry row either.
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT count(*) FROM projects WHERE slug='cproj'"
  [ "$output" = "0" ] || [ "$status" -ne 0 ]
}

@test "I7: mirror absent (no igris refresh yet) -> refused with the hint, install still exit 0" {
  rm -f "$MIRROR/pre-commit" "$MIRROR/commit-msg"
  run $CLI_BIN install "$PROJ" --slug cproj
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"git hook pre-commit: refused — canonical hook missing at $MIRROR/pre-commit"* ]] || return 1
  [[ "$output" == *"run 'igris refresh' first"* ]] || return 1
  [ ! -L "$PROJ/.git/hooks/pre-commit" ]
}

@test "I8: core.hooksPath that RESOLVES to .git/hooks itself is not a bypass — installs normally" {
  # The igris-ai and mbrgea-ai checkouts on the reference machine carry exactly
  # this (`core.hooksPath=<repo>/.git/hooks`, measured 2026-09-07): git reads
  # its default location, spelled out. Refusing here would strand them.
  git -C "$PROJ" config core.hooksPath "$PROJ/.git/hooks"
  run $CLI_BIN install "$PROJ" --slug cproj
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" != *"git hooks not installed"* ]] || return 1
  [[ "$output" == *"git hook pre-commit: installed"* ]] || return 1
  [ -L "$PROJ/.git/hooks/pre-commit" ]
  # And the RELATIVE spelling of the same place.
  git -C "$PROJ" config core.hooksPath .git/hooks
  run $CLI_BIN install "$PROJ" --slug cproj --verbose
  [ "$status" -eq 0 ]
  [[ "$output" == *"already-installed"* ]] || return 1
}
