#!/usr/bin/env bash
# worktree_write_gate.sh — TD-408: fail when a command mutates a TRACKED file.
#
# WHY THIS EXISTS
#   TD-406 (`applyPersona` overwriting the tracked `core/SOUL.md`) was not found
#   by a static sweep. It was found by hashing the worktree around a suite run.
#   That control needs no model of the mechanism, so it catches instances nobody
#   imagined — including ones that happen in bash, in a subprocess, or in a
#   library nobody has read. This script is that control, made reusable.
#
# WHAT IT MEASURES
#   `git diff HEAD` — the tracked-content delta against the current commit —
#   before and after the command. Any change to that delta means some tracked
#   file's content, mode or symlink target moved while the command ran. Git is
#   the instrument rather than `shasum` over `git ls-files` because a tracked
#   symlink whose target is absent (this repo has one: `.claude/rules/`) is
#   unreadable by `shasum` yet perfectly comparable by git.
#
# WHAT IT DELIBERATELY IGNORES
#   Untracked files. Builds, logs and scratch fixtures land there constantly; a
#   gate that shouted about them would be turned off, and the hazard class is
#   *tracked source being overwritten*. New untracked paths are reported as INFO
#   with a count, never as a failure.
#
# STATED LIMITS  (each of these was observed during TD-408, not imagined)
#   - A file mutated and restored to its pre-run bytes inside the window is a
#     net no-op and reports CLEAN. The gate measures state, not events. TD-408's
#     own red-first pair did exactly this: `project-hook` wrote the tracked
#     settings file and `unproject-hook` wrote it back, and run together they
#     reported CLEAN. Run separately, each was caught.
#   - It attributes to the WINDOW, not to the command. Anything that edits a
#     tracked file while the command runs — including you, in another terminal —
#     is reported as a failure. Do not edit the worktree during a gated run.
#   - It cannot attribute the write to a test, a file or a line. It says THAT a
#     tracked file moved, which is the question a green suite cannot answer.
#
# USAGE
#   scripts/worktree_write_gate.sh <command> [args...]
#   scripts/worktree_write_gate.sh --repo <dir> -- <command> [args...]
#
# EXIT CODES
#   1  gate FAIL (a tracked file moved, or HEAD moved), whatever the command did
#   *  otherwise the command's own exit code, passed through unchanged, so a
#      suite with pre-existing failures still reports its own verdict

set -uo pipefail

REPO_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_DIR="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "worktree_write_gate: no command given" >&2
  echo "usage: worktree_write_gate.sh [--repo <dir>] [--] <command> [args...]" >&2
  exit 2
fi

if [ -z "$REPO_DIR" ]; then
  REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
# One check, not a `||`/`&&` chain whose precedence has to be reasoned about.
# `rev-parse --git-dir` is also the only form that accepts a linked worktree,
# where `.git` is a FILE rather than a directory.
if ! git -C "${REPO_DIR:-.}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "worktree_write_gate: not a git worktree: ${REPO_DIR:-<cwd>}" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wwgate.XXXXXX")"

# Snapshot the tracked-content state into $1.{sha,names,untracked}.
snapshot() {
  local out="$1"
  git -C "$REPO_DIR" diff HEAD | shasum -a256 | awk '{print $1}' > "$out.sha"
  git -C "$REPO_DIR" diff HEAD --name-only > "$out.names"
  git -C "$REPO_DIR" ls-files --others --exclude-standard > "$out.untracked"
  git -C "$REPO_DIR" rev-parse HEAD > "$out.head"
}

# Per-file tracked-content hash, so a file that was ALREADY modified before the
# run and modified AGAIN during it is still named (its name is in both lists;
# only the per-file hash separates the two states).
file_sha() {
  git -C "$REPO_DIR" diff HEAD -- "$1" | shasum -a256 | awk '{print $1}'
}

# Per-path lines "<sha> <path>". `while read` rather than `for f in $(cat)`:
# a tracked path may contain a space, which word-splitting would tear in half.
hash_names() {
  : > "$1.files"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s %s\n' "$(file_sha "$f")" "$f" >> "$1.files"
  done < "$1.names"
}

snapshot "$WORK/before"
hash_names "$WORK/before"

"$@"
CMD_STATUS=$?

snapshot "$WORK/after"
hash_names "$WORK/after"

BEFORE_SHA="$(cat "$WORK/before.sha")"
AFTER_SHA="$(cat "$WORK/after.sha")"
BEFORE_HEAD="$(cat "$WORK/before.head")"
AFTER_HEAD="$(cat "$WORK/after.head")"

NEW_UNTRACKED=$(comm -13 \
  <(sort "$WORK/before.untracked") \
  <(sort "$WORK/after.untracked") | wc -l | tr -d ' ')

echo "--- worktree write gate (TD-408) ---"
echo "repo:            $REPO_DIR"
echo "command:         $*"
echo "command exit:    $CMD_STATUS"
echo "tracked sha in:  $BEFORE_SHA"
echo "tracked sha out: $AFTER_SHA"
echo "new untracked:   $NEW_UNTRACKED (INFO only — never a failure)"

GATE_STATUS=0

if [ "$BEFORE_HEAD" != "$AFTER_HEAD" ]; then
  echo "GATE FAIL: HEAD moved during the run ($BEFORE_HEAD -> $AFTER_HEAD)"
  GATE_STATUS=1
fi

if [ "$BEFORE_SHA" != "$AFTER_SHA" ]; then
  echo "GATE FAIL: tracked file(s) changed while the command ran:"
  # A path is an offender when its per-file tracked-content hash differs
  # between the snapshots — which covers appeared, disappeared and changed.
  # `comm -3` tabs its right-hand column; strip that, then the 64-hex hash and
  # its single separating space — never a field split, so a path with a space
  # survives intact.
  comm -3 <(sort "$WORK/before.files") <(sort "$WORK/after.files") \
    | sed -e 's/^	//' -e 's/^[0-9a-f]\{64\} //' | sort -u | sed 's/^/  /'
  GATE_STATUS=1
fi

if [ "$GATE_STATUS" -eq 0 ]; then
  echo "GATE CLEAN: 0 tracked files changed"
fi

rm -rf "$WORK"

if [ "$GATE_STATUS" -ne 0 ]; then
  exit 1
fi
exit "$CMD_STATUS"
