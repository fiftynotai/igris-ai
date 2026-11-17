#!/bin/bash
# Description: Commit ONLY the named paths (TD-493). This is the one way a
#              brief's close commit is made: `/hunt` Phase 7 calls it, and
#              `/do-lite` (FR-279) is to call it the same way.
#
#              Several sessions share one working tree and one index on a
#              machine. A sweeping stage at close (`git add` with -A, --all or
#              `.`, or a commit with -a) takes every dirty and untracked path
#              in the tree, and anything a
#              sibling already staged, into a commit whose `closes #<ID>`
#              footer attributes it all to this brief. This script commits the
#              named paths with `git commit --only`, which builds the commit
#              from HEAD plus those paths and leaves every other index entry
#              out of it (and still staged afterwards).
#
#              The caller owns the path set. This script never widens it and
#              never derives it from "what changed since a baseline" (a
#              sibling's edit during the run counts as changed). It refuses,
#              committing nothing, when the set cannot be trusted:
#                - the set is empty;
#                - a path has no change (not modified, added, deleted or
#                  untracked) — the set is wrong, so stop rather than guess;
#                - a path is a directory (on disk, in HEAD or in the index —
#                  a directory deleted from disk still names every path
#                  under it), `.`, absolute outside the repo, or holds a
#                  `.`, `..` or empty segment — each would widen the commit.
#              Every path is literal: `*.md` names a file called `*.md`,
#              never a glob (lookups run with GIT_LITERAL_PATHSPECS=1, the
#              commit names each path as `:(literal)<path>`; the variable is
#              never exported, so the commit's pre-commit and commit-msg hooks
#              see a plain commit's environment).
#
#              New (untracked) paths are added by explicit path first, since
#              `--only` refuses a path git does not know. If the commit then
#              fails (a hook refused it, or the add itself failed part-way),
#              those new paths are taken back out of the index, so a refused
#              close leaves the index as it found it.
#
#              Limits, all inherent to committing files rather than hunks:
#                - If another session staged a hunk of a file in the set, the
#                  commit takes that file's whole working-tree content, the
#                  sibling's hunk included. Only a worktree per session
#                  (TD-359) removes the shared tree that makes this possible.
#                - A rename is two paths. Name the old and the new path, or
#                  the commit records only the new file as an addition.
#                - The script commits files, not submodule (gitlink) bumps; a
#                  checked-out submodule is refused as a directory.
#
#              The hooks run as on any commit, against a temporary index that
#              holds only the named paths: pre-commit (phase guard, secrets
#              scan, path-triggered validators) and commit-msg (length,
#              signature, acceptance-criteria and agent-event gates).
#
# Usage:
#   scoped_commit.sh (-m <message> | -F <message-file>) [--dry-run] -- <path>...
#
#   Paths are repository-relative, as `git status` prints them from the
#   repository root; an absolute path inside the repository is accepted. The
#   script runs from the repository root whatever the current directory is.
#   --dry-run validates and prints the set, then exits without committing.
#
# Output: the path set, one `  <XY> <path>` line per path (XY is the
#   `git status --porcelain` code), printed before the commit is attempted;
#   then git's own commit output. Errors go to stderr, prefixed `scoped_commit:`.
#
# Exit codes:
#   0  committed (or --dry-run: the set is valid)
#   1  refused before committing — nothing staged, nothing committed
#   2  usage error, or not inside a git work tree
#   3  git add or git commit failed (a hook refused, or git errored) —
#      nothing committed, new paths unstaged again
#   4  committed, but the commit holds a path outside the set (should be
#      impossible with --only; reported loudly, never rewritten)
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.

set -u
# Literal pathspecs for this script's OWN lookups only, set per call through
# lgit and never exported: git hands an exported GIT_LITERAL_PATHSPECS to the
# hooks, and a hook that matches paths (the contract checker's
# `git check-ignore --stdin`) then misreads them and refuses the commit
# (measured on this brief's own close). The commit itself names each path as
# `:(literal)<path>`, so the hooks run in the environment a plain commit has.
# The caller's global pathspec settings are cleared: git refuses literal
# combined with any of them.
unset GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
lgit() { GIT_LITERAL_PATHSPECS=1 git "$@"; }

die() { echo "scoped_commit: $2" >&2; exit "$1"; }

msg_flag=""
msg_val=""
dry_run=0
paths=()
saw_sep=0

while [ $# -gt 0 ]; do
  if [ "$saw_sep" -eq 1 ]; then
    paths+=("$1"); shift; continue
  fi
  case "$1" in
    -m|-F)
      [ -z "$msg_flag" ] || die 2 "give exactly one of -m or -F"
      [ $# -ge 2 ] || die 2 "$1 needs a value"
      msg_flag="$1"; msg_val="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --) saw_sep=1; shift ;;
    *) die 2 "unexpected argument '$1' (paths go after --)" ;;
  esac
done

[ -n "$msg_flag" ] || die 2 "a commit message is required (-m <message> or -F <file>)"
if [ "$msg_flag" = "-F" ]; then
  [ -f "$msg_val" ] && [ -r "$msg_val" ] || die 2 "message file not readable: $msg_val"
  # Resolve before the cd below, so a relative message-file path still works.
  case "$msg_val" in /*) ;; *) msg_val="$(pwd)/$msg_val" ;; esac
fi

top="$(git rev-parse --show-toplevel 2>/dev/null)" || die 2 "not inside a git work tree"
[ -n "$top" ] || die 2 "not inside a git work tree"
cd "$top" || die 2 "cannot enter repository root: $top"
top="$(pwd -P)"

[ "${#paths[@]}" -gt 0 ] \
  || die 1 "refusing to commit: the path set is empty (name the brief's own paths after --)"

# Normalise and validate every path; build the de-duplicated set.
set_paths=()
set_codes=()
new_paths=()
for raw in "${paths[@]}"; do
  p="$raw"
  [ -n "$p" ] || die 1 "refusing to commit: an empty path was given"
  case "$p" in
    /*)
      # Resolve the parent physically (macOS /var -> /private/var) so an
      # absolute path through a symlinked prefix still matches the root.
      d="$(dirname "$p")"
      if [ -d "$d" ]; then p="$(cd "$d" && pwd -P)/$(basename "$p")"; fi
      case "$p" in
        "$top"|"$top/"|"$top/.") die 1 "refusing to commit: '$raw' names the repository root" ;;
        "$top"/*) p="${p#"$top"/}" ;;
        *) die 1 "refusing to commit: '$raw' is outside the repository" ;;
      esac ;;
  esac
  while case "$p" in ./*) true ;; *) false ;; esac; do p="${p#./}"; done
  # Only the plain spelling git prints is accepted. A '..' leaves the set; a
  # '.' or empty segment (`dir/.`, `a//b`) reaches past the directory checks
  # below, which look the path up by that exact spelling.
  case "/$p/" in
    */../*|*/./*|*//*) die 1 "refusing to commit: '$raw' holds a '.', '..' or empty segment — name the path as git prints it" ;;
  esac
  [ -d "$p" ] && [ ! -L "$p" ] \
    && die 1 "refusing to commit: '$raw' is a directory — name its changed files"
  # A directory gone from disk still widens: `--only -- dir` commits every
  # path under it. Catch it where git still knows it — HEAD or the index.
  if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
    # Ask for the object TYPE alone: matching " tree " against the whole
    # ls-tree line would also match a file whose NAME holds " tree ".
    [ "$(git cat-file -t "HEAD:$p" 2>/dev/null)" = "tree" ] \
      && die 1 "refusing to commit: '$raw' is a directory in HEAD — name its changed files"
  fi
  while IFS= read -r -d '' e; do
    [ "$e" = "$p" ] \
      || die 1 "refusing to commit: '$raw' is a directory in the index — name its changed files"
  done < <(lgit ls-files -z -- "$p" 2>/dev/null)

  dup=0
  if [ "${#set_paths[@]}" -gt 0 ]; then
    for q in "${set_paths[@]}"; do [ "$q" = "$p" ] && { dup=1; break; }; done
  fi
  [ "$dup" -eq 1 ] && continue

  st="$(lgit status --porcelain=v1 --untracked-files=all -- "$p" 2>/dev/null)" \
    || die 1 "refusing to commit: git cannot read the status of '$raw'"
  [ -n "$st" ] || die 1 "refusing to commit: '$raw' has no change (the path set is wrong)"
  code="${st:0:2}"
  set_paths+=("$p")
  set_codes+=("$code")
  [ "$code" = "??" ] && new_paths+=("$p")
done

echo "scoped_commit: ${#set_paths[@]} path(s) in the set:"
i=0
while [ "$i" -lt "${#set_paths[@]}" ]; do
  echo "  ${set_codes[$i]} ${set_paths[$i]}"
  i=$((i + 1))
done

[ "$dry_run" -eq 1 ] && { echo "scoped_commit: --dry-run, nothing committed"; exit 0; }

# Take the new paths back out of the index. --ignore-unmatch: after a
# part-way add, some were never staged, and a plain `git rm` would then
# refuse the whole list and unstage none.
unstage_new() {
  [ "${#new_paths[@]}" -gt 0 ] || return 0
  lgit rm --cached -q --ignore-unmatch -- "${new_paths[@]}" >/dev/null 2>&1 \
    || echo "scoped_commit: WARNING could not unstage the new paths: ${new_paths[*]}" >&2
}

if [ "${#new_paths[@]}" -gt 0 ]; then
  if ! lgit add -- "${new_paths[@]}"; then
    unstage_new
    die 3 "git add of the new paths failed; nothing committed (new paths unstaged again)"
  fi
fi

commit_specs=()
for q in "${set_paths[@]}"; do commit_specs+=(":(literal)$q"); done
if ! git commit --only "$msg_flag" "$msg_val" -- "${commit_specs[@]}"; then
  unstage_new
  die 3 "git commit failed; nothing committed (new paths unstaged again)"
fi

# Belt check: the commit holds nothing outside the set.
stray=""
while IFS= read -r -d '' f; do
  hit=0
  for q in "${set_paths[@]}"; do [ "$q" = "$f" ] && { hit=1; break; }; done
  [ "$hit" -eq 1 ] || stray="$stray $f"
done < <(git diff-tree --no-commit-id --name-only -r -z --root HEAD)
[ -z "$stray" ] || die 4 "the commit holds paths outside the set:$stray"

exit 0
