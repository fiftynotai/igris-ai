#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# scoped_commit.test.bash — TD-493. Tests for core/scripts/scoped_commit.sh,
# the close-commit step of /hunt Phase 7 (core/skills/hunt/SKILL.md).
#
# THE DEFECT, RED-FIRST
# ---------------------
# Phase 7 used to stage with a sweeping `git add` and commit with the brief's
# `closes #<ID>` footer. Several sessions share one working tree and index, so
# the close took other sessions' files with it. (R0) reruns that old step on a
# sandbox seeded with three sibling files next to the brief's own modified and
# new files, and shows all three sibling files land in the commit. (G1) runs
# the new step on the same seed: none of the three land, both of the brief's
# own files do, and every sibling file keeps the state it had.
#
# (M1)-(M4) are mutation controls: each mutates a sandbox COPY of the
# script, proves the mutation landed, and shows the behaviour the matching
# green test pins breaks — so G1, A6, A3c and G2c can fail.
#
# Isolation: every test works in a fresh sandbox repo under TEST_TEMP_DIR,
# with HOME pointed at a scratch dir (no global git config, no global hooks)
# and core.hooksPath pinned to the sandbox's own hooks dir. Every `git -C`
# path is "${SBX:?}" (TD-348), and every run of the script first cd's into
# "${SBX:?}" — the script commits in whatever repo the current directory is.

load test_helper

SC="$IGRIS_ROOT/core/scripts/scoped_commit.sh"
HUNT="$IGRIS_ROOT/core/skills/hunt/SKILL.md"

setup() {
  [ -f "$SC" ] || { echo "script not found at $SC"; return 1; }
  command -v git >/dev/null 2>&1 || skip "git not available"
  export HOME="$TEST_TEMP_DIR/home"
  mkdir -p "$HOME"
  export GIT_CONFIG_NOSYSTEM=1
  SBX="$TEST_TEMP_DIR/sbx"
  mkdir -p "${SBX:?}/sub" "${SBX:?}/hooks"
  git -C "${SBX:?}" init -q
  git -C "${SBX:?}" config user.email t@t
  git -C "${SBX:?}" config user.name t
  git -C "${SBX:?}" config commit.gpgsign false
  git -C "${SBX:?}" config core.hooksPath "${SBX:?}/hooks"
  printf 'base\n' > "${SBX:?}/own.txt"
  printf 'base\n' > "${SBX:?}/sib_mod.txt"
  printf 'base\n' > "${SBX:?}/sib_staged.txt"
  printf 'base\n' > "${SBX:?}/gone.txt"
  printf 'base\n' > "${SBX:?}/unchanged.txt"
  printf 'base\n' > "${SBX:?}/sub/a.txt"
  git -C "${SBX:?}" add own.txt sib_mod.txt sib_staged.txt gone.txt unchanged.txt sub/a.txt
  git -C "${SBX:?}" commit -qm init
  BASE="$(git -C "${SBX:?}" rev-parse HEAD)"
}

# The brief's own work (a modified file, a new file) next to three sibling
# files: one modified, one modified AND staged, one untracked.
seed_mixed() {
  printf 'own\n' >> "${SBX:?}/own.txt"
  printf 'new\n' > "${SBX:?}/new.txt"
  printf 'sib\n' >> "${SBX:?}/sib_mod.txt"
  printf 'sib\n' >> "${SBX:?}/sib_staged.txt"
  git -C "${SBX:?}" add sib_staged.txt
  printf 'sib\n' > "${SBX:?}/sib_new.txt"
}

# Files in HEAD's commit, sorted, one per line.
head_files() { git -C "${SBX:?}" diff-tree --no-commit-id --name-only -r --root HEAD | sort; }
# The porcelain status line of one path.
st_of() { git -C "${SBX:?}" status --porcelain=v1 --untracked-files=all -- "$1"; }

@test "(ARM) the sandbox repo has a base commit and a hooks dir of its own" {
  [ -n "${BASE:-}" ] || return 1
  run git -C "${SBX:?}" config core.hooksPath
  [ "$output" = "${SBX:?}/hooks" ] || return 1
}

@test "(R0) the OLD Phase 7 step commits all three sibling files" {
  seed_mixed
  cd "${SBX:?}"
  git add -A
  git commit -qm "chore: close"$'\n\n'"closes #TD-000"
  run head_files
  [[ "$output" == *sib_mod.txt* ]] || return 1
  [[ "$output" == *sib_staged.txt* ]] || return 1
  [[ "$output" == *sib_new.txt* ]] || return 1
}

@test "(G1) the new step commits the brief's own files and none of the sibling files" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close"$'\n\n'"closes #TD-000" -- own.txt new.txt
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  run head_files
  [ "$output" = $'new.txt\nown.txt' ] || { echo "HEAD holds: $output"; return 1; }
  [ "$(st_of sib_mod.txt)" = " M sib_mod.txt" ] || return 1
  [ "$(st_of sib_staged.txt)" = "M  sib_staged.txt" ] || return 1
  [ "$(st_of sib_new.txt)" = "?? sib_new.txt" ] || return 1
  [ -z "$(st_of own.txt)" ] || return 1
  [ -z "$(st_of new.txt)" ] || return 1
}

@test "(G1b) the set is printed with each path's status before the commit" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- own.txt new.txt
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"2 path(s) in the set:"* ]] || return 1
  [[ "$output" == *" M own.txt"* ]] || return 1
  [[ "$output" == *"?? new.txt"* ]] || return 1
}

@test "(G2) the pre-commit hook sees only the named paths in its index" {
  seed_mixed
  seen="$TEST_TEMP_DIR/hook-seen.txt"
  printf '#!/bin/sh\ngit diff --cached --name-only | sort > "%s"\n' "$seen" > "${SBX:?}/hooks/pre-commit"
  chmod +x "${SBX:?}/hooks/pre-commit"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- own.txt new.txt
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(cat "$seen")" = $'new.txt\nown.txt' ] || { echo "hook saw: $(cat "$seen")"; return 1; }
}

@test "(G2b) the hooks run without GIT_LITERAL_PATHSPECS (it broke the contract checker's check-ignore)" {
  seed_mixed
  seen="$TEST_TEMP_DIR/hook-env.txt"
  printf '#!/bin/sh\necho "${GIT_LITERAL_PATHSPECS:-unset}" > "%s"\n' "$seen" > "${SBX:?}/hooks/pre-commit"
  chmod +x "${SBX:?}/hooks/pre-commit"
  cd "${SBX:?}"
  run env GIT_LITERAL_PATHSPECS=1 bash "$SC" -m "chore: close" -- own.txt new.txt
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(cat "$seen")" = "unset" ] || { echo "hook saw GIT_LITERAL_PATHSPECS=$(cat "$seen")"; return 1; }
}

@test "(G2c) the commit itself is literal: a file named '*.txt' commits alone, its glob siblings stay out" {
  printf 'star\n' > "${SBX:?}/*.txt"
  git -C "${SBX:?}" add -- "*.txt"
  git -C "${SBX:?}" commit -qm "add star"
  printf 'more\n' >> "${SBX:?}/*.txt"
  printf 'sib\n' >> "${SBX:?}/sib_mod.txt"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- "*.txt"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  run head_files
  [ "$output" = "*.txt" ] || { echo "HEAD holds: $output"; return 1; }
  [ "$(st_of sib_mod.txt)" = " M sib_mod.txt" ] || return 1
}

@test "(G2d) ':(literal)' holds for a leading ':', a '[..]' class and a newline in the name" {
  nl="$(printf 'n\nl.txt')"
  for f in ":colon" "[br].txt" "$nl" b.txt r.txt; do printf 'x\n' > "${SBX:?}/$f"; done
  GIT_LITERAL_PATHSPECS=1 git -C "${SBX:?}" add -- ":colon" "[br].txt" "$nl" b.txt r.txt
  git -C "${SBX:?}" commit -qm "add names"
  for f in ":colon" "[br].txt" "$nl" b.txt r.txt; do printf 'y\n' >> "${SBX:?}/$f"; done
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- ":colon" "[br].txt" "$nl"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(git -C "${SBX:?}" diff-tree --no-commit-id --name-only -r -z HEAD | tr '\0' '|')" = ":colon|[br].txt|$nl|" ] \
    || { echo "HEAD holds: $(git -C "${SBX:?}" diff-tree --no-commit-id --name-only -r HEAD)"; return 1; }
  [ "$(st_of b.txt)" = " M b.txt" ] || return 1
  [ "$(st_of r.txt)" = " M r.txt" ] || return 1
}

# (G2e) TD-494: /hunt identifies its close commit to the phase guard with a
# one-shot env prefix, `IGRIS_INSTANCE_ID=<id> bash scoped_commit.sh ...`
# (no new option, so row 169's grammar is unchanged). The script must hand the
# variable to both hooks untouched; a future `env -i` or an unset list that
# swallowed it would leave the guard unable to name the session. The second
# commit, with no prefix, is the control: the hooks then see no value, so the
# first reading came from the prefix and not from a leaked environment.
@test "(G2e) a one-shot IGRIS_INSTANCE_ID prefix reaches both hooks unchanged; without it they see none" {
  unset IGRIS_INSTANCE_ID
  seed_mixed
  pre_seen="$TEST_TEMP_DIR/pre-commit-iid.txt"
  msg_seen="$TEST_TEMP_DIR/commit-msg-iid.txt"
  printf '#!/bin/sh\necho "${IGRIS_INSTANCE_ID:-unset}" > "%s"\n' "$pre_seen" > "${SBX:?}/hooks/pre-commit"
  printf '#!/bin/sh\necho "${IGRIS_INSTANCE_ID:-unset}" > "%s"\n' "$msg_seen" > "${SBX:?}/hooks/commit-msg"
  chmod +x "${SBX:?}/hooks/pre-commit" "${SBX:?}/hooks/commit-msg"
  iid="0b5e7c1a-94d2-4e0f-8a61-2f3c4d5e6f70"
  cd "${SBX:?}"
  run bash -c 'IGRIS_INSTANCE_ID="$1" bash "$2" -m "chore: close" -- own.txt' _ "$iid" "$SC"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(cat "$pre_seen")" = "$iid" ] || { echo "pre-commit saw: $(cat "$pre_seen")"; return 1; }
  [ "$(cat "$msg_seen")" = "$iid" ] || { echo "commit-msg saw: $(cat "$msg_seen")"; return 1; }

  run bash "$SC" -m "chore: close" -- new.txt
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(cat "$pre_seen")" = "unset" ] || { echo "control: pre-commit saw: $(cat "$pre_seen")"; return 1; }
  [ "$(cat "$msg_seen")" = "unset" ] || { echo "control: commit-msg saw: $(cat "$msg_seen")"; return 1; }
}

@test "(G3) a deleted file, a git-rm'd file and a path with a space commit" {
  rm "${SBX:?}/gone.txt"
  git -C "${SBX:?}" rm -q sub/a.txt
  printf 'x\n' > "${SBX:?}/with space.txt"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- gone.txt sub/a.txt "with space.txt"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  run head_files
  [ "$output" = $'gone.txt\nsub/a.txt\nwith space.txt' ] || { echo "HEAD holds: $output"; return 1; }
}

@test "(G4) run from a subdirectory: repo-relative and absolute paths both work" {
  seed_mixed
  cd "${SBX:?}/sub"
  run bash "$SC" -m "chore: close" -- own.txt "${SBX:?}/new.txt"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  run head_files
  [ "$output" = $'new.txt\nown.txt' ] || return 1
}

@test "(G5) a path named twice (once as ./path) is one entry" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- own.txt ./own.txt
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"1 path(s) in the set:"* ]] || return 1
}

@test "(G6) -F with a relative message file works from a subdirectory" {
  seed_mixed
  printf 'chore: from file\n\ncloses #TD-000\n' > "${SBX:?}/sub/msg.txt"
  cd "${SBX:?}/sub"
  run bash "$SC" -F msg.txt -- own.txt
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(git -C "${SBX:?}" log -1 --format=%s)" = "chore: from file" ] || return 1
}

@test "(G8) legitimate dotted names are not taken for '.' or '..' segments" {
  mkdir -p "${SBX:?}/a.b"
  for f in .hidden ... x. a.b/c; do printf 'n\n' > "${SBX:?}/$f"; done
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- .hidden ... x. a.b/c
  [ "$status" -eq 0 ] || { echo "$status: $output"; return 1; }
  run head_files
  [ "$output" = $'...\n.hidden\na.b/c\nx.' ] || { echo "HEAD holds: $output"; return 1; }
}

@test "(A1) an empty set is refused: exit 1, nothing committed" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" --
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"path set is empty"* ]] || return 1
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
}

@test "(A2) a listed path with no change is refused before anything is staged" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- new.txt own.txt unchanged.txt
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"'unchanged.txt' has no change"* ]] || return 1
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
  [ "$(st_of new.txt)" = "?? new.txt" ] || return 1
}

@test "(A3) a directory, '.', and a trailing-slash path are refused" {
  seed_mixed
  printf 'y\n' >> "${SBX:?}/sub/a.txt"
  cd "${SBX:?}"
  for p in . ./ sub sub/ "${SBX:?}"; do
    run bash "$SC" -m "chore: close" -- "$p"
    [ "$status" -eq 1 ] || { echo "path '$p' gave $status: $output"; return 1; }
  done
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
}

@test "(A3b) a directory deleted from disk is refused (it would commit every deletion under it)" {
  rm -rf "${SBX:?}/sub"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- sub
  [ "$status" -eq 1 ] || { echo "$status: $output"; return 1; }
  [[ "$output" == *"is a directory"* ]] || return 1
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
}

@test "(A3c) a directory a sibling git-rm'd (gone from disk and index, still in HEAD) is refused" {
  git -C "${SBX:?}" rm -r -q sub
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- sub
  [ "$status" -eq 1 ] || { echo "$status: $output"; return 1; }
  [[ "$output" == *"is a directory in HEAD"* ]] || return 1
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
  [ "$(st_of sub/a.txt)" = "D  sub/a.txt" ] || return 1
}

@test "(A3d) a directory known only to the index (staged new files, gone from disk) is refused" {
  mkdir -p "${SBX:?}/newdir"
  printf 'n\n' > "${SBX:?}/newdir/x.txt"
  git -C "${SBX:?}" add newdir/x.txt
  rm -rf "${SBX:?}/newdir"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- newdir
  [ "$status" -eq 1 ] || { echo "$status: $output"; return 1; }
  [[ "$output" == *"is a directory in the index"* ]] || return 1
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
}

@test "(G7) a file whose name holds ' tree ' is a file, not a directory" {
  printf 'base\n' > "${SBX:?}/a tree b.txt"
  git -C "${SBX:?}" add "a tree b.txt"
  git -C "${SBX:?}" commit -qm "add a tree b"
  printf 'more\n' >> "${SBX:?}/a tree b.txt"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- "a tree b.txt"
  [ "$status" -eq 0 ] || { echo "$status: $output"; return 1; }
  run head_files
  [ "$output" = "a tree b.txt" ] || return 1
}

@test "(A4) a '..' segment and an absolute path outside the repo are refused" {
  seed_mixed
  cd "${SBX:?}"
  for p in ../x.txt sub/../own.txt /etc/hosts; do
    run bash "$SC" -m "chore: close" -- "$p"
    [ "$status" -eq 1 ] || { echo "path '$p' gave $status: $output"; return 1; }
  done
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
}

@test "(A4b) '.' and empty segments are refused, even where a sibling git-rm'd the directory" {
  git -C "${SBX:?}" rm -r -q sub
  cd "${SBX:?}"
  for p in sub/. ./sub/. sub/./a.txt sub//a.txt; do
    run bash "$SC" -m "chore: close" -- "$p"
    [ "$status" -eq 1 ] || { echo "path '$p' gave $status: $output"; return 1; }
    [[ "$output" == *"empty segment"* ]] || { echo "path '$p': $output"; return 1; }
  done
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
  [ "$(st_of sub/a.txt)" = "D  sub/a.txt" ] || return 1
}

@test "(A5) a glob is a literal name, not a pathspec: '*.txt' is refused" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- '*.txt'
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
}

@test "(A6) a hook refusal: exit 3, nothing committed, the new file unstaged again, siblings untouched" {
  seed_mixed
  printf '#!/bin/sh\necho "hook says no" >&2\nexit 1\n' > "${SBX:?}/hooks/pre-commit"
  chmod +x "${SBX:?}/hooks/pre-commit"
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- own.txt new.txt
  [ "$status" -eq 3 ] || { echo "$output"; return 1; }
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
  [ "$(st_of new.txt)" = "?? new.txt" ] || { echo "new.txt: $(st_of new.txt)"; return 1; }
  [ "$(st_of own.txt)" = " M own.txt" ] || return 1
  [ "$(st_of sib_staged.txt)" = "M  sib_staged.txt" ] || return 1
}

@test "(A6b) a part-way git add failure: exit 3, every new path unstaged again" {
  printf 'ok\n' > "${SBX:?}/a_new.txt"
  printf 'locked\n' > "${SBX:?}/z_new.txt"
  chmod 000 "${SBX:?}/z_new.txt"
  if [ -r "${SBX:?}/z_new.txt" ]; then chmod 644 "${SBX:?}/z_new.txt"; skip "running as a user that reads mode-000 files"; fi
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" -- a_new.txt z_new.txt
  chmod 644 "${SBX:?}/z_new.txt"
  [ "$status" -eq 3 ] || { echo "$status: $output"; return 1; }
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
  [ "$(st_of a_new.txt)" = "?? a_new.txt" ] || { echo "a_new.txt: $(st_of a_new.txt)"; return 1; }
  [ "$(st_of z_new.txt)" = "?? z_new.txt" ] || { echo "z_new.txt: $(st_of z_new.txt)"; return 1; }
}

@test "(A7) usage errors exit 2" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -- own.txt
  [ "$status" -eq 2 ] || return 1
  run bash "$SC" -m a -F b -- own.txt
  [ "$status" -eq 2 ] || return 1
  run bash "$SC" -m a own.txt
  [ "$status" -eq 2 ] || return 1
  run bash "$SC" -F "$TEST_TEMP_DIR/no-such-file" -- own.txt
  [ "$status" -eq 2 ] || return 1
  mkdir -p "$TEST_TEMP_DIR/not-a-repo"
  cd "$TEST_TEMP_DIR/not-a-repo"
  run env GIT_CEILING_DIRECTORIES="$TEST_TEMP_DIR" bash "$SC" -m a -- x.txt
  [ "$status" -eq 2 ] || return 1
}

@test "(A8) --dry-run prints the set and stages and commits nothing" {
  seed_mixed
  cd "${SBX:?}"
  run bash "$SC" -m "chore: close" --dry-run -- own.txt new.txt
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"--dry-run, nothing committed"* ]] || return 1
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" = "$BASE" ] || return 1
  [ "$(st_of new.txt)" = "?? new.txt" ] || return 1
}

@test "(M1) mutation control: --only turned into --include sweeps the sibling-staged file in" {
  mut="$TEST_TEMP_DIR/scoped_commit.mut.sh"
  sed 's/git commit --only /git commit --include /' "$SC" > "$mut"
  grep -q 'git commit --include ' "$mut" || { echo "mutation did not land"; return 1; }
  seed_mixed
  cd "${SBX:?}"
  run bash "$mut" -m "chore: close" -- own.txt new.txt
  run head_files
  [[ "$output" == *sib_staged.txt* ]] || { echo "the mutant kept the sibling out: $output"; return 1; }
}

@test "(M2) mutation control: without the unstage, a hook refusal leaves the new file staged" {
  mut="$TEST_TEMP_DIR/scoped_commit.mut.sh"
  sed 's/lgit rm --cached -q --ignore-unmatch -- /true -- /' "$SC" > "$mut"
  grep -q '^  true -- "\${new_paths\[@\]}"' "$mut" || { echo "mutation did not land"; return 1; }
  ! grep -q 'rm --cached' "$mut" || { echo "the unstage call is still there"; return 1; }
  seed_mixed
  printf '#!/bin/sh\nexit 1\n' > "${SBX:?}/hooks/pre-commit"
  chmod +x "${SBX:?}/hooks/pre-commit"
  cd "${SBX:?}"
  run bash "$mut" -m "chore: close" -- own.txt new.txt
  [ "$status" -eq 3 ] || return 1
  [ "$(st_of new.txt)" = "A  new.txt" ] || { echo "new.txt: $(st_of new.txt)"; return 1; }
}

@test "(M3) mutation control: without the HEAD-tree check, a sibling's git rm -r of a directory is committed (exit 4 after the fact)" {
  mut="$TEST_TEMP_DIR/scoped_commit.mut.sh"
  sed 's/git cat-file -t "HEAD:\$p"/printf blob/' "$SC" > "$mut"
  grep -q '"$(printf blob 2>/dev/null)" = "tree"' "$mut" || { echo "mutation did not land"; return 1; }
  git -C "${SBX:?}" rm -r -q sub
  cd "${SBX:?}"
  run bash "$mut" -m "chore: close" -- sub
  # The widening commit lands; only the post-commit belt check sees it.
  [ "$status" -eq 4 ] || { echo "the mutant gave $status: $output"; return 1; }
  [[ "$output" == *"outside the set: sub/a.txt"* ]] || return 1
  run head_files
  [ "$output" = "sub/a.txt" ] || { echo "HEAD holds: $output"; return 1; }
}

@test "(M4) mutation control: without :(literal) on the commit, '*.txt' globs in the sibling's file" {
  mut="$TEST_TEMP_DIR/scoped_commit.mut.sh"
  sed 's/commit_specs+=(":(literal)\$q")/commit_specs+=("$q")/' "$SC" > "$mut"
  grep -q 'commit_specs+=("$q")' "$mut" || { echo "mutation did not land"; return 1; }
  printf 'star\n' > "${SBX:?}/*.txt"
  git -C "${SBX:?}" add -- "*.txt"
  git -C "${SBX:?}" commit -qm "add star"
  printf 'more\n' >> "${SBX:?}/*.txt"
  printf 'sib\n' >> "${SBX:?}/sib_mod.txt"
  cd "${SBX:?}"
  run bash "$mut" -m "chore: close" -- "*.txt"
  run head_files
  [[ "$output" == *sib_mod.txt* ]] || { echo "the mutant kept the sibling out: $output"; return 1; }
}

@test "(S1) hunt Phase 7 calls the script and holds no sweeping stage" {
  phase7="$(awk '/^### Phase 7: COMMITTING/{on=1} /^### Phase 8:/{on=0} on' "$HUNT")"
  [ -n "$phase7" ] || { echo "Phase 7 not found"; return 1; }
  [[ "$phase7" == *"scoped_commit.sh"* ]] || return 1
  [[ "$phase7" == *"git commit --only -- <paths>"* ]] || return 1
  [[ "$phase7" == *"closes #{BRIEF_ID}"* ]] || return 1
  # The fence must surface the script's exit code, not rm's (warden, round 1).
  [[ "$phase7" == *'echo "scoped_commit exit=$rc"; [ "$rc" -eq 0 ]'* ]] || return 1
  for form in 'git add -A' 'git add .' 'git add --all' 'git commit -a'; do
    [[ "$phase7" != *"$form"* ]] || { echo "Phase 7 still holds '$form'"; return 1; }
  done
}

@test "(S2) no commit instruction in core/, cli/src or scripts stages the whole tree" {
  # Command position only: start of line (after optional whitespace or a '$'
  # prompt) or after && / ;. Prose that names a form in backticks mid-line is
  # not an instruction. Listed exception: cli/src test fixtures that build a
  # throwaway repo (git(repo, "add", "-A")) use the argv form and are out of
  # this pattern by construction.
  run grep -rnE '(^|&&|;|\$)[[:space:]]*git (add (-A|\.|--all)|commit (-a|--all))([[:space:]]|$)' \
    "$IGRIS_ROOT/core" "$IGRIS_ROOT/cli/src" "$IGRIS_ROOT/scripts"
  [ "$status" -eq 1 ] || { echo "hits:"; echo "$output"; return 1; }
}
