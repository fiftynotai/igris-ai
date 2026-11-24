#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# review_worktree.test.bash — TD-497. Tests for core/scripts/review_worktree.sh,
# the review-worktree door /hunt TESTING and REVIEWING run every reviewer
# through (core/skills/hunt/SKILL.md, steps 3.7 and 5).
#
# `open` builds a detached worktree from the caller's HEAD plus the claimed
# paths, writes an env.sh that enters it with a temporary HOME and brain dir,
# and records the stash list, the ref names, the caller's checked-out branch
# and the claimed paths' content. `close` compares all four, removes the
# worktree and exits 1 on any change.
#
#   ARM    the sandbox repo itself: a base commit, a side branch, its own hooks
#   O1-O4  open: the copy, the env file, the refusals, a linked-worktree caller
#   C0     a read-only reviewer: exit 0, every line unchanged (surviving control)
#   C1-C8  the comparison fires on a stash, a branch, a tag, a stash of the
#          shared tree, a branch switch and a claimed-file edit; it stays quiet
#          on a sibling commit (C6) and a sibling's unclaimed edit (C8)
#   L1     the stated limit: a stash-then-pop in the shared tree is not seen
#   W1     an unreverted mutation inside the worktree is reported, not failed
#   R1     close refuses anything that is not a review root
#   E1     AC6: a brain writer run through env.sh lands in the fenced brain and
#          leaves the stand-in live brain byte-identical
#   C-E1   control: the same writer without env.sh changes the stand-in
#   M1-M5  mutation controls, each on a sandbox COPY of the script (with
#          scoped_commit.sh beside it), each proven landed with grep -c
#   K1     --link and --home-link: the links reach their targets, and close
#          removes the links while both targets keep their files
#          (MK: a close whose delete follows links empties both targets)
#   Y1     a symlink in the claimed set arrives as a link, never a copy of its
#          target (MY: `cp -p` without -P copies the target's bytes)
#   H1-H3  a claimed path beyond a symlink in HEAD (a link to a directory, a
#          directory reached through one, a dangling link): exit 1 before any
#          mkdir, so nothing is created where the link points and nothing is
#          left behind (MH2, MH3: each half of the check dropped)
#   Q1, Q2 a TMPDIR holding a single quote, and a TMPDIR inside the caller's
#          checkout: exit 1, nothing left behind (MQ1, MQ2: each refusal
#          dropped, and that open succeeds)
#
# Isolation: a fresh sandbox repo under TEST_TEMP_DIR per test, HOME,
# IGRIS_BRAIN_DIR and TMPDIR fenced under it (review roots are created in the
# fenced TMPDIR), repo-local user.name/user.email so `git stash` can commit,
# core.hooksPath pinned to the sandbox's own hooks dir. Every `git -C` path is
# "${X:?}" (TD-348). No test opens ~/.igris/memory/knowledge.db: E1's "live"
# brain is a stand-in under TEST_TEMP_DIR.

load test_helper

RW="$IGRIS_ROOT/core/scripts/review_worktree.sh"
SC="$IGRIS_ROOT/core/scripts/scoped_commit.sh"

setup() {
  [ -f "$RW" ] || { echo "script not found at $RW"; return 1; }
  command -v git >/dev/null 2>&1 || skip "git not available"
  export HOME="$TEST_TEMP_DIR/home"
  export IGRIS_BRAIN_DIR="$TEST_TEMP_DIR/outer-brain"
  export TMPDIR="$TEST_TEMP_DIR/tmp"
  mkdir -p "$HOME" "$IGRIS_BRAIN_DIR" "$TMPDIR"
  unset IGRIS_DB_PATH IGRIS_PIDS_DIR
  export GIT_CONFIG_NOSYSTEM=1
  SBX="$TEST_TEMP_DIR/sbx"
  mkdir -p "${SBX:?}/sub" "${SBX:?}/hooks"
  git -C "${SBX:?}" init -q
  git -C "${SBX:?}" config user.email t@t
  git -C "${SBX:?}" config user.name t
  git -C "${SBX:?}" config commit.gpgsign false
  git -C "${SBX:?}" config core.hooksPath "${SBX:?}/hooks"
  printf 'deps/\n' > "${SBX:?}/.gitignore"
  printf 'base\n' > "${SBX:?}/own.txt"
  printf 'base\n' > "${SBX:?}/sib_mod.txt"
  printf 'base\n' > "${SBX:?}/gone.txt"
  printf 'base\n' > "${SBX:?}/unchanged.txt"
  printf 'base\n' > "${SBX:?}/sub/a.txt"
  git -C "${SBX:?}" add .gitignore own.txt sib_mod.txt gone.txt unchanged.txt sub/a.txt
  git -C "${SBX:?}" commit -qm init
  git -C "${SBX:?}" branch side
  BASE="$(git -C "${SBX:?}" rev-parse HEAD)"
  RWBIN="$RW"
}

# The brief's own work — a modified, a deleted, a new executable and a nested
# new file — next to a dirty sibling file that is not in the set.
SET_FULL="own.txt gone.txt new.sh sub/deep/n.txt"
seed_full() {
  printf 'own\n' >> "${SBX:?}/own.txt"
  rm -f "${SBX:?}/gone.txt"
  printf '#!/bin/sh\necho new\n' > "${SBX:?}/new.sh"
  chmod +x "${SBX:?}/new.sh"
  mkdir -p "${SBX:?}/sub/deep"
  printf 'nested\n' > "${SBX:?}/sub/deep/n.txt"
  printf 'sib\n' >> "${SBX:?}/sib_mod.txt"
}

# Modified and deleted paths only: `git stash` refuses to run in a tree whose
# index holds intent-to-add entries, so the stash cases use this set.
SET_MOD="own.txt gone.txt"
seed_mod() {
  printf 'own\n' >> "${SBX:?}/own.txt"
  rm -f "${SBX:?}/gone.txt"
  printf 'sib\n' >> "${SBX:?}/sib_mod.txt"
}

kv() { printf '%s\n' "$output" | sed -n "s/^$1=//p"; }

# rw_open <id> <path>... — open from the sandbox root and keep the REVIEW_* values.
rw_open() {
  local id="$1"; shift
  rw_open_opts "$id" -- "$@"
}

# rw_open_opts <id> [--link <rel>]... [--home-link <name>]... -- <path>...
rw_open_opts() {
  local id="$1"; shift
  cd "${SBX:?}" || return 1
  run bash "$RWBIN" open --id "$id" "$@"
  [ "$status" -eq 0 ] || { echo "open exit $status: $output" >&2; return 1; }
  REVIEW_ROOT="$(kv REVIEW_ROOT)"
  REVIEW_DIR="$(kv REVIEW_DIR)"
  REVIEW_ENV="$(kv REVIEW_ENV)"
  REVIEW_DIFF="$(kv REVIEW_DIFF)"
  [ -n "$REVIEW_ROOT" ] && [ -d "$REVIEW_DIR" ] && [ -f "$REVIEW_ENV" ] && [ -f "$REVIEW_DIFF" ] \
    || { echo "open printed: $output" >&2; return 1; }
}

rw_close() { run bash "$RWBIN" close "$REVIEW_ROOT"; }

# Review roots left under the fenced TMPDIR.
roots_left() { find "$TMPDIR" -maxdepth 1 -name 'igris-review-*' | wc -l | tr -d ' '; }
# Worktrees registered on the sandbox repo.
wt_count() { git -C "${SBX:?}" worktree list --porcelain | grep -c '^worktree '; }

# mutant <name> <sed-expr> — a sandbox copy of the script with one edit, and
# scoped_commit.sh beside it (open calls it from its own directory).
mutant() {
  local d="$TEST_TEMP_DIR/mut-$1"
  mkdir -p "$d"
  cp "$SC" "$d/scoped_commit.sh"
  sed "$2" "$RW" > "$d/review_worktree.sh"
  RWBIN="$d/review_worktree.sh"
}

@test "(ARM) the sandbox repo has a base commit, a side branch and a hooks dir of its own" {
  [ -n "${BASE:-}" ] || return 1
  run git -C "${SBX:?}" config core.hooksPath
  [ "$output" = "${SBX:?}/hooks" ] || return 1
  run git -C "${SBX:?}" rev-parse side
  [ "$output" = "$BASE" ]
}

@test "(O1) open copies exactly the claimed set into a detached worktree; the dirty sibling stays at HEAD" {
  seed_full
  # shellcheck disable=SC2086
  rw_open T1 $SET_FULL
  [[ "$output" == *"paths: 4"* ]] || return 1
  # detached, registered on the caller's repo
  run git -C "${SBX:?}" worktree list --porcelain
  local block
  block="$(printf '%s\n' "$output" | awk -v w="worktree $REVIEW_DIR" '$0 == w { on = 1 } on && /^$/ { exit } on')"
  [[ "$block" == *detached* ]] || { echo "not detached: $block"; return 1; }
  run git -C "${REVIEW_DIR:?}" rev-parse HEAD
  [ "$output" = "$BASE" ] || return 1
  # content = HEAD + the set
  [ "$(cat "$REVIEW_DIR/own.txt")" = $'base\nown' ] || return 1
  [ ! -e "$REVIEW_DIR/gone.txt" ] || return 1
  [ -x "$REVIEW_DIR/new.sh" ] || return 1
  [ "$(cat "$REVIEW_DIR/sub/deep/n.txt")" = "nested" ] || return 1
  # the sibling keeps HEAD's bytes
  [ "$(cat "$REVIEW_DIR/sib_mod.txt")" = "base" ] || return 1
  # review.diff names exactly the set
  run bash -c "grep '^diff --git ' '$REVIEW_DIFF' | sed 's|^diff --git a/||; s| b/.*||' | LC_ALL=C sort"
  [ "$output" = $'gone.txt\nnew.sh\nown.txt\nsub/deep/n.txt' ] || { echo "diff names: $output"; return 1; }
  grep -q '^new file mode 100755' "$REVIEW_DIFF" || return 1
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(O2) env.sh enters the worktree with a temp HOME and brain dir and unsets the outranking seams, under bash, sh and zsh" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open T2 $SET_MOD
  local sh got tried=0
  for sh in bash sh zsh; do
    command -v "$sh" >/dev/null 2>&1 || continue
    tried=$((tried + 1))
    if [ "$sh" = zsh ]; then
      got="$(IGRIS_DB_PATH=/planted/db IGRIS_PIDS_DIR=/planted/pids zsh -f -c '. "$1" && printf "%s|%s|%s|%s|%s\n" "$(pwd -P)" "$HOME" "$IGRIS_BRAIN_DIR" "${IGRIS_DB_PATH-UNSET}" "${IGRIS_PIDS_DIR-UNSET}"' _ "$REVIEW_ENV")"
    else
      got="$(IGRIS_DB_PATH=/planted/db IGRIS_PIDS_DIR=/planted/pids "$sh" -c '. "$1" && printf "%s|%s|%s|%s|%s\n" "$(pwd -P)" "$HOME" "$IGRIS_BRAIN_DIR" "${IGRIS_DB_PATH-UNSET}" "${IGRIS_PIDS_DIR-UNSET}"' _ "$REVIEW_ENV")"
    fi
    [ "$got" = "$REVIEW_DIR|$REVIEW_ROOT/home|$REVIEW_ROOT/brain|UNSET|UNSET" ] \
      || { echo "$sh sourced env.sh to: $got"; return 1; }
  done
  [ "$tried" -ge 2 ] || { echo "fewer than two shells available"; return 1; }
  rw_close
  [ "$status" -eq 0 ]
}

@test "(O3) open refuses a bad set, id or link and leaves nothing behind" {
  seed_full
  cd "${SBX:?}"
  local before_wt
  before_wt="$(wt_count)"
  run bash "$RW" open --id T3 -- unchanged.txt
  [ "$status" -eq 1 ] || { echo "no-change path: $status $output"; return 1; }
  run bash "$RW" open --id T3 -- sub
  [ "$status" -eq 1 ] || { echo "directory: $status $output"; return 1; }
  run bash "$RW" open --id T3 -- /etc/hosts
  [ "$status" -eq 1 ] || { echo "outside path: $status $output"; return 1; }
  run bash "$RW" open --id 'bad id' -- own.txt
  [ "$status" -eq 2 ] || { echo "bad id: $status $output"; return 1; }
  run bash "$RW" open --id T3 --link own.txt -- own.txt
  [ "$status" -eq 1 ] || { echo "tracked --link: $status $output"; return 1; }
  run bash "$RW" open --id T3 --home-link .igris -- own.txt
  [ "$status" -eq 2 ] || { echo "--home-link .igris: $status $output"; return 1; }
  run bash "$RW" open --id T3 --home-link a/b -- own.txt
  [ "$status" -eq 2 ] || { echo "--home-link a/b: $status $output"; return 1; }
  [ "$(roots_left)" -eq 0 ] || { echo "a review root was left behind"; ls "$TMPDIR"; return 1; }
  [ "$(wt_count)" -eq "$before_wt" ] || { echo "a worktree registration was left behind"; return 1; }
}

@test "(O4) a linked-worktree caller: the review is built from THAT worktree's HEAD" {
  local LW="$TEST_TEMP_DIR/lw"
  git -C "${SBX:?}" worktree add -q -b lwb "${LW:?}" HEAD
  printf 'lw\n' > "${LW:?}/c.txt"
  git -C "${LW:?}" add c.txt
  git -C "${LW:?}" commit -qm lw
  printf 'mod\n' >> "${LW:?}/own.txt"
  cd "${LW:?}"
  run bash "$RW" open --id T4 -- own.txt
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  REVIEW_ROOT="$(kv REVIEW_ROOT)"; REVIEW_DIR="$(kv REVIEW_DIR)"
  run git -C "${REVIEW_DIR:?}" rev-parse HEAD
  [ "$output" = "$(git -C "${LW:?}" rev-parse HEAD)" ] || return 1
  [ "$output" != "$BASE" ] || return 1
  [ "$(cat "$REVIEW_DIR/c.txt")" = "lw" ] || return 1
  [ "$(cat "$REVIEW_DIR/own.txt")" = $'base\nmod' ] || return 1
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(C0) a read-only reviewer, plus writes inside the worktree and the temp HOME: exit 0, all unchanged, removed" {
  seed_full
  # shellcheck disable=SC2086
  rw_open C0 $SET_FULL
  ( . "$REVIEW_ENV" && git status --short >/dev/null && git log -1 --oneline >/dev/null \
      && git diff --stat HEAD >/dev/null && printf 'x\n' > scratch.out \
      && mkdir -p "$HOME/.cache" && printf 'y\n' > "$HOME/.cache/f" )
  rw_close
  echo "$output"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"stash: unchanged"* ]] || return 1
  [[ "$output" == *"refs: unchanged"* ]] || return 1
  [[ "$output" == *"head: unchanged"* ]] || return 1
  [[ "$output" == *"claimed: unchanged"* ]] || return 1
  [[ "$output" == *"worktree: as-opened"* ]] || return 1
  [[ "$output" == *"removed: yes"* ]] || return 1
  [ ! -e "$REVIEW_ROOT" ] || return 1
  [ "$(wt_count)" -eq 1 ]
}

@test "(C1, AC5) a reviewer that runs git stash in the worktree fails the review; the entry is not dropped; the worktree is removed" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open C1 $SET_MOD
  ( . "$REVIEW_ENV" && git stash -q )
  rw_close
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"stash: CHANGED"* ]] || return 1
  [[ "$output" == *"removed: yes"* ]] || return 1
  [ "$(git -C "${SBX:?}" stash list | wc -l | tr -d ' ')" -eq 1 ] || return 1
  [ ! -e "$REVIEW_ROOT" ]
}

@test "(M1) mutation: drop the stash comparison and C1 passes — the C1 assertion can fail" {
  mutant m1 '/check stash stash_list/d'
  [ "$(grep -c 'check stash stash_list' "$RW")" -eq 1 ] || return 1
  [ "$(grep -c 'check stash stash_list' "$RWBIN")" -eq 0 ] || return 1
  seed_mod
  # shellcheck disable=SC2086
  rw_open M1 $SET_MOD
  ( . "$REVIEW_ENV" && git stash -q )
  rw_close
  [ "$status" -eq 0 ] || { echo "mutant still failed: $output"; return 1; }
}

@test "(C2, AC5) a reviewer that creates a branch fails the review, naming it" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open C2 $SET_MOD
  ( . "$REVIEW_ENV" && git branch probe )
  rw_close
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"refs: CHANGED"* ]] || return 1
  [[ "$output" == *"  + refs/heads/probe"* ]]
}

@test "(C3) a reviewer that creates a tag fails the review, naming it" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open C3 $SET_MOD
  ( . "$REVIEW_ENV" && git tag t )
  rw_close
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"  + refs/tags/t"* ]]
}

@test "(C4) a reviewer that cd's into the shared tree and stashes it: exit 1 on stash AND claimed; the stash pops back intact" {
  seed_full
  # shellcheck disable=SC2086
  rw_open C4 $SET_FULL
  ( . "$REVIEW_ENV" && cd "${SBX:?}" && git stash -q -u )
  rw_close
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"stash: CHANGED"* ]] || return 1
  [[ "$output" == *"claimed: CHANGED"* ]] || return 1
  # nothing was dropped: the test pops it and the sibling's edit is back
  git -C "${SBX:?}" stash pop -q
  [ "$(cat "${SBX:?}/sib_mod.txt")" = $'base\nsib' ] || return 1
  [ "$(cat "${SBX:?}/own.txt")" = $'base\nown' ] || return 1
  [ -x "${SBX:?}/new.sh" ]
}

@test "(C5) the caller's checked-out branch moving during the review: head CHANGED" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open C5 $SET_MOD
  git -C "${SBX:?}" checkout -q side
  rw_close
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"head: CHANGED"* ]]
}

@test "(C6) a sibling commit on the shared branch moves a SHA, not a name: exit 0" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open C6 $SET_MOD
  printf 'other\n' > "${SBX:?}/other.txt"
  git -C "${SBX:?}" add other.txt
  git -C "${SBX:?}" commit -qm sibling -- other.txt
  [ "$(git -C "${SBX:?}" rev-parse HEAD)" != "$BASE" ] || return 1
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(M2) mutation: compare ref SHAs instead of names and C6 fails — names-only is what keeps C6 quiet" {
  mutant m2 's/%(refname)/%(objectname) %(refname)/'
  [ "$(grep -c '%(objectname)' "$RW")" -eq 0 ] || return 1
  [ "$(grep -c '%(objectname)' "$RWBIN")" -ge 1 ] || return 1
  seed_mod
  # shellcheck disable=SC2086
  rw_open M2 $SET_MOD
  printf 'other\n' > "${SBX:?}/other.txt"
  git -C "${SBX:?}" add other.txt
  git -C "${SBX:?}" commit -qm sibling -- other.txt
  rw_close
  [ "$status" -eq 1 ] || { echo "mutant passed: $output"; return 1; }
}

@test "(C7) a reviewer that edits a claimed file in the shared tree: claimed CHANGED, exit 1" {
  seed_full
  # shellcheck disable=SC2086
  rw_open C7 $SET_FULL
  ( . "$REVIEW_ENV" && cd "${SBX:?}" && printf 'x\n' >> own.txt )
  rw_close
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"claimed: CHANGED"* ]] || return 1
  [[ "$output" == *"own.txt"* ]]
}

@test "(M5) mutation: drop the claimed-path comparison and C7 passes" {
  mutant m5 '/check claimed claimed_state/d'
  [ "$(grep -c 'check claimed claimed_state' "$RW")" -eq 1 ] || return 1
  [ "$(grep -c 'check claimed claimed_state' "$RWBIN")" -eq 0 ] || return 1
  seed_full
  # shellcheck disable=SC2086
  rw_open M5 $SET_FULL
  ( . "$REVIEW_ENV" && cd "${SBX:?}" && printf 'x\n' >> own.txt )
  rw_close
  [ "$status" -eq 0 ] || { echo "mutant still failed: $output"; return 1; }
}

@test "(C8) a sibling editing an UNCLAIMED file during the review: exit 0 (control for the claimed check's noise)" {
  seed_full
  # shellcheck disable=SC2086
  rw_open C8 $SET_FULL
  printf 'more\n' >> "${SBX:?}/sib_mod.txt"
  printf 'more\n' >> "${SBX:?}/unchanged.txt"
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(L1) the stated limit: a stash-then-pop in the shared tree is NOT detected (exit 0)" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open L1 $SET_MOD
  ( . "$REVIEW_ENV" && cd "${SBX:?}" && git stash -q && git stash pop -q )
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  grep -q 'stash-then-pop' "$RW"
}

@test "(W1) an unreverted mutation inside the worktree: worktree differs, exit 0" {
  seed_mod
  # shellcheck disable=SC2086
  rw_open W1 $SET_MOD
  ( . "$REVIEW_ENV" && printf 'mutated\n' >> own.txt )
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"worktree: differs"* ]]
}

@test "(R1) close refuses a decoy and a second close, and removes nothing it does not own" {
  local decoy="$TMPDIR/igris-review-decoy-XXXX"
  mkdir -p "$decoy/wt"
  printf 'keep\n' > "$decoy/wt/keep.txt"
  run bash "$RW" close "$decoy"
  [ "$status" -eq 2 ] || { echo "decoy without marker: $status $output"; return 1; }
  [ -f "$decoy/wt/keep.txt" ] || return 1
  # a marker naming a different root is refused too
  printf 'root=/somewhere/else\ntop=%s\nid=x\n' "$SBX" > "$decoy/.igris-review"
  run bash "$RW" close "$decoy"
  [ "$status" -eq 2 ] || { echo "decoy with a foreign marker: $status $output"; return 1; }
  [ -f "$decoy/wt/keep.txt" ] || return 1
  # a directory whose name is not a review root
  mkdir -p "$TEST_TEMP_DIR/plain"
  run bash "$RW" close "$TEST_TEMP_DIR/plain"
  [ "$status" -eq 2 ] || return 1
  [ -d "$TEST_TEMP_DIR/plain" ] || return 1
  # a real root closes once; the second close is "not a review root"
  seed_mod
  # shellcheck disable=SC2086
  rw_open R1 $SET_MOD
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  rw_close
  [ "$status" -eq 2 ] || { echo "second close: $status $output"; return 1; }
  [[ "$output" == *"not a review root"* ]]
}

# --- AC6: the brain fence ----------------------------------------------------
# A stand-in "live" home with a seeded brain, and an outer IGRIS_DB_PATH aimed
# at it: the strongest outranking seam (db.ts resolveDbPath: explicit arg, then
# IGRIS_DB_PATH, then IGRIS_BRAIN_DIR, then ~/.igris/memory/knowledge.db).
setup_live_brain() {
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  LIVE_HOME="$TEST_TEMP_DIR/livehome"
  LIVE_DB="$LIVE_HOME/.igris/memory/knowledge.db"
  mkdir -p "$LIVE_HOME/.igris/memory"
  sqlite3 "$LIVE_DB" "CREATE TABLE t(x TEXT); INSERT INTO t VALUES('seed');"
  WRITER="$TEST_TEMP_DIR/bin/writer"
  mkdir -p "$TEST_TEMP_DIR/bin"
  cat > "$WRITER" <<'SH'
#!/bin/bash
# Resolves the brain path in resolveDbPath's order and writes one row.
p="${1:-}"
[ -n "$p" ] || p="${IGRIS_DB_PATH:-}"
if [ -z "$p" ] && [ -n "${IGRIS_BRAIN_DIR:-}" ]; then p="$IGRIS_BRAIN_DIR/memory/knowledge.db"; fi
[ -n "$p" ] || p="$HOME/.igris/memory/knowledge.db"
mkdir -p "$(dirname "$p")"
sqlite3 "$p" "CREATE TABLE IF NOT EXISTS t(x TEXT); INSERT INTO t VALUES('review-run');"
SH
  chmod +x "$WRITER"
  export HOME="$LIVE_HOME"
  export IGRIS_DB_PATH="$LIVE_DB"
}

live_sum() { sqlite3 -readonly "$LIVE_DB" .dump | shasum -a 256; }

@test "(E1, AC6) a brain writer run through env.sh writes the fenced brain and leaves the stand-in live brain byte-identical" {
  setup_live_brain
  seed_mod
  local before after
  before="$(live_sum)"
  # shellcheck disable=SC2086
  rw_open E1 $SET_MOD
  ( . "$REVIEW_ENV" && "$WRITER" )
  after="$(live_sum)"
  [ "$before" = "$after" ] || { echo "the stand-in live brain changed"; return 1; }
  # positive control: the write happened, in the fence
  run sqlite3 -readonly "$REVIEW_ROOT/brain/memory/knowledge.db" "SELECT x FROM t;"
  [ "$output" = "review-run" ] || { echo "fenced brain holds: $output"; return 1; }
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ ! -e "$REVIEW_ROOT" ]
}

@test "(C-E1) control: the same writer WITHOUT the env.sh prefix changes the stand-in — the witness can fail" {
  setup_live_brain
  local before after
  before="$(live_sum)"
  ( cd "${SBX:?}" && "$WRITER" )
  after="$(live_sum)"
  [ "$before" != "$after" ]
}

@test "(M4) mutation: env.sh without 'unset IGRIS_DB_PATH' lets the writer reach the stand-in" {
  mutant m4 's/unset IGRIS_DB_PATH IGRIS_PIDS_DIR/unset IGRIS_PIDS_DIR/'
  [ "$(grep -c 'unset IGRIS_DB_PATH' "$RW")" -ge 1 ] || return 1
  [ "$(grep -c 'unset IGRIS_DB_PATH' "$RWBIN")" -eq 0 ] || return 1
  setup_live_brain
  seed_mod
  local before after
  before="$(live_sum)"
  # shellcheck disable=SC2086
  rw_open M4 $SET_MOD
  ( . "$REVIEW_ENV" && "$WRITER" )
  after="$(live_sum)"
  [ "$before" != "$after" ] || { echo "the mutant still fenced the writer"; return 1; }
}

@test "(M3) mutation: drop --detach and the HEAD argument and C0 fails — git names a branch after the worktree" {
  # Dropping --detach alone is not a mutation: git detaches a worktree whose
  # commit-ish is not a branch name, HEAD included. Without the commit-ish it
  # creates a branch named after the directory.
  mutant m3 's/ --detach -q "\$wt" HEAD/ -q "$wt"/'
  [ "$(grep -cF -- '--detach -q "$wt" HEAD' "$RW")" -eq 1 ] || return 1
  [ "$(grep -cF -- '--detach -q "$wt" HEAD' "$RWBIN")" -eq 0 ] || return 1
  [ "$(grep -cF -- 'worktree add -q "$wt"' "$RWBIN")" -eq 1 ] || return 1
  seed_mod
  # shellcheck disable=SC2086
  rw_open M3 $SET_MOD
  rw_close
  [ "$status" -eq 1 ] || { echo "mutant passed: $output"; return 1; }
  [[ "$output" == *"  + refs/heads/wt"* ]]
}

# --- links, symlinks and where the root may live ------------------------------
# A gitignored dependency dir and a HOME entry, as /hunt links node_modules and
# cli/dist: close must remove the links and leave their targets' files alone.
seed_links() {
  mkdir -p "${SBX:?}/deps/lib" "${HOME:?}/hcache"
  printf 'dep\n' > "${SBX:?}/deps/lib/x.js"
  printf 'top\n' > "${SBX:?}/deps/top.txt"
  printf 'home\n' > "${HOME:?}/hcache/f"
}

@test "(K1) --link and --home-link: the links reach their targets; close removes the links and both targets keep their files" {
  seed_mod
  seed_links
  # shellcheck disable=SC2086
  rw_open_opts K1 --link deps --home-link hcache -- $SET_MOD
  # the links are links, and they reach the populated targets
  [ -L "$REVIEW_DIR/deps" ] || { echo "deps is not a link in the worktree"; return 1; }
  [ "$(cat "$REVIEW_DIR/deps/lib/x.js")" = "dep" ] || return 1
  [ -L "$REVIEW_ROOT/home/hcache" ] || { echo "hcache is not a link in the temp HOME"; return 1; }
  [ "$(cat "$REVIEW_ROOT/home/hcache/f")" = "home" ] || return 1
  rw_close
  echo "$output"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"removed: yes"* ]] || return 1
  # the links are gone with the root
  [ ! -e "$REVIEW_DIR/deps" ] && [ ! -L "$REVIEW_DIR/deps" ] || { echo "the deps link survived close"; return 1; }
  [ ! -e "$REVIEW_ROOT/home/hcache" ] && [ ! -L "$REVIEW_ROOT/home/hcache" ] || { echo "the hcache link survived close"; return 1; }
  # the targets keep every file
  [ "$(cat "${SBX:?}/deps/lib/x.js")" = "dep" ] || { echo "deps/lib/x.js lost"; return 1; }
  [ "$(cat "${SBX:?}/deps/top.txt")" = "top" ] || { echo "deps/top.txt lost"; return 1; }
  [ "$(cat "${HOME:?}/hcache/f")" = "home" ] || { echo "hcache/f lost"; return 1; }
}

@test "(MK) mutation: a close whose delete follows links empties both link targets — K1's survival assertions can fail" {
  # Scoped to cmd_close; `.*` stands for the git call that removes the worktree.
  mutant mk '/^cmd_close()/,/^}/ s|^\(    \)\(.*worktree remove --force "\$wt"\)|\1find -L "$root" -type f -exec rm -f {} + 2>/dev/null; \2|'
  [ "$(grep -c 'find -L' "$RW")" -eq 0 ] || return 1
  [ "$(grep -c 'find -L' "$RWBIN")" -eq 1 ] || return 1
  seed_mod
  seed_links
  # shellcheck disable=SC2086
  rw_open_opts MK --link deps --home-link hcache -- $SET_MOD
  rw_close
  [ ! -e "${SBX:?}/deps/lib/x.js" ] || { echo "the mutant left deps/lib/x.js: $output"; return 1; }
  [ ! -e "${SBX:?}/deps/top.txt" ] || { echo "the mutant left deps/top.txt: $output"; return 1; }
  [ ! -e "${HOME:?}/hcache/f" ] || { echo "the mutant left hcache/f: $output"; return 1; }
}

# A new symlink in the claimed set whose target lies outside the repository.
seed_link_claim() {
  printf 'outside\n' > "$TEST_TEMP_DIR/outside-target.txt"
  ln -s "$TEST_TEMP_DIR/outside-target.txt" "${SBX:?}/alias.lnk"
}

@test "(Y1) a symlink in the claimed set arrives in the worktree as a link, not a copy of its target" {
  seed_link_claim
  rw_open Y1 alias.lnk
  [ -L "$REVIEW_DIR/alias.lnk" ] || { echo "alias.lnk is not a link: $(ls -l "$REVIEW_DIR/alias.lnk")"; return 1; }
  [ "$(readlink "$REVIEW_DIR/alias.lnk")" = "$TEST_TEMP_DIR/outside-target.txt" ] || return 1
  grep -q '^new file mode 120000' "$REVIEW_DIFF" || { echo "review.diff does not add a link"; cat "$REVIEW_DIFF"; return 1; }
  rw_close
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "(MY) mutation: cp -p without -P copies the link target's bytes and Y1 fails" {
  mutant my 's/cp -pP "\$src"/cp -p "$src"/'
  [ "$(grep -cF 'cp -pP "$src"' "$RW")" -eq 1 ] || return 1
  [ "$(grep -cF 'cp -pP "$src"' "$RWBIN")" -eq 0 ] || return 1
  [ "$(grep -cF 'cp -p "$src"' "$RWBIN")" -eq 1 ] || return 1
  seed_link_claim
  rw_open MY alias.lnk
  [ ! -L "$REVIEW_DIR/alias.lnk" ] || { echo "the mutant still copied a link"; return 1; }
  [ "$(cat "$REVIEW_DIR/alias.lnk")" = "outside" ] || return 1
  ! grep -q '^new file mode 120000' "$REVIEW_DIFF" || return 1
  rw_close
}

@test "(H1) a claimed path under a directory that is a symlink in HEAD: exit 1, nothing created where the link points, nothing left behind" {
  local OUT="$TEST_TEMP_DIR/outside"
  mkdir -p "${OUT:?}"
  ln -s "${OUT:?}" "${SBX:?}/lnk"
  git -C "${SBX:?}" add lnk
  git -C "${SBX:?}" commit -qm 'lnk is a link'
  # the author replaced the link with a real directory holding a new file
  rm -f "${SBX:?}/lnk"
  mkdir -p "${SBX:?}/lnk/new"
  printf 'x\n' > "${SBX:?}/lnk/new/f.txt"
  cd "${SBX:?}"
  local before_wt
  before_wt="$(wt_count)"
  run bash "$RWBIN" open --id H1 -- lnk/new/f.txt
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"lies beyond a symbolic link in HEAD"* ]] || return 1
  [ -z "$(ls -A "${OUT:?}")" ] || { echo "open created outside the worktree: $(ls -A "${OUT:?}")"; return 1; }
  [ "$(roots_left)" -eq 0 ] || { echo "a review root was left behind"; return 1; }
  [ "$(wt_count)" -eq "$before_wt" ] || { echo "a worktree registration was left behind"; return 1; }
}

# seed_head_link <target> — commit lnk -> <target>, then replace the link in
# the caller's tree with a real directory (the author's change).
seed_head_link() {
  ln -s "$1" "${SBX:?}/lnk"
  git -C "${SBX:?}" add lnk
  git -C "${SBX:?}" commit -qm 'lnk is a link'
  rm -f "${SBX:?}/lnk"
}

# h_open <id> <path> — open from the sandbox root; keep the worktree count.
h_open() {
  cd "${SBX:?}" || return 1
  H_BEFORE_WT="$(wt_count)"
  run bash "$RWBIN" open --id "$1" -- "$2"
  echo "$output"
}

@test "(H2) the deepest existing part of the parent lies through a HEAD symlink (the pwd -P check): exit 1, nothing created outside" {
  local OUT="$TEST_TEMP_DIR/outside"
  mkdir -p "${OUT:?}/existing"
  seed_head_link "${OUT:?}"
  mkdir -p "${SBX:?}/lnk/existing/new"
  printf 'x\n' > "${SBX:?}/lnk/existing/new/f.txt"
  h_open H2 lnk/existing/new/f.txt
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"lies beyond a symbolic link in HEAD"* ]] || return 1
  [ -z "$(ls -A "${OUT:?}/existing")" ] || { echo "open created outside the worktree: $(ls -A "${OUT:?}/existing")"; return 1; }
  [ "$(roots_left)" -eq 0 ] || return 1
  [ "$(wt_count)" -eq "$H_BEFORE_WT" ] || return 1
}

@test "(MH2) mutation: drop the pwd -P comparison and H2 writes outside the worktree" {
  mutant mh2 's/ || { \[ -d .*; }; then$/; then/'
  [ "$(grep -cF '!= "$want" ]; }; then' "$RW")" -eq 1 ] || return 1
  [ "$(grep -cF '!= "$want" ]; }; then' "$RWBIN")" -eq 0 ] || return 1
  [ "$(grep -cF 'if [ -L "$wt/$a" ]; then' "$RWBIN")" -eq 1 ] || return 1
  local OUT="$TEST_TEMP_DIR/outside"
  mkdir -p "${OUT:?}/existing"
  seed_head_link "${OUT:?}"
  mkdir -p "${SBX:?}/lnk/existing/new"
  printf 'x\n' > "${SBX:?}/lnk/existing/new/f.txt"
  h_open MH2 lnk/existing/new/f.txt
  [ -n "$(ls -A "${OUT:?}/existing")" ] || { echo "the mutant created nothing outside: $status"; return 1; }
}

@test "(H3) a dangling symlink in HEAD as the parent (the -L check): exit 1, nothing left behind" {
  seed_head_link "$TEST_TEMP_DIR/nowhere"
  mkdir -p "${SBX:?}/lnk/new"
  printf 'x\n' > "${SBX:?}/lnk/new/f.txt"
  h_open H3 lnk/new/f.txt
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"lies beyond a symbolic link in HEAD"* ]] || return 1
  [ ! -e "$TEST_TEMP_DIR/nowhere" ] || { echo "open created the link's target"; return 1; }
  [ "$(roots_left)" -eq 0 ] || return 1
  [ "$(wt_count)" -eq "$H_BEFORE_WT" ] || return 1
}

@test "(MH3) mutation: drop the -L clause and H3 no longer exits 1" {
  mutant mh3 's/if \[ -L "\$wt\/\$a" \] || {/if {/'
  [ "$(grep -cF 'if [ -L "$wt/$a" ] || {' "$RW")" -eq 1 ] || return 1
  [ "$(grep -cF 'if [ -L "$wt/$a" ] || {' "$RWBIN")" -eq 0 ] || return 1
  seed_head_link "$TEST_TEMP_DIR/nowhere"
  mkdir -p "${SBX:?}/lnk/new"
  printf 'x\n' > "${SBX:?}/lnk/new/f.txt"
  h_open MH3 lnk/new/f.txt
  [ "$status" -ne 1 ] || { echo "the mutant still refused with exit 1"; return 1; }
}

@test "(Q1) a TMPDIR holding a single quote: open exits 1 and leaves nothing behind" {
  seed_mod
  local Q="$TEST_TEMP_DIR/it's"
  mkdir -p "$Q"
  cd "${SBX:?}"
  local before_wt
  before_wt="$(wt_count)"
  # shellcheck disable=SC2086
  run env TMPDIR="$Q" bash "$RWBIN" open --id Q1 -- $SET_MOD
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"holds a quote or newline"* ]] || return 1
  [ -z "$(ls -A "$Q")" ] || { echo "left behind: $(ls -A "$Q")"; return 1; }
  [ "$(wt_count)" -eq "$before_wt" ] || { echo "a worktree registration was left behind"; return 1; }
}

@test "(MQ1) mutation: drop the quote refusal and Q1's open succeeds" {
  mutant mq1 "s/\*\"'\"\*|//"
  [ "$(grep -cF "*\"'\"*|" "$RW")" -eq 1 ] || return 1
  [ "$(grep -cF "*\"'\"*|" "$RWBIN")" -eq 0 ] || return 1
  seed_mod
  local Q="$TEST_TEMP_DIR/it's"
  mkdir -p "$Q"
  cd "${SBX:?}"
  # shellcheck disable=SC2086
  run env TMPDIR="$Q" bash "$RWBIN" open --id MQ1 -- $SET_MOD
  [ "$status" -eq 0 ] || { echo "the mutant still refused: $status $output"; return 1; }
  run bash "$RWBIN" close "$(kv REVIEW_ROOT)"
}

@test "(Q2) a TMPDIR inside the caller's checkout: open exits 1 and leaves nothing behind" {
  seed_mod
  local IN="${SBX:?}/tmpin"
  mkdir -p "$IN"
  cd "${SBX:?}"
  local before_wt
  before_wt="$(wt_count)"
  # shellcheck disable=SC2086
  run env TMPDIR="$IN" bash "$RWBIN" open --id Q2 -- $SET_MOD
  echo "$output"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"is inside the checkout"* ]] || return 1
  [ -z "$(ls -A "$IN")" ] || { echo "left behind: $(ls -A "$IN")"; return 1; }
  [ "$(wt_count)" -eq "$before_wt" ] || { echo "a worktree registration was left behind"; return 1; }
}

@test "(MQ2) mutation: drop the in-checkout refusal and Q2's open succeeds" {
  mutant mq2 's|"\$top"/\*) die 1|"/never/matches"/*) die 1|'
  [ "$(grep -cF '"$top"/*) die 1' "$RW")" -eq 1 ] || return 1
  [ "$(grep -cF '"$top"/*) die 1' "$RWBIN")" -eq 0 ] || return 1
  seed_mod
  local IN="${SBX:?}/tmpin"
  mkdir -p "$IN"
  cd "${SBX:?}"
  # shellcheck disable=SC2086
  run env TMPDIR="$IN" bash "$RWBIN" open --id MQ2 -- $SET_MOD
  [ "$status" -eq 0 ] || { echo "the mutant still refused: $status $output"; return 1; }
  run bash "$RWBIN" close "$(kv REVIEW_ROOT)"
}
